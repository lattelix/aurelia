import Foundation
@testable import AureliaAppleUI
import AureliaPlaybackCore
import AureliaCloud

private enum OfflineIntegrationFailure: Error { case failed(String) }
private func requireOfflineIntegration(_ value: @autoclosure () -> Bool, _ message: String) throws {
    if !value() { throw OfflineIntegrationFailure.failed(message) }
}
@MainActor private func waitOfflineIntegration(_ predicate: () -> Bool) async throws {
    for _ in 0..<300 {
        if predicate() { return }
        try await Task.sleep(for: .milliseconds(5))
    }
    throw OfflineIntegrationFailure.failed("offline integration deadline")
}
private func integrationBox(_ kind: String, _ payload: Data) -> Data {
    let size = UInt32(payload.count + 8)
    return Data([UInt8((size >> 24) & 255), UInt8((size >> 16) & 255), UInt8((size >> 8) & 255), UInt8(size & 255)]) + Data(kind.utf8) + payload
}
private func integrationMedia() -> Data {
    let ftyp = integrationBox("ftyp", Data("M4A ".utf8) + Data(repeating: 0, count: 4))
    var sample = Data(repeating: 0, count: 28); sample[7] = 1
    let stsd = integrationBox("stsd", Data([0, 0, 0, 0, 0, 0, 0, 1]) + integrationBox("mp4a", sample))
    let dref = integrationBox("dref", Data([0, 0, 0, 0, 0, 0, 0, 1]) + integrationBox("url ", Data([0, 0, 0, 1])))
    let minf = integrationBox("minf", integrationBox("dinf", dref) + integrationBox("stbl", stsd))
    return ftyp + integrationBox("moov", integrationBox("trak", integrationBox("mdia", minf))) + integrationBox("mdat", Data(repeating: 17, count: 32))
}
private struct IntegrationSeedResolver: PlaybackResolving {
    let length: Int
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        let url = URL(string: "https://r1.googlevideo.com/videoplayback?id=offline-integration&itag=140&clen=\(length)&expire=4000000000&lmt=1000&mime=audio%2Fmp4&source=youtube&sig=fixture")!
        return try ResolvedAudio.youtube(lease: VerifiedYouTubeStreamLease(requestedVideoID: track.videoID, playerVideoID: track.videoID,
            itag: 140, mimeType: "audio/mp4; codecs=\"mp4a.40.2\"", contentLength: length,
            url: url, expiresAt: Date(timeIntervalSince1970: 4_000_000_000)))
    }
}
private struct IntegrationBytes: YouTubeHTTPTransport {
    let bytes: Data
    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        guard let range = PartialMediaSample.requestedRange(request.value(forHTTPHeaderField: "Range")), range.upperBound < bytes.count else {
            throw OfflineIntegrationFailure.failed("fixture range")
        }
        return BoundedHTTPResponse(status: 206, headers: ["content-length": String(range.count), "content-type": "audio/mp4",
            "content-range": "bytes \(range.lowerBound)-\(range.upperBound)/\(bytes.count)"], body: Data(bytes[range]))
    }
}
private actor IntegrationDenyResolver: PlaybackResolving {
    var count = 0
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio { count += 1; throw PlaybackFailure.network }
}
@MainActor private final class IntegrationCredential: CredentialStoring {
    private var value: CloudCredential?
    init(expiresAt: Date = Date().addingTimeInterval(600)) throws { value = try CloudCredential(token: String(repeating: "i", count: 43), accountID: "offline-owner", expiresAt: expiresAt) }
    func load() throws -> CloudCredential? { value }
    func save(_ credential: CloudCredential) throws { value = credential }
    func delete() throws { value = nil }
}
private actor IntegrationCloudHTTP: CloudHTTPTransport {
    let offline: Bool
    var rejectLogout = false
    init(offline: Bool = false) { self.offline = offline }
    func setRejectLogout(_ value: Bool) { rejectLogout = value }
    func send(_ request: URLRequest, maxBytes: Int) async throws -> CloudHTTPResponse {
        if request.url?.path == "/api/auth/logout" {
            if rejectLogout { throw CloudFailure.unavailable }
            return .init(status: 200, body: Data("{\"ok\":true}".utf8))
        }
        if offline { throw CloudFailure.unavailable }
        guard request.url?.path == "/api/bootstrap" else { throw CloudFailure.unavailable }
        let payload: [String: Any] = ["user": ["id": "offline-owner", "name": "Fixture", "email": NSNull(), "identities": []],
            "library": ["likes": [], "playlists": []], "capabilities": [:]]
        return .init(status: 200, body: try JSONSerialization.data(withJSONObject: payload))
    }
}
@MainActor private final class IntegrationDriver: PlaybackDriving {
    var onEvent: (@MainActor (UInt64, PlaybackDriverEvent) -> Void)?
    var offlineLoads = 0
    var plays = 0
    var volumes: [Float] = []
    var stops = 0
    func load(_ source: ResolvedAudio, track: PlaybackTrack, generation: UInt64) throws {
        guard source.isPlayable else { throw PlaybackFailure.invalidSource }
        if source.isOffline { offlineLoads += 1 }
    }
    func play() { plays += 1 }
    func pause() {}
    func stop() { stops += 1 }
    func seek(to position: Double) {}
    func dispose() {}
    func setVolume(_ volume: Float) { volumes.append(volume) }
}

