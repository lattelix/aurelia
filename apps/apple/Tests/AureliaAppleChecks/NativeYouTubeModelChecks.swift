import Foundation
import AureliaAppleUI
import AureliaPlaybackCore
import AureliaCloud

private enum NativeModelFailure: Error { case failed(String) }
private func requireNative(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw NativeModelFailure.failed(message) }
}
@MainActor private func waitNative(_ predicate: @MainActor () async -> Bool) async throws {
    for _ in 0..<200 {
        if await predicate() { return }
        try await Task.sleep(for: .milliseconds(5))
    }
    throw NativeModelFailure.failed("mock state deadline")
}

private func nativeTrack(youtube: Bool = true, overrides: [String: Any] = [:]) throws -> TrackDTO {
    var value: [String: Any] = [
        "id": youtube ? "youtube:00000000001" : "studio:afterglow-1",
        "provider": youtube ? "youtube" : "studio", "externalId": youtube ? "00000000001" : "1",
        "title": youtube ? "Mock YouTube recording" : "Golden Hour", "artist": "Mock artist",
        "album": "Mock collection", "duration": 123, "artwork": "https://untrusted.invalid/ignored.jpg"
    ]
    for (key, replacement) in overrides { value[key] = replacement }
    return try JSONDecoder().decode(TrackDTO.self, from: JSONSerialization.data(withJSONObject: value))
}

/// Deliberately unverified generic audio accepted only by this mock driver. It
/// performs no request, creates no AVPlayer and proves no live source capability.
private func mockNativeAudio() throws -> ResolvedAudio {
    try ResolvedAudio(url: URL(string: "https://r1.googlevideo.com/mock-only")!, expiresAt: Date().addingTimeInterval(600))
}
private struct InstantNativeResolver: PlaybackResolving {
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        try Task.checkCancellation()
        guard track.provider == .youtube else { throw PlaybackFailure.invalidTrack }
        return try mockNativeAudio()
    }
}
private actor HeldNativeResolver: PlaybackResolving {
    private var held: [Int: CheckedContinuation<ResolvedAudio, Error>] = [:]
    private(set) var count = 0
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        let request = count; count += 1
        return try await withCheckedThrowingContinuation { held[request] = $0 }
    }
    func release() throws {
        let source = try mockNativeAudio(), pending = Array(held.values)
        held = [:]
        // Intentionally returns after cancellation to exercise the generation gate.
        for continuation in pending { continuation.resume(returning: source) }
    }
    func release(_ index: Int) throws { held.removeValue(forKey: index)?.resume(returning: try mockNativeAudio()) }
}

@MainActor private final class NativeModelDriver: PlaybackDriving {
    var onEvent: (@MainActor (UInt64, PlaybackDriverEvent) -> Void)?
    var loaded: [PlaybackTrack] = []
    var plays = 0
    var volumes: [Float] = []
    var gainAtPlay: [Float] = []
    private var currentGain: Float = 0
    var generation: UInt64 = 0
    func load(_ source: ResolvedAudio, track: PlaybackTrack, generation: UInt64) throws {
        try requireNative(source.isPlayable, "mock source shape")
        self.generation = generation; loaded.append(track)
    }
    func play() { plays += 1; gainAtPlay.append(currentGain) }
    func pause() {}
    func stop() {}
    func dispose() {}
    func seek(to position: Double) {}
    func setVolume(_ value: Float) { currentGain = value; volumes.append(value) }
    func progress(_ position: Double, duration: Double) { onEvent?(generation, .progress(position: position, duration: duration)) }
    func control(_ control: PlaybackControl) { onEvent?(generation, .control(control)) }
}

