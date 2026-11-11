import Foundation

/// The implementation must bound its own execution and cooperate with task
/// cancellation. Downloaded JavaScript is data for a restricted cipher parser;
/// this protocol is not permission to run a general JavaScript environment.
public protocol YouTubeCipherSolving: Sendable {
    func signatureTimestamp(playerJavaScript: Data) async throws -> Int?
    func solve(playerJavaScript: Data, signature: String?, n: String?, videoID: String) async throws -> YouTubeCipherSolution
}

public extension YouTubeCipherSolving {
    func signatureTimestamp(playerJavaScript: Data) async throws -> Int? { nil }
}

public struct YouTubeCipherSolution: Sendable {
    public let signature: String?
    public let n: String?
    public init(signature: String?, n: String?) { self.signature = signature; self.n = n }
}

public struct RejectingYouTubeCipherSolver: YouTubeCipherSolving {
    public init() {}
    public func solve(playerJavaScript: Data, signature: String?, n: String?, videoID: String) async throws -> YouTubeCipherSolution {
        throw PlaybackFailure.scriptRequired
    }
}

/// Closed progress markers for local diagnostics. Never contains upstream data,
/// identifiers, URLs, script contents or credentials.
public enum YouTubeSourceStep: String, Sendable {
    case watchReceived, bootstrapDecoded, initialPlayerDecoded, playerResponseDecoded
    case formatSelected, scriptDecoded, cipherSolved, leaseValidated, preflightValidated
    case configurationFramesRead, configurationShapeRejected, configurationValidationRejected
    case configurationClientNameType, configurationClientVersionType, configurationTimestampType
    case configurationContextType, configurationClientType, configurationDataRejected, configurationKeyRejected
    case locatorValidated, challengeRead, scriptAddressValidated
    case televisionFallback
}

