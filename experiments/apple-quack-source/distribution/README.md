# Apple runtime source build

This runtime-only source projection retains QuackJS **0.1.2**, exact commit
`5af5261d31e50b578e4c81434f6fce8dfd81db93`, its eight unchanged common Kotlin
runtime files, Aurelia's bridge, build/check scripts and license inputs.
It excludes upstream `commonTest`, real-player extracts, fixture manifests,
downloaded players and the later experimental variant. The original upstream
17-entry `SOURCE_MANIFEST.json` is retained verbatim as provenance; its excluded
entries are not claimed to be present or granted by this projection.

## Prerequisites

- An Apple Silicon Mac with full Xcode and its macOS/iPhoneOS SDKs installed and
  its license/first-launch setup completed. Command Line Tools alone are
  insufficient. Keep the selected Xcode, or set `DEVELOPER_DIR` to a chosen
  Xcode application's `Contents/Developer` directory; scripts do not change
  system selection.
- An externally installed **JDK 21**, with `JAVA_HOME` selecting that JDK's home.
  The build checks both Java's specification version and `javac`. No private
  repository toolchain cache is required or searched for a JDK.
- Python 3.12 or later for the standard-library source checks and archive
  extraction. The official Kotlin/Native **2.4.21** downloader verifies the
  release archive size/checksum into the ignored experiment `.cache` directory.
  Alternatively, `KONAN_HOME` may select an existing exact 2.4.21 compiler.
  `KONAN_DATA_DIR` defaults to the experiment's ignored cache.

Only `macos_arm64` and `ios_arm64` are supported here. There is no simulator or
Intel slice. Kotlin's compiler and SDK dependency bootstrap can require network
access and several GiB of space; source checks do not download or compile.

From the repository root, using a JDK 21 already installed on the machine:

```sh
export JAVA_HOME="$(/usr/libexec/java_home -v 21)"
python3 experiments/apple-quack-source/scripts/source-packaging.py --check-projection
python3 experiments/apple-quack-source/scripts/toolchain.py
sh experiments/apple-quack-source/scripts/build-runtime-framework.sh macos_arm64 --dry-run
sh experiments/apple-quack-source/scripts/build-runtime-framework.sh ios_arm64 --dry-run
sh experiments/apple-quack-source/scripts/build-runtime-framework.sh macos_arm64
sh experiments/apple-quack-source/scripts/build-runtime-framework.sh ios_arm64
sh experiments/apple-quack-source/scripts/check-swift.sh macos_arm64
sh experiments/apple-quack-source/scripts/check-swift.sh ios_arm64
sh experiments/apple-quack-source/scripts/package-xcframework.sh
```

The Swift checks use a local synthetic cipher program and never play media.
The device-target check compiles/links but does not run on a phone. These
commands do not build, sign or install the Aurelia application.

## Existing artifact pin and reviewed rebuilds

The original `scripts/build-framework.sh` is kept byte-identical solely as the
historical recipe input hashed by the existing artifact pin. It used a private
JDK cache; **use `build-runtime-framework.sh` for new builds**. Both the old
recipe and the new portable recipe are included in the packaging manifest.
Runtime/bridge bytes and the recorded framework/binary hashes are unchanged.
The public pin removes only the private receipt reference.

A different checkout/toolchain can produce different static-framework bytes,
including debug paths. Bit-identical rebuilding has not been established.
The strict artifact stager keeps its default **full 17-entry source check**;
the public source tree deliberately requires explicit `--source-scope runtime`.
It never accepts a changed binary hash or downloads a prebuilt binary.

For a clean rebuild, first emit a new candidate without changing the old pin or
staging any framework:

```sh
python3 apps/mobile/native/AureliaYouTubeNative/scripts/prepare-artifact.py \
  --source-scope runtime --candidate-pin quack-rebuild-candidate.json
```

The candidate validates the complete runtime/build/license closure, two platform
slices, interop headers/modules, actual `lipo` arm64 results and new tree/binary
hashes. It records the portable recipe and exact packaging manifest hash, with
`reviewStatus: pending`. Candidate generation does not prove which source a
binary was compiled from. Review the clean build/toolchain, synthetic interop
results and pin diff; record that review before manually changing the candidate
to `reviewStatus: approved`. An unreviewed candidate cannot stage. After review:

```sh
python3 apps/mobile/native/AureliaYouTubeNative/scripts/prepare-artifact.py \
  --source-scope runtime --pin quack-rebuild-candidate.json
```

This stages only the explicitly reviewed local framework for SwiftPM. It does
not replace the checked-in historical pin, publish a package or approve a
binary release. Clean rebuild/interop review and final application notice/source
packaging remain binary-release gates; no new artifact was built for this source
projection. The retained Kotlin license bundle is a conservative input closure,
not an assertion that every compiler dependency is linked into the framework.

## Source-only checks

```sh
python3 -B -m unittest discover -s experiments/apple-quack-source/scripts/tests
python3 experiments/apple-quack-source/scripts/source-packaging.py --check-runtime
```

`--check-full` continues to verify all original 17 entries in the private full
checkout and fails if its verification fixtures are absent. `--print-files`
emits the separately verified public runtime allowlist. Neither mode silently
falls back to the other. Preserve the accompanying [notices](THIRD_PARTY_NOTICES.md),
upstream license and retained Kotlin notice inputs with corresponding source.
