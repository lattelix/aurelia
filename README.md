# Aurelia

Aurelia contains a Next.js music interface and API, a shared Capacitor Android
interface with a Media3 audio service, and a separate SwiftUI/AVPlayer client for
iPhone and macOS. The code implements search and catalogue browsing, likes,
playlists, queues, account linking, metadata import/export and lyrics. The Apple
client also implements managed offline storage and explicit local-file access.

This directory is a source candidate, not a published application release.
Implementation does not establish that every provider, recording, device or
background scenario works. No APK, IPA, signed Mac app, credentials, user library
or downloaded catalogue media is included. Native dependency closure, cleared
resources, clean-checkout builds and binary distribution checks remain separate
gates in [SOURCE_STATUS.json](SOURCE_STATUS.json).

The web player and Capacitor client share TypeScript code. The standalone Apple
client has a separate UI and playback implementation. Spotify is a metadata
import source; it is not an audio transport. YouTube and lyrics are third-party
services whose availability and terms are independent of this source license.
The included Studio recordings and artwork have their own CC0 grant.

Start with [BUILDING.md](BUILDING.md). The public source grant and its boundaries
are in [LICENSE](LICENSE) and [LICENSE-BOUNDARIES.md](LICENSE-BOUNDARIES.md).
Preserve [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the individual
upstream grants. Dependencies do not all use the same license.

Source snapshots are identified by `SOURCE_MANIFEST.json`: it records every
included path, size and SHA-256. It contains no private repository history.
The manifest is an integrity inventory, not proof of a reproducible build or
clearance to distribute a linked native binary.
