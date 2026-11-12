#!/usr/bin/env python3
"""Capture one bounded Gradle inventory marker; write only through a held parent FD."""
import argparse
import base64
import hashlib
import json
import math
import os
from pathlib import PurePosixPath
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

PREFIX = b"AURELIA_RUNTIME_INVENTORY:"
MAX_JSON = 4 * 1024 * 1024
MAX_STDOUT = 12 * 1024 * 1024
MAX_STDERR = 2 * 1024 * 1024
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class CaptureRefused(Exception):
    pass


def output_parent(value):
    path = PurePosixPath(value)
    if not path.is_absolute() or path.as_posix() != value or not path.name or any(
        part in (".", "..") or part != part.strip() or "\\" in part or ":" in part or
        any(ord(character) < 32 or ord(character) == 127 for character in part)
        for part in path.parts[1:]
    ):
        raise CaptureRefused("InvalidOutputPath")
    descriptor = os.open("/", DIR_FLAGS)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, DIR_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        owner = os.fstat(descriptor)
        if owner.st_uid != os.getuid() or owner.st_mode & 0o022:
            raise CaptureRefused("UnsafeOutputParent")
        try:
            os.stat(path.name, dir_fd=descriptor, follow_symlinks=False)
        except FileNotFoundError:
            return descriptor, path.name
        raise CaptureRefused("OutputAlreadyExists")
    except BaseException:
        os.close(descriptor)
        raise


def stop_owned(process):
    # Keep the leader unreaped until both signals: its descendants can retain the
    # pipes after it exits, and its PID must not be reused as another group ID.
    failure = None
    try:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        else:
            time.sleep(0.1)
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    except OSError as error:
        failure = error.__class__.__name__
    try:
        code = process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        raise CaptureRefused("CommandCleanupIncomplete") from None
    if failure:
        raise CaptureRefused("CommandCleanup" + failure)
    return code


def supervise(control, command):
    # A live owned leader avoids signaling a reaped/reused or empty group. A
    # caught handler resets to the default on exec; the command can receive TERM.
    signal.signal(signal.SIGTERM, lambda *_: None)
    code = 127
    try:
        process = subprocess.Popen(command, shell=False, stdin=subprocess.DEVNULL, close_fds=True)
        code = process.wait()
    except OSError:
        pass
    os.write(control, (str(code) + "\n").encode("ascii"))
    os.close(control)
    while True:
        signal.pause()


def bounded_command(command, timeout):
    started = time.monotonic()
    control_read, control_write = os.pipe()
    try:
        process = subprocess.Popen([sys.executable, "-B", os.path.abspath(__file__), "--internal-supervisor",
                                    str(control_write), *command], shell=False, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                                   pass_fds=(control_write,))
    except BaseException:
        os.close(control_read)
        raise
    finally:
        os.close(control_write)
    streams = {"stdout": bytearray(), "stderr": bytearray(), "control": bytearray()}
    limits = {"stdout": MAX_STDOUT, "stderr": MAX_STDERR, "control": 32}
    selector = selectors.DefaultSelector()
    cleanup_started = False
    command_code = None
    try:
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        selector.register(control_read, selectors.EVENT_READ, "control")
        while selector.get_map():
            remaining = timeout - (time.monotonic() - started)
            if remaining <= 0:
                raise CaptureRefused("CommandDeadlineExceeded")
            for key, _ in selector.select(min(remaining, 0.2)):
                chunk = os.read(key.fd, 64 * 1024)
                if not chunk:
                    selector.unregister(key.fileobj)
                    if key.data == "control" and command_code is None:
                        raise CaptureRefused("MissingCommandExitStatus")
                    continue
                target = streams[key.data]
                if len(target) + len(chunk) > limits[key.data]:
                    raise CaptureRefused("CommandStreamLimitExceeded")
                target.extend(chunk)
                if key.data == "control" and b"\n" in target:
                    if not re.fullmatch(rb"-?[0-9]{1,3}\n", target) or not -64 <= int(target) <= 255:
                        raise CaptureRefused("InvalidCommandExitStatus")
                    command_code = int(target)
                    # The command finished; its descendants can no longer extend
                    # the capture, even if they closed their inherited pipes.
                    if not cleanup_started:
                        cleanup_started = True
                        stop_owned(process)
        if command_code is None:
            raise CaptureRefused("MissingCommandExitStatus")
        return command_code, bytes(streams["stdout"]), bytes(streams["stderr"]), time.monotonic() - started
    except BaseException:
        if not cleanup_started:
            stop_owned(process)
        raise
    finally:
        selector.close()
        process.stdout.close()
        process.stderr.close()
        os.close(control_read)


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise CaptureRefused("DuplicateJsonKey")
        value[key] = item
    return value


