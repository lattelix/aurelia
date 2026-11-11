#!/usr/bin/env python3
"""Verify distinct full-upstream and public-runtime source scopes; never repin binaries."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath

EXPERIMENT = "experiments/apple-quack-source"
VENDOR = EXPERIMENT + "/vendor/quackjs"
MANIFEST = EXPERIMENT + "/distribution/RUNTIME_SOURCE_MANIFEST.json"
PUBLIC_PIN = EXPERIMENT + "/distribution/PUBLIC_SOURCE_BINARY_PIN.json"
PIN = "apps/mobile/native/AureliaYouTubeNative/SOURCE_BINARY_PIN.json"
RUNTIME_NAMES = (
    "HotCharacterPlan.kt", "Limits.kt", "Math.kt", "PlayerProgram.kt",
    "Runtime.kt", "SourceIndex.kt", "Specialization.kt", "Syntax.kt",
)
RUNTIME_PREFIX = "src/commonMain/kotlin/meow/nyx/quackjs/"
UPSTREAM_SHA256 = "781934eeafbd1e84558a5e2d98063a20e3899a54df936b6884a5783886a0e1a8"
KOTLIN_LICENSE_CLOSURE_SHA256 = "f9a8b07c4706139a366354c0d47c0ee98a4b9cfa5f86790a7952263f357d9991"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def safe_file(repo, relative):
    if not isinstance(relative, str):
        raise ValueError("invalid source path")
    path = PurePosixPath(relative)
    if path.is_absolute() or ".." in path.parts or "\\" in relative or not path.parts or path.as_posix() != relative:
        raise ValueError("invalid source path")
    candidate = repo
    for part in path.parts:
        candidate = candidate / part
        if candidate.is_symlink():
            raise ValueError("source symlink rejected: " + relative)
    if not candidate.is_file() or not candidate.resolve().is_relative_to(repo.resolve()):
        raise ValueError("missing or unconfined source: " + relative)
    return candidate


def upstream_manifest(repo):
    raw = safe_file(repo, VENDOR + "/SOURCE_MANIFEST.json").read_bytes()
    if sha256(raw) != UPSTREAM_SHA256:
        raise ValueError("original 17-entry upstream manifest changed")
    value = json.loads(raw)
    if len(value["files"]) != 17 or len({item["destination"] for item in value["files"]}) != 17:
        raise ValueError("expected all 17 distinct upstream entries")
    return value


def verify_upstream(repo, full):
    manifest = upstream_manifest(repo)
    selected = manifest["files"] if full else [item for item in manifest["files"]
        if not item["destination"].startswith(("src/commonTest/", "fixtures/"))]
    runtime = {item["destination"] for item in selected if item["destination"].startswith("src/commonMain/")}
    if runtime != {RUNTIME_PREFIX + name for name in RUNTIME_NAMES}:
        raise ValueError("runtime source set must contain exactly the eight pinned Kotlin inputs")
    for item in selected:
        data = safe_file(repo, VENDOR + "/" + item["destination"]).read_bytes()
        blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if len(data) != item["bytes"] or blob != item["gitBlob"]:
            raise ValueError("upstream Git blob mismatch: " + item["destination"])
    return manifest


def verify_runtime(repo, projection=False):
    upstream = verify_upstream(repo, full=False)
    manifest = json.loads(safe_file(repo, MANIFEST).read_text())
    if manifest["schemaVersion"] != 1 or manifest["sourceScope"] != "runtime-only":
        raise ValueError("unsupported runtime packaging manifest")
    if (manifest["upstreamManifestSHA256"] != UPSTREAM_SHA256 or manifest["commit"] != upstream["commit"]
            or manifest["tag"] != upstream["tag"] or manifest["repository"] != upstream["repository"]
            or manifest["originalUpstreamEntryCount"] != 17 or manifest["runtimeSourceCount"] != 8):
        raise ValueError("runtime manifest upstream identity mismatch")
    files = manifest["files"]
    paths = {item["path"] for item in files}
    if len(paths) != len(files):
        raise ValueError("duplicate packaging input")
    mandatory = {VENDOR + "/" + item["destination"] for item in upstream["files"]
                 if not item["destination"].startswith(("src/commonTest/", "fixtures/"))}
    mandatory |= {VENDOR + "/SOURCE_MANIFEST.json", EXPERIMENT + "/src/QuackCipherBridge.kt", PUBLIC_PIN,
                  EXPERIMENT + "/scripts/build-framework.sh", EXPERIMENT + "/scripts/build-runtime-framework.sh",
                  EXPERIMENT + "/scripts/build-runtime-framework.py", EXPERIMENT + "/scripts/source-packaging.py",
                  EXPERIMENT + "/scripts/package-xcframework.sh", EXPERIMENT + "/scripts/toolchain.py",
                  EXPERIMENT + "/checks/main.swift", EXPERIMENT + "/scripts/check-swift.sh",
                  EXPERIMENT + "/scripts/tests/test_native_packaging.py",
                  EXPERIMENT + "/distribution/README.md", EXPERIMENT + "/distribution/THIRD_PARTY_NOTICES.md",
                  "apps/mobile/native/AureliaYouTubeNative/scripts/prepare-artifact.py"}
    if not mandatory <= paths:
        raise ValueError("runtime packaging manifest omits required source/build/license inputs")
    license_tree = hashlib.sha256()
    for item in sorted(files, key=lambda entry: entry["path"]):
        if item["path"].startswith(EXPERIMENT + "/licenses/KotlinNative-2.4.21/"):
            license_tree.update(item["path"].encode() + b"\0" + item["sha256"].encode() + b"\n")
    if license_tree.hexdigest() != KOTLIN_LICENSE_CLOSURE_SHA256 or manifest["licenseInputClosureSHA256"] != KOTLIN_LICENSE_CLOSURE_SHA256:
        raise ValueError("complete retained Kotlin license input closure is required")
    for item in files:
        relative = item["path"]
        if relative not in mandatory and not relative.startswith(EXPERIMENT + "/licenses/KotlinNative-2.4.21/"):
            raise ValueError("unapproved packaging input: " + relative)
        if any(part in PurePosixPath(relative).parts for part in ("commonTest", "fixtures", "variants", "build", ".cache", "logs")) or relative.endswith((".js", "RESULTS.md")):
            raise ValueError("non-runtime source excluded from public packaging: " + relative)
        data = safe_file(repo, relative).read_bytes()
        if len(data) != item["bytes"] or sha256(data) != item["sha256"]:
            raise ValueError("packaging input checksum mismatch: " + relative)
    public_pin = json.loads(safe_file(repo, PUBLIC_PIN).read_text())
    if "verifiedReceipt" in public_pin or public_pin["sourceManifestSHA256"] != UPSTREAM_SHA256:
        raise ValueError("public pin has private receipt metadata or a different source identity")
    if public_pin["commit"] != upstream["commit"] or public_pin["quackVersion"] != upstream["tag"]:
        raise ValueError("public pin upstream identity mismatch")
    if public_pin["bridgeSHA256"] != sha256(safe_file(repo, EXPERIMENT + "/src/QuackCipherBridge.kt").read_bytes()):
        raise ValueError("public pin bridge identity mismatch")
    if public_pin["buildScriptSHA256"] != sha256(safe_file(repo, EXPERIMENT + "/scripts/build-framework.sh").read_bytes()):
        raise ValueError("historical recipe must stay byte-identical to the existing artifact pin")
    if projection:
        allowed_vendor = {path for path in paths if path.startswith(VENDOR + "/")}
        for path in (repo / VENDOR).rglob("*"):
            if not path.is_dir() or path.is_symlink():
                if path.relative_to(repo).as_posix() not in allowed_vendor:
                    raise ValueError("unexpected vendor content in runtime projection")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[3])
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check-full", action="store_true", help="verify all original 17 entries, including private verification fixtures")
    mode.add_argument("--check-runtime", action="store_true", help="verify the separately reviewed runtime packaging closure")
    mode.add_argument("--check-projection", action="store_true", help="also reject every unlisted file in the projected vendor tree")
    mode.add_argument("--print-files", action="store_true", help="emit the verified repo-relative public source allowlist as JSON")
    args = parser.parse_args()
    repo = args.repo.resolve()
    if args.check_full:
        verify_upstream(repo, full=True)
        print("Verified all 17 original upstream entries; runtime-only packaging was not substituted.")
    else:
        manifest = verify_runtime(repo, projection=args.check_projection)
        if args.print_files:
            print(json.dumps(sorted([item["path"] for item in manifest["files"]] + [MANIFEST])))
        else:
            print("Verified runtime-only packaging: 8 unchanged Kotlin sources and the declared build/license closure.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as error:
        raise SystemExit(str(error))