@MainActor private final class NativeFixtureCredentials: CredentialStoring {
    private var value: CloudCredential?
    init() throws {
        value = try CloudCredential(token: String(repeating: "m", count: 43), accountID: "mock-owner", expiresAt: Date().addingTimeInterval(600))
    }
    func load() throws -> CloudCredential? { value }
    func save(_ credential: CloudCredential) throws { value = credential }
    func delete() throws { value = nil }
}
private struct NativeFixtureTransport: CloudHTTPTransport {
    func send(_ request: URLRequest, maxBytes: Int) async throws -> CloudHTTPResponse {
        guard request.url?.path == "/api/bootstrap" else { throw CloudFailure.unavailable }
        let payload: [String: Any] = [
            "user": ["id": "mock-owner", "name": "Mock owner", "email": NSNull(), "identities": []],
            "library": ["likes": [], "playlists": []], "capabilities": [:]
        ]
        return CloudHTTPResponse(status: 200, body: try JSONSerialization.data(withJSONObject: payload))
    }
}

enum NativeYouTubeModelChecks {
    @MainActor static var cases: [(String, @MainActor () async throws -> Void)] {
        [
            ("native_youtube_requires_explicit_source_and_canonical_metadata", gatedMetadata),
            ("native_youtube_metadata_toggle_and_silent_start", metadataAndToggle),
            ("native_mixed_queue_occurrence_identity_and_navigation", mixedQueue),
            ("native_owner_transition_cancels_late_youtube_resolution", ownerCancellation),
            ("native_youtube_queue_replaces_legacy_studio_and_restores_paused", metadataQueueRestore),
            ("native_large_cloud_selection_uses_bounded_upcoming_window", largeCollection),
            ("native_pending_queue_selection_preserves_actual_play_intent", pendingQueueSelection),
            ("native_normal_manual_play_applies_volume_preference", normalVolumePreference),
            ("native_system_play_applies_preference_after_silent_restore", systemVolumePreference)
        ]
    }

    @MainActor private static func gatedMetadata() async throws {
        let track = try nativeTrack(), driver = NativeModelDriver()
        let model = AureliaModel(driver: driver, resolver: ApplePlaybackResolver(youtube: InstantNativeResolver()), store: LocalProfileStore(defaults: nil))
        defer { model.dispose() }
        try requireNative(!model.youtubePlaybackAvailable && !model.canPlayCloudTrack(track), "injected test resolver alone does not enable constructor gate")
        model.playCloudTracks([track])
        try requireNative(model.playback.queue.isEmpty && driver.loaded.isEmpty && model.notice != nil, "disabled source never queues or substitutes Studio")
        let enabled = AureliaModel(driver: NativeModelDriver(), resolver: ApplePlaybackResolver(youtube: InstantNativeResolver()), store: LocalProfileStore(defaults: nil), youtubePlaybackAvailable: true)
        defer { enabled.dispose() }
        for bad in [
            try nativeTrack(overrides: ["id": "youtube:00000000002"]),
            try nativeTrack(overrides: ["externalId": "../bad"]),
            try nativeTrack(overrides: ["title": ""]),
            try nativeTrack(overrides: ["provider": "unknown"]),
            try nativeTrack(youtube: false, overrides: ["externalId": "2"])
        ] {
            try requireNative(!enabled.canPlayCloudTrack(bad), "bad DTO is not a playback capability")
            enabled.playCloudTracks([bad])
            try requireNative(enabled.playback.queue.isEmpty, "bad DTO rejected atomically")
        }
        try requireNative(track.safeArtworkURL?.absoluteString == "https://i.ytimg.com/vi/00000000001/hqdefault.jpg", "untrusted raw artwork never selected")
        enabled.playCloudTracks([track], expectedAccountID: "another-owner")
        try requireNative(enabled.playback.queue.isEmpty, "stale displayed owner rejected")
    }

