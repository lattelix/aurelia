#!/bin/sh
set -eu
task_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
export DEVELOPER_DIR="${DEVELOPER_DIR:-$(xcode-select -p)}"
target=${1:?target required}
case "$target" in
  macos_arm64) sdk=macosx; triple=arm64-apple-macos14.0 ;;
  ios_arm64) sdk=iphoneos; triple=arm64-apple-ios17.0 ;;
  *) exit 2 ;;
esac
sdk_path=$(xcrun --sdk "$sdk" --show-sdk-path)
mkdir -p "$task_root/build/swift-module-cache"
xcrun --sdk "$sdk" swiftc -swift-version 6 -sdk "$sdk_path" -target "$triple" \
  -module-cache-path "$task_root/build/swift-module-cache" \
  -F "$task_root/build/$target" -framework AureliaQuack -lc++ \
  "$task_root/checks/main.swift" -o "$task_root/build/$target/swift-interop-check"
if [ "$target" = macos_arm64 ]; then
  "$task_root/build/$target/swift-interop-check"
fi
