import Foundation
import AureliaPlaybackCore

private enum ContractFailure: Error { case assertion }
private func check(_ condition: @autoclosure () -> Bool) throws {
    guard condition() else { throw ContractFailure.assertion }
}
private actor FixtureHTTP: YouTubeHTTPTransport {
    enum Mode: Sendable { case direct, cipher, nTransform, queryRange, wrongIdentity, oversized, denied }
    let mode: Mode
    private(set) var mediaCalls = 0
    private(set) var playerCalls = 0
    private(set) var mediaRangeHeaders = 0
    private(set) var mediaRangeQueries = 0
    init(_ mode: Mode) { self.mode = mode }
    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        if request.url?.host != "www.youtube.com" {
            mediaCalls += 1
            if request.value(forHTTPHeaderField: "Range") != nil { mediaRangeHeaders += 1 }
            if URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
                .contains(where: { $0.name.caseInsensitiveCompare("range") == .orderedSame }) == true {
                mediaRangeQueries += 1
            }
            guard let range = PartialMediaSample.requestedRange(request.value(forHTTPHeaderField: "Range")) else {
                return BoundedHTTPResponse(status: 200, headers: [:], body: Data())
            }
            return BoundedHTTPResponse(
                status: 206,
                headers: [
                    "content-length": "1024",
                    "content-range": "bytes \(range.lowerBound)-\(range.upperBound)/10000"
                ],
                body: Data(repeating: 7, count: 1024)
            )
        }
        playerCalls += 1
        if mode == .oversized { return BoundedHTTPResponse(status: 200, headers: [:], body: Data(repeating: 0, count: 1024 * 1024 + 1)) }
        if mode == .denied {
            return BoundedHTTPResponse(status: 200, headers: [:], body: Data(#"{"playabilityStatus":{"status":"LOGIN_REQUIRED"}}"#.utf8))
        }
        var format: [String: Any] = ["mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "bitrate": 128000, "contentLength": "10000"]
        if mode == .cipher { format["signatureCipher"] = "not-evaluated" }
        else {
            format["url"] = "https://r1.googlevideo.com/videoplayback?expire=4000000000"
                + (mode == .nTransform ? "&n=not-evaluated" : "")
                + (mode == .queryRange ? "&range=0-1023" : "")
        }
        let data = try JSONSerialization.data(withJSONObject: [
            "videoDetails": ["videoId": mode == .wrongIdentity ? "00000000002" : "00000000001", "isLiveContent": false],
            "playabilityStatus": ["status": "OK"], "streamingData": ["adaptiveFormats": [format]]
        ])
        return BoundedHTTPResponse(status: 200, headers: [:], body: data)
    }
}

@MainActor
private final class ContractDriver: PlaybackDriving {
    var onEvent: (@MainActor (UInt64, PlaybackDriverEvent) -> Void)?
    func load(_ source: ResolvedAudio, track: PlaybackTrack, generation: UInt64) throws {}
    func play() {}
    func pause() {}
    func seek(to position: Double) {}
    func stop() {}
    func dispose() {}
}
private struct ContractResolver: PlaybackResolving {
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        try ResolvedAudio(url: URL(string: "https://r1.googlevideo.com/test")!, expiresAt: Date(timeIntervalSince1970: 4000000000))
    }
}

@MainActor
func checkDeviceRevisionIsolation() throws {
    func request(_ revision: String, _ trackID: String) throws -> DeviceQueueRequest {
        let data = try JSONSerialization.data(withJSONObject: [
            "revision": revision, "ownerId": "test-owner", "index": 0, "position": 0,
            "playing": false, "repeat": "off", "shuffle": false, "volume": 0.75,
            "tracks": [["entryId": UUID().uuidString, "trackId": trackID, "provider": "youtube",
                        "externalId": "00000000001", "title": "Test", "artist": "Test"]]
        ])
        return try JSONDecoder().decode(DeviceQueueRequest.self, from: data)
    }
    let audio = DeviceAudioCoordinator(resolver: ContractResolver(), driver: ContractDriver())
    defer { audio.dispose() }
    try audio.loadQueue(request("old", "db:first"))
    try audio.loadQueue(request("new", "db:second"))
    let before = try JSONSerialization.data(withJSONObject: audio.snapshot(), options: [.sortedKeys])
    let staleActions: [() throws -> Void] = [
        { try audio.play(revision: "old") }, { try audio.pause(revision: "old") },
        { try audio.next(revision: "old") }, { try audio.previous(revision: "old") },
        { try audio.seek(revision: "old", position: 20) }, { try audio.setRepeat(revision: "old", mode: .all) },
        { try audio.setShuffle(revision: "old", enabled: true) }, { try audio.setVolume(revision: "old", value: 0) },
        { try audio.stop(revision: "old") }
    ]
    for action in staleActions {
        var failure: PlaybackFailure?
        do { try action() } catch { failure = error as? PlaybackFailure }
        try check(failure == .staleRequest)
    }
    let after = try JSONSerialization.data(withJSONObject: audio.snapshot(), options: [.sortedKeys])
    try check(before == after)
    try audio.stop(revision: "new")
    try check((audio.snapshot()["queue"] as? [[String: Any]])?.isEmpty == true)
    try check(audio.snapshot()["ownerId"] is NSNull)
    try check(audio.snapshot()["revision"] as? String != "new")
    let emptyBefore = try JSONSerialization.data(withJSONObject: audio.snapshot(), options: [.sortedKeys])
    let tooMany = (0..<501).map { index in
        ["entryId": UUID().uuidString, "trackId": "db:\(index)", "provider": "youtube",
         "externalId": "00000000001", "title": "Test", "artist": "Test"]
    }
    let oversized = try JSONSerialization.data(withJSONObject: [
        "revision": "oversized", "ownerId": "test-owner", "index": 0, "position": 0,
        "playing": false, "repeat": "off", "shuffle": false, "volume": 0.75, "tracks": tooMany
    ])
    var sizeFailure: PlaybackFailure?
    do { try audio.loadQueue(JSONDecoder().decode(DeviceQueueRequest.self, from: oversized)) }
    catch { sizeFailure = error as? PlaybackFailure }
    try check(sizeFailure == .invalidRequest)
    let emptyAfter = try JSONSerialization.data(withJSONObject: audio.snapshot(), options: [.sortedKeys])
    try check(emptyBefore == emptyAfter)
}

func checkHTTPOnlyResolverBoundaries() async throws {
    let track = try PlaybackTrack(videoID: "00000000001", title: "Test", artist: "Test")
    let direct = FixtureHTTP(.direct)
    let result = try await DirectResolver(transport: direct).resolve(track)
    try check(result.contentLength == 10000)
    let mediaCalls = await direct.mediaCalls
    try check(mediaCalls == 3)
    let rangeHeaders = await direct.mediaRangeHeaders
    let rangeQueries = await direct.mediaRangeQueries
    try check(rangeHeaders == 3)
    try check(rangeQueries == 0)
    try check(URLComponents(url: result.url, resolvingAgainstBaseURL: false)?.queryItems?
        .contains(where: { $0.name.caseInsensitiveCompare("range") == .orderedSame }) != true)
    for (mode, expected) in [(FixtureHTTP.Mode.cipher, PlaybackFailure.scriptRequired), (.nTransform, .scriptRequired), (.queryRange, .invalidSource), (.wrongIdentity, .invalidResponse), (.oversized, .invalidResponse), (.denied, .sourceDenied)] {
        let transport = FixtureHTTP(mode)
        var failure: PlaybackFailure?
        do { _ = try await DirectResolver(transport: transport).resolve(track) }
        catch { failure = error as? PlaybackFailure }
        try check(failure == expected)
        let count = await transport.mediaCalls
        try check(count == 0)
        let players = await transport.playerCalls
        try check(players == 3)
    }
}