    @MainActor private static func metadataAndToggle() async throws {
        let driver = NativeModelDriver(), track = try nativeTrack()
        let model = AureliaModel(driver: driver, resolver: ApplePlaybackResolver(youtube: InstantNativeResolver()), store: LocalProfileStore(defaults: nil), forceMuted: true, youtubePlaybackAvailable: true)
        defer { model.dispose() }
        model.playCloudTracks([track])
        try await waitNative { model.isPlaying }
        try requireNative(model.current == nil && model.currentPlaybackTrack?.title == track.title, "YouTube metadata is not mistaken for empty Studio selection")
        try requireNative(model.currentPlaybackTrack?.provider == .youtube && model.currentDuration == 123, "canonical provider and display duration")
        model.togglePlayback()
        try requireNative(model.playback.status == .paused, "YouTube pauses through global control")
        model.togglePlayback()
        try requireNative(model.isPlaying && driver.loaded.count == 1 && driver.plays == 2, "YouTube resumes existing load through global control")
        driver.progress(15, duration: 130)
        try requireNative(model.currentDuration == 130 && model.playback.position == 15, "driver duration wins over metadata estimate")
        try requireNative(driver.volumes.allSatisfy { $0 == 0 } && model.queuePersistenceText != nil, "silent intent and device-local metadata disclosure")
    }

    @MainActor private static func mixedQueue() async throws {
        let driver = NativeModelDriver(), studio = try nativeTrack(youtube: false), youtube = try nativeTrack()
        let model = AureliaModel(driver: driver, resolver: ApplePlaybackResolver(youtube: InstantNativeResolver()), store: LocalProfileStore(defaults: nil), youtubePlaybackAvailable: true)
        defer { model.dispose() }
        model.playCloudTracks([studio, youtube, youtube], at: 1)
        try await waitNative { model.isPlaying && driver.loaded.count == 1 }
        try requireNative(model.playback.queue.count == 3 && Set(model.playback.queue.map(\.id)).count == 3, "repeated video has distinct occurrence UUIDs")
        let firstOccurrence = model.currentPlaybackTrack?.id
        model.next()
        try await waitNative { driver.loaded.count == 2 && model.isPlaying }
        try requireNative(model.currentPlaybackTrack?.trackID == youtube.id && model.currentPlaybackTrack?.id != firstOccurrence, "next traverses repeated recording occurrence")
        model.selectQueue(0)
        try await waitNative { driver.loaded.count == 3 && model.isPlaying }
        try requireNative(model.current?.id == studio.id && model.currentPlaybackTrack?.provider == .studio, "mixed queue routes Studio to its bundled resolver")
        model.removeQueueEntry(model.playback.queue[1].id, expectedRevision: model.playback.queueRevision)
        try requireNative(driver.loaded.count == 3 && model.playback.queue.count == 2, "noncurrent mixed edit retains current native load")
    }

    @MainActor private static func ownerCancellation() async throws {
        let held = HeldNativeResolver(), driver = NativeModelDriver()
        let cloud = CloudAccountStore(client: CloudAPIClient(transport: NativeFixtureTransport()), credentials: try NativeFixtureCredentials())
        let model = AureliaModel(driver: driver, resolver: ApplePlaybackResolver(youtube: held), store: LocalProfileStore(defaults: nil), cloud: cloud, youtubePlaybackAvailable: true)
        defer { model.dispose() }
        model.playCloudTracks([try nativeTrack()])
        try await waitNative { await held.count == 1 }
        model.setVolume(0.8) // Mock driver only; no OS audio is instantiated.
        await cloud.restore()
        try requireNative(cloud.account?.id == "mock-owner", "fixture bootstrap validates account without Keychain or network")
        try requireNative(model.playback.queue.isEmpty && driver.volumes.last == 0 && model.volume == 0.8, "validated account change clears guest queue and mutes driver while retaining chosen volume")
        try await held.release()
        try await Task.sleep(for: .milliseconds(20))
        try requireNative(driver.loaded.isEmpty && driver.plays == 0, "cancel-ignoring guest resolver cannot load under account")
        model.playCloudTracks([try nativeTrack()], expectedAccountID: "mock-owner")
        try await waitNative { await held.count == 2 }
        cloud.onIdentityChange?() // Same synchronous hook used at sign-out start.
        try await held.release()
        try await Task.sleep(for: .milliseconds(20))
        try requireNative(model.playback.queue.isEmpty && driver.volumes.last == 0 && model.volume == 0.8 && driver.loaded.isEmpty, "sign-out boundary invalidates pending account resolver without resetting chosen volume")
    }

