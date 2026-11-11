import Foundation
@testable import AureliaCloud

private enum ParityFailure: Error { case assertion(String) }
private func parityExpect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw ParityFailure.assertion(message) }
}
private func parityJSON(_ value: Any, status: Int = 200) -> CloudHTTPResponse {
    CloudHTTPResponse(status: status, body: try! JSONSerialization.data(withJSONObject: value))
}
private actor ParityTransport: CloudHTTPTransport {
    enum Step: Sendable { case response(CloudHTTPResponse), held }
    var requests: [URLRequest] = []
    let steps: [Step]
    private var pending: CheckedContinuation<CloudHTTPResponse, Error>?
    init(_ responses: [CloudHTTPResponse]) { steps = responses.map(Step.response) }
    init(steps: [Step]) { self.steps = steps }
    func send(_ request: URLRequest, maxBytes: Int) async throws -> CloudHTTPResponse {
        let index = requests.count; requests.append(request)
        guard steps.indices.contains(index) else { throw CloudFailure.unavailable }
        switch steps[index] {
        case .response(let response): return response
        case .held: return try await withCheckedThrowingContinuation { pending = $0 }
        }
    }
    func finish(_ response: CloudHTTPResponse) { pending?.resume(returning: response); pending = nil }
    var count: Int { requests.count }
}
@MainActor private final class ParityCredentials: CredentialStoring {
    var value: CloudCredential?
    init(_ value: CloudCredential) { self.value = value }
    func load() throws -> CloudCredential? { value }
    func save(_ credential: CloudCredential) throws { value = credential }
    func delete() throws { value = nil }
}
private func parityTrack(_ id: String = "1", title: String = "Song", artist: String = "Artist", duration: Double = 60) -> [String: Any] {
    ["id": "studio:test-\(id)", "title": title, "artist": artist, "album": "Album", "provider": "studio", "externalId": id,
     "duration": duration, "artwork": "/art/test.svg"]
}
private func parityLyrics(_ id: Int = 1) -> [String: Any] {
    ["id": id, "trackName": "Song", "artistName": "Artist", "albumName": "Album", "duration": 60, "instrumental": false,
     "plainLyrics": "First\nSecond", "syncedLyrics": "[00:00.50]First\n[00:02.00]Second"]
}
private func parityBootstrap() -> CloudHTTPResponse {
    parityJSON(["user": ["id": "owner", "name": "Listener", "email": NSNull(), "identities": []],
        "library": ["likes": [], "playlists": [], "history": [], "searches": []], "capabilities": [:], "recommendations": []])
}
private func parityImportResult() -> [String: Any] {
    ["id": "00000000-0000-0000-0000-000000000001", "jobs": [["id": "00000000-0000-0000-0000-000000000001", "provider": "aurelia", "status": "complete", "total": 0, "imported": 0, "matched": 0, "unmatched": 0, "failed": 0, "notice": NSNull()]], "items": []]
}

@MainActor func runCloudParityChecks() async throws {
    try lyricsParsingAndCollectionViews()
    try await lyricsBoundaryAndSessions()
    try await listeningAndTransferContracts()
    try await ownerBoundaryAndOfflineAuthorization()
    try await selectedLyricsPersistence()
}