enum OfflineIntegrationChecks {
    @MainActor static var cases: [(String, @MainActor () async throws -> Void)] {
        [("apple_offline_scope_refresh_dedup_and_failed_signout_recovery", scopeLifecycle),
         ("apple_offline_cold_queue_restore_awaits_owner_without_network", coldRestore),
         ("apple_offline_deadline_revokes_reads_jobs_and_playback", authorizationDeadline)]
    }
    @MainActor private static func scopeLifecycle() async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("aurelia-offline-scope-\(UUID())", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let deny = IntegrationDenyResolver()
        let engine = try ManagedOfflineEngine(rootDirectory: root, resolver: deny, policy: .init(budgetBytes: 2 * 1024 * 1024))
        let preferred = OfflinePreferredResolver(engine: engine, upstream: deny)
        let track = try PlaybackTrack(videoID: "00000000001", title: "Fixture", artist: "Fixture")
        do { _ = try await preferred.resolve(track); throw OfflineIntegrationFailure.failed("unauthorized resolver admitted") }
        catch PlaybackFailure.staleRequest {}
        let deniedCalls = await deny.count
        try requireOfflineIntegration(deniedCalls == 0, "no-owner resolution never invokes upstream")
        let http = IntegrationCloudHTTP(), cloud = CloudAccountStore(client: .init(transport: http), credentials: try IntegrationCredential())
        let offline = AppleOfflineStore(resolver: preferred, cloud: cloud, monitorNetwork: false)
        let model = AureliaModel(driver: IntegrationDriver(), resolver: preferred, store: .init(defaults: nil), cloud: cloud, youtubePlaybackAvailable: true, offline: offline)
        defer { model.dispose() }
        await cloud.restore()
        try await waitOfflineIntegration { offline.isReadyForPlayback(expectedAccountID: "offline-owner") }
        let revision = offline.ownerRevision
        await cloud.refresh()
        try await waitOfflineIntegration { offline.isReadyForPlayback(expectedAccountID: "offline-owner") }
        try requireOfflineIntegration(offline.ownerRevision == revision, "same-owner bootstrap preserves admission revision")
        await http.setRejectLogout(true)
        await cloud.signOut(expectedAccountID: "offline-owner")
        try await waitOfflineIntegration { offline.isReadyForPlayback(expectedAccountID: "offline-owner") }
        try requireOfflineIntegration(offline.ownerRevision != revision, "failed signout reauthorizes a new scope only after mutation ends")
        guard let staleRevision = revision else { throw OfflineIntegrationFailure.failed("scope revision") }
        let dto = try TrackDTO(id: track.trackID, title: track.title, artist: track.artist, album: "", provider: "youtube", externalId: track.videoID, duration: 0, artwork: "")
        await offline.download(dto, expectedOwnerRevision: staleRevision)
        // Scope admission is ready before the asynchronous UI snapshot read.
        // Explicit readback verifies the stale action did not enqueue a record.
        await offline.refresh()
        try await waitOfflineIntegration { offline.snapshot != nil }
        try requireOfflineIntegration(offline.snapshot?.items.isEmpty == true, "late download action cannot write into renewed scope")
    }