/// Native-only WEB player preparation. It returns a validated lease, never a
/// script, locator or response body to the UI. It does not enable a source gate.
public actor PortableYouTubeResolver: PlaybackResolving {
    private let transport: any YouTubeHTTPTransport
    private let cipherSolver: any YouTubeCipherSolving
    private let deadline: TimeInterval
    private let now: @Sendable () -> Date
    private let diagnostic: @Sendable (YouTubeSourceStep) -> Void
    private var active = false
    // One public player program only; never watch/player responses, visitor
    // context, signed locators or media. The entry has no disk persistence.
    private struct CachedPlayerScript {
        let url: URL
        let body: Data
        let cachedAt: Date
    }
    private var cachedPlayerScript: CachedPlayerScript?

    public init(
        transport: any YouTubeHTTPTransport = PlayerSourceHTTP(),
        cipherSolver: any YouTubeCipherSolving = RejectingYouTubeCipherSolver(),
        deadline: TimeInterval = 35,
        now: @escaping @Sendable () -> Date = { Date() },
        diagnostic: @escaping @Sendable (YouTubeSourceStep) -> Void = { _ in }
    ) {
        self.transport = transport; self.cipherSolver = cipherSolver
        self.deadline = deadline.isFinite ? min(max(deadline, 0.1), 35) : 35
        self.now = now
        self.diagnostic = diagnostic
    }

    public func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        guard track.provider == .youtube, sourceVideoID(track.videoID) else { throw PlaybackFailure.invalidTrack }
        try Task.checkCancellation()
        guard !active else { throw PlaybackFailure.busy }
        active = true
        defer { active = false }
        let budget = SourceBudget(seconds: deadline)
        do {
        var watch = URLRequest(url: URL(string: "https://www.youtube.com/watch?v=\(track.videoID)&hl=en")!)
        watch.setValue("text/html", forHTTPHeaderField: "Accept")
        let watchBody = try await fetch(watch, maxBytes: 4 * 1024 * 1024, mime: ["text/html"], budget: budget)
        diagnostic(.watchReceived)
        let bootstrap = try SourceBootstrap(data: watchBody, diagnostic: diagnostic)
        diagnostic(.bootstrapDecoded)
        var script: Data?
        var payload = try bootstrap.initialPlayerResponse()
        diagnostic(.initialPlayerDecoded)
        if payload == nil || (payload?.playabilityStatus?.status == "OK"
            && !(payload?.streamingData?.adaptiveFormats?.contains { $0.isAACAudio && $0.hasLocator } ?? false)) {
            guard let client = try bootstrap.webClient() else { throw PlaybackFailure.invalidResponse }
            let visitor = try bootstrap.visitorData()
            var timestamp = bootstrap.signatureTimestamp
            if timestamp == nil, let scriptURL = try bootstrap.playerScriptURL() {
                let loaded = try await fetchScript(scriptURL, budget: budget)
                script = loaded
                try budget.check()
                timestamp = try await cipherSolver.signatureTimestamp(playerJavaScript: loaded)
                try budget.check()
            }
            if let timestamp, timestamp <= 0 || timestamp > 1_000_000 { throw PlaybackFailure.invalidResponse }
            let player = try SourcePlayerProfile.web(version: client.version).request(
                videoID: track.videoID, visitorData: visitor, signatureTimestamp: timestamp
            )
            let data = try await fetch(player, maxBytes: 1024 * 1024, mime: ["application/json"], budget: budget)
            payload = try decodeSourceJSON(PortablePlayerResponse.self, from: data)
            if payload?.playabilityStatus?.status == "OK",
               !(payload?.streamingData?.adaptiveFormats?.contains { $0.isAACAudio && $0.hasLocator } ?? false) {
                // Maintained yt-dlp tv_samsung profile, checked 09 Nov 2026.
                // WEB may supply SABR metadata only. One alternate profile is
                // allowed inside the same deadline, never an open-ended loop.
                diagnostic(.televisionFallback)
                let tv = try SourcePlayerProfile.televisionSamsung.request(
                    videoID: track.videoID, visitorData: visitor, signatureTimestamp: timestamp
                )
                let tvData = try await fetch(tv, maxBytes: 1024 * 1024, mime: ["application/json"], budget: budget)
                payload = try decodeSourceJSON(PortablePlayerResponse.self, from: tvData)
            }
        }
        guard let payload else { throw PlaybackFailure.invalidResponse }
        diagnostic(.playerResponseDecoded)
        guard payload.playabilityStatus?.status == "OK" else { throw PlaybackFailure.sourceDenied }
        guard payload.videoDetails?.videoId == track.videoID else { throw PlaybackFailure.invalidResponse }
        guard payload.videoDetails?.isLiveContent != true, payload.videoDetails?.isLive != true,
              payload.videoDetails?.isUpcoming != true else { throw PlaybackFailure.unavailable }
        guard payload.streamingData?.licenseInfos?.isEmpty ?? true else { throw PlaybackFailure.unavailable }
        let formats = (payload.streamingData?.adaptiveFormats ?? []).filter { $0.isAACAudio && $0.hasLocator }
            .sorted { ($0.bitrate ?? 0) > ($1.bitrate ?? 0) }
        guard let format = formats.first else { throw PlaybackFailure.unavailable }
        diagnostic(.formatSelected)
        var locator = try format.locator()
        diagnostic(.locatorValidated)
        let fields = try sourceQuery(locator.percentEncodedQuery)
        let n = fields["n"]
        if let n, !sourceCipherValue(n) { throw PlaybackFailure.invalidSource }
        diagnostic(.challengeRead)
        if locator.signature != nil || n != nil {
            if script == nil {
                guard let scriptURL = try bootstrap.playerScriptURL() else { throw PlaybackFailure.scriptRequired }
                diagnostic(.scriptAddressValidated)
                script = try await fetchScript(scriptURL, budget: budget)
            }
            guard let script else { throw PlaybackFailure.scriptRequired }
            diagnostic(.scriptDecoded)
            try budget.check()
            let solution = try await cipherSolver.solve(
                playerJavaScript: script, signature: locator.signature, n: n, videoID: track.videoID
            )
            try budget.check()
            diagnostic(.cipherSolved)
            guard (locator.signature == nil) == (solution.signature == nil), (n == nil) == (solution.n == nil),
                  solution.signature.map(sourceCipherValue) ?? true,
                  solution.n.map(sourceCipherValue) ?? true else { throw PlaybackFailure.invalidSource }
            if let signature = solution.signature { try locator.setQueryValue(signature, named: locator.signatureParameter) }
            if let transformedN = solution.n { try locator.setQueryValue(transformedN, named: "n") }
        }
        guard let url = locator.url,
              let lengthText = format.contentLength, let length = sourceDecimal(lengthText), length >= 3072,
              let expiryText = try sourceQuery(locator.percentEncodedQuery)["expire"],
              let expiry = sourceDecimal(expiryText) else { throw PlaybackFailure.invalidSource }
        let lease = try VerifiedYouTubeStreamLease(
            requestedVideoID: track.videoID, playerVideoID: payload.videoDetails!.videoId,
            itag: format.itag, mimeType: format.mimeType, contentLength: length, url: url,
            expiresAt: Date(timeIntervalSince1970: TimeInterval(expiry)), bitrate: format.bitrate, now: now()
        )
        diagnostic(.leaseValidated)
        // Preflight is deliberately tiny. Complete media delivery is separately
        // guarded by the lease-aware AVPlayer resource loader.
        for start in [0, length / 2 - 512, length - 1024] {
            try budget.check()
            var request = URLRequest(url: url)
            request.setValue("bytes=\(start)-\(start + 1023)", forHTTPHeaderField: "Range")
            request.timeoutInterval = try budget.remaining()
            request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
            let response = try await transport.request(request, maxBytes: 1024)
            try budget.check()
            try PlayerSourceHTTP.validateMediaContentEncoding(response.headers)
            guard sourceMIME(response.headers) == "audio/mp4" else { throw PlaybackFailure.invalidResponse }
            try PartialMediaSample.validate(response, expectedStart: start, expectedEnd: start + 1023, expectedTotal: length)
        }
        try budget.check()
        guard lease.expiresAt.timeIntervalSince(now()) > 0 else { throw PlaybackFailure.expired }
        diagnostic(.preflightValidated)
        return try ResolvedAudio.youtube(lease: lease)
        } catch is CancellationError { throw CancellationError() }
        catch let failure as PlaybackFailure { throw failure }
        catch {
            if Task.isCancelled { throw CancellationError() }
            throw PlaybackFailure.invalidResponse
        }
    }

    private func fetchScript(_ url: URL, budget: SourceBudget) async throws -> Data {
        guard PlayerSourceHTTP.isAllowedPlayerScript(url) else { throw PlaybackFailure.invalidSource }
        try budget.check()
        let cacheable = url.path.contains("/player_ias.vflset/")
        if let cached = cachedPlayerScript {
            let age = now().timeIntervalSince(cached.cachedAt)
            if !age.isFinite || age < 0 || age >= 600 { cachedPlayerScript = nil }
            else if cacheable && cached.url == url { return cached.body }
        }
        let data = try await fetch(URLRequest(url: url), maxBytes: 8 * 1024 * 1024,
                                   mime: ["text/javascript", "application/javascript", "application/x-javascript"], budget: budget)
        guard !data.isEmpty, String(data: data, encoding: .utf8) != nil else { throw PlaybackFailure.invalidResponse }
        let timestamp = now()
        try budget.check()
        if cacheable && timestamp.timeIntervalSince1970.isFinite {
            cachedPlayerScript = CachedPlayerScript(url: url, body: data, cachedAt: timestamp)
        }
        return data
    }

    private func fetch(_ original: URLRequest, maxBytes: Int, mime: Set<String>, budget: SourceBudget) async throws -> Data {
        var request = original
        request.timeoutInterval = try budget.remaining()
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if request.value(forHTTPHeaderField: "User-Agent") == nil {
            // Maintained web_safari/web_embedded compatibility profile. The
            // watch bootstrap chooses its own canonical player script URL.
            request.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)", forHTTPHeaderField: "User-Agent")
        }
        guard PlayerSourceHTTP.isAllowedControlRequest(request, maxBytes: maxBytes) else { throw PlaybackFailure.invalidSource }
        let response = try await transport.request(request, maxBytes: maxBytes)
        try budget.check()
        guard response.status == 200, response.body.count <= maxBytes,
              let contentType = sourceMIME(response.headers), mime.contains(contentType) else {
            throw PlaybackFailure.invalidResponse
        }
        if let rawLength = sourceHeader("content-length", in: response.headers) {
            guard let length = sourceDecimal(rawLength), length == response.body.count else { throw PlaybackFailure.invalidResponse }
        }
        return response.body
    }
}