    @MainActor private static func metadataQueueRestore() async throws {
        let suite = "aurelia-youtube-model-\(UUID().uuidString)", track = try nativeTrack()
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = LocalProfileStore(defaults: defaults)
        var previous = LocalProfile()
        previous.queueIDs = Array(StudioCatalogue.tracks.prefix(2).map(\.id)); previous.queueIndex = 1; previous.position = 17
        previous.likes = [StudioCatalogue.tracks[0].id]; previous.appearance = .dark
        previous.playlists = [LocalPlaylist(name: "Preserved", trackIDs: [StudioCatalogue.tracks[0].id])]
        store.save(previous)
        let driver = NativeModelDriver()
        let model = AureliaModel(driver: driver, resolver: ApplePlaybackResolver(youtube: InstantNativeResolver()), store: store, youtubePlaybackAvailable: true)
        try await waitNative { model.playback.status == .paused }
        try requireNative(driver.plays == 0 && model.playback.position == 17, "prior Studio restore is paused")
        model.playCloudTracks(Array(repeating: track, count: 501), at: 500)
        try await waitNative { model.isPlaying }
        try requireNative(model.playback.queue.count == 1 && model.playback.index == 0, "501-song tail selection queues only its remaining song")
        driver.progress(56, duration: 123)
        let saved = store.load()
        try requireNative(saved.queueIDs.isEmpty && saved.queueIndex == 0 && saved.position == 0, "explicit YouTube replacement clears old Studio queue and index")
        try requireNative(saved.likes == previous.likes && saved.playlists == previous.playlists && saved.appearance == previous.appearance, "local collections and theme remain intact")
        let text = String(decoding: try JSONEncoder().encode(saved), as: UTF8.self)
        try requireNative(!text.contains("youtube") && !text.contains("://") && !text.contains("volume") && !text.contains("playing"), "legacy Studio profile has no YouTube identity, source, playing or volume")
        let occurrence = model.currentPlaybackTrack!.id
        model.dispose()
        let nextDriver = NativeModelDriver()
        let next = AureliaModel(driver: nextDriver, resolver: ApplePlaybackResolver(youtube: InstantNativeResolver()), store: store, youtubePlaybackAvailable: true)
        defer { next.dispose() }
        try await waitNative { next.playback.status == .paused }
        try requireNative(next.playback.queue.count == 1 && next.currentPlaybackTrack?.id == occurrence && next.currentPlaybackTrack?.provider == .youtube,
                          "relaunch restores replacement YouTube occurrence without resurrecting old Studio queue")
        try requireNative(next.playback.position == 56 && nextDriver.plays == 0 && nextDriver.volumes.allSatisfy { $0 == 0 },
                          "metadata restore retains position and never autoplays")
    }

