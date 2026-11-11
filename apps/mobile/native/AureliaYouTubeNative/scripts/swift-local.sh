#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CLANG_MODULE_CACHE_PATH="$PWD/.build/clang-cache"
export SWIFT_MODULECACHE_PATH="$PWD/.build/swift-cache"
command_name="${1:-build}"
if [ "$#" -gt 0 ]; then shift; fi
exec swift "$command_name" --disable-sandbox --cache-path .build/cache \
    --config-path .build/config --security-path .build/security -j 2 "$@"
