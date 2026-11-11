import Foundation
import AureliaPlaybackCore
import ImageIO

private enum OfflineCheckFailure: Error { case assertion }
private func offlineRequire(_ condition: @autoclosure () throws -> Bool, line: UInt = #line) throws {
    guard try condition() else { print("Offline assertion at line \(line)"); throw OfflineCheckFailure.assertion }
}
private func offlineBox(_ kind: String, _ payload: Data) -> Data {
    let size = UInt32(payload.count + 8)
    return Data([UInt8((size >> 24) & 255), UInt8((size >> 16) & 255), UInt8((size >> 8) & 255), UInt8(size & 255)])
        + Data(kind.utf8) + payload
}
private func offlineFixtureMedia() -> Data {
    let ftyp = offlineBox("ftyp", Data("M4A ".utf8) + Data(repeating: 0, count: 4))
    var sample = Data(repeating: 0, count: 28); sample[7] = 1
    let stsd = offlineBox("stsd", Data([0, 0, 0, 0, 0, 0, 0, 1]) + offlineBox("mp4a", sample))
    let dref = offlineBox("dref", Data([0, 0, 0, 0, 0, 0, 0, 1]) + offlineBox("url ", Data([0, 0, 0, 1])))
    let minf = offlineBox("minf", offlineBox("dinf", dref) + offlineBox("stbl", stsd))
    let moov = offlineBox("moov", offlineBox("trak", offlineBox("mdia", minf)))
    return ftyp + moov + offlineBox("mdat", Data(repeating: 17, count: 700_000))
}
private actor OfflineFixtureResolver: PlaybackResolving {
    let length: Int
    var calls = 0
    var recording = 1
    init(length: Int) { self.length = length }
    func changeRecording() { recording += 1 }
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        calls += 1
        let url = URL(string: "https://r1.googlevideo.com/videoplayback?id=fixture-\(recording)&itag=140&clen=\(length)&expire=4000000000&lmt=1000&mime=audio%2Fmp4&source=youtube&sig=fixture-signing-material")!
        return try ResolvedAudio.youtube(lease: VerifiedYouTubeStreamLease(
            requestedVideoID: track.videoID, playerVideoID: track.videoID, itag: 140,
            mimeType: "audio/mp4; codecs=\"mp4a.40.2\"", contentLength: length,
            url: url, expiresAt: Date(timeIntervalSince1970: 4_000_000_000)))
    }
}
private actor OfflineFixtureHTTP: YouTubeHTTPTransport {
    let media: Data
    var failAfterFirst = false
    var wrongRange = false
    var ranges: [ClosedRange<Int>] = []
    init(_ media: Data) { self.media = media }
    func configure(failAfterFirst: Bool = false, wrongRange: Bool = false) {
        self.failAfterFirst = failAfterFirst; self.wrongRange = wrongRange
    }
    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        guard let range = PartialMediaSample.requestedRange(request.value(forHTTPHeaderField: "Range")),
              maxBytes == range.count, range.upperBound < media.count else { throw OfflineCheckFailure.assertion }
        ranges.append(range)
        if failAfterFirst && range.lowerBound > 0 { throw PlaybackFailure.network }
        return BoundedHTTPResponse(status: 206, headers: [
            "content-length": String(range.count), "content-type": "audio/mp4",
            "content-range": "bytes \(range.lowerBound + (wrongRange ? 1 : 0))-\(range.upperBound)/\(media.count)"
        ], body: Data(media[range]))
    }
}
private func offlineRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
        .appendingPathComponent("aurelia-offline-check-" + UUID().uuidString, isDirectory: true)
    return root
}
private func offlineTrack(_ video: String = "00000000001") throws -> PlaybackTrack {
    try PlaybackTrack(videoID: video, title: "Offline fixture", artist: "Fixture")
}
private func offlineWait(_ engine: ManagedOfflineEngine, owner: OfflineOwnerScope,
                         state: OfflineState, id: UUID? = nil) async throws -> OfflineItemSnapshot {
    for _ in 0..<300 {
        if let item = try await engine.snapshot(owner: owner).items.first(where: { id == nil || $0.id == id }), item.state == state { return item }
        try await Task.sleep(for: .milliseconds(10))
    }
    let items = try await engine.snapshot(owner: owner).items
    print("Offline state timeout: \(items.map { "\($0.state.rawValue):\($0.failure?.rawValue ?? "none"):\($0.receivedBytes)" }.joined(separator: ","))")
    throw OfflineCheckFailure.assertion
}

