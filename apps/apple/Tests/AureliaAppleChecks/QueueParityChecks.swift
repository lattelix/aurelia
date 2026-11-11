import Foundation
import AureliaAppleUI
import AureliaPlaybackCore
import AureliaCloud

private enum QueueCheckFailure: Error { case failed(String) }
private func requireQueue(_ value: @autoclosure () -> Bool, _ message: String) throws {
    if !value() { throw QueueCheckFailure.failed(message) }
}
@MainActor private func waitQueue(_ predicate: () -> Bool) async throws {
    for _ in 0..<200 {
        if predicate() { return }
        try await Task.sleep(for: .milliseconds(5))
    }
    throw QueueCheckFailure.failed("queue state deadline")
}
private func queueTrack(_ suffix: Int = 1) throws -> TrackDTO {
    let id = String(format: "%011d", suffix)
    let object: [String: Any] = ["id": "youtube:\(id)", "externalId": id, "provider": "youtube",
                                 "title": "Queue fixture \(suffix)", "artist": "Fixture artist", "album": "Fixture album",
                                 "duration": 240, "artwork": "https://untrusted.invalid/signed?token=private"]
    return try JSONDecoder().decode(TrackDTO.self, from: JSONSerialization.data(withJSONObject: object))
}
private struct QueueResolver: PlaybackResolving {
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        try Task.checkCancellation()
        if track.provider == .studio { return try await StudioResolver().resolve(track) }
        return try ResolvedAudio(url: URL(string: "https://r1.googlevideo.com/mock-only?token=private")!, expiresAt: Date().addingTimeInterval(600))
    }
}
@MainActor private final class QueueDriver: PlaybackDriving {
    var onEvent: (@MainActor (UInt64, PlaybackDriverEvent) -> Void)?
    var generation: UInt64 = 0
    var loads: [PlaybackTrack] = []
    var plays = 0
    var volumes: [Float] = []
    func load(_ source: ResolvedAudio, track: PlaybackTrack, generation: UInt64) throws {
        self.generation = generation; loads.append(track)
    }
    func play() { plays += 1 }
    func pause() {}
    func stop() {}
    func dispose() {}
    func seek(to position: Double) {}
    func setVolume(_ volume: Float) { volumes.append(volume) }
    func emit(_ event: PlaybackDriverEvent) { onEvent?(generation, event) }
}
private actor QueueSleepGate {
    var continuation: CheckedContinuation<Void, Error>?
    func wait(_ seconds: Double) async throws {
        try await withCheckedThrowingContinuation { continuation = $0 }
    }
    func release() { continuation?.resume(); continuation = nil }
    var pending: Bool { continuation != nil }
}
private final class QueueClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date()
    func now() -> Date { lock.lock(); defer { lock.unlock() }; return value }
    func advance(_ seconds: Double) { lock.lock(); value.addTimeInterval(seconds); lock.unlock() }
}
@MainActor private final class QueueCredential: CredentialStoring {
    private var value: CloudCredential?
    init() throws { value = try CloudCredential(token: String(repeating: "q", count: 43), accountID: "queue-owner", expiresAt: Date().addingTimeInterval(600)) }
    func load() throws -> CloudCredential? { value }
    func save(_ value: CloudCredential) throws { self.value = value }
    func delete() throws { value = nil }
}
private struct QueueTransport: CloudHTTPTransport {
    func send(_ request: URLRequest, maxBytes: Int) async throws -> CloudHTTPResponse {
        if request.url?.path == "/api/auth/logout" {
            return CloudHTTPResponse(status: 200, body: Data("{\"ok\":true}".utf8))
        }
        guard request.url?.path == "/api/bootstrap" else { throw CloudFailure.unavailable }
        let body: [String: Any] = ["user": ["id": "queue-owner", "name": "Queue fixture", "email": NSNull(), "identities": []],
                                   "library": ["likes": [], "playlists": []], "capabilities": [:]]
        return CloudHTTPResponse(status: 200, body: try JSONSerialization.data(withJSONObject: body))
    }
}

enum QueueParityChecks {
    @MainActor static var cases: [(String, @MainActor () async throws -> Void)] {
        [("apple_metadata_queue_restore_preserves_occurrences_paused", metadataRestore),
         ("apple_play_next_and_append_preserve_load_and_shuffle_order", insert),
         ("apple_guest_account_queue_isolation_and_relaunch", ownerIsolation),
         ("apple_sleep_timer_completion_cancel_and_track_end", sleepTimer),
         ("apple_elapsed_sleep_timer_blocks_system_resume", elapsedSleepTimer),
         ("apple_profile_palette_migration_and_queue_corruption", validation)] + OfflineIntegrationChecks.cases
    }

