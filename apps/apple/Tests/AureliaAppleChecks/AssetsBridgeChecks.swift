import Foundation
import ImageIO
import CoreGraphics
@testable import AureliaAppleUI
import AureliaCloud
import AureliaPlaybackCore

private enum AssetsBridgeFailure: Error { case assertion(String) }
private func requireAssetsBridge(_ value: @autoclosure () -> Bool, _ label: String) throws {
    if !value() { throw AssetsBridgeFailure.assertion(label) }
}
private func assetsBox(_ type: String, _ payload: Data) -> Data {
    let size = UInt32(payload.count + 8)
    return Data([UInt8((size >> 24) & 255), UInt8((size >> 16) & 255), UInt8((size >> 8) & 255), UInt8(size & 255)]) + Data(type.utf8) + payload
}
private func assetsMedia() -> Data {
    let ftyp = assetsBox("ftyp", Data("M4A ".utf8) + Data(repeating: 0, count: 4))
    var sample = Data(repeating: 0, count: 28); sample[7] = 1
    let stsd = assetsBox("stsd", Data([0, 0, 0, 0, 0, 0, 0, 1]) + assetsBox("mp4a", sample))
    let dref = assetsBox("dref", Data([0, 0, 0, 0, 0, 0, 0, 1]) + assetsBox("url ", Data([0, 0, 0, 1])))
    let minf = assetsBox("minf", assetsBox("dinf", dref) + assetsBox("stbl", stsd))
    return ftyp + assetsBox("moov", assetsBox("trak", assetsBox("mdia", minf))) + assetsBox("mdat", Data(repeating: 17, count: 32))
}
private struct AssetsMediaTransport: YouTubeHTTPTransport, PlaybackResolving {
    let bytes = assetsMedia()
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        let url = URL(string: "https://r1.googlevideo.com/videoplayback?id=assets-bridge&itag=140&clen=\(bytes.count)&expire=4000000000&lmt=1000&mime=audio%2Fmp4&source=youtube")!
        return try .youtube(lease: VerifiedYouTubeStreamLease(requestedVideoID: track.videoID, playerVideoID: track.videoID,
            itag: 140, mimeType: "audio/mp4; codecs=\"mp4a.40.2\"", contentLength: bytes.count, url: url,
            expiresAt: Date(timeIntervalSince1970: 4_000_000_000)))
    }
    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        guard let range = PartialMediaSample.requestedRange(request.value(forHTTPHeaderField: "Range")),
              range.upperBound < bytes.count, range.count <= maxBytes else { throw PlaybackFailure.invalidRequest }
        return .init(status: 206, headers: ["content-length": String(range.count), "content-type": "audio/mp4",
            "content-range": "bytes \(range.lowerBound)-\(range.upperBound)/\(bytes.count)"], body: Data(bytes[range]))
    }
}
private func assetsJPEG() throws -> Data {
    guard let context = CGContext(data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 32,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw AssetsBridgeFailure.assertion("JPEG context") }
    context.setFillColor(CGColor(red: 0.2, green: 0.3, blue: 0.6, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
    let data = NSMutableData()
    guard let image = context.makeImage(), let output = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else { throw AssetsBridgeFailure.assertion("JPEG output") }
    CGImageDestinationAddImage(output, image, nil)
    guard CGImageDestinationFinalize(output) else { throw AssetsBridgeFailure.assertion("JPEG finalize") }
    return data as Data
}
private actor AssetsCover: AudioExportCoverProviding {
    let bytes: Data?
    private var held: Bool
    private var pending: [CheckedContinuation<Void, Never>] = []
    private(set) var calls = 0
    private var active = 0
    private(set) var maximumActive = 0
    init(bytes: Data?, held: Bool = false) { self.bytes = bytes; self.held = held }
    func jpeg(forVideoID videoID: String) async throws -> Data? {
        guard videoID == "00000000001" else { throw AssetsBridgeFailure.assertion("canonical cover identity") }
        calls += 1; active += 1; maximumActive = max(maximumActive, active)
        defer { active -= 1 }
        // Deliberately ignore cancellation to exercise physical admission.
        if held { await withCheckedContinuation { pending.append($0) } }
        return bytes
    }
    func release() { held = false; let waiting = pending; pending = []; waiting.forEach { $0.resume() } }
}
private actor AssetsLyricsHTTP: CloudHTTPTransport {
    let response: Data
    private(set) var calls = 0
    init(response: Data) { self.response = response }
    func send(_ request: URLRequest, maxBytes: Int) async throws -> CloudHTTPResponse {
        guard request.url?.path == "/api/lyrics", request.value(forHTTPHeaderField: "Authorization") == nil,
              !request.httpShouldHandleCookies else { throw AssetsBridgeFailure.assertion("anonymous lyrics endpoint only") }
        calls += 1; return .init(status: 200, body: response)
    }
}
private func assetsHTTP(_ records: [[String: Any]]) throws -> AssetsLyricsHTTP {
    AssetsLyricsHTTP(response: try JSONSerialization.data(withJSONObject: records))
}
private func assetsLyrics(_ id: Int, text: String, title: String = "CAFE SIGNAL", artist: String = "synth e", duration: Double = 123) -> [String: Any] {
    ["id": id, "trackName": title, "artistName": artist, "albumName": "Fixture album", "duration": duration,
     "instrumental": false, "plainLyrics": text, "syncedLyrics": "[00:01.00]" + text]
}
@MainActor private final class AssetsUpdates { var count = 0 }
private struct AssetsFixture {
    let root: URL
    let engine: ManagedOfflineEngine
    let owner: OfflineOwnerScope
    let id: UUID
    let track: TrackDTO
    let playback: PlaybackTrack
}
@MainActor private func assetsFixture(ready: Bool = true) async throws -> AssetsFixture {
    let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("AureliaAssetsBridge-" + UUID().uuidString, isDirectory: true)
    let source = AssetsMediaTransport()
    let engine = try ManagedOfflineEngine(rootDirectory: root, resolver: source,
        policy: .init(budgetBytes: 16 * 1024 * 1024, reserveBytes: 0), transport: source, availableSpace: { _ in 100 * 1024 * 1024 })
    let owner = try OfflineOwnerScope(ownerID: "assets-bridge-owner")
    let track = try TrackDTO(id: "youtube:00000000001", title: "Café — Signal", artist: "SYNTH É", album: "Fixture album", provider: "youtube", externalId: "00000000001", duration: 120)
    let playback = try PlaybackTrack(videoID: track.externalId, title: track.title, artist: track.artist)
    try await engine.activateOwner(owner)
    let id = try await engine.enqueue(playback, owner: owner)
    if ready {
        try await engine.setEnvironment(foreground: true, onWiFi: true)
        try await waitAssetsBridge { try await engine.snapshot(owner: owner).items.first?.state == .ready }
    }
    return AssetsFixture(root: root, engine: engine, owner: owner, id: id, track: track, playback: playback)
}
@MainActor private func waitAssetsBridge(_ predicate: @MainActor () async throws -> Bool) async throws {
    for _ in 0..<400 { if try await predicate() { return }; try await Task.sleep(for: .milliseconds(5)) }
    throw AssetsBridgeFailure.assertion("assets bridge state deadline")
}
@MainActor private func assetsCoordinator(_ fixture: AssetsFixture, http: AssetsLyricsHTTP, cover: AssetsCover) -> OfflineAssetsCoordinator {
    let coordinator = OfflineAssetsCoordinator(engine: fixture.engine, music: CloudMusicStore(client: .init(transport: http)), cover: cover, selectedLyrics: { _ in nil })
    coordinator.activate(fixture.owner); coordinator.register([fixture.track])
    return coordinator
}

enum AssetsBridgeChecks {
    @MainActor static var cases: [(String, @MainActor () async throws -> Void)] {
        [("managed_assets_seed_metadata_and_stable_revision", metadata),
         ("managed_assets_auto_match_unique_or_ambiguous", matching),
         ("managed_assets_manual_choice_wins_and_survives_cold_enrichment", manualChoice),
         ("managed_assets_cancelled_physical_work_never_overlaps", physicalAdmission)]
    }
    @MainActor private static func metadata() async throws {
        let fixture = try await assetsFixture(ready: false)
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let http = try assetsHTTP([]), cover = AssetsCover(bytes: nil), coordinator = assetsCoordinator(fixture, http: http, cover: cover)
        defer { coordinator.stop() }
        let sparse = try TrackDTO(id: fixture.track.id, title: fixture.track.title, artist: fixture.track.artist,
            album: "", provider: "youtube", externalId: fixture.track.externalId, duration: 0)
        coordinator.register([sparse])
        let initial = try await fixture.engine.snapshot(owner: fixture.owner)
        let changed = await coordinator.seedMetadata(initial, owner: fixture.owner)
        let seeded = try await fixture.engine.snapshot(owner: fixture.owner)
        try requireAssetsBridge(changed && seeded.items[0].album == fixture.track.album && seeded.items[0].duration == 120 && seeded.items[0].state == .queued,
            "cloud metadata persists independently of audio readiness")
        let revision = seeded.items[0].assetsRevision
        let repeated = await coordinator.seedMetadata(seeded, owner: fixture.owner)
        let final = try await fixture.engine.snapshot(owner: fixture.owner)
        try requireAssetsBridge(!repeated && final.items[0].assetsRevision == revision, "unchanged metadata does not rewrite the payload CAS")
        let covers = await cover.calls, lyrics = await http.calls
        try requireAssetsBridge(covers == 0 && lyrics == 0, "metadata seeding never fetches optional assets")
        try await fixture.engine.activateOwner(nil)
    }
    @MainActor private static func matching() async throws {
        for ambiguous in [false, true] {
            let fixture = try await assetsFixture(); defer { try? FileManager.default.removeItem(at: fixture.root) }
            var candidates = [assetsLyrics(1, text: "Exact unique text"), assetsLyrics(3, text: "Wrong artist", artist: "Other"),
                assetsLyrics(4, text: "Wrong version", title: "Cafe Signal live"), assetsLyrics(5, text: "Wrong duration", duration: 123.01)]
            if ambiguous { candidates.append(assetsLyrics(2, text: "Second exact candidate", duration: 120)) }
            let http = try assetsHTTP(candidates), cover = AssetsCover(bytes: try assetsJPEG()), coordinator = assetsCoordinator(fixture, http: http, cover: cover)
            defer { coordinator.stop() }
            _ = await coordinator.seedMetadata(try await fixture.engine.snapshot(owner: fixture.owner), owner: fixture.owner)
            coordinator.enrich(try await fixture.engine.snapshot(owner: fixture.owner), owner: fixture.owner, allowNetwork: true)
            try await waitAssetsBridge { try await fixture.engine.readAssets(fixture.id, owner: fixture.owner)?.payload.isEnriched == true }
            let stored = try await fixture.engine.readAssets(fixture.id, owner: fixture.owner)
            try requireAssetsBridge(stored?.payload.coverJPEG != nil && stored?.payload.album == fixture.track.album, "optional JPEG and metadata persist")
            try requireAssetsBridge(ambiguous ? stored?.payload.plainLyrics == nil : stored?.payload.plainLyrics == "Exact unique text",
                "only one exact normalized artist/title within three seconds can be automatically selected")
            let requests = await http.calls
            try requireAssetsBridge(requests == 1, "one bounded lyrics query per enrichment")
            try await fixture.engine.activateOwner(nil)
        }
    }
    @MainActor private static func manualChoice() async throws {
        let fixture = try await assetsFixture(); defer { try? FileManager.default.removeItem(at: fixture.root) }
        let http = try assetsHTTP([assetsLyrics(1, text: "Automatic candidate")]), cover = AssetsCover(bytes: try assetsJPEG(), held: true)
        let coordinator = assetsCoordinator(fixture, http: http, cover: cover), updates = AssetsUpdates()
        coordinator.onUpdate = { updates.count += 1 }
        defer { coordinator.stop(); Task { await cover.release() } }
        _ = await coordinator.seedMetadata(try await fixture.engine.snapshot(owner: fixture.owner), owner: fixture.owner)
        coordinator.enrich(try await fixture.engine.snapshot(owner: fixture.owner), owner: fixture.owner, allowNetwork: true)
        try await waitAssetsBridge { await cover.calls == 1 }
        let selected = try JSONDecoder().decode(LyricsDTO.self, from: JSONSerialization.data(withJSONObject: assetsLyrics(77, text: "User-selected version")))
        let saved = await coordinator.storeLyrics(selected, trackID: fixture.track.id, snapshot: try await fixture.engine.snapshot(owner: fixture.owner), owner: fixture.owner)
        try requireAssetsBridge(saved, "manual selection saves while an older cover request is held")
        let selectedRevision = try await fixture.engine.readAssets(fixture.id, owner: fixture.owner)?.revision
        await cover.release()
        try await waitAssetsBridge { updates.count >= 2 }
        let afterLate = try await fixture.engine.readAssets(fixture.id, owner: fixture.owner)
        try requireAssetsBridge(afterLate?.payload.plainLyrics == "User-selected version" && afterLate?.revision == selectedRevision,
            "automatic late response loses CAS without replacing the manual choice")
        coordinator.stop()
        let coldHTTP = try assetsHTTP([assetsLyrics(1, text: "Must never replace manual text")]), coldCover = AssetsCover(bytes: try assetsJPEG())
        let cold = assetsCoordinator(fixture, http: coldHTTP, cover: coldCover)
        defer { cold.stop() }
        cold.enrich(try await fixture.engine.snapshot(owner: fixture.owner), owner: fixture.owner, allowNetwork: true)
        try await waitAssetsBridge { try await fixture.engine.readAssets(fixture.id, owner: fixture.owner)?.payload.isEnriched == true }
        let restored = try await fixture.engine.readAssets(fixture.id, owner: fixture.owner), coldLyricsCalls = await coldHTTP.calls
        try requireAssetsBridge(restored?.payload.plainLyrics == "User-selected version" && restored?.payload.coverJPEG != nil && coldLyricsCalls == 0,
            "cold cover enrichment preserves managed text even after the separate small cache is missing")
        cold.stop(); try await fixture.engine.activateOwner(nil)
        let source = AssetsMediaTransport()
        let reopened = try ManagedOfflineEngine(rootDirectory: fixture.root, resolver: source,
            policy: .init(budgetBytes: 16 * 1024 * 1024, reserveBytes: 0), transport: source, availableSpace: { _ in 100 * 1024 * 1024 })
        let reopenedOwner = try OfflineOwnerScope(ownerID: fixture.owner.ownerID)
        try await reopened.activateOwner(reopenedOwner)
        let reopenedSnapshot = try await reopened.snapshot(owner: reopenedOwner)
        try requireAssetsBridge(reopenedSnapshot.items.first?.assetsEnriched == true, "enrichment marker survives a cold native-index activation")
        let reopenedFixture = AssetsFixture(root: fixture.root, engine: reopened, owner: reopenedOwner,
            id: fixture.id, track: fixture.track, playback: fixture.playback)
        let persisted = assetsCoordinator(reopenedFixture, http: coldHTTP, cover: coldCover)
        defer { persisted.stop() }
        let coversBefore = await coldCover.calls
        persisted.enrich(reopenedSnapshot, owner: reopenedOwner, allowNetwork: true)
        for _ in 0..<20 { await Task.yield() }
        let coversAfter = await coldCover.calls, lyricsAfter = await coldHTTP.calls
        try requireAssetsBridge(coversAfter == coversBefore && lyricsAfter == 0, "persisted enrichment marker skips network on a new coordinator")
        try await reopened.activateOwner(nil)
    }
    @MainActor private static func physicalAdmission() async throws {
        for changeOwner in [false, true] {
            let fixture = try await assetsFixture(); defer { try? FileManager.default.removeItem(at: fixture.root) }
            let http = try assetsHTTP([]), cover = AssetsCover(bytes: try assetsJPEG(), held: true), coordinator = assetsCoordinator(fixture, http: http, cover: cover)
            let updates = AssetsUpdates(); coordinator.onUpdate = { updates.count += 1 }
            defer { coordinator.stop(); Task { await cover.release() } }
            _ = await coordinator.seedMetadata(try await fixture.engine.snapshot(owner: fixture.owner), owner: fixture.owner)
            coordinator.enrich(try await fixture.engine.snapshot(owner: fixture.owner), owner: fixture.owner, allowNetwork: true)
            try await waitAssetsBridge { await cover.calls == 1 }
            var owner = fixture.owner, id = fixture.id
            if changeOwner {
                coordinator.activate(nil); try await fixture.engine.activateOwner(nil)
                owner = try OfflineOwnerScope(ownerID: "assets-new-owner")
                try await fixture.engine.activateOwner(owner)
                id = try await fixture.engine.enqueue(fixture.playback, owner: owner)
                try await waitAssetsBridge { try await fixture.engine.snapshot(owner: owner).items.first?.state == .ready }
                coordinator.activate(owner); coordinator.register([fixture.track])
                _ = await coordinator.seedMetadata(try await fixture.engine.snapshot(owner: owner), owner: owner)
            } else { coordinator.stop() }
            coordinator.enrich(try await fixture.engine.snapshot(owner: owner), owner: owner, allowNetwork: true)
            for _ in 0..<20 { await Task.yield() }
            let heldCalls = await cover.calls
            try requireAssetsBridge(heldCalls == 1, "cancelled physical request retains its admission slot until it actually returns")
            await cover.release()
            try await waitAssetsBridge { updates.count >= 1 }
            let notCommitted = try await fixture.engine.readAssets(id, owner: owner)
            try requireAssetsBridge(notCommitted?.payload.isEnriched != true && notCommitted?.payload.coverJPEG == nil,
                "owner/background generation change discards cancellation-ignoring late cover")
            coordinator.enrich(try await fixture.engine.snapshot(owner: owner), owner: owner, allowNetwork: true)
            try await waitAssetsBridge { try await fixture.engine.readAssets(id, owner: owner)?.payload.isEnriched == true }
            let finalCalls = await cover.calls, maximum = await cover.maximumActive
            try requireAssetsBridge(finalCalls == 2 && maximum == 1, "new generation starts only after old physical work releases")
            try await fixture.engine.activateOwner(nil)
        }
    }
}