    @MainActor private static func largeCollection() async throws {
        let driver = NativeModelDriver()
        let model = AureliaModel(driver: driver, resolver: ApplePlaybackResolver(youtube: InstantNativeResolver()), store: LocalProfileStore(defaults: nil), youtubePlaybackAvailable: true)
        defer { model.dispose() }
        let tracks = try (0..<601).map { index in
            let videoID = String(format: "%011d", index + 1)
            return try nativeTrack(overrides: ["id": "youtube:\(videoID)", "externalId": videoID,
                                               "title": "Window song \(index)", "duration": 1000 + index])
        }
        model.playCloudTracks(tracks, at: 100)
        try await waitNative { model.isPlaying && driver.loaded.count == 1 }
        try requireNative(model.playback.queue.count == 500 && model.playback.index == 0, "large selection becomes bounded queue beginning at selection")
        try requireNative(model.playback.queue.map(\.trackID) == tracks[100..<600].map(\.id), "window preserves upcoming order and excludes history and excess tail")
        try requireNative(model.currentPlaybackTrack?.title == tracks[100].title && model.currentDuration == 1100, "window durations are zipped from selected slice")
        model.next()
        try await waitNative { model.isPlaying && driver.loaded.count == 2 }
        try requireNative(model.currentPlaybackTrack?.trackID == tracks[101].id && model.currentDuration == 1101, "following window duration and selection remain aligned")

        model.playCloudTracks(Array(tracks.prefix(501)), at: 1)
        try await waitNative { model.isPlaying && driver.loaded.count == 3 }
        try requireNative(model.playback.queue.count == 500 && model.playback.queue.last?.trackID == tracks[500].id, "501-song collection accepts selection and fills only bounded upcoming window")
        try requireNative(model.currentPlaybackTrack?.trackID == tracks[1].id && model.currentDuration == 1001, "501-song selection is not silently reset to original first track")

        model.playCloudTracks(tracks, at: 600)
        try await waitNative { model.isPlaying && driver.loaded.count == 4 }
        try requireNative(model.playback.queue.count == 1 && model.playback.index == 0 && model.currentDuration == 1600, "tail index creates one correctly timed occurrence")

        let duplicate = tracks[0]
        model.playCloudTracks(Array(repeating: duplicate, count: 501))
        try await waitNative { model.isPlaying && driver.loaded.count == 5 }
        try requireNative(model.playback.queue.count == 500 && Set(model.playback.queue.map(\.id)).count == 500, "bounded window does not deduplicate repeated recordings or occurrence identities")

        model.playCloudTracks(Array(tracks.prefix(500)), at: 499)
        try await waitNative { model.isPlaying && driver.loaded.count == 6 }
        try requireNative(model.playback.queue.count == 500 && model.playback.index == 499 && model.currentDuration == 1499, "small collections retain presented history and original selected index")
        let unchanged = model.playback.queue, revision = model.playback.queueRevision
        model.playCloudTracks(Array(tracks.prefix(501)), at: 501)
        model.playCloudTracks(tracks, at: -1)
        model.playCloudTracks(Array(repeating: duplicate, count: 20_001))
        try requireNative(model.playback.queue == unchanged && model.playback.queueRevision == revision && model.notice != nil, "invalid original indices and collection cap reject before queue conversion")

        var outsideInvalid = tracks
        outsideInvalid[0] = try nativeTrack(overrides: ["provider": "unknown"])
        model.playCloudTracks(outsideInvalid, at: 600)
        try await waitNative { model.isPlaying && driver.loaded.count == 7 }
        try requireNative(model.playback.queue.count == 1 && model.currentPlaybackTrack?.trackID == tracks[600].id, "metadata outside requested window is not converted or allowed to block selection")
        model.playCloudTracks(Array(repeating: duplicate, count: 20_000), at: 19_999)
        try await waitNative { model.isPlaying && driver.loaded.count == 8 }
        try requireNative(model.playback.queue.count == 1 && model.currentDuration == 1000, "cloud contract maximum selects a bounded correctly timed tail")

        let studioDriver = NativeModelDriver()
        let studioModel = AureliaModel(driver: studioDriver, store: LocalProfileStore(defaults: nil))
        defer { studioModel.dispose() }
        var sourceOff = Array(repeating: try nativeTrack(youtube: false), count: 601)
        sourceOff[0] = duplicate
        studioModel.playCloudTracks(sourceOff, at: 600)
        try await waitNative { studioModel.isPlaying }
        try requireNative(studioModel.playback.queue.count == 1 && studioModel.current?.id == sourceOff[600].id, "unavailable YouTube outside the window cannot block a playable Studio selection")
    }