private func lyricsParsingAndCollectionViews() throws {
    let lines = LyricsLine.parse("[ar:Artist]\n[00:02.25][00:01:005]Two stamps\r\n[00:03]♪\n[00:70]Invalid")
    try parityExpect(lines.map(\.time) == [1.005, 2.25, 3], "LRC stamps sorted with hundredths/milliseconds, invalid stamps omitted")
    try parityExpect(lines.map(\.text) == ["Two stamps", "Two stamps", "♪"], "LRC metadata stripped")
    try parityExpect(LyricsLine.activeIndex(in: lines, position: 0) == nil, "no highlight before first line")
    try parityExpect(LyricsLine.activeIndex(in: lines, position: 2.25) == 1, "line timestamp boundary highlighted")
    try parityExpect(LyricsLine.activeIndex(in: lines, position: .nan) == nil, "nonfinite playback rejected")
    let decoder = JSONDecoder()
    let tracks = try [parityTrack("1", title: "Éclair 10", artist: "Beta", duration: 120),
        parityTrack("2", title: "Eclair 2", artist: "Alpha", duration: 60),
        parityTrack("3", title: "Other", artist: "Beta", duration: 60)].map {
            try decoder.decode(TrackDTO.self, from: JSONSerialization.data(withJSONObject: $0))
        }
    try parityExpect(CloudCollectionView.tracks(tracks, query: "éCLAIR", sort: .saved).map(\.id) == [tracks[0].id, tracks[1].id], "filter preserves saved order")
    try parityExpect(CloudCollectionView.tracks(tracks, query: "", sort: .title).map(\.id) == [tracks[1].id, tracks[0].id, tracks[2].id], "numeric title sort")
    try parityExpect(CloudCollectionView.tracks(tracks, query: "", sort: .duration).map(\.id) == [tracks[1].id, tracks[2].id, tracks[0].id], "stable equal-duration order")
    try parityExpect(tracks.map(\.title) == ["Éclair 10", "Eclair 2", "Other"], "display sort did not mutate source")
}

@MainActor private func lyricsBoundaryAndSessions() async throws {
    let transport = ParityTransport([parityJSON([parityLyrics()]), parityJSON([parityLyrics(2)])])
    let music = CloudMusicStore(client: CloudAPIClient(transport: transport))
    let first = music.makeLyricsSession(), second = music.makeLyricsSession()
    await first.search("  Song Artist  "); await second.search("Different Artist")
    try parityExpect(first.records.first?.id == 1 && second.records.first?.id == 2, "independent lyrics recording results")
    let request = await transport.requests[0]
    try parityExpect(request.url?.path == "/api/lyrics" && URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems == [URLQueryItem(name: "q", value: "Song Artist")], "fixed exact lyrics endpoint")
    try parityExpect(request.value(forHTTPHeaderField: "Authorization") == nil && !request.httpShouldHandleCookies, "lyrics is anonymous")
    first.reset(); try parityExpect(first.records.isEmpty && second.records.count == 1, "lyrics close reset isolated")
    let client = CloudAPIClient(transport: transport)
    for invalid in ["x", "\n", String(repeating: "a", count: 201)] {
        do { _ = try await client.lyrics(invalid); throw ParityFailure.assertion("invalid lyrics query sent") }
        catch CloudFailure.invalidResponse {}
    }
    let count = await transport.count
    try parityExpect(count == 2, "invalid queries did not reach transport")
    for path in ["/api/lyrics?q=x", "/api/lyrics?q=Song&q=Other", "/api/lyrics?q=Song&provider=youtube"] {
        try parityExpect(!CloudAPIClient.isAPIURL(URL(string: "https://aurelia.lattelix.com" + path)!), "extra or invalid lyrics query refused")
    }
    do {
        _ = try await CloudAPIClient(transport: ParityTransport([parityJSON([parityLyrics(), parityLyrics()])])).lyrics("Song")
        throw ParityFailure.assertion("duplicate recording IDs accepted")
    } catch CloudFailure.invalidResponse {}
    let racing = ParityTransport(steps: [.held, .response(parityJSON([parityLyrics(3)]))])
    let session = CloudLyricsStore(client: CloudAPIClient(transport: racing))
    let old = Task { await session.search("Old Song") }
    for _ in 0..<100 { if await racing.count > 0 { break }; await Task.yield() }
    await session.search("New Song")
    await racing.finish(parityJSON([parityLyrics(4)])); await old.value
    try parityExpect(session.records.first?.id == 3, "late lyrics response cannot replace new search")
}

