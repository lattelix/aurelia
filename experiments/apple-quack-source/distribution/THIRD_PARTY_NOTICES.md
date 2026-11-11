# Runtime source projection notices

- QuackJS 0.1.2, commit `5af5261d31e50b578e4c81434f6fce8dfd81db93`, is
  GPL-3.0-only. Retain `../vendor/quackjs/LICENSE`, upstream README/notices,
  referenced Apache-2.0 and MIT texts and the unchanged source manifest.
  The eight common runtime sources are verbatim. Aurelia's separate bridge and
  portable build recipe are identified in `RUNTIME_SOURCE_MANIFEST.json`.
- Upstream real-player extracts, full players, `commonTest` and fixture data are
  excluded. Upstream notices identify component grants and do not grant a
  blanket license to a whole YouTube player. Their reference to private upstream
  fixtures does not add those files to this runtime-only source projection.
- Kotlin/Native 2.4.21 supplies the compiler and linked native runtime. Its
  complete retained 69-file license input bundle is included under
  `../licenses/KotlinNative-2.4.21/`, including JetBrains LICENSE/NOTICE and
  third-party texts. This conservative source input bundle is not an exact
  inventory of linked runtime components or the final app's dependencies.
- Xcode and JDK 21 are external build prerequisites, not vendored SDK/toolchain
  binaries. Their installation and applicable terms remain separate inputs.

The application/first-party grant is defined at the public source root. This
document preserves upstream grants; it does not change the private repository's
license or authorize binary distribution. A binary release still needs its
reviewed artifact pin, actual dependency/notice inventory and matching source
and build/install information in the distributed package.
