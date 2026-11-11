#!/usr/bin/env python3
"""Build only the pinned runtime sources using an explicit external JDK 21."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("source_packaging", ROOT / "scripts/source-packaging.py")
packaging = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packaging)


def output(command, env):
    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30, check=True)
    return result.stdout + result.stderr


def build_plan(root, target, environment, host=None):
    if (host or (platform.system(), platform.machine())) != ("Darwin", "arm64"):
        raise ValueError("An Apple Silicon Mac is required; supported targets are macos_arm64 and ios_arm64.")
    if target not in ("macos_arm64", "ios_arm64"):
        raise ValueError("unsupported target")
    env = dict(environment)
    java_home = Path(env.get("JAVA_HOME", ""))
    if not env.get("JAVA_HOME") or not java_home.is_absolute() or not (java_home / "bin/javac").is_file():
        raise ValueError("Set JAVA_HOME to an external JDK 21 installation (including bin/java and bin/javac).")
    version = output([str(java_home / "bin/java"), "-XshowSettings:properties", "-version"], env)
    if not re.search(r"(?m)^\s*java\.specification\.version\s*=\s*21\s*$", version):
        raise ValueError("JAVA_HOME must select JDK 21.")
    if not re.search(r"\bjavac 21(?:\.|\s|$)", output([str(java_home / "bin/javac"), "-version"], env)):
        raise ValueError("JAVA_HOME must contain the matching JDK 21 compiler.")
    developer = Path(env.get("DEVELOPER_DIR") or output(["xcode-select", "-p"], env).strip())
    if not (developer / "usr/bin/xcodebuild").is_file():
        raise ValueError("Full Xcode is required; select it or set DEVELOPER_DIR to its Contents/Developer directory.")
    env["DEVELOPER_DIR"] = str(developer)
    sdk = "iphoneos" if target == "ios_arm64" else "macosx"
    if not Path(output(["xcrun", "--sdk", sdk, "--show-sdk-path"], env).strip()).is_dir():
        raise ValueError("The selected Xcode SDK is unavailable.")
    konan = Path(env.get("KONAN_HOME") or root / ".cache/kotlin-native-prebuilt-macos-aarch64-2.4.21")
    compiler = konan / "bin/konanc"
    if not compiler.is_file() or not re.search(r"\b2\.4\.21\b", output([str(compiler), "-version"], env)):
        raise ValueError("Kotlin/Native 2.4.21 is required; run scripts/toolchain.py or set KONAN_HOME.")
    env.setdefault("KONAN_DATA_DIR", str(root / ".cache/konan"))
    env.setdefault("JAVA_OPTS", "-Xmx2g")
    destination = root / "build" / target / "AureliaQuack"
    sources = [root / "vendor/quackjs" / packaging.RUNTIME_PREFIX / name for name in packaging.RUNTIME_NAMES]
    command = [str(compiler), "-target", target, "-produce", "framework", "-Xstatic-framework", "-g",
               "-Xbinary=bundleId=com.lattelix.aurelia.quack", "-module-name", "AureliaQuack", "-o", str(destination),
               *map(str, sources), str(root / "src/QuackCipherBridge.kt")]
    return command, env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=("macos_arm64", "ios_arm64"))
    parser.add_argument("--dry-run", action="store_true", help="verify source/toolchain prerequisites and print the command without compiling")
    args = parser.parse_args()
    packaging.verify_runtime(ROOT.parents[1])
    command, env = build_plan(ROOT, args.target, os.environ)
    if args.dry_run:
        print(json.dumps({"target": args.target, "command": command}, indent=2))
    else:
        (ROOT / "build" / args.target).mkdir(parents=True, exist_ok=True)
        subprocess.run(command, env=env, check=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error))