private func listeningAndTransferContracts() async throws {
    let auth = try CloudCredential(token: String(repeating: "a", count: 43), accountID: "owner", expiresAt: Date().addingTimeInterval(3600))
    let export: [String: Any] = ["format": "aurelia-library", "version": 1, "exportedAt": "2026-11-10T00:00:00Z", "tracks": [], "likes": [], "playlists": [], "artists": [], "history": [], "searches": [], "notices": []]
    let transport = ParityTransport([parityJSON(["ok": true]), parityJSON(["ok": true]), parityJSON([["track": parityTrack(), "score": 1.5, "reason": "Because you listened"]]), parityJSON(export), parityJSON(parityImportResult()), parityJSON(["ok": true])])
    let client = CloudAPIClient(transport: transport), playID = UUID()
    try await client.recordHistory(trackID: "studio:test-1", playID: playID, completion: 0.5, credential: auth)
    try await client.recordSignal(.search, query: "New music", credential: auth)
    let recommendations = try await client.recommendations(auth)
    try parityExpect(recommendations.count == 1 && recommendations[0].reason == "Because you listened", "recommendation wire metadata")
    let data = try await client.exportLibrary(auth)
    let exportObject = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    try parityExpect(exportObject?["format"] as? String == "aurelia-library", "portable envelope returned")
    var upload = export; upload["notices"] = (0..<18).map { String(repeating: "a", count: 999) + String($0 % 10) }
    let uploadData = try JSONSerialization.data(withJSONObject: upload)
    let imported = try await client.importLibrary(uploadData, credential: auth)
    try parityExpect(imported.jobs.first?.status == "complete", "import actual jobs/items envelope decoded")
    try await client.deletePlaylist("00000000-0000-0000-0000-000000000001", credential: auth)
    let requests = await transport.requests
    try parityExpect(requests.allSatisfy { $0.value(forHTTPHeaderField: "X-Aurelia-Account") == "owner" && $0.value(forHTTPHeaderField: "Authorization") == "Bearer " + String(repeating: "a", count: 43) }, "all listening/transfer endpoints owner-scoped")
    let body = try JSONSerialization.jsonObject(with: requests[0].httpBody!) as! [String: Any]
    try parityExpect(body["playId"] as? String == playID.uuidString && body["completion"] as? Double == 0.5, "history occurrence idempotency payload")
    try parityExpect(requests[4].httpBody == uploadData && CloudAPIClient.requestBodyLimit(requests[4]) == 2_000_000, "bounded import exception preserves raw JSON")
    var anonymousUpload = requests[4]; anonymousUpload.setValue(nil, forHTTPHeaderField: "Authorization")
    try parityExpect(CloudAPIClient.requestBodyLimit(anonymousUpload) == 16 * 1024, "anonymous upload does not expand body allowance")
    for invalid in [Double.nan, -0.1, 1.1] {
        do { try await client.recordHistory(trackID: "studio:test-1", playID: playID, completion: invalid, credential: auth); throw ParityFailure.assertion("invalid completion sent") }
        catch CloudFailure.invalidResponse {}
    }
    let count = await transport.count
    try parityExpect(count == 6, "invalid activity rejected before IO")
}

