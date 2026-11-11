"""Source-only gates; fake framework/JDK fixtures never invoke compilers or media."""
import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[4]
EXPERIMENT = REPO / "experiments/apple-quack-source"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


packaging = load("packaging_checks", EXPERIMENT / "scripts/source-packaging.py")
builder = load("builder_checks", EXPERIMENT / "scripts/build-runtime-framework.py")
artifact = load("artifact_checks", REPO / "apps/mobile/native/AureliaYouTubeNative/scripts/prepare-artifact.py")


class RuntimeProjectionChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="aurelia-native-source-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        manifest = json.loads((REPO / packaging.MANIFEST).read_text())
        for relative in [entry["path"] for entry in manifest["files"]] + [packaging.MANIFEST]:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / relative, target)

    def test_runtime_projection_is_complete_without_private_fixtures(self):
        value = packaging.verify_runtime(self.root, projection=True)
        self.assertEqual(value["sourceScope"], "runtime-only")
        with self.assertRaisesRegex(ValueError, "missing"):
            packaging.verify_upstream(self.root, full=True)

    def test_original_all_17_gate_still_passes_without_manifest_edits(self):
        if (REPO / packaging.VENDOR / "src/commonTest").is_dir():
            self.assertEqual(len(packaging.verify_upstream(REPO, full=True)["files"]), 17)
        else:
            with self.assertRaisesRegex(ValueError, "missing"):
                packaging.verify_upstream(REPO, full=True)
        self.assertEqual(hashlib.sha256((REPO / packaging.VENDOR / "SOURCE_MANIFEST.json").read_bytes()).hexdigest(), packaging.UPSTREAM_SHA256)

    def test_runtime_source_tampering_and_missing_file_fail_closed(self):
        source = self.root / packaging.VENDOR / packaging.RUNTIME_PREFIX / "Runtime.kt"
        source.write_bytes(source.read_bytes() + b"\n// mutation")
        with self.assertRaisesRegex(ValueError, "Git blob mismatch"):
            packaging.verify_runtime(self.root)
        source.unlink()
        with self.assertRaisesRegex(ValueError, "missing"):
            packaging.verify_runtime(self.root)

    def test_pruned_license_inventory_is_rejected(self):
        path = self.root / packaging.MANIFEST
        value = json.loads(path.read_text())
        value["files"] = [entry for entry in value["files"] if not entry["path"].endswith("boost_LICENSE.txt")]
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "license input closure"):
            packaging.verify_runtime(self.root)

    def test_unlisted_player_or_runtime_file_is_not_public_projection(self):
        for name in ("player.js", "extra.kt"):
            extra = self.root / packaging.VENDOR / name
            extra.write_text("synthetic unlisted content")
            with self.assertRaisesRegex(ValueError, "unexpected vendor"):
                packaging.verify_runtime(self.root, projection=True)
            extra.unlink()

    def test_manifest_cannot_authorize_an_unrelated_private_file(self):
        relative = "tools/unrelated-personal-note.md"
        extra = self.root / relative
        extra.parent.mkdir()
        extra.write_bytes(b"synthetic data")
        path = self.root / packaging.MANIFEST
        value = json.loads(path.read_text())
        value["files"].append({"path": relative, "bytes": 14, "sha256": hashlib.sha256(extra.read_bytes()).hexdigest()})
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "unapproved packaging input"):
            packaging.verify_runtime(self.root)

    def test_symlinks_and_path_aliases_are_rejected(self):
        source = self.root / packaging.VENDOR / "LICENSE"
        outside = self.root / "outside.txt"
        source.rename(outside)
        source.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "symlink"):
            packaging.verify_runtime(self.root)
        for relative in ("../outside", "/outside", "a/./b", "a//b", "a\\b"):
            with self.assertRaises(ValueError):
                packaging.safe_file(self.root, relative)

    def test_public_pin_removes_only_private_receipt_reference(self):
        original = json.loads((REPO / packaging.PIN).read_text())
        projected = json.loads((REPO / packaging.PUBLIC_PIN).read_text())
        self.assertEqual(projected, {key: value for key, value in original.items() if key != "verifiedReceipt"})
        self.assertEqual(projected["frameworkTreeSHA256"], original["frameworkTreeSHA256"])


class ToolchainChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="aurelia-native-toolchain-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.env = {"JAVA_HOME": str(self.root / "jdk"), "DEVELOPER_DIR": str(self.root / "Xcode/Contents/Developer"),
                    "KONAN_HOME": str(self.root / "konan")}
        for path in ("jdk/bin/java", "jdk/bin/javac", "Xcode/Contents/Developer/usr/bin/xcodebuild", "konan/bin/konanc"):
            file = self.root / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("fixture")
        (self.root / "sdk").mkdir()

    def answer(self, command, environment):
        if command[0].endswith("/java"):
            return "    java.specification.version = 21\n"
        if command[0].endswith("/javac"):
            return "javac 21.0.13\n"
        if command[0].endswith("/konanc"):
            return "info: kotlinc-native 2.4.21\n"
        if command[:2] == ["xcrun", "--sdk"]:
            self.assertEqual(environment["DEVELOPER_DIR"], self.env["DEVELOPER_DIR"])
            return str(self.root / "sdk") + "\n"
        self.fail("unexpected subprocess: " + str(command))

    def test_explicit_external_jdk_and_two_targets_produce_exact_runtime_plan(self):
        with patch.object(builder, "output", side_effect=self.answer):
            for target in ("macos_arm64", "ios_arm64"):
                command, env = builder.build_plan(EXPERIMENT, target, self.env, host=("Darwin", "arm64"))
                self.assertEqual(env["JAVA_HOME"], self.env["JAVA_HOME"])
                self.assertEqual(env["DEVELOPER_DIR"], self.env["DEVELOPER_DIR"])
                self.assertEqual(len([arg for arg in command if arg.endswith(".kt")]), 9)
                self.assertFalse(any(".runtime" in arg for arg in command))
                self.assertIn(target, command)

    def test_missing_or_non_21_jdk_and_unsupported_hosts_fail(self):
        with self.assertRaisesRegex(ValueError, "JAVA_HOME"):
            builder.build_plan(EXPERIMENT, "ios_arm64", {}, host=("Darwin", "arm64"))
        with patch.object(builder, "output", return_value="java.specification.version = 17\n"):
            with self.assertRaisesRegex(ValueError, "JDK 21"):
                builder.build_plan(EXPERIMENT, "ios_arm64", self.env, host=("Darwin", "arm64"))
        with self.assertRaisesRegex(ValueError, "Apple Silicon"):
            builder.build_plan(EXPERIMENT, "ios_arm64", self.env, host=("Darwin", "x86_64"))


class CandidatePinChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="aurelia-native-candidate-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "fixture.xcframework"
        self.source.mkdir()
        libraries = []
        for identifier, platform in (("ios-arm64", "ios"), ("macos-arm64", "macos")):
            framework = self.source / identifier / "AureliaQuack.framework"
            (framework / "Headers").mkdir(parents=True)
            (framework / "Modules").mkdir()
            (framework / "AureliaQuack").write_bytes(b"synthetic archive, not executable media")
            (framework / "Headers/AureliaQuack.h").write_text("// synthetic header")
            (framework / "Modules/module.modulemap").write_text("// synthetic module")
            libraries.append({"LibraryIdentifier": identifier, "SupportedPlatform": platform,
                              "SupportedArchitectures": ["arm64"], "LibraryPath": "AureliaQuack.framework"})
        (self.source / "Info.plist").write_bytes(plistlib.dumps({"AvailableLibraries": libraries}))
        self.pin = json.loads((REPO / packaging.PUBLIC_PIN).read_text())

    def lipo(self, command, **kwargs):
        self.assertEqual(command[:3], ["xcrun", "lipo", "-archs"])
        return subprocess.CompletedProcess(command, 0, stdout="arm64\n", stderr="")

    def test_candidate_is_pending_preserves_original_pin_and_cannot_stage(self):
        original = (REPO / packaging.PIN).read_bytes()
        artifact.verify_sources(REPO, self.pin, "runtime")
        with patch.object(artifact.subprocess, "run", side_effect=self.lipo):
            candidate = artifact.candidate_pin(REPO, self.pin, self.source)
        self.assertEqual(candidate["reviewStatus"], "pending")
        self.assertEqual(candidate["buildRecipePath"], artifact.RUNTIME_RECIPE)
        self.assertNotIn("verifiedReceipt", candidate)
        self.assertEqual(candidate["sourceManifestSHA256"], self.pin["sourceManifestSHA256"])
        self.assertEqual((REPO / packaging.PIN).read_bytes(), original)
        with self.assertRaisesRegex(ValueError, "pending review"):
            artifact.stage(self.root, self.source, candidate, candidate["binarySHA256"])
        self.assertFalse((self.root / "Artifacts").exists())

    def test_false_architecture_metadata_and_escaping_symlinks_are_rejected(self):
        with patch.object(artifact.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout="x86_64\n", stderr="")):
            with self.assertRaisesRegex(ValueError, "binary architecture"):
                artifact.framework_binaries(self.source)
        (self.source / "escape").symlink_to("../outside")
        with self.assertRaisesRegex(ValueError, "symlink"):
            artifact.framework_tree(self.source)

    def test_staging_verifies_copy_and_keeps_runtime_binary_pins(self):
        hashes = artifact.framework_binaries(self.source, inspect=False)
        reviewed = dict(self.pin, reviewStatus="approved", frameworkTreeSHA256=artifact.framework_tree(self.source), binarySHA256=hashes)
        artifact.stage(self.root, self.source, reviewed, hashes)
        self.assertEqual(artifact.framework_tree(self.root / "Artifacts/AureliaQuack.xcframework"), reviewed["frameworkTreeSHA256"])
        binary = self.source / "ios-arm64/AureliaQuack.framework/AureliaQuack"
        binary.write_bytes(b"changed after review")
        with self.assertRaisesRegex(ValueError, "changed during verified staging"):
            artifact.stage(self.root, self.source, reviewed, hashes)
        self.assertEqual(artifact.framework_tree(self.root / "Artifacts/AureliaQuack.xcframework"), reviewed["frameworkTreeSHA256"])


if __name__ == "__main__":
    unittest.main()
