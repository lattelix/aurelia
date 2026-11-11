#!/bin/sh
set -eu
task_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
repo_root=$(CDPATH= cd -- "$task_root/../.." && pwd)
export JAVA_HOME="$repo_root/.runtime/toolchains/jdk-21.0.13+9/Contents/Home"
export KONAN_DATA_DIR="$task_root/.cache/konan"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export JAVA_OPTS=-Xmx2g
compiler="$task_root/.cache/kotlin-native-prebuilt-macos-aarch64-2.4.21/bin/konanc"
target=${1:?target required}
case "$target" in macos_arm64|ios_arm64) ;; *) exit 2 ;; esac
mkdir -p "$task_root/build/$target"
"$compiler" -target "$target" -produce framework -Xstatic-framework -g \
  -Xbinary=bundleId=com.lattelix.aurelia.quack \
  -module-name AureliaQuack -o "$task_root/build/$target/AureliaQuack" \
  "$task_root"/vendor/quackjs/src/commonMain/kotlin/meow/nyx/quackjs/*.kt \
  "$task_root/src/QuackCipherBridge.kt"