func checkOfflineIntegrityOwnerAndPrivacy() async throws {
    let root = try offlineRoot(); defer { try? FileManager.default.removeItem(at: root) }
    let bytes = offlineFixtureMedia(), resolver = OfflineFixtureResolver(length: offlineFixtureMedia().count)
    let http = OfflineFixtureHTTP(bytes)
    let engine = try ManagedOfflineEngine(rootDirectory: root, resolver: resolver,
        policy: OfflineStoragePolicy(budgetBytes: 16 * 1024 * 1024, reserveBytes: 0),
        transport: http, availableSpace: { _ in 100 * 1024 * 1024 })
    let owner = try OfflineOwnerScope(ownerID: "owner-A-must-not-be-persisted")
    try await engine.activateOwner(owner); try await engine.setEnvironment(foreground: true, onWiFi: true)
    let track = try offlineTrack(), id = try await engine.enqueue(track, owner: owner)
    let ready = try await offlineWait(engine, owner: owner, state: .ready)
    try offlineRequire(ready.receivedBytes == bytes.count && ready.totalBytes == bytes.count)
    var copy: OfflineLocalCopy? = try await engine.openReady(track, owner: owner)
    try offlineRequire(copy!.isValid && copy!.url.pathExtension == "m4a")
    var audio: ResolvedAudio? = try ResolvedAudio.offline(copy!)
    try offlineRequire(audio!.isPlayable && audio!.isOffline && audio!.offlineVideoID == track.videoID && audio!.youtubeLease == nil)
    var removeFailure: OfflineFailure?
    do { try await engine.remove(id, owner: owner) } catch { removeFailure = error as? OfflineFailure }
    try offlineRequire(removeFailure == .inUse)
    let owners = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
    let persisted = try Data(contentsOf: owners[0].appendingPathComponent("index.json"))
    let text = String(decoding: persisted, as: UTF8.self)
    for forbidden in ["googlevideo", "videoplayback", "fixture-signing-material", "expire=", owner.ownerID] {
        try offlineRequire(!text.contains(forbidden))
    }
    let other = try OfflineOwnerScope(ownerID: "owner-B")
    try await engine.activateOwner(other)
    let otherSnapshot = try await engine.snapshot(owner: other)
    try offlineRequire(otherSnapshot.items.isEmpty && !copy!.isValid && !audio!.isPlayable)
    var stale: OfflineFailure?
    do { _ = try await engine.snapshot(owner: owner) } catch { stale = error as? OfflineFailure }
    try offlineRequire(stale == .staleOwner)
    let restored = try OfflineOwnerScope(ownerID: owner.ownerID)
    try await engine.activateOwner(restored)
    let restoredSnapshot = try await engine.snapshot(owner: restored)
    try offlineRequire(restoredSnapshot.items.first?.state == .ready)
    audio = nil; copy = nil
    var reopened: OfflineLocalCopy? = try await engine.openReady(track, owner: restored)
    let local = reopened!.url; reopened = nil
    let handle = try FileHandle(forWritingTo: local)
    try handle.seek(toOffset: UInt64(bytes.count - 1)); try handle.write(contentsOf: Data([99])); try handle.close()
    var corruption: OfflineFailure?
    do { _ = try await engine.openReady(track, owner: restored) } catch { corruption = error as? OfflineFailure }
    try offlineRequire(corruption == .corrupt)
    let calls = await resolver.calls; try offlineRequire(calls == 1)
    try await engine.activateOwner(nil)
}

