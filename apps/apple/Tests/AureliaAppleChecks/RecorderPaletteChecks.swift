import Foundation
@testable import AureliaAppleUI
@testable import AureliaPlaybackCore
import AureliaCloud

private enum RecorderCheckFailure: Error { case failed(String) }
private func requireRecorder(_ value: @autoclosure () -> Bool, _ message: String) throws {
    if !value() { throw RecorderCheckFailure.failed(message) }
}
@MainActor private func waitRecorder(_ predicate: () async -> Bool) async throws {
    for _ in 0..<200 {
        if await predicate() { return }
        try await Task.sleep(for: .milliseconds(5))
    }
    throw RecorderCheckFailure.failed("recorder deadline")
}

/// The initializer creates no preference writes; every data read/write used by
/// the recorder is intercepted. No standard domain or disk-backed suite is used.
private final class RecorderMemoryDefaults: UserDefaults, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    private var writes = 0
    init(inMemory: Bool) { super.init(suiteName: "aurelia-in-memory-recorder-check")! }
    override func data(forKey key: String) -> Data? {
        lock.lock(); defer { lock.unlock() }; return values[key]
    }
    override func set(_ value: Any?, forKey key: String) {
        lock.lock(); defer { lock.unlock() }
        values[key] = value as? Data; writes += 1
    }
    var writeCount: Int { lock.lock(); defer { lock.unlock() }; return writes }
    var stored: [String: Data] { lock.lock(); defer { lock.unlock() }; return values }
}
private final class RecorderClock: @unchecked Sendable {
    private let lock = NSLock()
    private var time: TimeInterval = 0
    func now() -> TimeInterval { lock.lock(); defer { lock.unlock() }; return time }
    func advance(_ seconds: TimeInterval = 1) { lock.lock(); time += seconds; lock.unlock() }
}
@MainActor private final class RecorderCredential: CredentialStoring {
    var credential: CloudCredential?
    init(owner: String) throws {
        credential = try CloudCredential(token: String(repeating: "r", count: 43), accountID: owner, expiresAt: Date().addingTimeInterval(600))
    }
    func load() throws -> CloudCredential? { credential }
    func save(_ value: CloudCredential) throws { credential = value }
    func delete() throws { credential = nil }
}
private struct RecordedHistory: Sendable {
    let owner: String
    let trackID: String
    let playID: String
    let completion: Double
}
private actor RecorderHTTP: CloudHTTPTransport {
    let owner: String
    private var online: Bool
    private var history: [RecordedHistory] = []
    private var deviceAttempts = 0
    init(owner: String, online: Bool) { self.owner = owner; self.online = online }
    func connect() { online = true }
    func results() -> [RecordedHistory] { history }
    func rejectedDeviceCount() -> Int { deviceAttempts }
    func send(_ request: URLRequest, maxBytes: Int) async throws -> CloudHTTPResponse {
        guard online else { throw CloudFailure.unavailable }
        if request.url?.path == "/api/bootstrap" {
            let payload: [String: Any] = ["user": ["id": owner, "name": "Recorder fixture", "email": NSNull(), "identities": []],
                "library": ["likes": [], "playlists": []], "capabilities": [:]]
            return .init(status: 200, body: try JSONSerialization.data(withJSONObject: payload))
        }
        guard let body = request.httpBody, let payload = try JSONSerialization.jsonObject(with: body) as? [String: Any],
              request.value(forHTTPHeaderField: "X-Aurelia-Account") == owner else { throw CloudFailure.invalidResponse }
        if request.url?.path == "/api/library/history" {
            guard let track = payload["trackId"] as? String else { throw CloudFailure.invalidResponse }
            if track.hasPrefix("device:") { deviceAttempts += 1; throw CloudFailure.unavailable }
            history.append(.init(owner: owner, trackID: track, playID: payload["playId"] as? String ?? "",
                                 completion: payload["completion"] as? Double ?? -1))
        } else if request.url?.path != "/api/library/signals" { throw CloudFailure.unavailable }
        return .init(status: 200, body: Data("{\"ok\":true}".utf8))
    }
}
private func recorderSnapshot(_ track: PlaybackTrack, position: Double, status: PlaybackStatus = .playing, duration: Double = 100) -> PlaybackSnapshot {
    var snapshot = PlaybackSnapshot()
    snapshot.queue = [track]; snapshot.index = 0; snapshot.position = position
    snapshot.duration = duration; snapshot.status = status
    return snapshot
}
@MainActor private func recorderCloud(owner: String, online: Bool) async throws -> (CloudAccountStore, RecorderHTTP) {
    let http = RecorderHTTP(owner: owner, online: online)
    let cloud = CloudAccountStore(client: .init(transport: http), credentials: try RecorderCredential(owner: owner))
    await cloud.restore()
    try requireRecorder(cloud.authorizedOwnerID == owner, "fixture credential authorizes the owner online or offline")
    return (cloud, http)
}