    @MainActor private static func metadataRestore() async throws {
        let suite = "aurelia-queue-restore-\(UUID())", defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = LocalProfileStore(defaults: defaults), driver = QueueDriver(), youtube = try queueTrack()
        let model = AureliaModel(driver: driver, resolver: QueueResolver(), store: store, youtubePlaybackAvailable: true)
        model.playCloudTracks([youtube, try queueTrack(2), youtube], at: 2)
        try await waitQueue { model.isPlaying }
        driver.emit(.progress(position: 180, duration: 240))
        model.cycleRepeat(); model.toggleShuffle(); model.setSleepTimerAtTrackEnd()
        let ids = model.playback.queue.map(\.id)
        let data = try JSONEncoder().encode(store.loadQueue(ownerID: nil)!)
        let text = String(decoding: data, as: UTF8.self)
        try requireQueue(text.contains("youtube:") && text.contains("Fixture album"), "recording metadata persisted")
        try requireQueue(!text.contains("://") && !text.contains("token") && !text.contains("artwork") && !text.contains("volume") && !text.contains("playing") && !text.contains("timer"), "locators and session intent excluded")
        model.dispose()
        let restoredDriver = QueueDriver()
        let restored = AureliaModel(driver: restoredDriver, resolver: QueueResolver(), store: store, youtubePlaybackAvailable: true)
        defer { restored.dispose() }
        try await waitQueue { restored.playback.status == .paused }
        try requireQueue(restored.playback.queue.map(\.id) == ids && Set(ids).count == 3, "duplicate occurrence UUIDs survive relaunch")
        try requireQueue(restored.playback.index == 2 && restored.playback.position == 180 && restored.currentDuration == 240, "long YouTube position and metadata preserved")
        try requireQueue(restored.currentAlbum == "Fixture album" && restored.cloudCurrentTrack?.id == youtube.id, "reconstructed DTO supports current-track actions")
        try requireQueue(restored.playback.shuffle && restored.playback.repeatMode == .all && restored.sleepTimer == nil, "repeat/shuffle restored, timer discarded")
        try requireQueue(restoredDriver.plays == 0 && restoredDriver.volumes.allSatisfy { $0 == 0 }, "restoration stays silent and paused")
        restored.clearQueue(expectedRevision: restored.playback.queueRevision)
        try requireQueue(store.loadQueue(ownerID: nil)?.entries.isEmpty == true, "clear writes a tombstone instead of reviving legacy queues")
    }

    @MainActor private static func insert() async throws {
        let driver = QueueDriver(), model = AureliaModel(driver: driver, resolver: QueueResolver(), store: .init(defaults: nil), youtubePlaybackAvailable: true)
        defer { model.dispose() }
        let song = try queueTrack()
        model.addCloudToQueue(song)
        try await waitQueue { model.playback.status == .paused }
        try requireQueue(driver.plays == 0, "append to empty queue prepares paused")
        model.togglePlayback(); try await waitQueue { model.isPlaying }
        driver.emit(.progress(position: 38, duration: 240))
        let occurrence = model.currentPlaybackTrack!.id, loads = driver.loads.count
        model.addCloudToQueue(song); model.addCloudToQueue(try queueTrack(2))
        model.toggleShuffle()
        model.playCloudNext(try queueTrack(3))
        let next = model.playback.queue[(model.playback.index ?? 0) + 1].id
        try requireQueue(model.currentPlaybackTrack?.id == occurrence && model.playback.position == 38 && driver.loads.count == loads, "insert does not reload or seek current source")
        try requireQueue(model.playback.queue.count == 4 && Set(model.playback.queue.map(\.id)).count == 4, "duplicates are independent occurrences")
        model.next(); try await waitQueue { model.isPlaying && model.currentPlaybackTrack?.id == next }
        try requireQueue(model.currentPlaybackTrack?.trackID == "youtube:00000000003", "play next wins over shuffle traversal")
        let queue = model.playback.queue
        model.addCloudToQueue(song, expectedAccountID: "old-owner")
        try requireQueue(model.playback.queue == queue, "stale owner cannot append")
    }

    @MainActor private static func ownerIsolation() async throws {
        let suite = "aurelia-queue-owner-\(UUID())", defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = LocalProfileStore(defaults: defaults), guestDriver = QueueDriver()
        let cloud = CloudAccountStore(client: .init(transport: QueueTransport()), credentials: try QueueCredential())
        let model = AureliaModel(driver: guestDriver, resolver: QueueResolver(), store: store, cloud: cloud, youtubePlaybackAvailable: true)
        defer { model.dispose() }
        model.playCloudTracks([try queueTrack(1)])
        try await waitQueue { model.isPlaying }
        let guestID = model.currentPlaybackTrack!.id
        await cloud.restore()
        try await waitQueue { cloud.authorizedOwnerID == "queue-owner" && model.playback.queue.isEmpty }
        model.playCloudTracks([try queueTrack(2)], expectedAccountID: "queue-owner")
        try await waitQueue { model.isPlaying }
        let accountID = model.currentPlaybackTrack!.id
        try requireQueue(store.loadQueue(ownerID: nil)?.entries.first?.id == guestID && store.loadQueue(ownerID: "queue-owner")?.entries.first?.id == accountID, "guest and account write separate records")
        model.setSleepTimerAtTrackEnd()
        await cloud.signOut(expectedAccountID: "queue-owner")
        try await waitQueue { model.playback.status == .paused && model.currentPlaybackTrack?.id == guestID }
        try requireQueue(model.sleepTimer == nil && model.cloudCurrentTrack?.id == "youtube:00000000001", "signout restores guest metadata paused and cancels timer")
        model.playCloudTracks([try queueTrack(3)], expectedAccountID: "queue-owner")
        try requireQueue(model.currentPlaybackTrack?.id == guestID, "stale account selection cannot replace guest queue")
        let nextCloud = CloudAccountStore(client: .init(transport: QueueTransport()), credentials: try QueueCredential())
        let nextDriver = QueueDriver()
        let next = AureliaModel(driver: nextDriver, resolver: QueueResolver(), store: store, cloud: nextCloud, youtubePlaybackAvailable: true)
        defer { next.dispose() }
        await nextCloud.restore()
        try await waitQueue { next.playback.status == .paused && next.currentPlaybackTrack?.id == accountID }
        try requireQueue(nextDriver.plays == 0 && nextDriver.volumes.allSatisfy { $0 == 0 }, "validated returning account restores its own queue paused")
    }

