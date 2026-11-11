#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/swift-local.sh run AureliaAppleChecks
./scripts/swift-local.sh run AureliaCloudChecks
plutil -lint iOS/Info.plist iOS/Aurelia.xcodeproj/project.pbxproj
python3 -B scripts/validate-ios-project.py