enum RecorderPaletteChecks {
    @MainActor static var cases: [(String, @MainActor () async throws -> Void)] {
        [("apple_recorder_local_play_cannot_block_cloud_history", localThenCloud),
         ("apple_recorder_paused_seek_and_bounded_completion_updates", intentAndBoundedUpdates),
         ("apple_recorder_offline_outbox_isolates_owners", ownerOutboxes),
         ("apple_recorder_repeat_one_reuses_queue_id_but_starts_new_listen", repeatOne),
         ("apple_palette_accents_meet_text_contrast_on_both_surfaces", paletteContrast),
         ("apple_export_names_bound_utf8_and_remove_path_components", exportNames)]
    }

    @MainActor private static func localThenCloud() async throws {
        let (cloud, http) = try await recorderCloud(owner: "recorder-local-owner", online: true)
        let defaults = RecorderMemoryDefaults(inMemory: true), clock = RecorderClock()
        let recorder = PlaybackActivityRecorder(defaults: defaults, monotonicNow: { clock.now() })
        let local = try PlaybackTrack(deviceID: UUID(), title: "Private local title", artist: "Local artist")
        for position in 0...20 { clock.advance(); recorder.accept(recorderSnapshot(local, position: Double(position)), cloud: cloud) }
        let youtube = try PlaybackTrack(videoID: "00000000001", title: "Cloud fixture", artist: "Fixture")
        for position in 0...11 { clock.advance(); recorder.accept(recorderSnapshot(youtube, position: Double(position)), cloud: cloud) }
        try await waitRecorder { !(await http.results()).isEmpty }
        let history = await http.results(), deviceAttempts = await http.rejectedDeviceCount()
        try requireRecorder(deviceAttempts == 0 && history.allSatisfy { $0.trackID == youtube.trackID }, "local files never enter or block cloud history")
        try requireRecorder(history[0].completion >= 0.1 && UUID(uuidString: history[0].playID) != nil, "actual progress emits a bounded completion with an idempotent play ID")
    }