    @MainActor private static func sleepTimer() async throws {
        let gate = QueueSleepGate(), driver = QueueDriver()
        let model = AureliaModel(driver: driver, resolver: QueueResolver(), store: .init(defaults: nil), youtubePlaybackAvailable: true,
                                 timerSleep: { try await gate.wait($0) })
        defer { model.dispose() }
        model.playCloudTracks([try queueTrack(), try queueTrack(2)])
        try await waitQueue { model.isPlaying }
        model.setSleepTimer(minutes: 5)
        for _ in 0..<100 { if await gate.pending { break }; try await Task.sleep(for: .milliseconds(1)) }
        await gate.release()
        try await waitQueue { model.sleepTimer == nil && model.playback.status == .paused }
        model.togglePlayback(); try await waitQueue { model.isPlaying }
        model.setSleepTimer(minutes: 5)
        for _ in 0..<100 { if await gate.pending { break }; try await Task.sleep(for: .milliseconds(1)) }
        model.cancelSleepTimer(); await gate.release()
        try await Task.sleep(for: .milliseconds(10))
        try requireQueue(model.isPlaying, "cancelled timer cannot pause a later play")
        model.cycleRepeat(); model.cycleRepeat()
        let occurrence = model.currentPlaybackTrack!.id, loads = driver.loads.count
        model.setSleepTimerAtTrackEnd(); driver.emit(.ended)
        try requireQueue(model.playback.status == .paused && model.currentPlaybackTrack?.id == occurrence && driver.loads.count == loads && model.sleepTimer == nil, "track-end timer stops before repeat/next")
        model.setSleepTimerAtTrackEnd(); model.next()
        try await waitQueue { model.currentPlaybackTrack?.id != occurrence }
        try requireQueue(model.sleepTimer == nil, "manual track change cancels occurrence-bound timer")
    }

    @MainActor private static func validation() async throws {
        let old = Data("{\"version\":1,\"appearance\":\"dark\"}".utf8)
        let migrated = try JSONDecoder().decode(LocalProfile.self, from: old)
        try requireQueue(migrated.palette == .base && migrated.appearance == .dark && migrated.likes.isEmpty, "old profile defaults palette without discarding preferences")
        let studio = StudioCatalogue.tracks[0], playback = try studio.queueEntry()
        let entry = LocalQueueEntry(track: playback, album: studio.album, duration: 72)
        let corrupt = LocalQueueSnapshot(ownerID: nil, entries: [entry, entry], index: 0, position: 0, repeatMode: .off, shuffle: false)
        try requireQueue(corrupt.validated() == nil, "duplicate UUID snapshot is rejected rather than silently reindexed")
        let invalid = try PlaybackTrack(videoID: "00000000001", title: "https://media.invalid/?token=private", artist: "Fixture")
        let invalidEntry = LocalQueueEntry(track: invalid, album: "", duration: 240)
        try requireQueue((try? invalidEntry.playbackTrack()) == nil, "locator-bearing metadata cannot enter queue persistence")
    }

    @MainActor private static func elapsedSleepTimer() async throws {
        let clock = QueueClock(), gate = QueueSleepGate(), driver = QueueDriver()
        let model = AureliaModel(driver: driver, resolver: QueueResolver(), store: .init(defaults: nil), youtubePlaybackAvailable: true,
                                 timerNow: { clock.now() }, timerSleep: { try await gate.wait($0) })
        defer { model.dispose() }
        model.playCloudTracks([try queueTrack()]); try await waitQueue { model.isPlaying }
        model.setSleepTimer(minutes: 5)
        for _ in 0..<100 { if await gate.pending { break }; try await Task.sleep(for: .milliseconds(1)) }
        model.pause(); let plays = driver.plays
        clock.advance(301)
        driver.emit(.control(.play))
        try requireQueue(model.playback.status == .paused && driver.plays == plays && model.sleepTimer == nil,
                         "elapsed timer prevents driver.play even before suspended timer task resumes")
        await gate.release()
        model.togglePlayback()
        try requireQueue(model.isPlaying && driver.plays == plays + 1, "later deliberate play works after timer completion")
    }
}
