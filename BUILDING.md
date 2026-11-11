# Building the source candidate

Read `SOURCE_STATUS.json` before building. An incomplete candidate may lack
native inputs and is not advertised as a complete buildable release. The
commands below are build recipes, not claims that this snapshot passed them.
Use synthetic accounts and the original Studio fixtures for local checks.

## Web and shared TypeScript packages

Use Node 24.15 or later within Node 24, npm, and a supported local C/C++ toolchain
where required by installed packages. The root npm lockfile is authoritative.

```sh
npm ci
npm run verify
```

For a local UI with the included original Studio catalogue:

```sh
STUDIO_DEMO=true npm run dev --workspace @aurelia/web -- --hostname 127.0.0.1
```

The default database is process-local disk-backed PGlite. Production hosting
requires PostgreSQL through `DATABASE_URL`; PGlite is not persistent storage on
a serverless host. The startup script reads optional `apps/web/.env.local`.
`configuration.example` lists non-secret local settings. Export environment
variables or create your own ignored local configuration. No existing account,
provider registrations or service credentials are supplied.

After a production build, `npm start` starts the web server. For browser checks,
start a separate loopback server and run `npm run test:e2e`. Browser binaries
must be installed explicitly with the repository's Playwright version. The
tests use synthetic metadata, routes and accounts. Never point the test runner
at an unrelated personal or production library.

The optional `scripts/media-gateway.ts` is a self-host media transport. It needs
its own reviewed network, origin, token and availability configuration. Provider
credentials, gateway endpoints and a managed host are not supplied by this
source package. Guest verification is off for local development; an exposed
service needs a separately configured server verification policy.

## Android

Android uses Java 21, Android SDK 37 for compilation, the checked Gradle 9.4.1
wrapper and declared AGP/Kotlin versions. SDK installation and license
acceptance are explicit prerequisites. An `ANDROID_SDK_ROOT` belongs to the
builder's environment; no SDK, local.properties or signing material is shipped.

The bundled shared interface is built from
`experiments/mobile-bundle-probe/build.mjs`, its source adapters and the shared
web code. Its pinned esbuild dependency must be installed explicitly in that
directory before invoking the build script:

```sh
npm install --prefix experiments/mobile-bundle-probe --ignore-scripts
node experiments/mobile-bundle-probe/build.mjs --public-metadata
node --import tsx experiments/mobile-bundle-probe/prepare-android.mjs \
  --sdk "$ANDROID_SDK_ROOT" --profile-preview --output source-check-android
```

The generated isolated Android project is a local build output, not part of
this source snapshot. Follow its declared Gradle inputs for compilation.
InnerTubeX/Quack source and transitive dependency verification remain explicit
release gates. A successful TypeScript bundle is not an APK acceptance test.
Signing, installation and playback are separate checks.

## Standalone Apple client

Use macOS, a compatible full Xcode installation with the macOS/iOS SDKs,
Swift 6 and an externally supplied Java 21 `JAVA_HOME`. The existing Quack
recipe supports macOS arm64 and iOS arm64. Simulator, Intel and bit-identical
cross-machine rebuilds are not established.

The runtime-only Quack source manifest and its build recipe are required before
building `AureliaYouTubeNative`. Do not download or substitute an unpinned
XCFramework to bypass a missing source/artifact gate. Follow the runtime
projection's own instructions, then the consumer's `prepare-artifact.py` with
its explicit runtime source scope. The original full-source fixture integrity
check is separate and must not be represented as passed by the runtime check.

The included public Apple PNG resources are generated from the included CC0
SVGs. To reproduce them in an isolated directory within the public checkout:

```sh
node apps/apple/scripts/generate-artwork.mjs --output-root .runtime/artwork-check
```

These are newly generated public derivatives, not a claim of byte identity with
the artwork in an earlier private app. The asset inventory names each original
and recipe. After the framework and resources are present, `apps/apple/scripts/check.sh`
runs the local Apple/Cloud checks, and `scripts/package-mac.sh` from that package
builds the Mac app. Its app packaging currently needs final notices/source
verification before distribution. Open `apps/apple/iOS/Aurelia.xcodeproj` for
an iPhone build and select your own signing team. The public project deliberately
contains no development-team assignment. No store approval or installer release
is implied by compilation.