    @MainActor private static func intentAndBoundedUpdates() async throws {
        let (cloud, _) = try await recorderCloud(owner: "recorder-progress-owner", online: false)
        let defaults = RecorderMemoryDefaults(inMemory: true), clock = RecorderClock()
        let recorder = PlaybackActivityRecorder(defaults: defaults, monotonicNow: { clock.now() })
        let track = try PlaybackTrack(videoID: "00000000002", title: "Intent fixture", artist: "Fixture")
        recorder.accept(recorderSnapshot(track, position: 0, status: .paused), cloud: cloud)
        clock.advance(60)
        recorder.accept(recorderSnapshot(track, position: 60, status: .paused), cloud: cloud)
        recorder.accept(recorderSnapshot(track, position: 60), cloud: cloud)
        for position in 61...80 { recorder.accept(recorderSnapshot(track, position: Double(position)), cloud: cloud) }
        for position in [0.0, 90, 0, 90, 0, 90] { recorder.accept(recorderSnapshot(track, position: position), cloud: cloud) }
        recorder.accept(recorderSnapshot(track, position: 90, status: .ended), cloud: cloud)
        try requireRecorder(defaults.writeCount == 0, "paused wall time and zero-elapsed small/large seeks cannot create listens")
        let next = try PlaybackTrack(videoID: "00000000003", title: "Progress fixture", artist: "Fixture")
        recorder.accept(recorderSnapshot(next, position: 0), cloud: cloud)
        for position in 1...19 { clock.advance(); recorder.accept(recorderSnapshot(next, position: Double(position)), cloud: cloud) }
        try requireRecorder(defaults.writeCount == 1, "10 seconds emits one update, intervening ticks do not rewrite the outbox")
        for position in 20...99 { clock.advance(); recorder.accept(recorderSnapshot(next, position: Double(position)), cloud: cloud) }
        try requireRecorder((8...10).contains(defaults.writeCount), "completion updates stay near 10% boundaries across 99 ticks")
        guard let data = defaults.stored.values.first,
              let events = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { throw RecorderCheckFailure.failed("memory outbox") }
        try requireRecorder(events.count == 1 && events[0]["trackID"] as? String == next.trackID, "one playback occurrence updates one event")
    }

    @MainActor private static func ownerOutboxes() async throws {
        let (firstCloud, firstHTTP) = try await recorderCloud(owner: "recorder-owner-A", online: false)
        let (secondCloud, secondHTTP) = try await recorderCloud(owner: "recorder-owner-B", online: false)
        let defaults = RecorderMemoryDefaults(inMemory: true), clock = RecorderClock()
        let recorder = PlaybackActivityRecorder(defaults: defaults, monotonicNow: { clock.now() })
        let firstTrack = try PlaybackTrack(videoID: "00000000004", title: "First owner fixture", artist: "Fixture")
        let secondTrack = try PlaybackTrack(videoID: "00000000005", title: "Second owner fixture", artist: "Fixture")
        for position in 0...11 { clock.advance(); recorder.accept(recorderSnapshot(firstTrack, position: Double(position)), cloud: firstCloud) }
        for position in 0...11 { clock.advance(); recorder.accept(recorderSnapshot(secondTrack, position: Double(position)), cloud: secondCloud) }
        try requireRecorder(defaults.stored.count == 2, "offline owners persist distinct outboxes")
        try requireRecorder(defaults.stored.allSatisfy { key, data in
            !key.contains("owner-A") && !key.contains("owner-B") && !String(decoding: data, as: UTF8.self).contains("://")
        }, "outbox keys are hashed and values hold no locators")
        await firstHTTP.connect(); await firstCloud.refresh()
        recorder.accept(recorderSnapshot(firstTrack, position: 11, status: .paused), cloud: firstCloud)
        try await waitRecorder { !(await firstHTTP.results()).isEmpty }
        let sentFirst = await firstHTTP.results(), sentSecondBeforeConnect = await secondHTTP.results()
        try requireRecorder(sentFirst.allSatisfy { $0.owner == "recorder-owner-A" && $0.trackID == firstTrack.trackID } && sentSecondBeforeConnect.isEmpty,
                            "reconnecting one owner never flushes another owner's saved activity")
        await secondHTTP.connect(); await secondCloud.refresh()
        recorder.accept(recorderSnapshot(secondTrack, position: 11, status: .paused), cloud: secondCloud)
        try await waitRecorder { !(await secondHTTP.results()).isEmpty }
        let sentSecond = await secondHTTP.results()
        try requireRecorder(sentSecond.allSatisfy { $0.owner == "recorder-owner-B" && $0.trackID == secondTrack.trackID }, "second owner resumes only their own outbox")
    }

