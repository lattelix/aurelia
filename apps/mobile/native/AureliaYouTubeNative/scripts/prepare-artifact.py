#!/usr/bin/env python3
"""Verify local source/framework identity, or emit an explicitly unreviewed rebuild pin."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

PACKAGE = Path(__file__).resolve().parents[1]
REPO = PACKAGE.parents[3]
EXPERIMENT = "experiments/apple-quack-source"
HISTORICAL_RECIPE = EXPERIMENT + "/scripts/build-framework.sh"
RUNTIME_RECIPE = EXPERIMENT + "/scripts/build-runtime-framework.sh"
RUNTIME_MANIFEST = EXPERIMENT + "/distribution/RUNTIME_SOURCE_MANIFEST.json"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def packaging_module(repo):
    spec = importlib.util.spec_from_file_location("source_packaging", repo / EXPERIMENT / "scripts/source-packaging.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_sources(repo, pin, scope):
    packaging = packaging_module(repo)
    manifest = packaging.verify_upstream(repo, full=scope == "full")
    require(pin.get("reviewStatus") in (None, "approved"), "Candidate pin is pending review; it cannot stage an artifact.")
    require(pin["sourceManifestSHA256"] == packaging.UPSTREAM_SHA256, "source manifest pin mismatch")
    require(manifest["commit"] == pin["commit"] and manifest["tag"] == pin["quackVersion"], "upstream identity mismatch")
    require(digest(packaging.safe_file(repo, EXPERIMENT + "/src/QuackCipherBridge.kt")) == pin["bridgeSHA256"], "bridge pin mismatch")
    recipe = pin.get("buildRecipePath", HISTORICAL_RECIPE)
    require(recipe in (HISTORICAL_RECIPE, RUNTIME_RECIPE), "unsupported build recipe pin")
    require(digest(packaging.safe_file(repo, recipe)) == pin["buildScriptSHA256"], "build recipe pin mismatch")
    if scope == "runtime" or recipe == RUNTIME_RECIPE:
        packaging.verify_runtime(repo)
    if recipe == RUNTIME_RECIPE:
        require(pin.get("runtimeSourceManifestSHA256") == digest(repo / RUNTIME_MANIFEST), "runtime build/license closure pin mismatch")


def framework_tree(source):
    require(source.is_dir() and not source.is_symlink(), "Build the local framework first; see distribution/README.md.")
    tree = hashlib.sha256()
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            require(not os.path.isabs(os.readlink(path)) and path.resolve().is_relative_to(source.resolve()), "framework symlink escapes its portable tree")
            value = "symlink:" + os.readlink(path)
        elif path.is_file():
            value = digest(path)
        else:
            continue
        tree.update(path.relative_to(source).as_posix().encode() + b"\0" + value.encode() + b"\n")
    return tree.hexdigest()


def framework_binaries(source, inspect=True):
    libraries = plistlib.loads((source / "Info.plist").read_bytes())["AvailableLibraries"]
    platforms = {"ios-arm64": "ios", "macos-arm64": "macos"}
    require(len(libraries) == 2 and {item["LibraryIdentifier"] for item in libraries} == set(platforms), "exact iOS arm64 + macOS arm64 slices required")
    hashes = {}
    for item in libraries:
        identifier = item["LibraryIdentifier"]
        require(item["SupportedArchitectures"] == ["arm64"] and item["SupportedPlatform"] == platforms[identifier]
                and not item.get("SupportedPlatformVariant") and item["LibraryPath"] == "AureliaQuack.framework", "unsupported framework platform/architecture")
        framework = source / identifier / "AureliaQuack.framework"
        require((framework / "Headers/AureliaQuack.h").is_file() and (framework / "Modules/module.modulemap").is_file(), "framework interop headers/modules missing")
        binary = framework / "AureliaQuack"
        hashes[identifier] = digest(binary)
        if inspect:
            result = subprocess.run(["xcrun", "lipo", "-archs", str(binary)], capture_output=True, text=True, timeout=30, check=True)
            require(result.stdout.strip().split() == ["arm64"], "binary architecture does not match its framework metadata")
    return hashes


def candidate_pin(repo, original, source):
    tree = framework_tree(source)
    binaries = framework_binaries(source)
    value = {key: item for key, item in original.items() if key != "verifiedReceipt"}
    value.update(reviewStatus="pending", buildRecipePath=RUNTIME_RECIPE,
                 buildScriptSHA256=digest(repo / RUNTIME_RECIPE), runtimeSourceManifestSHA256=digest(repo / RUNTIME_MANIFEST),
                 frameworkTreeSHA256=tree, binarySHA256=binaries)
    value["reviewRequired"] = "Review the clean build inputs, toolchain, source closure, interop checks and binary changes before marking approved."
    return value


def stage(package, source, pin, hashes):
    require(pin.get("reviewStatus") in (None, "approved"), "Candidate pin is pending review; it cannot stage an artifact.")
    target = package / "Artifacts/AureliaQuack.xcframework"
    require(not target.parent.is_symlink() and target.parent.resolve() == package.resolve() / "Artifacts", "unconfined artifact destination")
    target.parent.mkdir(exist_ok=True)
    require(not target.is_symlink() and (not target.exists() or target.is_dir()), "artifact destination must be a real directory")
    manifest_target = target.parent / "source-manifest.json"
    require(not manifest_target.is_symlink() and (not manifest_target.exists() or manifest_target.is_file()), "invalid artifact manifest destination")
    with tempfile.TemporaryDirectory(prefix=".verified-stage-", dir=target.parent) as temporary:
        temporary = Path(temporary)
        copied = temporary / "AureliaQuack.xcframework"
        shutil.copytree(source, copied, symlinks=True)
        require(framework_tree(copied) == pin["frameworkTreeSHA256"] and framework_binaries(copied, inspect=False) == hashes,
                "framework changed during verified staging")
        backup = temporary / "previous.xcframework"
        if target.exists():
            target.rename(backup)
        try:
            copied.rename(target)
        except OSError:
            if backup.exists():
                backup.rename(target)
            raise
        manifest = {"quackVersion": pin["quackVersion"], "commit": pin["commit"],
                    "source": EXPERIMENT + "/vendor/quackjs", "binarySHA256": hashes}
        metadata = temporary / "source-manifest.json"
        metadata.write_text(json.dumps(manifest, indent=2) + "\n")
        metadata.replace(manifest_target)


def main():
    if not __debug__:
        raise ValueError("Artifact verification requires Python assertions enabled.")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-scope", choices=("full", "runtime"), default="full", help="full retains the original 17-entry gate; runtime is an explicit public packaging policy")
    parser.add_argument("--pin", type=Path, default=PACKAGE / "SOURCE_BINARY_PIN.json", help="existing historical pin or explicitly approved reviewed rebuild pin")
    parser.add_argument("--framework", type=Path, default=REPO / EXPERIMENT / "build/AureliaQuack.xcframework")
    parser.add_argument("--candidate-pin", type=Path, help="write a NEW pending-review candidate instead of staging; never overwrites a pin")
    args = parser.parse_args()
    pin = json.loads(args.pin.read_text())
    verify_sources(REPO, pin, args.source_scope)
    if args.candidate_pin:
        require(args.source_scope == "runtime", "Rebuild candidates require explicit --source-scope runtime.")
        value = candidate_pin(REPO, pin, args.framework)
        with args.candidate_pin.open("x") as output:
            output.write(json.dumps(value, indent=2) + "\n")
        print("Wrote pending-review candidate only. No framework was staged and no existing pin changed.")
        return
    require(framework_tree(args.framework) == pin["frameworkTreeSHA256"], "Review a --candidate-pin for the rebuilt artifact before staging; existing pin was not changed.")
    hashes = framework_binaries(args.framework)
    require(hashes == pin["binarySHA256"], "binary pin mismatch")
    stage(PACKAGE, args.framework, pin, hashes)
    print("Staged pinned-source iOS arm64 + macOS arm64 static framework (" + args.source_scope + " source scope).")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error))
