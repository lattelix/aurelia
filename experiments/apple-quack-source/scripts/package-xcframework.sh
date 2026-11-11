#!/bin/sh
set -eu
task_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
export DEVELOPER_DIR="${DEVELOPER_DIR:-$(xcode-select -p)}"
xcrun xcodebuild -create-xcframework \
  -framework "$task_root/build/macos_arm64/AureliaQuack.framework" \
  -framework "$task_root/build/ios_arm64/AureliaQuack.framework" \
  -output "$task_root/build/AureliaQuack.xcframework"
