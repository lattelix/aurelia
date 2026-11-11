import Foundation
import AureliaPlaybackCore

private enum RangeCheckFailure: Error { case assertion }
private func require(_ condition: @autoclosure () -> Bool) throws {
    guard condition() else { throw RangeCheckFailure.assertion }
}

private func sample(
    status: Int = 206,
    length: String? = "1024",
    range: String? = "bytes 0-1023/10000",
    bytes: Int = 1024
) -> BoundedHTTPResponse {
    var headers: [String: String] = [:]
    if let length { headers["content-length"] = length }
    if let range { headers["content-range"] = range }
    return BoundedHTTPResponse(
        status: status,
        headers: headers,
        body: Data(repeating: 1, count: bytes)
    )
}

private func expectInvalid(_ response: BoundedHTTPResponse) throws {
    var failure: PlaybackFailure?
    do {
        try PartialMediaSample.validate(
            response,
            expectedStart: 0,
            expectedEnd: 1023,
            expectedTotal: 10000
        )
    } catch {
        failure = error as? PlaybackFailure
    }
    try require(failure == .invalidResponse)
}

func checkPartialMediaSampleContracts() throws {
    try PartialMediaSample.validate(
        sample(), expectedStart: 0, expectedEnd: 1023, expectedTotal: 10000
    )
    try PartialMediaSample.validate(
        sample(length: nil), expectedStart: 0, expectedEnd: 1023, expectedTotal: 10000
    )
    try PartialMediaSample.validate(
        sample(length: "0001024", range: "bytes 0000-0001023/00010000"),
        expectedStart: 0,
        expectedEnd: 1023,
        expectedTotal: 10000
    )

    try expectInvalid(sample(status: 200))
    try expectInvalid(sample(range: "bytes 1-1023/10000"))
    try expectInvalid(sample(range: "bytes 0-1022/10000"))
    try expectInvalid(sample(range: "bytes 0-1023/10001"))
    try expectInvalid(sample(range: "bytes 0-1023/*"))
    try expectInvalid(sample(range: "bytes=0-1023/10000"))
    try expectInvalid(sample(range: "bytes 0-1023/10000, bytes 0-1023/10000"))
    try expectInvalid(sample(range: "bytes 0-1023/999999999999999999999999999999"))
    try expectInvalid(sample(range: nil))
    try expectInvalid(sample(length: "1023"))
    try expectInvalid(sample(length: "1024, 1024"))
    try expectInvalid(sample(length: "999999999999999999999999999999"))
    try expectInvalid(sample(bytes: 1023))
    try expectInvalid(sample(bytes: 1025))
    try expectInvalid(BoundedHTTPResponse(
        status: 206,
        headers: [
            "Content-Length": "1024",
            "content-length": "1024",
            "content-range": "bytes 0-1023/10000"
        ],
        body: Data(repeating: 1, count: 1024)
    ))
    try expectInvalid(BoundedHTTPResponse(
        status: 206,
        headers: [
            "content-length": "1024",
            "Content-Range": "bytes 0-1023/10000",
            "content-range": "bytes 0-1023/10000"
        ],
        body: Data(repeating: 1, count: 1024)
    ))

    let diagnostic = PartialMediaSample.safeDiagnostic(
        sample(length: nil),
        requested: 0...1023,
        expectedTotal: 10000
    )
    try require(diagnostic == "media:status=206:bytes=1024:cl=absent:cr=match")
}

private actor ProfileHTTP: YouTubeHTTPTransport {
    enum Scenario: Sendable { case invalidThenDenied, mediaDenied, lateValid, cancelled }
    let scenario: Scenario
    private var profile = 0

    init(_ scenario: Scenario) { self.scenario = scenario }

    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        if request.url?.host == "www.youtube.com" {
            if scenario == .cancelled { throw CancellationError() }
            profile += 1
            if profile == 1 || (scenario == .lateValid && profile == 3) {
                return try playerResponse()
            }
            return BoundedHTTPResponse(
                status: 200,
                headers: [:],
                body: Data(#"{"playabilityStatus":{"status":"LOGIN_REQUIRED"}}"#.utf8)
            )
        }
        if scenario == .mediaDenied { throw PlaybackFailure.sourceDenied }
        guard let requested = PartialMediaSample.requestedRange(
            request.value(forHTTPHeaderField: "Range")
        ) else { throw PlaybackFailure.invalidResponse }
        let total = scenario == .lateValid && profile == 3 ? 10000 : 10001
        return BoundedHTTPResponse(
            status: 206,
            headers: [
                "content-length": "1024",
                "content-range": "bytes \(requested.lowerBound)-\(requested.upperBound)/\(total)"
            ],
            body: Data(repeating: 2, count: 1024)
        )
    }

    private func playerResponse() throws -> BoundedHTTPResponse {
        let data = try JSONSerialization.data(withJSONObject: [
            "videoDetails": ["videoId": "00000000001", "isLiveContent": false],
            "playabilityStatus": ["status": "OK"],
            "streamingData": ["adaptiveFormats": [[
                "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"",
                "bitrate": 128000,
                "contentLength": "10000",
                "url": "https://r1.googlevideo.com/videoplayback?expire=4000000000"
            ]]]
        ])
        return BoundedHTTPResponse(status: 200, headers: [:], body: data)
    }
}

private func resolverFailure(
    _ transport: any YouTubeHTTPTransport,
    track: PlaybackTrack
) async -> PlaybackFailure? {
    do {
        _ = try await DirectResolver(transport: transport).resolve(track)
        return nil
    } catch is CancellationError {
        return nil
    } catch {
        return error as? PlaybackFailure
    }
}

func checkResolverProfileFailures() async throws {
    let track = try PlaybackTrack(videoID: "00000000001", title: "Test", artist: "Test")

    let invalid = await resolverFailure(ProfileHTTP(.invalidThenDenied), track: track)
    try require(invalid == .invalidResponse)

    let diagnostic = DiagnosticHTTP(upstream: ProfileHTTP(.mediaDenied))
    let denied = await resolverFailure(diagnostic, track: track)
    try require(denied == .sourceDenied)
    let records = await diagnostic.records()
    try require(records.contains("media:error=sourceDenied"))

    let late = try await DirectResolver(transport: ProfileHTTP(.lateValid)).resolve(track)
    try require(late.contentLength == 10000)

    var cancellationPropagated = false
    do {
        _ = try await DirectResolver(transport: ProfileHTTP(.cancelled)).resolve(track)
    } catch is CancellationError {
        cancellationPropagated = true
    }
    try require(cancellationPropagated)
}