@MainActor private func ownerBoundaryAndOfflineAuthorization() async throws {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let auth = try CloudCredential(token: String(repeating: "a", count: 43), accountID: "owner", expiresAt: now.addingTimeInterval(3600))
    let offline = CloudAccountStore(client: CloudAPIClient(transport: ParityTransport([parityJSON([:], status: 503)])), credentials: ParityCredentials(auth), now: { now })
    await offline.restore()
    try parityExpect(offline.phase == .offline && offline.account == nil && offline.authorizedOwnerID == "owner", "valid stored owner can open downloads on cold offline boot")
    let expired = try CloudCredential(token: String(repeating: "a", count: 43), accountID: "owner", expiresAt: now.addingTimeInterval(-1))
    let denied = CloudAccountStore(client: CloudAPIClient(transport: ParityTransport([])), credentials: ParityCredentials(expired), now: { now })
    await denied.restore()
    try parityExpect(denied.authorizedOwnerID == nil && denied.phase == .expired, "expired owner has no offline authorization")
    let transport = ParityTransport(steps: [.response(parityBootstrap()), .held, .response(parityJSON(["ok": true]))])
    let store = CloudAccountStore(client: CloudAPIClient(transport: transport), credentials: ParityCredentials(auth), now: { now })
    await store.restore()
    let old = Task { await store.loadRecommendations(expectedAccountID: "owner") }
    for _ in 0..<100 { if await transport.count >= 2 { break }; await Task.yield() }
    await store.signOut(expectedAccountID: "owner")
    await transport.finish(parityJSON([["track": parityTrack(), "score": 1, "reason": "Old account"]])); await old.value
    try parityExpect(store.authorizedOwnerID == nil && store.recommendations.isEmpty && !store.recommendationsLoading, "late owner recommendation discarded after signout")
}

private func selectedLyricsPersistence() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("AureliaLyricsChecks-" + UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = LyricsSelectionCache(directory: directory)
    let record = try JSONDecoder().decode(LyricsDTO.self, from: JSONSerialization.data(withJSONObject: parityLyrics()))
    let saved = await cache.save(record, for: "studio:test-1")
    try parityExpect(saved, "chosen lyrics recording persisted locally")
    let cold = LyricsSelectionCache(directory: directory)
    let restored = await cold.selection(for: "studio:test-1")
    try parityExpect(restored == record && restored?.lines.count == 2, "cold offline cache restores exact selected plain and synced text")
    for id in 2...55 { _ = await cache.save(record, for: "studio:test-\(id)") }
    let old = await cache.selection(for: "studio:test-1"), recent = await cache.selection(for: "studio:test-55")
    try parityExpect(old == nil && recent != nil, "selected cache evicts oldest beyond fifty records")
    let url = directory.appendingPathComponent("selected-lyrics.json")
    let data = try Data(contentsOf: url)
    let envelope = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let entries = envelope["entries"] as! [[String: Any]]
    try parityExpect(entries.count == 50 && data.count <= LyricsSelectionCache.maximumBytes, "persistent selected-record and byte caps")
    try parityExpect(Set(envelope.keys) == ["version", "entries"] && entries.allSatisfy { Set($0.keys) == ["trackID", "record", "selectedAt"] }, "cache stores public recording metadata only")
    var large = parityLyrics(2)
    large["plainLyrics"] = String(repeating: "\\", count: 100_000)
    large["syncedLyrics"] = String(repeating: "\\", count: 100_000)
    let largeRecord = try JSONDecoder().decode(LyricsDTO.self, from: JSONSerialization.data(withJSONObject: large))
    for id in 56...70 { _ = await cache.save(largeRecord, for: "studio:test-\(id)") }
    let bounded = try Data(contentsOf: url)
    let boundedEntries = (try JSONSerialization.jsonObject(with: bounded) as! [String: Any])["entries"] as! [[String: Any]]
    try parityExpect(bounded.count <= LyricsSelectionCache.maximumBytes && boundedEntries.count < 50, "byte pressure evicts records before five MiB")
    let coldBounded = LyricsSelectionCache(directory: directory)
    let newest = await coldBounded.selection(for: "studio:test-70")
    try parityExpect(newest?.id == 2, "latest selected version remains readable after byte eviction")
    try Data(repeating: 0, count: LyricsSelectionCache.maximumBytes + 1).write(to: url)
    let oversized = LyricsSelectionCache(directory: directory)
    let rejected = await oversized.selection(for: "studio:test-70")
    try parityExpect(rejected == nil, "oversized local cache is rejected before decoding")
}