func checkOfflineResumeIdentityAndRangeGuard() async throws {
    let root = try offlineRoot(); defer { try? FileManager.default.removeItem(at: root) }
    let bytes = offlineFixtureMedia(), resolver = OfflineFixtureResolver(length: offlineFixtureMedia().count)
    let http = OfflineFixtureHTTP(bytes); await http.configure(failAfterFirst: true)
    let engine = try ManagedOfflineEngine(rootDirectory: root, resolver: resolver,
        policy: OfflineStoragePolicy(budgetBytes: 16 * 1024 * 1024, reserveBytes: 0),
        transport: http, availableSpace: { _ in 100 * 1024 * 1024 })
    let owner = try OfflineOwnerScope(ownerID: "resume-owner"), track = try offlineTrack()
    try await engine.activateOwner(owner); try await engine.setEnvironment(foreground: true, onWiFi: true)
    let id = try await engine.enqueue(track, owner: owner)
    let failed = try await offlineWait(engine, owner: owner, state: .failed)
    try offlineRequire(failed.failure == .network && failed.receivedBytes == GuardedYouTubeByteSource.maximumChunkBytes)
    let owners = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
    let partial = owners[0].appendingPathComponent(id.uuidString.lowercased() + ".partial")
    // A process dying after a write but before its metadata checkpoint leaves
    // an uncommitted tail. Resume validates the prefix and discards that tail.
    let handle = try FileHandle(forWritingTo: partial)
    try handle.seekToEnd(); try handle.write(contentsOf: Data([9, 9, 9])); try handle.close()
    await http.configure(); try await engine.resume(id, owner: owner)
    _ = try await offlineWait(engine, owner: owner, state: .ready)
    let ranges = await http.ranges
    try offlineRequire(ranges.count == 4 && ranges[2].lowerBound == GuardedYouTubeByteSource.maximumChunkBytes)
    await http.configure(failAfterFirst: true)
    try await engine.restart(id, owner: owner)
    _ = try await offlineWait(engine, owner: owner, state: .failed)
    await resolver.changeRecording(); await http.configure()
    try await engine.resume(id, owner: owner)
    let changed = try await offlineWait(engine, owner: owner, state: .failed)
    try offlineRequire(changed.failure == .identityChanged && changed.receivedBytes == GuardedYouTubeByteSource.maximumChunkBytes)
    try await engine.restart(id, owner: owner)
    _ = try await offlineWait(engine, owner: owner, state: .ready)
    try await engine.remove(id, owner: owner)
    await http.configure(wrongRange: true)
    _ = try await engine.enqueue(track, owner: owner)
    let invalid = try await offlineWait(engine, owner: owner, state: .failed)
    try offlineRequire(invalid.receivedBytes == 0 && invalid.state != .ready)
    try await engine.activateOwner(nil)
}

func checkOfflineScopesAndStorageAdmission() async throws {
    let root = try offlineRoot(); defer { try? FileManager.default.removeItem(at: root) }
    let resolver = OfflineFixtureResolver(length: offlineFixtureMedia().count)
    let engine = try ManagedOfflineEngine(rootDirectory: root, resolver: resolver,
        policy: OfflineStoragePolicy(budgetBytes: 16 * 1024 * 1024, reserveBytes: 0),
        transport: OfflineFixtureHTTP(offlineFixtureMedia()), availableSpace: { _ in 0 })
    let owner = try OfflineOwnerScope(ownerID: "scoped-owner"), track = try offlineTrack()
    try await engine.activateOwner(owner)
    let collections = OfflineCollectionSnapshot(library: [track], likes: [track], playlists: ["one": [track], "two": [track]])
    let settings = OfflineSyncSettings(enabled: true, scope: .playlists, playlistIDs: ["one", "two"])
    try await engine.reconcile(settings: settings, collections: collections, owner: owner)
    let selected = try await engine.snapshot(owner: owner)
    try offlineRequire(selected.items.count == 1 && selected.items[0].selectedScopes.count == 2 && !selected.items[0].manual)
    try await engine.setEnvironment(foreground: true, onWiFi: false)
    let callsBefore = await resolver.calls; try offlineRequire(callsBefore == 0)
    try await engine.setEnvironment(foreground: true, onWiFi: true)
    let space = try await offlineWait(engine, owner: owner, state: .failed)
    try offlineRequire(space.failure == .insufficientSpace && space.receivedBytes == 0)
    // The audio would fit, but an atomic index replacement also needs its
    // bounded 2 MiB headroom. It cannot consume the owner's free-space reserve.
    try await engine.setPolicy(OfflineStoragePolicy(budgetBytes: 1024 * 1024, reserveBytes: 0), owner: owner)
    try await engine.resume(selected.items[0].id, owner: owner)
    let budget = try await offlineWait(engine, owner: owner, state: .failed)
    try offlineRequire(budget.failure == .storageLimit && budget.receivedBytes == 0)
    try await engine.remove(selected.items[0].id, owner: owner)
    try await engine.reconcile(settings: settings, collections: collections, owner: owner)
    let suppressed = try await engine.snapshot(owner: owner); try offlineRequire(suppressed.items.isEmpty)
    let empty = OfflineCollectionSnapshot(library: [], likes: [], playlists: [:])
    try await engine.reconcile(settings: settings, collections: empty, owner: owner)
    try await engine.reconcile(settings: settings, collections: collections, owner: owner)
    _ = try await offlineWait(engine, owner: owner, state: .failed)
    try await engine.reconcile(settings: OfflineSyncSettings(), collections: collections, owner: owner)
    let disabled = try await engine.snapshot(owner: owner)
    try offlineRequire(disabled.items.count == 1 && disabled.items[0].state == .failed && disabled.items[0].selectedScopes.isEmpty)
    try await engine.activateOwner(nil)
}

