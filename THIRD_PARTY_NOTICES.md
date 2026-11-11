# Third-party notices

First-party source in this projection is covered by `LICENSE` within the scope
set out in `LICENSE-BOUNDARIES.md`. Separate upstream grants remain in force;
the application grant does not replace them. This is a source inventory, not a
complete inventory of a future installed server, APK, app or framework.

## JavaScript and web runtime

The npm lockfile records the exact dependency graph. Next.js, React, Capacitor,
YouTube.js, QuickJS Emscripten/QuickJS, BgUtils, jsdom, pg, openid-client, Zod and
much of the tooling use permissive licenses. Lucide uses ISC. PGlite uses
Apache-2.0 and embeds PostgreSQL under the PostgreSQL license. Preserve the
actual license and notice files distributed with each installed dependency.

Sharp uses Apache-2.0; its platform libvips packages include LGPL-3.0-or-later
components. Other transitive packages include OFL fonts, CC-BY data and MPL
development tooling. Do not describe a built bundle as wholly MIT or GPL solely
because the first-party application has one license. A binary/container release
needs a separate inventory of the dependencies actually distributed.

DM Sans and Manrope are bundled through Fontsource under SIL Open Font License
1.1. Their retained texts are in `apps/web/public/licenses`.

## Native source dependencies

Android's `youtube-source` module declares InnerTubeX v0.11.2 at upstream commit
`c863ddf15be01a1abfa4630329bdc0a1e95f1531`, under its upstream GPL grant, and
QuackJS 0.1.2. Exact resolved Android artifacts, their transitive dependencies,
source correspondence and complete notices still require verification. A Gradle
coordinate or a local cache is not a corresponding-source bundle.

The standalone Apple adapter links QuackJS 0.1.2 from upstream commit
`5af5261d31e50b578e4c81434f6fce8dfd81db93`, whose grant is GPL-3.0-only.
The runtime projection retains its upstream copyright, GPL and notice files,
local bridge, source manifest and build scripts. Its runtime-only policy excludes
uncleared upstream player extracts and test fixtures; it does not grant rights
to those omitted files. The Kotlin/Native license bundle retains JetBrains'
Apache-2.0 LICENSE/NOTICE and upstream third-party texts. The exact linked runtime
inventory must still be checked for each distributed framework.

Gradle's wrapper and downloaded distribution have their own upstream license
and notices. Wrapper integrity and a distribution checksum do not establish
Android dependency provenance. Apple/Android SDKs, compilers and their caches
are prerequisites, not included source artifacts.

## Original assets and provider content

The original generated Studio audio and artwork explicitly listed in
`ASSET_PROVENANCE.json` retain the separate CC0-1.0 grant. Exact duplicate Studio
MP3s and native derivatives are included only with their recorded source mapping.
The public Apple PNG resources are new derivatives generated from the included
CC0 SVGs by `apps/apple/scripts/generate-artwork.mjs`. Their exact hashes and
original/recipe mappings are recorded in the asset inventory. Earlier private
PNG resources are not copied. Correspondence to an existing private binary or
a newly built native artifact remains a separate gate.

No sampled commercial recording, downloaded library, catalogue cover or lyric
is included by this grant. YouTube, Spotify, LRCLIB and identity providers have
their own service and content terms. Access to source code does not authorize
media redistribution or provide service credentials.
