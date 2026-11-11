import Foundation

public struct BoundedHTTPResponse: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let body: Data
    public init(status: Int, headers: [String: String], body: Data) {
        self.status = status; self.headers = headers; self.body = body
    }
}

public protocol YouTubeHTTPTransport: Sendable {
    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse
}

private final class RefuseRedirects: NSObject, URLSessionTaskDelegate, Sendable {
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

/// One credential-free session per transport, so sequential media chunks reuse
/// their TLS connection. Copies share only this immutable, thread-safe client.
private final class BoundedHTTPSession: Sendable {
    let session: URLSession
    let diagnostic: (@Sendable (YouTubeHTTPDiagnostic) -> Void)?
    init(diagnostic: (@Sendable (YouTubeHTTPDiagnostic) -> Void)?) {
        self.diagnostic = diagnostic
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 60
        config.httpMaximumConnectionsPerHost = 4
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil; config.urlCredentialStorage = nil; config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: config, delegate: RefuseRedirects(diagnostic: diagnostic), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
}

/// Batch appends avoid one Foundation Data mutation and cancellation lookup per
/// byte. The cap still applies before accepting every byte; scratch <=16 KiB.
func boundedSourceBody(_ bytes: URLSession.AsyncBytes, maxBytes: Int) async throws -> Data {
    try Task.checkCancellation()
    var body = Data()
    body.reserveCapacity(min(maxBytes, 64 * 1024))
    var block: [UInt8] = []
    block.reserveCapacity(min(maxBytes, 16 * 1024))
    for try await byte in bytes {
        if block.isEmpty { try Task.checkCancellation() }
        guard body.count + block.count < maxBytes else { throw PlaybackFailure.invalidResponse }
        block.append(byte)
        if block.count == 16 * 1024 {
            body.append(contentsOf: block); block.removeAll(keepingCapacity: true)
        }
    }
    try Task.checkCancellation()
    body.append(contentsOf: block)
    return body
}

/// Does not fetch scripts, store credentials/cookies, follow redirects or log URLs.
public struct BoundedYouTubeHTTP: YouTubeHTTPTransport {
    private let client: BoundedHTTPSession
    public init(diagnostic: (@Sendable (YouTubeHTTPDiagnostic) -> Void)? = nil) {
        client = BoundedHTTPSession(diagnostic: diagnostic)
    }

    public func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        guard let url = request.url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.user == nil, parts.password == nil,
              parts.port == nil, parts.fragment == nil,
              (parts.host == "www.youtube.com" && parts.path == "/youtubei/v1/player")
                || ResolvedAudio.isAllowed(url),
              maxBytes > 0, maxBytes <= 32 * 1024 * 1024,
              request.httpBody.map({ $0.count <= 16 * 1024 }) ?? true,
              request.value(forHTTPHeaderField: "Authorization") == nil,
              request.value(forHTTPHeaderField: "Cookie") == nil else { throw PlaybackFailure.invalidSource }
        let session = client.session
        do {
            try Task.checkCancellation()
            let (bytes, rawResponse) = try await session.bytes(for: request)
            // The client outlives this request. Abort rejected or partially
            // consumed responses without invalidating other admitted reads.
            defer { bytes.task.cancel() }
            guard let response = rawResponse as? HTTPURLResponse else { throw PlaybackFailure.invalidResponse }
            client.diagnostic?(.response(status: response.statusCode))
            if let rawLength = response.value(forHTTPHeaderField: "Content-Length"),
               let length = Int(rawLength), length > maxBytes { throw PlaybackFailure.invalidResponse }
            guard [200, 206].contains(response.statusCode) else {
                throw response.statusCode >= 500 ? PlaybackFailure.network : PlaybackFailure.sourceDenied
            }
            let body = try await boundedSourceBody(bytes, maxBytes: maxBytes)
            let headers = ["Content-Length", "Content-Range", "Content-Type", "Content-Encoding"].reduce(into: [String: String]()) {
                if let value = response.value(forHTTPHeaderField: $1) { $0[$1.lowercased()] = value }
            }
            return BoundedHTTPResponse(status: response.statusCode, headers: headers, body: body)
        } catch is CancellationError { throw CancellationError() }
        catch let error as PlaybackFailure { throw error }
        catch { throw PlaybackFailure.network }
    }
}