    @MainActor private static func pendingQueueSelection() async throws {
        let held = HeldNativeResolver(), driver = NativeModelDriver()
        let first = try nativeTrack(), second = try nativeTrack(overrides: ["id": "youtube:00000000002", "externalId": "00000000002", "title": "Second mock recording"])
        let model = AureliaModel(driver: driver, resolver: ApplePlaybackResolver(youtube: held), store: LocalProfileStore(defaults: nil), youtubePlaybackAvailable: true)
        defer { model.dispose() }
        model.playCloudTracks([first, second])
        try await waitNative { await held.count == 1 }
        let secondOccurrence = model.playback.queue[1].id, revision = model.playback.queueRevision
        try requireNative(model.playback.status == .loading, "explicit play is resolving before queue selection")
        model.selectQueueEntry(secondOccurrence, expectedRevision: revision)
        try await waitNative { await held.count == 2 }
        try await held.release(0)
        try await Task.sleep(for: .milliseconds(20))
        try requireNative(driver.loaded.isEmpty && driver.plays == 0, "old cancelled selection cannot load before newly selected recording resolves")
        try await held.release(1)
        try await waitNative { model.isPlaying }
        try requireNative(driver.loaded.count == 1 && driver.loaded[0].id == secondOccurrence && driver.plays == 1, "selection preserves pending explicit play intent")
        try requireNative(model.playback.queueRevision == revision, "selection preserves queue occurrence identities and revision")

        model.playCloudTracks([first, second])
        try await waitNative { await held.count == 3 }
        model.pause()
        let pausedOccurrence = model.playback.queue[1].id
        model.selectQueue(1) // Compatibility wrapper must preserve the same intent.
        try await waitNative { await held.count == 4 }
        try await held.release(2)
        try await held.release(3)
        try await waitNative { driver.loaded.count == 2 && model.playback.status == .paused }
        try requireNative(model.currentPlaybackTrack?.id == pausedOccurrence && driver.plays == 1, "explicitly paused pending selection remains paused")
        let staleRevision = model.playback.queueRevision
        model.moveQueueEntry(model.playback.queue[0].id, by: 1, expectedRevision: staleRevision)
        model.selectQueueEntry(model.playback.queue[1].id, expectedRevision: staleRevision)
        try requireNative(model.currentPlaybackTrack?.id == pausedOccurrence && model.notice != nil && driver.loaded.count == 2, "stale captured queue selection cannot choose a different occurrence")
    }

    @MainActor private static func normalVolumePreference() async throws {
        let driver = NativeModelDriver(), track = try nativeTrack()
        let cloud = CloudAccountStore(client: CloudAPIClient(transport: NativeFixtureTransport()), credentials: try NativeFixtureCredentials())
        let model = AureliaModel(driver: driver, resolver: ApplePlaybackResolver(youtube: InstantNativeResolver()), store: LocalProfileStore(defaults: nil), cloud: cloud, youtubePlaybackAvailable: true)
        defer { model.dispose() }
        try requireNative(model.volume == 0.75 && driver.volumes == [0], "normal session preference is audible but startup driver remains muted")
        try requireNative(model.playback.queue.isEmpty && driver.loaded.isEmpty && driver.plays == 0, "normal startup never selects or plays music")
        model.playCloudTracks([track])
        try await waitNative { model.isPlaying }
        try requireNative(driver.volumes.last == 0.75 && driver.plays == 1, "first explicit YouTube selection applies normal listening volume")
        model.setVolume(0)
        model.pause(); model.togglePlayback()
        try requireNative(model.isPlaying && driver.volumes.last == 0 && model.volume == 0, "explicit resume preserves deliberate manual mute")
        model.setVolume(0.42)
        await cloud.restore()
        try requireNative(model.playback.queue.isEmpty && driver.volumes.last == 0 && model.volume == 0.42, "validated account boundary clears and mutes actual driver without losing chosen level")
        let previousPlays = driver.plays
        model.playCloudTracks([track], expectedAccountID: "mock-owner")
        try await waitNative { model.isPlaying && driver.plays == previousPlays + 1 }
        try requireNative(driver.volumes.last == Float(0.42) && model.volume == 0.42, "next explicit account selection reapplies chosen level")
        model.setVolume(0)
        cloud.onIdentityChange?()
        try requireNative(model.playback.queue.isEmpty && driver.volumes.last == 0 && model.volume == 0, "account boundary also preserves intentional zero preference")
        model.playCloudTracks([track], expectedAccountID: "mock-owner")
        try await waitNative { model.isPlaying }
        try requireNative(driver.volumes.last == 0 && model.volume == 0, "next explicit selection does not override intentional mute")

        let mutedDriver = NativeModelDriver()
        let muted = AureliaModel(driver: mutedDriver, resolver: ApplePlaybackResolver(youtube: InstantNativeResolver()), store: LocalProfileStore(defaults: nil), forceMuted: true, youtubePlaybackAvailable: true)
        defer { muted.dispose() }
        muted.setVolume(1); muted.playCloudTracks([track])
        try await waitNative { muted.isPlaying }
        muted.pause(); muted.togglePlayback()
        try requireNative(muted.volume == 0 && mutedDriver.volumes.allSatisfy { $0 == 0 }, "forced QA keeps both preference and every driver write at zero")
    }

