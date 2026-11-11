import Foundation
import AureliaPlaybackCore

private enum PortableCheckFailure: Error { case assertion }
private func portableRequire(_ condition: @autoclosure () -> Bool) throws {
    guard condition() else { throw PortableCheckFailure.assertion }
}

private let fixtureVideoID = "00000000001"
private let fixtureNow = Date(timeIntervalSince1970: 2_000_000_000)
private let fixtureScript = "/s/player/abc12345/player_ias.vflset/en_US/base.js"
private let fixtureURL = "https://r1.googlevideo.com/videoplayback?id=opaque-audio-id&itag=140&clen=10000&expire=2000003600&mime=audio%2Fmp4&source=youtube&lmt=123"

private func portableFormat(url: String = fixtureURL, cipher: String? = nil, itag: Int = 140, bitrate: Int = 128000) -> [String: Any] {
    var value: [String: Any] = ["itag": itag, "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "contentLength": "10000", "bitrate": bitrate]
    if let cipher { value["signatureCipher"] = cipher } else { value["url"] = url }
    return value
}

private func portablePayload(formats: [[String: Any]]? = nil, videoID: String = fixtureVideoID, live: Bool = false, status: String = "OK") throws -> Data {
    try JSONSerialization.data(withJSONObject: [
        "playabilityStatus": ["status": status],
        "videoDetails": ["videoId": videoID, "isLiveContent": live],
        "streamingData": ["adaptiveFormats": formats ?? [portableFormat()]]
    ], options: [.sortedKeys])
}

private func portableWatch(payload: Data?, script: String? = fixtureScript, config: Bool = true,
                           visitor: String? = nil, clientVisitor: String? = nil) throws -> Data {
    var text = "<!doctype html><html><script>"
    if config {
        var client = ["clientName": "WEB", "clientVersion": "2.20261109.00.00"]
        if let clientVisitor { client["visitorData"] = clientVisitor }
        var object: [String: Any] = ["INNERTUBE_CONTEXT": ["client": client], "STS": 12345]
        if let script { object["PLAYER_JS_URL"] = script }
        if let visitor { object["VISITOR_DATA"] = visitor }
        let data = try JSONSerialization.data(withJSONObject: object)
        text += "ytcfg.set(" + String(decoding: data, as: UTF8.self) + ");"
    }
    if let payload { text += "var ytInitialPlayerResponse = " + String(decoding: payload, as: UTF8.self) + ";" }
    return Data((text + "</script></html>").utf8)
}

private actor PortableFixtureHTTP: YouTubeHTTPTransport {
    enum Media: Sendable { case valid, fullResponse, wrongRange, wrongMIME, cancelled }
    let watch: Data
    let watchResponses: [Data]?
    private var watchResponseIndex = 0
    let playerResponses: [Data]
    private var playerResponseIndex = 0
    let media: Media
    let script: Data
    let scriptResponses: [Data]?
    private var scriptResponseIndex = 0
    let mediaHeaders: [String: String]
    private var seen: [URLRequest] = []
    init(watch: Data, watchResponses: [Data]? = nil, player: Data? = nil, playerResponses: [Data]? = nil, media: Media = .valid,
         script: Data = Data("restricted fixture program".utf8), scriptResponses: [Data]? = nil, mediaHeaders: [String: String] = [:]) {
        self.watch = watch; self.watchResponses = watchResponses
        self.playerResponses = playerResponses ?? player.map { [$0] } ?? []
        self.media = media; self.script = script; self.scriptResponses = scriptResponses; self.mediaHeaders = mediaHeaders
    }
    func requests() -> [URLRequest] { seen }
    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        seen.append(request)
        if request.url?.path == "/watch" {
            if let watchResponses {
                guard watchResponses.indices.contains(watchResponseIndex) else { throw PlaybackFailure.invalidRequest }
                let body = watchResponses[watchResponseIndex]
                watchResponseIndex += 1
                return BoundedHTTPResponse(status: 200, headers: ["content-type": "text/html"], body: body)
            }
            return BoundedHTTPResponse(status: 200, headers: ["content-type": "text/html"], body: watch)
        }
        if request.url?.path == "/youtubei/v1/player" {
            // Exhaustion is a failure: a hidden retry cannot silently replay
            // the last successful response and make the contract check pass.
            guard request.httpMethod == "POST", maxBytes > 0, maxBytes <= 1024 * 1024,
                  playerResponseIndex < 2, playerResponses.indices.contains(playerResponseIndex) else {
                throw PlaybackFailure.invalidRequest
            }
            let player = playerResponses[playerResponseIndex]
            playerResponseIndex += 1
            return BoundedHTTPResponse(status: 200, headers: ["content-type": "application/json"], body: player)
        }
        if request.url?.path.hasSuffix("/base.js") == true {
            guard maxBytes > 0, maxBytes <= 8 * 1024 * 1024 else { throw PlaybackFailure.invalidRequest }
            if let scriptResponses {
                guard scriptResponses.indices.contains(scriptResponseIndex) else { throw PlaybackFailure.invalidRequest }
                let body = scriptResponses[scriptResponseIndex]
                scriptResponseIndex += 1
                return BoundedHTTPResponse(status: 200, headers: ["content-type": "text/javascript"], body: body)
            }
            return BoundedHTTPResponse(status: 200, headers: ["content-type": "text/javascript"], body: script)
        }
        if media == .cancelled { throw CancellationError() }
        guard let range = PartialMediaSample.requestedRange(request.value(forHTTPHeaderField: "Range")) else { throw PlaybackFailure.invalidRequest }
        var headers = ["content-type": media == .wrongMIME ? "text/html" : "audio/mp4", "content-length": "1024",
                       "content-range": "bytes \(range.lowerBound)-\(range.upperBound)/\(media == .wrongRange ? 10001 : 10000)"]
        headers.merge(mediaHeaders) { _, replacement in replacement }
        return BoundedHTTPResponse(
            status: media == .fullResponse ? 200 : 206, headers: headers,
            body: Data(repeating: 42, count: 1024)
        )
    }
}

