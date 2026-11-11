#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
configuration="${CONFIGURATION:-release}"
./scripts/swift-local.sh build -c "$configuration" -debug-info-format none --product AureliaMac
binary_dir="$(./scripts/swift-local.sh build -c "$configuration" --show-bin-path)"
# Quit Aurelia before packaging; process inspection is unavailable in this host.
app="$PWD/dist/Aurelia.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
# A prior coordinator-signed preview must not retain a stale resource seal.
if [ -d "$app/Contents/_CodeSignature" ]; then
    rm -rf "$app/Contents/_CodeSignature"
fi
cp "$binary_dir/AureliaMac" "$app/Contents/MacOS/Aurelia"
resource_bundle="$binary_dir/AureliaApple_AureliaAppleUI.bundle"
if [ ! -d "$resource_bundle" ]; then
    echo "Missing SwiftPM resource bundle" >&2
    exit 1
fi
if [ -d "$app/Contents/Resources/AureliaApple_AureliaAppleUI.bundle" ]; then
    rm -rf "$app/Contents/Resources/AureliaApple_AureliaAppleUI.bundle"
fi
cp -R "$resource_bundle" "$app/Contents/Resources/"
icon_source="$PWD/Sources/AureliaAppleUI/Resources/Art/aurelia-icon.png"
sips -s format icns "$icon_source" --out "$app/Contents/Resources/Aurelia.icns" >/dev/null
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Aurelia</string>
<key>CFBundleDisplayName</key><string>Aurelia</string>
<key>CFBundleIdentifier</key><string>com.lattelix.aurelia.native.mac</string>
<key>CFBundleExecutable</key><string>Aurelia</string>
<key>CFBundleIconFile</key><string>Aurelia</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSHumanReadableCopyright</key><string>Aurelia · Original Studio media CC0</string>
</dict></plist>
PLIST
plutil -lint "$app/Contents/Info.plist"
if [ "${ADHOC_SIGN:-0}" = "1" ]; then
    codesign --force --deep --sign - "$app"
    codesign --verify --deep --strict "$app"
fi
printf '%s\n' "$app"
printf '%s\n' 'Built only. No application or audio was launched.'