    @MainActor private static func coldRestore() async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("aurelia-offline-cold-\(UUID())", isDirectory: true)
        let suite = "aurelia-offline-cold-\(UUID())", defaults = UserDefaults(suiteName: suite)!
        defer { try? FileManager.default.removeItem(at: root); defaults.removePersistentDomain(forName: suite) }
        let bytes = integrationMedia(), track = try PlaybackTrack(videoID: "00000000001", title: "Offline fixture", artist: "Fixture")
        let engine = try ManagedOfflineEngine(rootDirectory: root, resolver: IntegrationSeedResolver(length: bytes.count),
            policy: .init(budgetBytes: 8 * 1024 * 1024, reserveBytes: 0), transport: IntegrationBytes(bytes: bytes), availableSpace: { _ in 100 * 1024 * 1024 })
        let owner = try OfflineOwnerScope(ownerID: "account:offline-owner")
        try await engine.activateOwner(owner); try await engine.setEnvironment(foreground: true, onWiFi: true)
        try await engine.enqueue(track, owner: owner)
        for _ in 0..<300 {
            if try await engine.snapshot(owner: owner).items.first?.state == .ready { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        let seeded = try await engine.snapshot(owner: owner).items.first?.state == .ready
        try requireOfflineIntegration(seeded, "seed completes before cold restore")
        let store = LocalProfileStore(defaults: defaults)
        store.saveQueue(.init(ownerID: "offline-owner", entries: [.init(track: track, album: "Fixture album", duration: 240)], index: 0, position: 37, repeatMode: .off, shuffle: false))
        let deny = IntegrationDenyResolver(), preferred = OfflinePreferredResolver(engine: engine, upstream: deny)
        let cloud = CloudAccountStore(client: .init(transport: IntegrationCloudHTTP(offline: true)), credentials: try IntegrationCredential())
        let offline = AppleOfflineStore(resolver: preferred, cloud: cloud, monitorNetwork: false), driver = IntegrationDriver()
        let model = AureliaModel(driver: driver, resolver: preferred, store: store, cloud: cloud, youtubePlaybackAvailable: true, offline: offline)
        defer { model.dispose() }
        await cloud.restore()
        try await waitOfflineIntegration { driver.offlineLoads == 1 && model.playback.status == .paused }
        let networkCalls = await deny.count
        try requireOfflineIntegration(networkCalls == 0 && driver.plays == 0 && driver.volumes.allSatisfy { $0 == 0 }, "cold offline restore stays paused without upstream resolution or audible gain")
        try requireOfflineIntegration(model.playback.position == 37 && model.currentPlaybackTrack?.id == track.id, "owner-scoped metadata position and occurrence survive cold restore")
    }
    @MainActor private static func authorizationDeadline() async throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("aurelia-offline-expiry-\(UUID())", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let clock = IntegrationExpiryClock(), sleeper = IntegrationExpirySleep(), bytes = IntegrationHeldBytes(bytes: integrationMedia())
        let seed = IntegrationSeedResolver(length: integrationMedia().count)
        let engine = try ManagedOfflineEngine(rootDirectory: root, resolver: seed, policy: .init(budgetBytes: 8 * 1024 * 1024, reserveBytes: 0), transport: bytes)
        let preferred = OfflinePreferredResolver(engine: engine, upstream: seed)
        let cloud = CloudAccountStore(client: .init(transport: IntegrationCloudHTTP()),
            credentials: try IntegrationCredential(expiresAt: clock.now().addingTimeInterval(10)), now: { clock.now() })
        let offline = AppleOfflineStore(resolver: preferred, cloud: cloud, monitorNetwork: false,
            now: { clock.now() }, sleep: { try await sleeper.wait($0) })
        let driver = IntegrationDriver(), model = AureliaModel(driver: driver, resolver: preferred,
            store: .init(defaults: nil), cloud: cloud, youtubePlaybackAvailable: true, offline: offline)
        defer { model.dispose() }
        await cloud.restore()
        try await waitOfflineIntegration { offline.isReadyForPlayback(expectedAccountID: "offline-owner") }
        guard let revision = offline.ownerRevision else { throw OfflineIntegrationFailure.failed("expiry owner admission") }
        let owner = try OfflineOwnerScope(ownerID: "account:offline-owner", revision: revision)
        try await engine.setEnvironment(foreground: true, onWiFi: true)
        let track = try TrackDTO(id: "youtube:00000000001", title: "Ready expiry fixture", artist: "Fixture", album: "", provider: "youtube", externalId: "00000000001", duration: 120)
        await offline.download(track, expectedOwnerRevision: revision)
        for _ in 0..<300 {
            await offline.refresh()
            if offline.snapshot?.items.first?.state == .ready { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        let playback = try PlaybackTrack(videoID: track.externalId, title: track.title, artist: track.artist)
        let copy = try await engine.openReady(playback, owner: owner)
        model.playCloudTracks([track], expectedAccountID: "offline-owner")
        try await waitOfflineIntegration { model.playback.status == .playing }
        await cloud.refresh()
        try await waitOfflineIntegration { offline.ownerRevision == revision }
        let timerCount = await sleeper.requests
        try requireOfflineIntegration(timerCount == 1 && copy.isValid && model.playback.status == .playing,
            "same-owner refresh neither revokes nor duplicates the expiry wakeup")
        await bytes.setHeld(true)
        let second = try TrackDTO(id: "youtube:00000000002", title: "Pending expiry fixture", artist: "Fixture", album: "", provider: "youtube", externalId: "00000000002", duration: 120)
        await offline.download(second, expectedOwnerRevision: revision)
        for _ in 0..<300 { if await bytes.entered { break }; try await Task.sleep(for: .milliseconds(5)) }
        let entered = await bytes.entered
        try requireOfflineIntegration(entered, "second physical download is in flight at expiry")
        let stops = driver.stops
        clock.advance(11); await sleeper.wake()
        try await waitOfflineIntegration { offline.snapshot == nil && !offline.canManage && model.playback.queue.isEmpty && !copy.isValid }
        try requireOfflineIntegration(driver.stops > stops && offline.ownerRevision == nil && cloud.authorizedOwnerID == nil,
            "deadline clears metadata, revokes existing reads, stops playback and invalidates owner")
        await bytes.release()
        for _ in 0..<20 { await Task.yield() }
        let cold = try ManagedOfflineEngine(rootDirectory: root, resolver: seed, policy: .init(budgetBytes: 8 * 1024 * 1024, reserveBytes: 0), transport: bytes)
        let auditOwner = try OfflineOwnerScope(ownerID: owner.ownerID)
        try await cold.activateOwner(auditOwner)
        let restored = try await cold.snapshot(owner: auditOwner)
        try requireOfflineIntegration(restored.items.first(where: { $0.track.videoID == second.externalId })?.state != .ready,
            "late transport completion cannot publish audio ready after expiry")
        try await cold.activateOwner(nil)
    }
}

private final class IntegrationExpiryClock: @unchecked Sendable {
    private let lock = NSLock()
    private var instant = Date(timeIntervalSince1970: 2_000_000_000)
    func now() -> Date { lock.lock(); defer { lock.unlock() }; return instant }
    func advance(_ seconds: TimeInterval) { lock.lock(); instant.addTimeInterval(seconds); lock.unlock() }
}
private actor IntegrationExpirySleep {
    private var pending: [UUID: CheckedContinuation<Void, Error>] = [:]
    private(set) var requests = 0
    func wait(_ seconds: TimeInterval) async throws {
        try Task.checkCancellation(); let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in pending[id] = continuation; requests += 1 }
        } onCancel: { Task { await self.cancel(id) } }
    }
    func wake() { let all = pending.values; pending.removeAll(); all.forEach { $0.resume() } }
    private func cancel(_ id: UUID) { pending.removeValue(forKey: id)?.resume(throwing: CancellationError()) }
}
private actor IntegrationHeldBytes: YouTubeHTTPTransport {
    let bytes: Data
    private var held = false
    private var pending: CheckedContinuation<Void, Never>?
    private(set) var entered = false
    init(bytes: Data) { self.bytes = bytes }
    func setHeld(_ value: Bool) { held = value }
    func release() { pending?.resume(); pending = nil }
    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        if held { entered = true; await withCheckedContinuation { pending = $0 } }
        return try await IntegrationBytes(bytes: bytes).request(request, maxBytes: maxBytes)
    }
}