private struct SourceBudget: Sendable {
    let end: TimeInterval
    init(seconds: TimeInterval) { end = ProcessInfo.processInfo.systemUptime + seconds }
    func check() throws {
        try Task.checkCancellation()
        guard ProcessInfo.processInfo.systemUptime < end else { throw PlaybackFailure.network }
    }
    func remaining() throws -> TimeInterval {
        try check()
        return max(0.001, end - ProcessInfo.processInfo.systemUptime)
    }
}

private func sourceHeader(_ name: String, in headers: [String: String]) -> String? {
    let matches = headers.filter { $0.key.caseInsensitiveCompare(name) == .orderedSame }
    guard matches.count == 1 else { return nil }
    return matches.first?.value
}

private func sourceMIME(_ headers: [String: String]) -> String? {
    sourceHeader("content-type", in: headers)?.split(separator: ";", maxSplits: 1).first?
        .trimmingCharacters(in: .whitespaces).lowercased()
}

private func sourceCipherValue(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 4096
        && value.utf8.allSatisfy { (33...126).contains($0) && $0 != 37 && $0 != 38 && $0 != 35 }
}

private struct PortablePlayerResponse: Decodable {
    struct Details: Decodable { let videoId: String; let isLiveContent: Bool?; let isLive: Bool?; let isUpcoming: Bool? }
    struct Status: Decodable { let status: String }
    struct Streaming: Decodable { let adaptiveFormats: [Format]?; let licenseInfos: [License]? }
    struct License: Decodable {}
    struct Format: Decodable {
        let itag: Int
        let mimeType: String
        let url: String?
        let signatureCipher: String?
        let cipher: String?
        let contentLength: String?
        let bitrate: Int?
        let drmFamilies: [String]?
        let drmTrackType: String?
        let width: Int?
        let height: Int?
        let qualityLabel: String?
        var hasLocator: Bool { url != nil || signatureCipher != nil || cipher != nil }
        var isAACAudio: Bool {
            [139, 140, 141].contains(itag)
                && mimeType.range(of: #"^audio/mp4;\s*codecs="mp4a\.40\.[25]"$"#, options: .regularExpression) != nil
                && (drmFamilies?.isEmpty ?? true) && drmTrackType == nil
                && width == nil && height == nil && qualityLabel == nil
        }
        func locator() throws -> SourceLocator {
            guard (signatureCipher == nil || cipher == nil), !(url != nil && (signatureCipher != nil || cipher != nil)) else {
                throw PlaybackFailure.invalidSource
            }
            if let cipher = signatureCipher ?? cipher {
                let fields = try sourceQuery(cipher, form: true)
                guard fields.keys.allSatisfy({ ["url", "s", "sp"].contains($0) }),
                      let rawURL = fields["url"], let signature = fields["s"], sourceCipherValue(signature),
                      ["sig", "signature"].contains(fields["sp"] ?? "signature") else { throw PlaybackFailure.invalidSource }
                return try SourceLocator(rawURL: rawURL, signature: signature, signatureParameter: fields["sp"] ?? "signature")
            }
            guard let url else { throw PlaybackFailure.invalidSource }
            return try SourceLocator(rawURL: url, signature: nil, signatureParameter: "signature")
        }
    }
    let videoDetails: Details?
    let playabilityStatus: Status?
    let streamingData: Streaming?
}

private struct SourceLocator {
    private var parts: URLComponents
    let signature: String?
    let signatureParameter: String
    var url: URL? { parts.url }
    var percentEncodedQuery: String? { parts.percentEncodedQuery }
    init(rawURL: String, signature: String?, signatureParameter: String) throws {
        guard rawURL.utf8.count <= 24 * 1024, validSourcePercentEncoding(rawURL),
              rawURL.unicodeScalars.allSatisfy({ $0.value >= 33 && $0.value != 127 }),
              let parts = URLComponents(string: rawURL), let url = parts.url,
              ResolvedAudio.isAllowed(url), parts.path == "/videoplayback", parts.percentEncodedPath == parts.path else {
            throw PlaybackFailure.invalidSource
        }
        let fields = try sourceQuery(parts.percentEncodedQuery)
        guard fields.keys.allSatisfy({ $0 == $0.lowercased() }),
              !fields.keys.contains(where: { ["range", "begin", "sq", "authorization", "cookie", "s"].contains($0) }),
              signature == nil || (fields["sig"] == nil && fields["signature"] == nil) else { throw PlaybackFailure.invalidSource }
        self.parts = parts; self.signature = signature; self.signatureParameter = signatureParameter
    }
    mutating func setQueryValue(_ value: String, named name: String) throws {
        let fields = try sourceQuery(parts.percentEncodedQuery)
        if name != "n", fields[name] != nil { throw PlaybackFailure.invalidSource }
        var encoding = URLComponents()
        encoding.queryItems = [URLQueryItem(name: name, value: value)]
        guard let encoded = encoding.percentEncodedQuery else { throw PlaybackFailure.invalidSource }
        var rawFields = (parts.percentEncodedQuery ?? "").split(separator: "&").map(String.init)
        rawFields.removeAll { field in
            field.split(separator: "=", maxSplits: 1).first?.removingPercentEncoding == name
        }
        rawFields.append(encoded)
        parts.percentEncodedQuery = rawFields.joined(separator: "&")
        _ = try sourceQuery(parts.percentEncodedQuery)
    }
}

private struct SourceBootstrap {
    private let bytes: [UInt8]
    private let configs: [Configuration]
    private struct Configuration: Decodable {
        struct Context: Decodable {
            struct Client: Decodable { let clientName: String?; let clientVersion: String?; let visitorData: String? }
            let client: Client?
        }
        let INNERTUBE_CONTEXT: Context?
        let INNERTUBE_CLIENT_VERSION: String?
        let STS: Int?
        let VISITOR_DATA: String?
    }
    struct WebClient { let version: String }
    init(data: Data, diagnostic: @Sendable (YouTubeSourceStep) -> Void) throws {
        guard data.count <= 4 * 1024 * 1024, String(data: data, encoding: .utf8) != nil else { throw PlaybackFailure.invalidResponse }
        bytes = Array(data)
        let frames = try SourceJSONFrames.objects(in: bytes, after: "ytcfg.set(", limit: 16, maxBytes: 1024 * 1024)
        diagnostic(.configurationFramesRead)
        // YouTube also calls ytcfg.set with unrelated JavaScript expressions
        // (e.g. telemetry). Those are not JSON and are never evaluated here.
        // Only canonical configuration fields consumed by this resolver enter
        // the strict JSON decoder. A malformed consumed frame still fails.
        let consumedFrames = try frames.filter { try SourceJSONFrames.containsConfigurationKey(in: $0) }
        do { configs = try consumedFrames.map { try decodeSourceJSON(Configuration.self, from: $0) } }
        catch let DecodingError.typeMismatch(_, context) {
            switch context.codingPath.map(\.stringValue).joined(separator: ".") {
            case "INNERTUBE_CONTEXT": diagnostic(.configurationContextType)
            case "INNERTUBE_CONTEXT.client": diagnostic(.configurationClientType)
            case "INNERTUBE_CONTEXT.client.clientName": diagnostic(.configurationClientNameType)
            case "INNERTUBE_CONTEXT.client.clientVersion", "INNERTUBE_CLIENT_VERSION": diagnostic(.configurationClientVersionType)
            case "STS": diagnostic(.configurationTimestampType)
            default: diagnostic(.configurationShapeRejected)
            }
            throw PlaybackFailure.invalidResponse
        }
        catch DecodingError.dataCorrupted { diagnostic(.configurationDataRejected); throw PlaybackFailure.invalidResponse }
        catch DecodingError.keyNotFound { diagnostic(.configurationKeyRejected); throw PlaybackFailure.invalidResponse }
        catch is DecodingError { diagnostic(.configurationShapeRejected); throw PlaybackFailure.invalidResponse }
        catch { diagnostic(.configurationValidationRejected); throw error }
    }
    var signatureTimestamp: Int? {
        let values = Set(configs.compactMap(\.STS))
        return values.count == 1 ? values.first : nil
    }
    func visitorData() throws -> String? {
        let values = Set(configs.flatMap { [$0.VISITOR_DATA, $0.INNERTUBE_CONTEXT?.client?.visitorData].compactMap { $0 } })
        guard values.count <= 1 else { throw PlaybackFailure.invalidResponse }
        guard let visitor = values.first else { return nil }
        guard visitor.range(of: #"^[A-Za-z0-9_=%+/\-]{1,4096}$"#, options: .regularExpression) != nil,
              validSourcePercentEncoding(visitor) else { throw PlaybackFailure.invalidResponse }
        return visitor
    }
    func initialPlayerResponse() throws -> PortablePlayerResponse? {
        let frames = try SourceJSONFrames.objects(in: bytes, after: "ytInitialPlayerResponse", limit: 1, maxBytes: 1024 * 1024, assignment: true)
        guard let data = frames.first else { return nil }
        return try decodeSourceJSON(PortablePlayerResponse.self, from: data)
    }
    func webClient() throws -> WebClient? {
        var versions: Set<String> = []
        for config in configs {
            if let name = config.INNERTUBE_CONTEXT?.client?.clientName, name != "WEB" { throw PlaybackFailure.invalidResponse }
            if let version = config.INNERTUBE_CONTEXT?.client?.clientVersion ?? config.INNERTUBE_CLIENT_VERSION { versions.insert(version) }
        }
        guard versions.count <= 1 else { throw PlaybackFailure.invalidResponse }
        guard let version = versions.first else { return nil }
        guard version.range(of: #"^[A-Za-z0-9_.-]{1,80}$"#, options: .regularExpression) != nil else { throw PlaybackFailure.invalidResponse }
        return WebClient(version: version)
    }
    func playerScriptURL() throws -> URL? {
        var values = try SourceJSONFrames.strings(in: bytes, named: "PLAYER_JS_URL")
        values += try SourceJSONFrames.strings(in: bytes, named: "jsUrl")
        var urls: Set<URL> = []
        for value in values {
            guard value.hasPrefix("/s/player/") || value.hasPrefix("https://www.youtube.com/s/player/") else {
                throw PlaybackFailure.invalidSource
            }
            guard let url = URL(string: value.hasPrefix("/") ? "https://www.youtube.com" + value : value),
                  PlayerSourceHTTP.isAllowedPlayerScript(url) else { throw PlaybackFailure.invalidSource }
            // Quack's restricted interpreter supports the IAS build; ES6
            // template interpolation is explicitly unsupported. Select only
            // the IAS sibling of the exact trusted build hash and locale.
            let compatible = URL(string: url.absoluteString.replacingOccurrences(
                of: "/player_es6.vflset/", with: "/player_ias.vflset/"
            ))!
            guard PlayerSourceHTTP.isAllowedPlayerScript(compatible) else { throw PlaybackFailure.invalidSource }
            urls.insert(compatible)
        }
        guard urls.count <= 1 else { throw PlaybackFailure.invalidResponse }
        return urls.first
    }
}

/// Extracts JSON frames by balanced delimiters with explicit byte/count/depth
/// caps. String contents and escape sequences cannot close a frame.
private enum SourceJSONFrames {
    /// Projects top-level key tokens only. Values remain opaque; in particular,
    /// words inside telemetry expressions cannot be mistaken for config keys.
    static func containsConfigurationKey(in data: Data) throws -> Bool {
        let bytes = Array(data)
        let consumed: Set<String> = ["INNERTUBE_CONTEXT", "INNERTUBE_CLIENT_VERSION", "STS", "VISITOR_DATA"]
        var index = 0, depth = 0, parentheses = 0
        var expectingKey = false
        while index < bytes.count {
            let byte = bytes[index]
            if byte == 34 || byte == 39 || byte == 96 {
                let start = index, delimiter = byte
                index += 1
                var escaped = false
                while index < bytes.count {
                    if bytes[index] == delimiter && !escaped { break }
                    if bytes[index] == 92 && !escaped { escaped = true } else { escaped = false }
                    index += 1
                }
                guard index < bytes.count else { throw PlaybackFailure.invalidResponse }
                if depth == 1 && parentheses == 0 && expectingKey {
                    var next = index + 1; skipWhitespace(bytes, &next)
                    if next < bytes.count && bytes[next] == 58 {
                        guard index - start <= 512 else { throw PlaybackFailure.invalidResponse }
                        let key: String
                        if delimiter == 34 {
                            key = try JSONDecoder().decode(String.self, from: Data(bytes[start...index]))
                        } else {
                            // Non-JSON key escapes are unsupported, never evaluated.
                            guard !bytes[(start + 1)..<index].contains(92) else { throw PlaybackFailure.invalidResponse }
                            key = String(decoding: bytes[(start + 1)..<index], as: UTF8.self)
                        }
                        if consumed.contains(key) { return true }
                        expectingKey = false
                    }
                }
            } else if byte == 123 || byte == 91 {
                depth += 1
                if depth == 1 { expectingKey = true }
            } else if byte == 125 || byte == 93 { depth -= 1 }
            else if byte == 40 { parentheses += 1 }
            else if byte == 41 { parentheses -= 1 }
            else if byte == 44 && depth == 1 && parentheses == 0 { expectingKey = true }
            else if depth == 1 && parentheses == 0 && expectingKey,
                    (65...90).contains(byte) || (97...122).contains(byte) || byte == 95 {
                let start = index
                while index + 1 < bytes.count && ((65...90).contains(bytes[index + 1]) || (97...122).contains(bytes[index + 1]) || (48...57).contains(bytes[index + 1]) || bytes[index + 1] == 95) { index += 1 }
                var next = index + 1; skipWhitespace(bytes, &next)
                if next < bytes.count && bytes[next] == 58 {
                    if consumed.contains(String(decoding: bytes[start...index], as: UTF8.self)) { return true }
                    expectingKey = false
                }
            }
            guard depth >= 0, depth <= 64, parentheses >= 0, parentheses <= 64 else { throw PlaybackFailure.invalidResponse }
            index += 1
        }
        return false
    }

    static func objects(in bytes: [UInt8], after marker: String, limit: Int, maxBytes: Int, assignment: Bool = false) throws -> [Data] {
        let needle = Array(marker.utf8)
        var cursor = 0
        var result: [Data] = []
        while let position = find(needle, in: bytes, from: cursor) {
            cursor = position + needle.count
            var start = cursor
            skipWhitespace(bytes, &start)
            if assignment {
                guard start < bytes.count, bytes[start] == 61 else { continue }
                start += 1; skipWhitespace(bytes, &start)
            }
            guard start < bytes.count, bytes[start] == 123 else { continue }
            guard result.count < limit else { throw PlaybackFailure.invalidResponse }
            let end = try objectEnd(bytes, start: start, maxBytes: maxBytes)
            result.append(Data(bytes[start..<end])); cursor = end
        }
        return result
    }
    static func strings(in bytes: [UInt8], named name: String) throws -> [String] {
        let needle = Array(("\"" + name + "\"").utf8)
        var cursor = 0
        var result: [String] = []
        while let position = find(needle, in: bytes, from: cursor) {
            cursor = position + needle.count
            var start = cursor; skipWhitespace(bytes, &start)
            guard start < bytes.count, bytes[start] == 58 else { continue }
            start += 1; skipWhitespace(bytes, &start)
            guard start < bytes.count, bytes[start] == 34 else { continue }
            guard result.count < 32 else { throw PlaybackFailure.invalidResponse }
            var end = start + 1; var escaped = false
            while end < bytes.count && end - start <= 4096 {
                if !escaped && bytes[end] == 34 { break }
                if bytes[end] == 92 && !escaped { escaped = true } else { escaped = false }
                end += 1
            }
            guard end < bytes.count, end - start <= 4096, bytes[end] == 34 else { throw PlaybackFailure.invalidResponse }
            result.append(try JSONDecoder().decode(String.self, from: Data(bytes[start...end])))
            cursor = end + 1
        }
        return result
    }
    private static func find(_ needle: [UInt8], in bytes: [UInt8], from: Int) -> Int? {
        guard !needle.isEmpty, from <= bytes.count, bytes.count - from >= needle.count else { return nil }
        for index in from...(bytes.count - needle.count) where bytes[index] == needle[0] {
            if bytes[index..<(index + needle.count)].elementsEqual(needle) { return index }
        }
        return nil
    }
    private static func skipWhitespace(_ bytes: [UInt8], _ index: inout Int) {
        while index < bytes.count && [9, 10, 13, 32].contains(bytes[index]) { index += 1 }
    }
    private static func objectEnd(_ bytes: [UInt8], start: Int, maxBytes: Int) throws -> Int {
        var depth = 0; var quote: UInt8?; var escaped = false
        for index in start..<min(bytes.count, start + maxBytes + 1) {
            let byte = bytes[index]
            if let delimiter = quote {
                if byte == delimiter && !escaped { quote = nil }
                if byte == 92 && !escaped { escaped = true } else { escaped = false }
            } else if byte == 34 || byte == 39 || byte == 96 { quote = byte }
            else if byte == 123 || byte == 91 {
                depth += 1
                guard depth <= 64 else { throw PlaybackFailure.invalidResponse }
            } else if byte == 125 || byte == 93 {
                depth -= 1
                guard depth >= 0 else { throw PlaybackFailure.invalidResponse }
                if depth == 0 { return index + 1 }
            }
        }
        throw PlaybackFailure.invalidResponse
    }
}

/// JSONDecoder accepts repeated keys. Reject them first so identity and source
/// fields have one meaning even when another parser interprets the response.
private struct SourceJSONScope {
    let object: Bool
    var expectingKey: Bool
    var keys: Set<String> = []
}

private func decodeSourceJSON<Value: Decodable>(_ type: Value.Type, from data: Data) throws -> Value {
    let bytes = Array(data)
    var stack: [SourceJSONScope] = []
    var index = 0
    var keyCount = 0
    while index < bytes.count {
        let byte = bytes[index]
        if byte == 34 {
            let start = index
            index += 1
            var escaped = false
            while index < bytes.count {
                if bytes[index] == 34 && !escaped { break }
                if bytes[index] == 92 && !escaped { escaped = true } else { escaped = false }
                index += 1
            }
            guard index < bytes.count else { throw PlaybackFailure.invalidResponse }
            if let last = stack.indices.last, stack[last].object && stack[last].expectingKey {
                guard index - start <= 512, keyCount < 32768 else { throw PlaybackFailure.invalidResponse }
                let key = try JSONDecoder().decode(String.self, from: Data(bytes[start...index]))
                guard stack[last].keys.insert(key).inserted else { throw PlaybackFailure.invalidResponse }
                keyCount += 1
            }
        } else if byte == 123 || byte == 91 {
            guard stack.count < 64 else { throw PlaybackFailure.invalidResponse }
            stack.append(SourceJSONScope(object: byte == 123, expectingKey: byte == 123))
        } else if byte == 125 || byte == 93 {
            guard let last = stack.last, last.object == (byte == 125) else { throw PlaybackFailure.invalidResponse }
            stack.removeLast()
        } else if byte == 58, let last = stack.indices.last {
            stack[last].expectingKey = false
        } else if byte == 44, let last = stack.indices.last, stack[last].object {
            stack[last].expectingKey = true
        }
        index += 1
    }
    guard stack.isEmpty else { throw PlaybackFailure.invalidResponse }
    return try JSONDecoder().decode(type, from: data)
}
