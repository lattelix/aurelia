import Foundation

/// Control-plane transport for the portable resolver. It has no cookie jar,
/// credentials, redirects, disk cache, arbitrary origins, or arbitrary scripts.
public struct PlayerSourceHTTP: YouTubeHTTPTransport {
    private let diagnostic: (@Sendable (YouTubeHTTPDiagnostic) -> Void)?
    public init(diagnostic: (@Sendable (YouTubeHTTPDiagnostic) -> Void)? = nil) {
        self.diagnostic = diagnostic
    }

    public func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        let media = Self.isAllowedMediaPreflight(request, maxBytes: maxBytes)
        guard media || Self.isAllowedControlRequest(request, maxBytes: maxBytes) else {
            throw PlaybackFailure.invalidSource
        }
        let configuration = URLSessionConfiguration.ephemeral
        let timeout = min(max(request.timeoutInterval, 0.1), 35)
        configuration.timeoutIntervalForRequest = min(timeout, 15)
        configuration.timeoutIntervalForResource = timeout
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: PlayerSourceRedirectRefusal(diagnostic: diagnostic), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            try Task.checkCancellation()
            let (bytes, raw) = try await session.bytes(for: request)
            guard let response = raw as? HTTPURLResponse else { throw PlaybackFailure.invalidResponse }
            diagnostic?(.response(status: response.statusCode))
            guard response.url == request.url else { throw PlaybackFailure.invalidResponse }
            guard response.statusCode == (media ? 206 : 200) else {
                throw response.statusCode >= 500 ? PlaybackFailure.network : PlaybackFailure.sourceDenied
            }
            if let rawLength = response.value(forHTTPHeaderField: "Content-Length") {
                guard let length = sourceDecimal(rawLength), length <= maxBytes else {
                    throw PlaybackFailure.invalidResponse
                }
            }
            var headers: [String: String] = [:]
            for (rawName, rawValue) in response.allHeaderFields {
                guard let name = rawName as? String,
                      ["content-type", "content-length", "content-range", "content-encoding"].contains(name.lowercased()) else { continue }
                // Preserve case variants for duplicate detection instead of
                // silently overwriting one with a lowercased dictionary key.
                headers[name] = String(describing: rawValue)
            }
            if media { try Self.validateMediaContentEncoding(headers) }
            let body = try await boundedSourceBody(bytes, maxBytes: maxBytes)
            return BoundedHTTPResponse(status: response.statusCode, headers: headers, body: body)
        } catch is CancellationError { throw CancellationError() }
        catch let failure as PlaybackFailure { throw failure }
        catch {
            if Task.isCancelled { throw CancellationError() }
            throw PlaybackFailure.network
        }
    }

    /// Encoded byte streams cannot satisfy exact media Range semantics after
    /// URLSession transparently decompresses them. Also reject ambiguity from
    /// case-variant or comma-combined response fields.
    static func validateMediaContentEncoding(_ headers: [String: String]) throws {
        let values = headers.filter { $0.key.caseInsensitiveCompare("content-encoding") == .orderedSame }.map(\.value)
        guard values.isEmpty || (values.count == 1
            && values[0].trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "identity") else {
            throw PlaybackFailure.invalidResponse
        }
    }

    /// Public for deterministic policy checks; this never performs I/O.
    public static func isAllowedControlRequest(_ request: URLRequest, maxBytes: Int) -> Bool {
        guard let url = request.url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.host == "www.youtube.com",
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
              parts.percentEncodedPath == parts.path,
              request.value(forHTTPHeaderField: "Cookie") == nil,
              request.value(forHTTPHeaderField: "Authorization") == nil,
              request.httpBodyStream == nil,
              request.timeoutInterval.isFinite, request.timeoutInterval > 0,
              request.httpBody.map({ $0.count <= 16 * 1024 }) ?? true else { return false }
        let method = request.httpMethod ?? "GET"
        if parts.path == "/watch" {
            guard method == "GET", request.httpBody == nil, maxBytes > 0, maxBytes <= 4 * 1024 * 1024,
                  let fields = try? sourceQuery(parts.percentEncodedQuery), fields.count == 2,
                  fields["v"].map(sourceVideoID) == true, fields["hl"] == "en" else { return false }
            return true
        }
        if parts.path == "/youtubei/v1/player" {
            return method == "POST" && request.httpBody != nil && maxBytes > 0 && maxBytes <= 1024 * 1024
                && parts.percentEncodedQuery == "prettyPrint=false"
        }
        return method == "GET" && request.httpBody == nil && maxBytes > 0 && maxBytes <= 8 * 1024 * 1024
            && parts.query == nil && isAllowedPlayerScript(url)
    }

    private static func isAllowedMediaPreflight(_ request: URLRequest, maxBytes: Int) -> Bool {
        guard maxBytes > 0, maxBytes <= 1024, request.httpMethod == nil || request.httpMethod == "GET",
              request.httpBody == nil, request.httpBodyStream == nil,
              request.value(forHTTPHeaderField: "Cookie") == nil,
              request.value(forHTTPHeaderField: "Authorization") == nil,
              request.timeoutInterval.isFinite, request.timeoutInterval > 0,
              let url = request.url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              ResolvedAudio.isAllowed(url), parts.percentEncodedPath == "/videoplayback",
              let host = parts.host, host.range(of: #"^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.googlevideo\.com$"#, options: .regularExpression) != nil,
              let fields = try? sourceQuery(parts.percentEncodedQuery),
              !fields.keys.contains(where: { ["range", "begin", "sq", "authorization", "cookie"].contains($0.lowercased()) }),
              let range = PartialMediaSample.requestedRange(request.value(forHTTPHeaderField: "Range")),
              range.upperBound - range.lowerBound < 1024 else { return false }
        return true
    }

    static func isAllowedPlayerScript(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.host == "www.youtube.com", parts.port == nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path == parts.percentEncodedPath else { return false }
        return parts.path.range(
            of: #"^/s/player/[A-Za-z0-9_-]{6,64}/[A-Za-z0-9_-]{1,64}\.vflset/[A-Za-z0-9_-]{2,16}/base\.js$"#,
            options: .regularExpression
        ) != nil
    }
}