    @MainActor private static func repeatOne() async throws {
        let (cloud, _) = try await recorderCloud(owner: "recorder-repeat-owner", online: false)
        let defaults = RecorderMemoryDefaults(inMemory: true), clock = RecorderClock()
        let recorder = PlaybackActivityRecorder(defaults: defaults, monotonicNow: { clock.now() })
        let track = try PlaybackTrack(videoID: "00000000006", title: "Repeat fixture", artist: "Fixture")
        for position in 0...100 { clock.advance(); recorder.accept(recorderSnapshot(track, position: Double(position)), cloud: cloud) }
        // The native repeat-one controller goes straight from playing to a new
        // loading snapshot at zero, retaining the same occurrence UUID.
        var loading = recorderSnapshot(track, position: 0, status: .loading); loading.repeatMode = .one
        recorder.accept(loading, cloud: cloud)
        recorder.accept(recorderSnapshot(track, position: 0), cloud: cloud)
        for position in 1...11 { clock.advance(); recorder.accept(recorderSnapshot(track, position: Double(position)), cloud: cloud) }
        guard let data = defaults.stored.values.first,
              let events = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { throw RecorderCheckFailure.failed("repeat outbox") }
        let ids = events.compactMap { $0["id"] as? String }
        try requireRecorder(events.count == 2 && Set(ids).count == 2, "repeat-one starts a fresh idempotent play ID for the same queue occurrence")
        try requireRecorder(events.contains { $0["signal"] as? String == "complete" && ($0["completion"] as? Double ?? 0) >= 0.9 }, "the previous complete cycle is finalized before reload")
        try requireRecorder(events.contains { ($0["completion"] as? Double ?? 1) < 0.2 }, "the new cycle resets listened time and completion")
    }

    @MainActor private static func paletteContrast() async throws {
        for choice in ThemePalette.allCases {
            for dark in [false, true] {
                for increased in [false, true] {
                    let palette = ApplePalette(palette: choice, dark: dark, increasedContrast: increased)
                    let background = palette.backgroundRGB, card = palette.cardRGB
                    try requireRecorder(ApplePalette.contrast(palette.accentRGB, background) >= 4.5,
                                        "\(choice.rawValue)/\(dark)/\(increased) accent \(palette.accentRGB) on background \(background) meets normal-text contrast")
                    try requireRecorder(ApplePalette.contrast(palette.accentRGB, card) >= 4.5,
                                        "\(choice.rawValue)/\(dark)/\(increased) accent on card \(card) meets normal-text contrast")
                    if choice == .base {
                        let expected = dark ? (250.0 / 255, 88.0 / 255, 106.0 / 255) : (214.0 / 255, 0.0, 23.0 / 255)
                        try requireRecorder(palette.accentRGB == expected, "Base uses the approved accessible Music-inspired red pair")
                        for surface in [palette.backgroundRGB, palette.cardRGB] {
                            let channels = [surface.0, surface.1, surface.2]
                            try requireRecorder(channels.allSatisfy { $0.isFinite && (0...1).contains($0) }, "native surface resolves to bounded sRGB")
                            try requireRecorder(channels.max()! - channels.min()! < 0.04, "Base surfaces remain neutral")
                            try requireRecorder(dark ? channels.max()! < 0.3 : channels.min()! > 0.8, "explicit in-app appearance selects the native surface mode")
                        }
                    }
                }
            }
        }
    }

    @MainActor private static func exportNames() async throws {
        for input in ["../../A/B\\C:bad\u{0}\n", String(repeating: "音楽", count: 100), String(repeating: "👩🏽‍💻", count: 100), "....", ""] {
            let name = AudioFileExport.safeName(input)
            try requireRecorder(!name.isEmpty && name.utf8.count <= 180, "names remain bounded in filesystem bytes")
            try requireRecorder(!name.contains("/") && !name.contains("\\") && !name.contains(":") && !name.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
                                "export metadata cannot form path components or control characters")
            let directory = URL(fileURLWithPath: "/aurelia-check-parent", isDirectory: true)
            try requireRecorder(directory.appendingPathComponent(name).deletingLastPathComponent().path == directory.path, "safe basename stays in the selected directory")
        }
    }
}