def public_values(value, depth=0):
    if depth > 16:
        raise CaptureRefused("InventoryNestingLimitExceeded")
    if isinstance(value, str):
        if len(value) > 1024 or "/" in value or "\\" in value or any(ord(character) < 32 for character in value):
            raise CaptureRefused("PrivateLocatorOrUnboundedValue")
        if re.search(r"-----BEGIN .*PRIVATE KEY-----|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", value):
            raise CaptureRefused("PrivateValueInInventory")
    elif isinstance(value, dict):
        if len(value) > 64:
            raise CaptureRefused("InventoryObjectLimitExceeded")
        for key, child in value.items():
            public_values(key, depth + 1)
            public_values(child, depth + 1)
    elif isinstance(value, list):
        if len(value) > 3000:
            raise CaptureRefused("InventoryListLimitExceeded")
        for child in value:
            public_values(child, depth + 1)
    elif type(value) is float and not math.isfinite(value):
        raise CaptureRefused("NonfiniteInventoryNumber")
    elif value is not None and type(value) not in (int, float, bool):
        raise CaptureRefused("InvalidInventoryValue")


def validate_report(stdout):
    markers = [line[len(PREFIX):] for line in stdout.splitlines() if line.startswith(PREFIX)]
    if len(markers) != 1:
        raise CaptureRefused("ExpectedExactlyOneInventoryMarker")
    if len(markers[0]) > 4 * ((MAX_JSON + 2) // 3):
        raise CaptureRefused("InventoryJsonLimitExceeded")
    raw = base64.b64decode(markers[0], validate=True)
    if len(raw) > MAX_JSON:
        raise CaptureRefused("InventoryJsonLimitExceeded")
    report = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                        parse_constant=lambda _: (_ for _ in ()).throw(CaptureRefused("InvalidJsonConstant")))
    public_values(report)
    if not isinstance(report, dict) or type(report.get("schemaVersion")) is not int or report.get("schemaVersion") != 1 or report.get("kind") != "aurelia-android-runtime-inventory":
        raise CaptureRefused("InvalidInventoryObject")
    allowed = {"schemaVersion", "kind", "capturedAt", "configuration", "toolchain", "properties", "state", "graphResolved",
               "artifactsVerified", "sourceClosureComplete", "binaryReleaseReady", "sourceMetadata", "components", "edges",
               "artifacts", "errors", "limits", "counts", "errorsTruncated", "inventoryTruncated", "observedCounts"}
    if set(report) - allowed or report.get("configuration") not in ("releaseRuntimeClasspath", "debugRuntimeClasspath"):
        raise CaptureRefused("InvalidInventoryFields")
    if report.get("sourceClosureComplete") is not False or report.get("binaryReleaseReady") is not False:
        raise CaptureRefused("UnapprovedClosureClaim")
    if report.get("state") not in ("resolved", "partial") or any(type(report.get(key)) is not bool for key in ("graphResolved", "artifactsVerified")):
        raise CaptureRefused("InvalidInventoryStatus")
    for key, limit in (("components", 332), ("edges", 3000), ("artifacts", 600), ("errors", 100)):
        if not isinstance(report.get(key), list) or len(report[key]) > limit or any(not isinstance(row, dict) for row in report[key]):
            raise CaptureRefused("InvalidInventoryRows")
    modules = sum(row.get("kind") == "module" for row in report["components"])
    projects = sum(row.get("kind") == "project" for row in report["components"])
    if modules > 300 or projects > 32 or modules + projects != len(report["components"]):
        raise CaptureRefused("InvalidComponentCount")
    for row in report["components"]:
        if row["kind"] == "project" and row.get("projectArtifact") != "not-built":
            raise CaptureRefused("UnapprovedProjectArtifactClaim")
    identifiers = [row.get("id") for row in report["components"]]
    if any(not isinstance(value, str) or not value for value in identifiers) or len(set(identifiers)) != len(identifiers):
        raise CaptureRefused("InvalidComponentIdentity")
    module_ids = {row["id"] for row in report["components"] if row["kind"] == "module"}
    for row in report["edges"]:
        if row.get("from") not in identifiers or ("selected" in row and row["selected"] not in identifiers):
            raise CaptureRefused("InvalidDependencyEdge")
    total = 0
    for row in report["artifacts"]:
        size, filename = row.get("bytes"), row.get("filename")
        if row.get("component") not in module_ids or type(size) is not int or not 0 <= size <= 128 * 1024 * 1024 or not isinstance(filename, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.+ ()-]{0,255}", filename):
            raise CaptureRefused("InvalidArtifactIdentity")
        if not isinstance(row.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", row["sha256"]):
            raise CaptureRefused("InvalidArtifactChecksum")
        total += size
    if total > 512 * 1024 * 1024:
        raise CaptureRefused("ArtifactByteLimitExceeded")
    expected = {"modules": modules, "projects": projects, "edges": len(report["edges"]), "artifacts": len(report["artifacts"])}
    if report.get("counts") != expected or any(type(value) is not int for value in report.get("counts", {}).values()):
        raise CaptureRefused("InventoryCountMismatch")
    if report["state"] == "resolved" and (not report["graphResolved"] or not report["artifactsVerified"] or report["errors"] or not modules or not report["artifacts"]):
        raise CaptureRefused("EmptyOrIncompleteSuccess")
    text = raw.decode("utf-8")
    if re.search(r"/(?:Users|home)/|[A-Za-z]:\\|file://|\.gradle[/\\]caches|-----BEGIN .*PRIVATE KEY-----", text):
        raise CaptureRefused("PrivateLocatorInInventory")
    return report, hashlib.sha256(raw).hexdigest()


def write_exclusive(parent_fd, name, report):
    data = (json.dumps(report, separators=(",", ":"), ensure_ascii=True, allow_nan=False) + "\n").encode("utf-8")
    if len(data) > MAX_JSON + 4096:
        raise CaptureRefused("CapturedReportLimitExceeded")
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
    try:
        os.fchmod(descriptor, 0o600)
        position = 0
        while position < len(data):
            count = os.write(descriptor, data[position:])
            if count <= 0:
                raise CaptureRefused("IncompleteReportWrite")
            position += count
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=600)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or len(command) > 64 or sum(map(len, command)) > 128 * 1024 or not 1 <= args.timeout_seconds <= 1800:
        raise CaptureRefused("InvalidCommandOrDeadline")
    parent, name = output_parent(args.output)
    try:
        code, stdout, stderr, elapsed = bounded_command(command, args.timeout_seconds)
        report, payload_hash = validate_report(stdout)
        if code != 0:
            report["state"] = "partial"
            report["graphResolved"] = False
            report["artifactsVerified"] = False
        report["capture"] = {"commandExitCode": code, "elapsedSeconds": round(elapsed, 3), "protocolPayloadSHA256": payload_hash,
                             "stdoutBytes": len(stdout), "stderrBytes": len(stderr),
                             "stdoutSHA256": hashlib.sha256(stdout).hexdigest(), "stderrSHA256": hashlib.sha256(stderr).hexdigest()}
        write_exclusive(parent, name, report)
        print("Captured runtime inventory: " + report["state"])
        return code if 0 < code < 126 else 1 if code != 0 or report["state"] != "resolved" else 0
    finally:
        os.close(parent)


if __name__ == "__main__":
    try:
        if len(sys.argv) > 3 and sys.argv[1] == "--internal-supervisor":
            supervise(int(sys.argv[2]), sys.argv[3:])
            raise SystemExit(127)
        raise SystemExit(main())
    except (CaptureRefused, OSError, ValueError, TypeError, KeyError, RecursionError, subprocess.SubprocessError) as error:
        code = str(error) if isinstance(error, CaptureRefused) else error.__class__.__name__
        print("Runtime inventory capture refused: " + code, file=sys.stderr)
        raise SystemExit(1)
