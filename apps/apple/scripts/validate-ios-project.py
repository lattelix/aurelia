#!/usr/bin/env python3
"""Validate static Xcode wiring without claiming an iOS SDK/device build."""
import json
import plistlib
import re
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

root = Path(__file__).resolve().parents[1]
project = root / "iOS/Aurelia.xcodeproj/project.pbxproj"
converted = subprocess.run(["plutil", "-convert", "json", "-o", "-", str(project)], check=True, capture_output=True)
data = json.loads(converted.stdout)
objects = data["objects"]
refs = re.findall(r"AA[0-9A-F]{22}", project.read_text())
assert all(ref in objects for ref in refs), "unresolved project object"
for obj in objects.values():
    if obj.get("isa") == "PBXFileReference" and obj.get("sourceTree") == "<group>":
        assert (root / "iOS" / obj["path"]).exists(), "missing source/resource"
package_refs = [obj for obj in objects.values() if obj.get("isa") == "XCLocalSwiftPackageReference"]
assert len(package_refs) == 2
assert {(root / "iOS" / ref["relativePath"] / "Package.swift").resolve() for ref in package_refs} == {
    root / "Package.swift", (root / "../mobile/native/AureliaYouTubeNative/Package.swift").resolve()
}
assert {obj["productName"] for obj in objects.values() if obj.get("isa") == "XCSwiftPackageProductDependency"} == {
    "AureliaAppleUI", "AureliaYouTubeNative"
}
scheme = ET.parse(root / "iOS/Aurelia.xcodeproj/xcshareddata/xcschemes/Aurelia.xcscheme")
assert scheme.find(".//CommandLineArgument").attrib == {"argument": "--force-muted", "isEnabled": "YES"}
for node in scheme.findall(".//BuildableReference"):
    assert node.attrib["BlueprintIdentifier"] in objects
with (root / "iOS/Info.plist").open("rb") as stream:
    info = plistlib.load(stream)
assert info["UIBackgroundModes"] == ["audio"]
assert set(info["UISupportedInterfaceOrientations~ipad"]) == {
    "UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown",
    "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight",
}
assert "NSAppTransportSecurity" not in info
contents = json.loads((root / "iOS/Assets.xcassets/AppIcon.appiconset/Contents.json").read_text())
assert (root / "iOS/Assets.xcassets/AppIcon.appiconset" / contents["images"][0]["filename"]).is_file()
print("PASS iOS project static wiring, resources, silent launch scheme (no iOS build)")