private final class PlayerSourceRedirectRefusal: NSObject, URLSessionTaskDelegate, Sendable {
    private let diagnostic: (@Sendable (YouTubeHTTPDiagnostic) -> Void)?
    init(diagnostic: (@Sendable (YouTubeHTTPDiagnostic) -> Void)?) {
        self.diagnostic = diagnostic
        super.init()
    }
    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        diagnostic?(.redirect(status: response.statusCode))
        completionHandler(nil)
    }
}

func sourceVideoID(_ value: String) -> Bool {
    value.range(of: #"^[A-Za-z0-9_-]{11}$"#, options: .regularExpression) != nil
}

func sourceDecimal(_ value: String) -> Int? {
    guard !value.isEmpty, value.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else { return nil }
    return Int(value)
}

/// Exactly one percent decoding pass. Form '+' conversion applies only to the
/// outer signatureCipher field, never to the signed CDN query.
func sourceQuery(_ query: String?, form: Bool = false) throws -> [String: String] {
    guard let query, !query.isEmpty, query.utf8.count <= 24 * 1024 else { throw PlaybackFailure.invalidSource }
    var result: [String: String] = [:]
    for field in query.split(separator: "&", omittingEmptySubsequences: false) {
        let pair = field.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
        guard pair.count == 2, result.count < 100 else { throw PlaybackFailure.invalidSource }
        func decode(_ value: Substring) throws -> String {
            let raw = form ? String(value).replacingOccurrences(of: "+", with: " ") : String(value)
            guard validSourcePercentEncoding(raw), let decoded = raw.removingPercentEncoding,
                  decoded.utf8.count <= 16 * 1024,
                  decoded.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value != 127 }) else {
                throw PlaybackFailure.invalidSource
            }
            return decoded
        }
        let name = try decode(pair[0])
        let value = try decode(pair[1])
        guard name.range(of: #"^[A-Za-z0-9_]{1,64}$"#, options: .regularExpression) != nil,
              !result.keys.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) else {
            throw PlaybackFailure.invalidSource
        }
        result[name] = value
    }
    return result
}

func validSourcePercentEncoding(_ string: String) -> Bool {
    let bytes = Array(string.utf8)
    var index = 0
    while index < bytes.count {
        if bytes[index] == 37 {
            guard index + 2 < bytes.count else { return false }
            for byte in bytes[(index + 1)...(index + 2)] {
                guard (48...57).contains(byte) || (65...70).contains(byte) || (97...102).contains(byte) else { return false }
            }
            index += 3
        } else { index += 1 }
    }
    return true
}