    @MainActor private static func systemVolumePreference() async throws {
        let suite = "aurelia-system-play-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = LocalProfileStore(defaults: defaults)
        var saved = LocalProfile()
        saved.queueIDs = [StudioCatalogue.tracks[0].id]; saved.position = 12
        store.save(saved)
        let cloud = CloudAccountStore(client: CloudAPIClient(transport: NativeFixtureTransport()), credentials: try NativeFixtureCredentials())
        let driver = NativeModelDriver()
        let model = AureliaModel(driver: driver, resolver: ApplePlaybackResolver(youtube: InstantNativeResolver()), store: store, cloud: cloud, youtubePlaybackAvailable: true)
        defer { model.dispose() }
        try await waitNative { model.playback.status == .paused }
        try requireNative(driver.plays == 0 && driver.volumes.allSatisfy { $0 == 0 } && model.volume == 0.75, "cold queue restoration never applies audible gain or autoplay")
        driver.control(.play)
        try requireNative(model.isPlaying && driver.plays == 1 && driver.gainAtPlay == [0.75], "system play applies preference before driver.play after cold paused restore")
        model.setVolume(0); driver.control(.pause); driver.control(.play)
        try requireNative(model.isPlaying && driver.gainAtPlay.last == 0 && model.volume == 0, "system resume honours intentional mute")
        model.setVolume(0.42)
        await cloud.restore()
        let playsBeforeEmptyRemote = driver.plays, writesBeforeEmptyRemote = driver.volumes.count
        driver.control(.play)
        try requireNative(model.playback.queue.isEmpty && driver.plays == playsBeforeEmptyRemote && driver.volumes.count == writesBeforeEmptyRemote,
                          "empty system play after account boundary neither selects music nor reapplies gain")
        try requireNative(driver.volumes.last == 0 && model.volume == 0.42, "account boundary keeps chosen preference and actual muted driver")
        model.playCloudTracks([try nativeTrack()], expectedAccountID: "mock-owner")
        try await waitNative { model.isPlaying }
        try requireNative(driver.gainAtPlay.last == Float(0.42), "new account selection plays at preserved chosen level")
        driver.control(.pause)
        driver.setVolume(0) // Simulate a muted driver without changing preference.
        driver.control(.play)
        try requireNative(model.isPlaying && driver.gainAtPlay.last == Float(0.42), "direct system resume reasserts chosen gain before actual play")

        store.save(saved)
        let mutedDriver = NativeModelDriver()
        let muted = AureliaModel(driver: mutedDriver, store: store, forceMuted: true)
        defer { muted.dispose() }
        try await waitNative { muted.playback.status == .paused }
        mutedDriver.control(.play)
        try requireNative(muted.isPlaying && mutedDriver.gainAtPlay == [0] && mutedDriver.volumes.allSatisfy { $0 == 0 }, "forced QA system play stays muted after restore")
        muted.clearQueue(expectedRevision: muted.playback.queueRevision)
        let playsBeforeClear = mutedDriver.plays, writesBeforeClear = mutedDriver.volumes.count
        mutedDriver.control(.play)
        try requireNative(muted.playback.queue.isEmpty && mutedDriver.plays == playsBeforeClear && mutedDriver.volumes.count == writesBeforeClear, "empty system transport cannot recreate a queue or invoke the play hook")
    }
}
