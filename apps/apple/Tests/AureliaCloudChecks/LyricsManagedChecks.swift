import Foundation
@testable import AureliaCloud

private enum ManagedLyricsFailure: Error { case assertion(String) }
private func requireManagedLyrics(_ value: @autoclosure () -> Bool, _ label: String) throws {
    if !value() { throw ManagedLyricsFailure.assertion(label) }
}
private func legacyLyricsData(id: Int = 1) throws -> Data {
    try JSONSerialization.data(withJSONObject: ["id": id, "trackName": "Cached recording", "artistName": "Fixture artist", "albumName": "Fixture album",
        "duration": 120, "instrumental": false, "plainLyrics": "Cached text", "syncedLyrics": "[00:01.00]Cached text"])
}
private actor ManagedLyricsHTTP: CloudHTTPTransport {
    private(set) var calls = 0
    let response: Data?
    init(response: Data? = nil) { self.response = response }
    func send(_ request: URLRequest, maxBytes: Int) async throws -> CloudHTTPResponse {
        calls += 1
        guard let response else { throw CloudFailure.unavailable }
        return CloudHTTPResponse(status: 200, body: response)
    }
}
private actor HeldManagedLyrics {
    private(set) var entered = false
    private var continuation: CheckedContinuation<LyricsDTO?, Never>?
    func load() async -> LyricsDTO? {
        entered = true
        return await withCheckedContinuation { continuation = $0 }
    }
    func finish(_ value: LyricsDTO?) { continuation?.resume(returning: value); continuation = nil }
}
@MainActor private final class ManagedLyricsProbe { var completed = false }

enum CloudManagedLyricsChecks {
    @MainActor static var cases: [(String, @MainActor () async throws -> Void)] {
        [("managed_lyrics_provenance_identity_and_legacy_decode", provenance),
         ("managed_lyrics_precedes_independent_cache_without_network", precedence),
         ("managed_lyrics_cancel_and_reset_discard_late_owner_read", cancellation)]
    }
    private static func managed(_ text: String = "Saved text") throws -> LyricsDTO {
        guard let record = LyricsDTO.managed(trackName: "Native recording", artistName: "Fixture artist", albumName: "Fixture album",
            duration: 120, plainLyrics: text, syncedLyrics: "[00:01.00]" + text) else { throw ManagedLyricsFailure.assertion("valid managed factory") }
        return record
    }
    @MainActor private static func provenance() async throws {
        let record = try managed(), same = try managed(), changed = try managed("New selected text")
        try requireManagedLyrics(record.provenance == .managed && record.id == 0 && record.selectionID.hasPrefix("managed:"), "saved text never claims an LRCLIB recording id")
        try requireManagedLyrics(record.selectionID == same.selectionID && record.selectionID != changed.selectionID, "stable content identity distinguishes managed selections with id0")
        let roundtrip = try JSONDecoder().decode(LyricsDTO.self, from: JSONEncoder().encode(record))
        try requireManagedLyrics(roundtrip == record && roundtrip.lines.count == 1, "managed text and provenance roundtrip")
        let legacy = try JSONDecoder().decode(LyricsDTO.self, from: legacyLyricsData())
        try requireManagedLyrics(legacy.provenance == .lrclib && legacy.id == 1 && legacy.selectionID == "lrclib:1", "old public/cache records default to LRCLIB")
        for duration in [Double.nan, Double.infinity, -1, 86401] {
            try requireManagedLyrics(LyricsDTO.managed(trackName: "Track", artistName: "Artist", albumName: "", duration: duration, plainLyrics: "text", syncedLyrics: nil) == nil, "managed duration bounds")
        }
        try requireManagedLyrics(LyricsDTO.managed(trackName: "Track", artistName: "Artist", albumName: "", duration: 0, plainLyrics: nil, syncedLyrics: nil) == nil, "missing text does not become a saved recording")
        try requireManagedLyrics(LyricsDTO.managed(trackName: "Track", artistName: "Artist", albumName: "", duration: 1, plainLyrics: String(repeating: "x", count: 100001), syncedLyrics: nil) == nil, "managed text cap")
        do { _ = try JSONDecoder().decode(LyricsDTO.self, from: legacyLyricsData(id: 0)); throw ManagedLyricsFailure.assertion("public id0 admitted") }
        catch CloudFailure.invalidResponse {}
        let response = try JSONEncoder().encode([record])
        do { _ = try await CloudAPIClient(transport: ManagedLyricsHTTP(response: response)).lyrics("Fixture"); throw ManagedLyricsFailure.assertion("public endpoint impersonated managed provenance") }
        catch CloudFailure.invalidResponse {}
    }
    @MainActor private static func precedence() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("AureliaManagedLyrics-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let cache = LyricsSelectionCache(directory: folder), http = ManagedLyricsHTTP()
        let cached = try JSONDecoder().decode(LyricsDTO.self, from: legacyLyricsData())
        _ = await cache.save(cached, for: "youtube:00000000001")
        let store = CloudLyricsStore(client: CloudAPIClient(transport: http), selectionCache: cache)
        let gate = HeldManagedLyrics(), probe = ManagedLyricsProbe(), selected = try managed()
        let reading = Task { @MainActor in
            let result = await store.restorePreferredSelection(for: "youtube:00000000001", loadManaged: { await gate.load() })
            probe.completed = true; return result
        }
        for _ in 0..<200 { if await gate.entered { break }; await Task.yield() }
        let entered = await gate.entered
        try requireManagedLyrics(entered && !probe.completed, "managed lookup must finish before small-cache fallback")
        await gate.finish(selected)
        let result = await reading.value
        try requireManagedLyrics(result == selected, "download-owned text takes precedence over a different cache selection")
        let fallback = await store.restorePreferredSelection(for: "youtube:00000000001", loadManaged: { nil })
        try requireManagedLyrics(fallback == cached, "missing managed text falls back to local selection")
        let calls = await http.calls
        try requireManagedLyrics(calls == 0, "managed/cache restoration never performs a public request")
    }
    @MainActor private static func cancellation() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("AureliaManagedLyricsCancel-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let cache = LyricsSelectionCache(directory: folder), http = ManagedLyricsHTTP()
        let cached = try JSONDecoder().decode(LyricsDTO.self, from: legacyLyricsData())
        _ = await cache.save(cached, for: "youtube:00000000001")
        let store = CloudLyricsStore(client: CloudAPIClient(transport: http), selectionCache: cache)
        for reset in [false, true] {
            let gate = HeldManagedLyrics()
            let reading = Task { await store.restorePreferredSelection(for: "youtube:00000000001", loadManaged: { await gate.load() }) }
            for _ in 0..<200 { if await gate.entered { break }; await Task.yield() }
            if reset { store.reset() } else { reading.cancel() }
            await gate.finish(try managed())
            let result = await reading.value
            try requireManagedLyrics(result == nil, "cancel/reset discards a late owner-scoped text read")
        }
        let calls = await http.calls
        try requireManagedLyrics(calls == 0, "cancelled restoration does not fall through to network")
    }
}