/// This is a deterministic fixture, not a production decipher implementation.
private actor FixtureCipherSolver: YouTubeCipherSolving {
    private var calls = 0
    func count() -> Int { calls }
    func solve(playerJavaScript: Data, signature: String?, n: String?, videoID: String) async throws -> YouTubeCipherSolution {
        guard playerJavaScript == Data("restricted fixture program".utf8), videoID == fixtureVideoID else { throw PlaybackFailure.invalidResponse }
        calls += 1
        return YouTubeCipherSolution(signature: signature.map { String($0.reversed()) }, n: n.map { String($0.reversed()) })
    }
}

private func portableFailure(_ resolver: PortableYouTubeResolver, track: PlaybackTrack) async -> PlaybackFailure? {
    do { _ = try await resolver.resolve(track); return nil }
    catch { return error as? PlaybackFailure }
}

private func portableResolver(_ http: any YouTubeHTTPTransport, solver: any YouTubeCipherSolving = RejectingYouTubeCipherSolver()) -> PortableYouTubeResolver {
    PortableYouTubeResolver(transport: http, cipherSolver: solver, now: { fixtureNow })
}

func checkPortableSourceContracts() async throws {
    let track = try PlaybackTrack(videoID: fixtureVideoID, title: "Fixture", artist: "Fixture")
    let plain = PortableFixtureHTTP(watch: try portableWatch(payload: portablePayload()))
    let resolved = try await portableResolver(plain).resolve(track)
    try portableRequire(resolved.youtubeLease?.requestedVideoID == fixtureVideoID && resolved.youtubeLease?.itag == 140)
    try portableRequire(resolved.contentLength == 10000)
    let plainRequests = await plain.requests()
    try portableRequire(plainRequests.count == 4 && plainRequests.dropFirst().allSatisfy { $0.value(forHTTPHeaderField: "Range") != nil })
    try portableRequire(plainRequests.allSatisfy { $0.value(forHTTPHeaderField: "Cookie") == nil && $0.value(forHTTPHeaderField: "Authorization") == nil })

    // Real watch pages include an unrelated JS-literal config after the JSON
    // bootstrap. Never evaluate it or reject the usable consumed JSON with it.
    var withTelemetry = try portableWatch(payload: portablePayload())
    withTelemetry.append(Data(#"<script>ytcfg.set({"unrelatedTelemetry": 'brace } and \' quote', "sample": window.fixture});</script>"#.utf8))
    _ = try await portableResolver(PortableFixtureHTTP(watch: withTelemetry)).resolve(track)
    var lookalikeTelemetry = try portableWatch(payload: portablePayload())
    lookalikeTelemetry.append(Data(#"<script>ytcfg.set({"POSTS": window.fixture, "note": 'STS'});</script>"#.utf8))
    _ = try await portableResolver(PortableFixtureHTTP(watch: lookalikeTelemetry)).resolve(track)
    var invalidConsumed = try portableWatch(payload: portablePayload())
    invalidConsumed.append(Data("<script>ytcfg.set({\"STS\": window.fixture});</script>".utf8))
    let invalidConfiguration = await portableFailure(portableResolver(PortableFixtureHTTP(watch: invalidConsumed)), track: track)
    try portableRequire(invalidConfiguration == .invalidResponse)
    var escapedConsumed = try portableWatch(payload: portablePayload())
    escapedConsumed.append(Data(#"<script>ytcfg.set({"S\u0054S": window.fixture});</script>"#.utf8))
    let invalidEscapedConfiguration = await portableFailure(portableResolver(PortableFixtureHTTP(watch: escapedConsumed)), track: track)
    try portableRequire(invalidEscapedConfiguration == .invalidResponse)

    var outer = URLComponents()
    outer.queryItems = [URLQueryItem(name: "url", value: fixtureURL + "&n=abc123"), URLQueryItem(name: "s", value: "cipher123"), URLQueryItem(name: "sp", value: "sig")]
    let cipher = FixtureCipherSolver()
    let cipherHTTP = PortableFixtureHTTP(watch: try portableWatch(payload: portablePayload(formats: [portableFormat(cipher: outer.percentEncodedQuery!)])))
    let deciphered = try await portableResolver(cipherHTTP, solver: cipher).resolve(track)
    let decipheredFields = URLComponents(url: deciphered.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    try portableRequire(decipheredFields.first { $0.name == "sig" }?.value == "321rehpic")
    try portableRequire(decipheredFields.first { $0.name == "n" }?.value == "321cba")
    let cipherCount = await cipher.count()
    try portableRequire(cipherCount == 1)
    let cipherRequests = await cipherHTTP.requests()
    try portableRequire(cipherRequests.count == 5 && cipherRequests[1].url?.path == fixtureScript)
    let es6Script = fixtureScript.replacingOccurrences(of: "/player_ias.vflset/", with: "/player_es6.vflset/")
    let es6HTTP = PortableFixtureHTTP(watch: try portableWatch(payload: portablePayload(formats: [portableFormat(url: fixtureURL + "&n=abc")]), script: es6Script))
    _ = try await portableResolver(es6HTTP, solver: FixtureCipherSolver()).resolve(track)
    let compatibleRequests = await es6HTTP.requests()
    try portableRequire(compatibleRequests.count == 5 && compatibleRequests[1].url?.path == fixtureScript)
    let unsolved = await portableFailure(portableResolver(cipherHTTP), track: track)
    try portableRequire(unsolved == .scriptRequired)

    let fallback = PortableFixtureHTTP(watch: try portableWatch(payload: nil), player: try portablePayload())
    _ = try await portableResolver(fallback).resolve(track)
    let fallbackRequests = await fallback.requests()
    try portableRequire(fallbackRequests.count == 5 && fallbackRequests[1].httpMethod == "POST")
    let playerBody = try JSONSerialization.jsonObject(with: fallbackRequests[1].httpBody!) as? [String: Any]
    let context = playerBody?["playbackContext"] as? [String: Any]
    let contentContext = context?["contentPlaybackContext"] as? [String: Any]
    try portableRequire(contentContext?["signatureTimestamp"] as? Int == 12345)

    // Current watch pages can expose SABR format metadata without media locators.
    // It is not a usable source until the bounded player response supplies one.
    var metadataOnlyFormat = portableFormat()
    metadataOnlyFormat.removeValue(forKey: "url")
    let metadataFormats = PortableFixtureHTTP(watch: try portableWatch(payload: portablePayload(formats: [metadataOnlyFormat])), player: try portablePayload())
    _ = try await portableResolver(metadataFormats).resolve(track)
    let metadataFormatRequests = await metadataFormats.requests()
    try portableRequire(metadataFormatRequests.count == 5 && metadataFormatRequests[1].httpMethod == "POST")

    try await portableTelevisionFallbackChecks(track: track, metadataOnlyFormat: metadataOnlyFormat)

    // A usable watch response may carry metadata but omit streamingData. It
    // needs the same single player-API fallback as an absent response.
    var metadataOnly = try JSONSerialization.jsonObject(with: portablePayload()) as! [String: Any]
    metadataOnly.removeValue(forKey: "streamingData")
    let missingFormats = PortableFixtureHTTP(watch: try portableWatch(payload: JSONSerialization.data(withJSONObject: metadataOnly)),
                                            player: try portablePayload())
    _ = try await portableResolver(missingFormats).resolve(track)
    let missingFormatRequests = await missingFormats.requests()
    try portableRequire(missingFormatRequests.count == 5 && missingFormatRequests[1].httpMethod == "POST")

    let highURL = fixtureURL.replacingOccurrences(of: "itag=140", with: "itag=141")
    var video = portableFormat(bitrate: 900000); video["width"] = 1920
    var drm = portableFormat(bitrate: 800000); drm["drmFamilies"] = ["WIDEVINE"]
    let best = PortableFixtureHTTP(watch: try portableWatch(payload: portablePayload(formats: [video, drm, portableFormat(), portableFormat(url: highURL, itag: 141, bitrate: 256000)])))
    let bestResolved = try await portableResolver(best).resolve(track)
    try portableRequire(bestResolved.youtubeLease?.itag == 141)

    for rawURL in [
        fixtureURL + "&itag=140", fixtureURL + "&%69tag=140", fixtureURL + "&Range=0-1023",
        fixtureURL + "&n=one&n=two", fixtureURL + "&N=challenge", fixtureURL + "&s=challenge", fixtureURL + "&begin=1", fixtureURL + "&authorization=x",
        fixtureURL.replacingOccurrences(of: "r1.googlevideo.com", with: "r1.googlevideo.com.evil.test"),
        fixtureURL.replacingOccurrences(of: "/videoplayback", with: "/%76ideoplayback"),
        fixtureURL.replacingOccurrences(of: "clen=10000", with: "clen=10001"),
        fixtureURL.replacingOccurrences(of: "itag=140", with: "itag=141"),
        fixtureURL + "&x=%ZZ"
    ] {
        let http = PortableFixtureHTTP(watch: try portableWatch(payload: portablePayload(formats: [portableFormat(url: rawURL)])))
        let failure = await portableFailure(portableResolver(http), track: track)
        try portableRequire(failure == .invalidSource)
        let requests = await http.requests()
        try portableRequire(requests.count == 1)
    }
    let stale = PortableFixtureHTTP(watch: try portableWatch(payload: portablePayload(formats: [portableFormat(url: fixtureURL.replacingOccurrences(of: "expire=2000003600", with: "expire=1999999999"))])))
    let staleFailure = await portableFailure(portableResolver(stale), track: track)
    try portableRequire(staleFailure == .expired)

    for (payload, expected) in [
        (try portablePayload(videoID: "00000000002"), PlaybackFailure.invalidResponse),
        (try portablePayload(live: true), .unavailable),
        (try portablePayload(status: "LOGIN_REQUIRED"), .sourceDenied),
        (Data("{}".utf8), .sourceDenied)
    ] {
        let http = PortableFixtureHTTP(watch: try portableWatch(payload: payload))
        let failure = await portableFailure(portableResolver(http), track: track)
        try portableRequire(failure == expected)
        let requests = await http.requests()
        try portableRequire(requests.count == 1)
    }
    for media in [PortableFixtureHTTP.Media.fullResponse, .wrongRange, .wrongMIME] {
        let http = PortableFixtureHTTP(watch: try portableWatch(payload: portablePayload()), media: media)
        let failure = await portableFailure(portableResolver(http), track: track)
        try portableRequire(failure == .invalidResponse)
        let requests = await http.requests()
        try portableRequire(requests.count == 2)
    }
    // Simulate transparently decompressed bytes with otherwise perfect Range
    // metadata: encoding must be rejected before accepting a usable lease.
    for encoding in [
        ["content-encoding": "gzip"], ["Content-Encoding": "br"], ["content-encoding": "deflate"],
        ["content-encoding": "identity, gzip"], ["content-encoding": ""],
        ["content-encoding": "identity", "Content-Encoding": "identity"]
    ] {
        let http = PortableFixtureHTTP(watch: try portableWatch(payload: portablePayload()), mediaHeaders: encoding)
        let failure = await portableFailure(portableResolver(http), track: track)
        try portableRequire(failure == .invalidResponse)
        let requests = await http.requests()
        try portableRequire(requests.count == 2)
    }
    let identity = PortableFixtureHTTP(watch: try portableWatch(payload: portablePayload()), mediaHeaders: ["Content-Encoding": " IDENTITY "])
    _ = try await portableResolver(identity).resolve(track)
    let identityRequests = await identity.requests()
    try portableRequire(identityRequests.count == 4)
    try portableRequire(identityRequests.allSatisfy { $0.value(forHTTPHeaderField: "Accept-Encoding") == "identity" })

    let missingScript = PortableFixtureHTTP(watch: try portableWatch(payload: portablePayload(formats: [portableFormat(url: fixtureURL + "&n=abc")]), script: nil))
    let missingFailure = await portableFailure(portableResolver(missingScript, solver: FixtureCipherSolver()), track: track)
    try portableRequire(missingFailure == .scriptRequired)
    let evilScript = PortableFixtureHTTP(watch: try portableWatch(payload: portablePayload(formats: [portableFormat(url: fixtureURL + "&n=abc")]), script: "https://evil.test/base.js"))
    let evilFailure = await portableFailure(portableResolver(evilScript), track: track)
    try portableRequire(evilFailure == .invalidSource)
    let duplicateJSON = Data(#"{"playabilityStatus":{"status":"OK"},"videoDetails":{"videoId":"00000000002","videoId":"00000000001"}}"#.utf8)
    let ambiguous = PortableFixtureHTTP(watch: try portableWatch(payload: duplicateJSON))
    let ambiguousFailure = await portableFailure(portableResolver(ambiguous), track: track)
    try portableRequire(ambiguousFailure == .invalidResponse)
    let oversized = PortableFixtureHTTP(watch: Data(repeating: 32, count: 4 * 1024 * 1024 + 1))
    let capFailure = await portableFailure(portableResolver(oversized), track: track)
    try portableRequire(capFailure == .invalidResponse)
    let cancelled = PortableFixtureHTTP(watch: try portableWatch(payload: portablePayload()), media: .cancelled)
    var cancellation = false
    do { _ = try await portableResolver(cancelled).resolve(track) } catch is CancellationError { cancellation = true }
    try portableRequire(cancellation)
    try portableControlBoundaryChecks()
    try await portableAdmissionCheck(track: track)
    try await portableScriptCacheChecks(track: track)
}

private func portableTelevisionFallbackChecks(track: PlaybackTrack, metadataOnlyFormat: [String: Any]) async throws {
    let metadataPayload = try portablePayload(formats: [metadataOnlyFormat])
    let watch = try portableWatch(payload: metadataPayload)
    let successful = PortableFixtureHTTP(watch: watch, playerResponses: [metadataPayload, try portablePayload()])
    let source = try await portableResolver(successful).resolve(track)
    try portableRequire(source.youtubeLease?.requestedVideoID == track.videoID && source.youtubeLease?.itag == 140)
    let requests = await successful.requests()
    let posts = requests.filter { $0.url?.path == "/youtubei/v1/player" }
    try portableRequire(requests.count == 6 && posts.count == 2)
    try portableRequire(requests.first?.url?.path == "/watch")
    try portableRequire(requests.dropFirst(3).allSatisfy { $0.value(forHTTPHeaderField: "Range") != nil })
    try portableRequire(requests.allSatisfy {
        $0.value(forHTTPHeaderField: "Cookie") == nil && $0.value(forHTTPHeaderField: "Authorization") == nil
            && $0.value(forHTTPHeaderField: "Accept-Encoding") == "identity"
            && $0.timeoutInterval > 0 && $0.timeoutInterval <= 35
    })
    try portableRequire(posts[0].value(forHTTPHeaderField: "X-Youtube-Client-Name") == "1")
    try portableRequire(posts.allSatisfy {
        $0.value(forHTTPHeaderField: "Origin") == "https://www.youtube.com"
            && $0.value(forHTTPHeaderField: "X-Goog-Visitor-Id") == nil
    })
    let television = posts[1]
    try portableRequire(television.value(forHTTPHeaderField: "X-Youtube-Client-Name") == "7")
    try portableRequire(television.value(forHTTPHeaderField: "X-Youtube-Client-Version") == "5.20260707")
    let televisionUA = "Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1"
    try portableRequire(television.value(forHTTPHeaderField: "User-Agent") == televisionUA)
    try portableRequire(television.value(forHTTPHeaderField: "Content-Type") == "application/json")
    try portableRequire(television.timeoutInterval <= posts[0].timeoutInterval)
    let body = try JSONSerialization.jsonObject(with: television.httpBody!) as? [String: Any]
    let context = body?["context"] as? [String: Any]
    let client = context?["client"] as? [String: Any]
    try portableRequire(body?["videoId"] as? String == track.videoID)
    try portableRequire(client?["clientName"] as? String == "TVHTML5")
    try portableRequire(client?["clientVersion"] as? String == "5.20260707")
    try portableRequire(client?["userAgent"] as? String == televisionUA)
    try portableRequire(client?["deviceMake"] as? String == "Samsung" && client?["osName"] as? String == "Tizen")
    let playbackContext = body?["playbackContext"] as? [String: Any]
    let contentContext = playbackContext?["contentPlaybackContext"] as? [String: Any]
    try portableRequire(contentContext?["html5Preference"] as? String == "HTML5_PREF_WANTS")
    try portableRequire(contentContext?["signatureTimestamp"] as? Int == 12345)

    // Synthetic anonymous context stays inside native control requests. Both
    // configuration locations must agree, and absence remains supported above.
    let visitor = "fixture_Visitor-123="
    let withVisitor = PortableFixtureHTTP(
        watch: try portableWatch(payload: metadataPayload, visitor: visitor, clientVisitor: visitor),
        playerResponses: [metadataPayload, try portablePayload()]
    )
    _ = try await portableResolver(withVisitor).resolve(track)
    let visitorRequests = await withVisitor.requests()
    let visitorPosts = visitorRequests.filter { $0.httpMethod == "POST" }
    try portableRequire(visitorPosts.count == 2 && visitorRequests.count == 6)
    for post in visitorPosts {
        let visitorBody = try JSONSerialization.jsonObject(with: post.httpBody!) as? [String: Any]
        let visitorContext = visitorBody?["context"] as? [String: Any]
        let visitorClient = visitorContext?["client"] as? [String: Any]
        try portableRequire(visitorClient?["visitorData"] as? String == visitor)
        try portableRequire(post.value(forHTTPHeaderField: "X-Goog-Visitor-Id") == visitor)
        try portableRequire(post.value(forHTTPHeaderField: "Origin") == "https://www.youtube.com")
        try portableRequire(post.value(forHTTPHeaderField: "Cookie") == nil && post.value(forHTTPHeaderField: "Authorization") == nil)
    }
    for (topLevel, nested) in [("fixture_a", "fixture_b"), ("invalid visitor", "invalid visitor")] {
        let invalid = PortableFixtureHTTP(
            watch: try portableWatch(payload: metadataPayload, visitor: topLevel, clientVisitor: nested),
            playerResponses: [metadataPayload, try portablePayload()]
        )
        let failure = await portableFailure(portableResolver(invalid), track: track)
        try portableRequire(failure == .invalidResponse)
        let invalidRequests = await invalid.requests()
        try portableRequire(invalidRequests.count == 1)
    }

    // Two metadata-only responses exhaust the one alternate profile. Never
    // repeat TV, request media, or manufacture a locator from format metadata.
    let unavailable = PortableFixtureHTTP(watch: watch, playerResponses: [metadataPayload, metadataPayload])
    let unavailableFailure = await portableFailure(portableResolver(unavailable), track: track)
    try portableRequire(unavailableFailure == .unavailable)
    let unavailableRequests = await unavailable.requests()
    try portableRequire(unavailableRequests.count == 3
        && unavailableRequests.dropFirst().allSatisfy { $0.httpMethod == "POST" })
    try portableRequire(unavailableRequests.last?.value(forHTTPHeaderField: "X-Youtube-Client-Name") == "7")

    // A denial is terminal for this route; the alternate profile is only for
    // OK responses that lack usable locators.
    let denied = PortableFixtureHTTP(watch: watch, playerResponses: [try portablePayload(status: "LOGIN_REQUIRED"), try portablePayload()])
    let deniedFailure = await portableFailure(portableResolver(denied), track: track)
    try portableRequire(deniedFailure == .sourceDenied)
    let deniedRequests = await denied.requests()
    try portableRequire(deniedRequests.count == 2)

    let wrongVideo = PortableFixtureHTTP(watch: watch, playerResponses: [metadataPayload, try portablePayload(videoID: "00000000002")])
    let wrongVideoFailure = await portableFailure(portableResolver(wrongVideo), track: track)
    try portableRequire(wrongVideoFailure == .invalidResponse)
    let wrongVideoRequests = await wrongVideo.requests()
    try portableRequire(wrongVideoRequests.count == 3)
}

private func portableControlBoundaryChecks() throws {
    for path in ["https://www.youtube.com/watch?v=00000000001&hl=en", "https://www.youtube.com" + fixtureScript] {
        try portableRequire(PlayerSourceHTTP.isAllowedControlRequest(URLRequest(url: URL(string: path)!), maxBytes: 1024))
    }
    for path in [
        "http://www.youtube.com" + fixtureScript, "https://youtube.com" + fixtureScript,
        "https://www.youtube.com/s/player/abc12345/../base.js", "https://www.youtube.com" + fixtureScript + "?x=1",
        "https://www.youtube.com/watch?v=00000000001&v=00000000002&hl=en", "https://www.youtube.com/watch?v=00000000001&hl=en#fragment",
        "https://www.youtube.com/iframe_api", "https://www.youtube.com:443" + fixtureScript,
        "https://user@www.youtube.com" + fixtureScript
    ] {
        try portableRequire(!PlayerSourceHTTP.isAllowedControlRequest(URLRequest(url: URL(string: path)!), maxBytes: 1024))
    }
    var cookie = URLRequest(url: URL(string: "https://www.youtube.com" + fixtureScript)!)
    cookie.setValue("fixture", forHTTPHeaderField: "Cookie")
    try portableRequire(!PlayerSourceHTTP.isAllowedControlRequest(cookie, maxBytes: 1024))
}

private actor PortableGateHTTP: YouTubeHTTPTransport {
    let underlying: PortableFixtureHTTP
    private var blocked: CheckedContinuation<Void, Never>?
    private var entered: CheckedContinuation<Void, Never>?
    private var didEnter = false
    init(_ underlying: PortableFixtureHTTP) { self.underlying = underlying }
    func waitUntilEntered() async {
        if didEnter { return }
        await withCheckedContinuation { entered = $0 }
    }
    func release() { blocked?.resume(); blocked = nil }
    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        if !didEnter {
            await withCheckedContinuation { continuation in
                blocked = continuation; didEnter = true; entered?.resume(); entered = nil
            }
        }
        return try await underlying.request(request, maxBytes: maxBytes)
    }
}

private func portableAdmissionCheck(track: PlaybackTrack) async throws {
    let http = PortableFixtureHTTP(watch: try portableWatch(payload: portablePayload()))
    let gate = PortableGateHTTP(http)
    let resolver = portableResolver(gate)
    let first = Task { try await resolver.resolve(track) }
    await gate.waitUntilEntered()
    let failure = await portableFailure(resolver, track: track)
    try portableRequire(failure == .busy)
    first.cancel()
    let stillBusy = await portableFailure(resolver, track: track)
    try portableRequire(stillBusy == .busy)
    await gate.release()
    var cancelled = false
    do { _ = try await first.value } catch is CancellationError { cancelled = true }
    try portableRequire(cancelled)
    _ = try await resolver.resolve(track)
}


private final class PortableFixtureClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = fixtureNow
    func now() -> Date {
        lock.lock(); defer { lock.unlock() }
        return value
    }
    func set(_ value: Date) {
        lock.lock(); defer { lock.unlock() }
        self.value = value
    }
}

private actor PortableScriptGateHTTP: YouTubeHTTPTransport {
    let underlying: PortableFixtureHTTP
    private var entered = false
    private var waiting: CheckedContinuation<Void, Never>?
    private var blocked: CheckedContinuation<Void, Never>?
    init(_ underlying: PortableFixtureHTTP) { self.underlying = underlying }
    func waitUntilScriptEntered() async {
        if entered { return }
        await withCheckedContinuation { waiting = $0 }
    }
    func release() { blocked?.resume(); blocked = nil }
    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        if !entered && request.url?.path.hasSuffix("/base.js") == true {
            await withCheckedContinuation { continuation in
                blocked = continuation; entered = true; waiting?.resume(); waiting = nil
            }
        }
        // Deliberately return even after cancellation, like a late transport.
        return try await underlying.request(request, maxBytes: maxBytes)
    }
}

private func portableScriptCacheChecks(track: PlaybackTrack) async throws {
    let payload = try portablePayload(formats: [portableFormat(url: fixtureURL + "&n=abc")])
    let firstWatch = try portableWatch(payload: payload)
    let otherScript = fixtureScript.replacingOccurrences(of: "abc12345", with: "def67890")
    let otherWatch = try portableWatch(payload: payload, script: otherScript)
    let switching = PortableFixtureHTTP(watch: firstWatch, watchResponses: [firstWatch, firstWatch, otherWatch, firstWatch])
    let switchingSolver = FixtureCipherSolver()
    let switchingResolver = portableResolver(switching, solver: switchingSolver)
    for _ in 0..<4 { _ = try await switchingResolver.resolve(track) }
    let switchingRequests = await switching.requests()
    let fetchedScripts = switchingRequests.filter { $0.url?.path.hasSuffix("/base.js") == true }
    try portableRequire(fetchedScripts.compactMap { $0.url?.path } == [fixtureScript, otherScript, fixtureScript])
    try portableRequire(switchingRequests.filter { $0.url?.path == "/watch" }.count == 4)
    try portableRequire(switchingRequests.filter { $0.value(forHTTPHeaderField: "Range") != nil }.count == 12)
    let solves = await switchingSolver.count()
    try portableRequire(solves == 4) // Script reuse never reuses a signed source.

    let clock = PortableFixtureClock()
    let timed = PortableFixtureHTTP(watch: firstWatch)
    let timedResolver = PortableYouTubeResolver(transport: timed, cipherSolver: FixtureCipherSolver(), now: { clock.now() })
    _ = try await timedResolver.resolve(track)
    clock.set(fixtureNow.addingTimeInterval(599))
    _ = try await timedResolver.resolve(track)
    var timedRequests = await timed.requests()
    try portableRequire(timedRequests.filter { $0.url?.path.hasSuffix("/base.js") == true }.count == 1)
    clock.set(fixtureNow.addingTimeInterval(600))
    _ = try await timedResolver.resolve(track)
    timedRequests = await timed.requests()
    try portableRequire(timedRequests.filter { $0.url?.path.hasSuffix("/base.js") == true }.count == 2)
    clock.set(fixtureNow.addingTimeInterval(599)) // Earlier than the last cache write.
    _ = try await timedResolver.resolve(track)
    timedRequests = await timed.requests()
    try portableRequire(timedRequests.filter { $0.url?.path.hasSuffix("/base.js") == true }.count == 3)

    let validScript = Data("restricted fixture program".utf8)
    for invalidScript in [Data(), Data([0xff]), Data(repeating: 65, count: 8 * 1024 * 1024 + 1)] {
        let invalid = PortableFixtureHTTP(watch: firstWatch, scriptResponses: [invalidScript, validScript])
        let invalidResolver = portableResolver(invalid, solver: FixtureCipherSolver())
        let invalidFailure = await portableFailure(invalidResolver, track: track)
        try portableRequire(invalidFailure == .invalidResponse)
        _ = try await invalidResolver.resolve(track)
        _ = try await invalidResolver.resolve(track)
        let invalidRequests = await invalid.requests()
        try portableRequire(invalidRequests.filter { $0.url?.path.hasSuffix("/base.js") == true }.count == 2)
    }

    // An unsuccessful replacement cannot overwrite the last validated entry.
    let failedReplacement = PortableFixtureHTTP(
        watch: firstWatch, watchResponses: [firstWatch, otherWatch, firstWatch], scriptResponses: [validScript, Data([0xff])]
    )
    let replacementResolver = portableResolver(failedReplacement, solver: FixtureCipherSolver())
    _ = try await replacementResolver.resolve(track)
    let replacementFailure = await portableFailure(replacementResolver, track: track)
    try portableRequire(replacementFailure == .invalidResponse)
    _ = try await replacementResolver.resolve(track)
    let replacementRequests = await failedReplacement.requests()
    try portableRequire(replacementRequests.filter { $0.url?.path.hasSuffix("/base.js") == true }.count == 2)

    let cancelledHTTP = PortableFixtureHTTP(watch: firstWatch)
    let gated = PortableScriptGateHTTP(cancelledHTTP)
    let cancelledSolver = FixtureCipherSolver()
    let cancelledResolver = portableResolver(gated, solver: cancelledSolver)
    let cancelled = Task { try await cancelledResolver.resolve(track) }
    await gated.waitUntilScriptEntered()
    cancelled.cancel()
    await gated.release()
    var propagated = false
    do { _ = try await cancelled.value } catch is CancellationError { propagated = true }
    try portableRequire(propagated)
    let beforeRetry = await cancelledHTTP.requests()
    try portableRequire(beforeRetry.count == 2 && beforeRetry.allSatisfy { $0.value(forHTTPHeaderField: "Range") == nil })
    _ = try await cancelledResolver.resolve(track)
    let afterRetry = await cancelledHTTP.requests()
    try portableRequire(afterRetry.filter { $0.url?.path.hasSuffix("/base.js") == true }.count == 2)
    try portableRequire(afterRetry.filter { $0.value(forHTTPHeaderField: "Range") != nil }.count == 3)
    let cancelledSolves = await cancelledSolver.count()
    try portableRequire(cancelledSolves == 1)
}