private final class OfflineTransitionClock: @unchecked Sendable {
    private let lock = NSLock()
    private var time = Date(timeIntervalSince1970: 2_000_000_000)
    func now() -> Date { lock.lock(); defer { lock.unlock() }; return time }
    func expireStream() { lock.lock(); time = Date(timeIntervalSince1970: 4_000_000_001); lock.unlock() }
}
private actor OfflineTransitionResolver: PlaybackResolving {
    private let sources: [ResolvedAudio]
    private var count = 0
    init(_ sources: [ResolvedAudio]) { self.sources = sources }
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        let position = count; count += 1
        guard sources.indices.contains(position) else { throw PlaybackFailure.unavailable }
        return sources[position]
    }
    func calls() -> Int { count }
}
@MainActor private final class OfflineTransitionDriver: PlaybackDriving {
    var onEvent: (@MainActor (UInt64, PlaybackDriverEvent) -> Void)?
    var sources: [ResolvedAudio] = []
    var generation: UInt64 = 0
    var seeks: [Double] = []
    func load(_ source: ResolvedAudio, track: PlaybackTrack, generation: UInt64) throws {
        sources.append(source); self.generation = generation
    }
    func play() {}
    func pause() {}
    func seek(to position: Double) { seeks.append(position) }
    func stop() {}
    func dispose() {}
    func progress() { onEvent?(generation, .progress(position: 42, duration: 120)) }
}
@MainActor private func offlineTransitionEventually(_ condition: @MainActor () -> Bool) async throws {
    for _ in 0..<300 {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    throw OfflineCheckFailure.assertion
}

@MainActor func checkOfflineControllerTransition() async throws {
    let root = try offlineRoot(); defer { try? FileManager.default.removeItem(at: root) }
    let bytes = offlineFixtureMedia(), sourceResolver = OfflineFixtureResolver(length: offlineFixtureMedia().count)
    let engine = try ManagedOfflineEngine(rootDirectory: root, resolver: sourceResolver,
        policy: OfflineStoragePolicy(budgetBytes: 16 * 1024 * 1024, reserveBytes: 0),
        transport: OfflineFixtureHTTP(bytes), availableSpace: { _ in 100 * 1024 * 1024 })
    let owner = try OfflineOwnerScope(ownerID: "transition-owner"), track = try offlineTrack()
    try await engine.activateOwner(owner); try await engine.setEnvironment(foreground: true, onWiFi: true)
    let id = try await engine.enqueue(track, owner: owner)
    _ = try await offlineWait(engine, owner: owner, state: .ready, id: id)
    let local = try await ResolvedAudio.offline(engine.openReady(track, owner: owner))
    let remote = try await sourceResolver.resolve(track)

    func transition(_ candidate: ResolvedAudio, accepted: Bool) async throws {
        let clock = OfflineTransitionClock(), resolver = OfflineTransitionResolver([remote, candidate])
        let driver = OfflineTransitionDriver()
        let controller = NativePlaybackController(resolver: resolver, driver: driver, now: { clock.now() })
        defer { controller.dispose() }
        try controller.setQueue([track], playing: true)
        try await offlineTransitionEventually { driver.sources.count == 1 && controller.snapshot.status == .playing }
        driver.progress(); controller.pause(); clock.expireStream(); controller.play()
        try await offlineTransitionEventually { driver.sources.count == 2 || controller.snapshot.status == .failed }
        let calls = await resolver.calls()
        try offlineRequire(calls == 2 && controller.snapshot.currentTrack?.id == track.id && controller.snapshot.position == 42)
        if accepted {
            try offlineRequire(driver.sources.count == 2 && driver.sources[1].isOffline && driver.seeks.last == 42)
            try offlineRequire(controller.snapshot.status == .playing && controller.snapshot.failure == nil)
        } else {
            try offlineRequire(driver.sources.count == 1 && controller.snapshot.failure == .invalidSource)
        }
    }
    try await transition(local, accepted: true)
    let wrongTrack = try offlineTrack("00000000002"), wrongID = try await engine.enqueue(wrongTrack, owner: owner)
    _ = try await offlineWait(engine, owner: owner, state: .ready, id: wrongID)
    let wrong = try await ResolvedAudio.offline(engine.openReady(wrongTrack, owner: owner))
    try await transition(wrong, accepted: false)
    try await engine.activateOwner(nil)
    try await transition(local, accepted: false)
}

private func offlineAssetsJPEG() throws -> Data {
    let bytes = NSMutableData()
    guard let context = CGContext(data: nil, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 64,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue),
          let image = context.makeImage(), let destination = CGImageDestinationCreateWithData(bytes, "public.jpeg" as CFString, 1, nil) else {
        throw OfflineCheckFailure.assertion
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw OfflineCheckFailure.assertion }
    return bytes as Data
}
private final class OfflineAssetsIndexFault: @unchecked Sendable {
    private let lock = NSLock()
    private var target: URL?
    func arm(_ url: URL) { lock.lock(); target = url; lock.unlock() }
    func freeSpace() -> Int64 {
        lock.lock(); let url = target; target = nil; lock.unlock()
        if let url {
            let backup = url.appendingPathExtension("test-backup")
            try? FileManager.default.moveItem(at: url, to: backup)
            try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        }
        return 100 * 1024 * 1024
    }
    func restore(_ url: URL) throws {
        try FileManager.default.removeItem(at: url)
        try FileManager.default.moveItem(at: url.appendingPathExtension("test-backup"), to: url)
    }
}
func checkOfflineAssetsContracts() async throws {
    let root = try offlineRoot(); defer { try? FileManager.default.removeItem(at: root) }
    let media = offlineFixtureMedia(), resolver = OfflineFixtureResolver(length: offlineFixtureMedia().count), fault = OfflineAssetsIndexFault()
    let engine = try ManagedOfflineEngine(rootDirectory: root, resolver: resolver,
        policy: OfflineStoragePolicy(budgetBytes: 16 * 1024 * 1024, reserveBytes: 0),
        transport: OfflineFixtureHTTP(media), availableSpace: { _ in fault.freeSpace() })
    let owner = try OfflineOwnerScope(ownerID: "assets-owner"), track = try offlineTrack()
    try await engine.activateOwner(owner)
    let id = try await engine.enqueue(track, owner: owner), jpeg = try offlineAssetsJPEG()
    var payload = try OfflineAssetsPayload(album: "Offline album", duration: 120, coverJPEG: jpeg,
        plainLyrics: "First line\nВторая строка", syncedLyrics: "[00:00]First line\n[00:01]Вторая строка")
    var revision = try await engine.saveAssets(payload, for: id, owner: owner, expectedRevision: nil)
    let queued = try await engine.snapshot(owner: owner).items[0]
    let stored = try await engine.readAssets(id, owner: owner)
    try offlineRequire(queued.hasAssets && queued.album == payload.album && queued.duration == 120 && queued.state == .queued)
    try offlineRequire(stored?.payload == payload && stored?.revision == revision && queued.assetsRevision == revision)
    try offlineRequire(stored?.payload.isEnriched == false)
    payload = try OfflineAssetsPayload(album: payload.album, duration: payload.duration, coverJPEG: payload.coverJPEG,
        plainLyrics: payload.plainLyrics, syncedLyrics: payload.syncedLyrics, enrichmentComplete: true)
    revision = try await engine.saveAssets(payload, for: id, owner: owner, expectedRevision: revision)
    let enriched = try await engine.readAssets(id, owner: owner)
    try offlineRequire(enriched?.payload.isEnriched == true)
    let enrichedSnapshot = try await engine.snapshot(owner: owner).items[0]
    try offlineRequire(enrichedSnapshot.assetsEnriched)
    var legacyPayload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as! [String: Any]
    legacyPayload.removeValue(forKey: "enrichmentComplete")
    let decodedLegacy = try JSONDecoder().decode(OfflineAssetsPayload.self, from: JSONSerialization.data(withJSONObject: legacyPayload))
    try offlineRequire(!decodedLegacy.isEnriched && decodedLegacy.coverJPEG == jpeg)
    var stale: OfflineFailure?
    do { _ = try await engine.saveAssets(payload, for: id, owner: owner, expectedRevision: nil) }
    catch { stale = error as? OfflineFailure }
    try offlineRequire(stale == .staleOwner)
    try await engine.setPolicy(OfflineStoragePolicy(budgetBytes: 2 * 1024 * 1024, reserveBytes: 0), owner: owner)
    var quota: OfflineFailure?
    do { _ = try await engine.saveAssets(payload, for: id, owner: owner, expectedRevision: revision) }
    catch { quota = error as? OfflineFailure }
    try offlineRequire(quota == .storageLimit)
    let unchanged = try await engine.readAssets(id, owner: owner); try offlineRequire(unchanged?.revision == revision)
    for invalid in [Data([0]), Data(repeating: 0, count: 512 * 1024 + 1)] {
        var failure: OfflineFailure?
        do { _ = try OfflineAssetsPayload(album: "", duration: 0, coverJPEG: invalid) } catch { failure = error as? OfflineFailure }
        try offlineRequire(failure == .invalidRequest)
    }
    var textFailure: OfflineFailure?
    do { _ = try OfflineAssetsPayload(album: "", duration: 0, plainLyrics: String(repeating: "x", count: 100_001)) }
    catch { textFailure = error as? OfflineFailure }
    try offlineRequire(textFailure == .invalidRequest)
    try await engine.activateOwner(nil)
    let coldOwner = try OfflineOwnerScope(ownerID: owner.ownerID)
    try await engine.activateOwner(coldOwner)
    let cold: OfflineStoredAssets?
    do { cold = try await engine.readAssets(id, owner: coldOwner) }
    catch {
        let dirs = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        let files = try FileManager.default.contentsOfDirectory(at: dirs[0], includingPropertiesForKeys: nil)
        let expectedName = id.uuidString.lowercased() + "." + revision.uuidString.lowercased() + ".assets.json"
        let disk = try JSONSerialization.jsonObject(with: Data(contentsOf: dirs[0].appendingPathComponent("index.json"))) as! [String: Any]
        let diskRecord = (disk["records"] as! [[String: Any]])[0]
        let diskRevision = (diskRecord["assetsRevision"] as? String).flatMap(UUID.init(uuidString:))
        print("Assets cold failure: \((error as? OfflineFailure)?.rawValue ?? "other") assetCount=\(files.filter { $0.lastPathComponent.hasSuffix(".assets.json") }.count) expectedExists=\(files.contains { $0.lastPathComponent == expectedName }) diskRevisionSame=\(diskRevision == revision)")
        throw error
    }
    try offlineRequire(cold?.payload == payload && cold?.revision == revision)
    try await engine.setPolicy(OfflineStoragePolicy(budgetBytes: 16 * 1024 * 1024, reserveBytes: 0), owner: coldOwner)
    try await engine.setEnvironment(foreground: true, onWiFi: true); try await engine.resume(id, owner: coldOwner)
    _ = try await offlineWait(engine, owner: coldOwner, state: .ready, id: id)
    var copy: OfflineLocalCopy? = try await engine.openReady(track, owner: coldOwner)
    let ownerDirectory = copy!.url.deletingLastPathComponent(), assetURL = ownerDirectory.appendingPathComponent(id.uuidString.lowercased() + "." + revision.uuidString.lowercased() + ".assets.json")
    let indexURL = ownerDirectory.appendingPathComponent("index.json")
    fault.arm(indexURL)
    var writeFailure: OfflineFailure?
    do { _ = try await engine.saveAssets(OfflineAssetsPayload(album: "Uncommitted", duration: 121), for: id, owner: coldOwner, expectedRevision: revision) }
    catch { writeFailure = error as? OfflineFailure }
    let prior = try await engine.readAssets(id, owner: coldOwner)
    try offlineRequire(writeFailure == .storage && prior?.revision == revision && prior?.payload == payload)
    try fault.restore(indexURL)
    let committedFiles = try FileManager.default.contentsOfDirectory(at: ownerDirectory, includingPropertiesForKeys: nil)
        .filter { $0.lastPathComponent.hasSuffix(".assets.json") }
    try offlineRequire(committedFiles.map(\.lastPathComponent) == [assetURL.lastPathComponent])
    // An interrupted pre-index commit can leave a new immutable orphan; a
    // post-index commit can leave an old one. Both are pruned on cold load.
    let orphan = ownerDirectory.appendingPathComponent(id.uuidString.lowercased() + "." + UUID().uuidString.lowercased() + ".assets.json")
    let indexStage = ownerDirectory.appendingPathComponent(UUID().uuidString.lowercased() + ".index.tmp")
    try Data([0]).write(to: orphan); try Data([0]).write(to: indexStage)
    try await engine.activateOwner(nil)
    try await engine.activateOwner(coldOwner)
    let preserved = try await engine.readAssets(id, owner: coldOwner)
    try offlineRequire(preserved?.payload == payload && !FileManager.default.fileExists(atPath: orphan.path) && !FileManager.default.fileExists(atPath: indexStage.path))
    try Data([0, 1, 2]).write(to: assetURL)
    var corrupt: OfflineFailure?
    do { _ = try await engine.readAssets(id, owner: coldOwner) } catch { corrupt = error as? OfflineFailure }
    let ready = try await engine.snapshot(owner: coldOwner).items[0]
    var freshCopy: OfflineLocalCopy? = try await engine.openReady(track, owner: coldOwner)
    try offlineRequire(corrupt == .corrupt && freshCopy!.isValid && ready.state == .ready && !ready.assetsEnriched)
    freshCopy = nil
    let another = try OfflineOwnerScope(ownerID: "another-assets-owner")
    try await engine.activateOwner(another)
    var wrongOwner: OfflineFailure?
    do { _ = try await engine.readAssets(id, owner: coldOwner) } catch { wrongOwner = error as? OfflineFailure }
    try offlineRequire(wrongOwner == .staleOwner && !copy!.isValid); copy = nil
    try await engine.activateOwner(nil)
    // Simulate an installed v1 index from before the optional asset fields.
    var old = try JSONSerialization.jsonObject(with: Data(contentsOf: indexURL)) as! [String: Any]
    var records = old["records"] as! [[String: Any]]
    for key in ["album", "duration", "assetsChecksum", "assetsRevision", "assetsEnriched"] { records[0].removeValue(forKey: key) }
    old["records"] = records; try JSONSerialization.data(withJSONObject: old).write(to: indexURL, options: .atomic)
    let legacyOwner = try OfflineOwnerScope(ownerID: owner.ownerID)
    try await engine.activateOwner(legacyOwner)
    let legacy = try await engine.snapshot(owner: legacyOwner).items[0]
    let absent = try await engine.readAssets(id, owner: legacyOwner)
    try offlineRequire(legacy.state == .ready && !legacy.hasAssets && legacy.album.isEmpty && legacy.duration == 0 && absent == nil)
    try await engine.remove(id, owner: legacyOwner)
    try offlineRequire(!FileManager.default.fileExists(atPath: assetURL.path))
    try await engine.activateOwner(nil)
}
