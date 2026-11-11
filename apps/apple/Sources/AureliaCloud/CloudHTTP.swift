import Foundation

public struct CloudHTTPResponse: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let body: Data
    public init(status: Int, headers: [String: String] = [:], body: Data) {
        self.status = status; self.headers = headers; self.body = body
    }
}
public protocol CloudHTTPTransport: Sendable {
    func send(_ request: URLRequest, maxBytes: Int) async throws -> CloudHTTPResponse
}

enum CloudHTTPRoute: String, Sendable { case discovery, search, other }

/// Public metadata may wait for the server's bounded cold upstream load.
/// Identity-bearing requests and mutations keep their existing shorter limits.
struct CloudRequestPolicy: Equatable, Sendable {
    let requestTimeout: TimeInterval
    let resourceTimeout: TimeInterval
    let route: CloudHTTPRoute

    static func policy(for request: URLRequest) -> Self {
        guard let url = request.url, CloudAPIClient.isAPIURL(url) else {
            return Self(requestTimeout: 15, resourceTimeout: 20, route: .other)
        }
        let route: CloudHTTPRoute = switch url.path {
        case "/api/discovery": .discovery
        case "/api/search": .search
        default: .other
        }
        let catalogue = url.path.hasPrefix("/api/music/catalogue/") && validCatalogueRequest(url)
        let anonymousMetadata = (route != .other || catalogue) && request.httpMethod == "GET"
            && !request.httpShouldHandleCookies && request.httpBody == nil && request.httpBodyStream == nil
            && ["Authorization", "Proxy-Authorization", "X-Aurelia-Account", "Cookie", "Origin"].allSatisfy {
                request.value(forHTTPHeaderField: $0) == nil
            }
        return Self(requestTimeout: anonymousMetadata ? 30 : 15,
                    resourceTimeout: anonymousMetadata ? 45 : 20, route: route)
    }
}

#if DEBUG
/// The formatter accepts only finite route tags and numeric outcomes, never request/error text.
enum CloudHTTPDiagnostics {
    enum Result: Sendable { case httpStatus(Int), urlError(Int), failure }
    static func line(route: CloudHTTPRoute, result: Result, elapsedMilliseconds: Int) -> String {
        let outcome = switch result {
        case .httpStatus(let status): "http_status=\(status)"
        case .urlError(let code): "url_error=\(code)"
        case .failure: "failure"
        }
        return "AureliaCloud route=\(route.rawValue) \(outcome) elapsed_ms=\(min(86_400_000, max(0, elapsedMilliseconds)))"
    }
}
#endif

private final class CloudRedirectRefusal: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Created only by live wiring. No session/cookie/credential objects exist until send.
public struct URLSessionCloudTransport: CloudHTTPTransport {
    public init() {}
    public func send(_ request: URLRequest, maxBytes: Int) async throws -> CloudHTTPResponse {
        guard let url = request.url, CloudAPIClient.isAPIURL(url),
              request.value(forHTTPHeaderField: "Cookie") == nil,
              request.value(forHTTPHeaderField: "Origin") == nil,
              request.httpBody.map({ $0.count <= CloudAPIClient.requestBodyLimit(request) }) ?? true,
              maxBytes > 0, maxBytes <= 8 * 1024 * 1024 else { throw CloudFailure.invalidResponse }
        let policy = CloudRequestPolicy.policy(for: request)
        var request = request
        request.timeoutInterval = policy.requestTimeout
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false; config.httpCookieStorage = nil
        config.urlCredentialStorage = nil; config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = policy.requestTimeout
        config.timeoutIntervalForResource = policy.resourceTimeout
        let session = URLSession(configuration: config, delegate: CloudRedirectRefusal(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        #if DEBUG
        let started = ProcessInfo.processInfo.systemUptime
        var diagnosticResult: CloudHTTPDiagnostics.Result = .failure
        defer {
            let elapsed = min(86_400, max(0, ProcessInfo.processInfo.systemUptime - started))
            let line = CloudHTTPDiagnostics.line(route: policy.route, result: diagnosticResult,
                                                 elapsedMilliseconds: Int(elapsed * 1000))
            // A long-running device app may buffer stdout. Send this bounded,
            // sanitized DEBUG event immediately to its own console instead.
            try? FileHandle.standardError.write(contentsOf: Data((line + "\n").utf8))
        }
        #endif
        do {
            try Task.checkCancellation()
            let (bytes, raw) = try await session.bytes(for: request)
            #if DEBUG
            if let response = raw as? HTTPURLResponse { diagnosticResult = .httpStatus(response.statusCode) }
            #endif
            guard let response = raw as? HTTPURLResponse, response.url == url,
                  let type = response.value(forHTTPHeaderField: "Content-Type"),
                  type.lowercased().hasPrefix("application/json") else { throw CloudFailure.invalidResponse }
            if let rawLength = response.value(forHTTPHeaderField: "Content-Length"),
               let length = Int(rawLength), length > maxBytes { throw CloudFailure.invalidResponse }
            var data = Data(); data.reserveCapacity(min(maxBytes, 64 * 1024))
            for try await byte in bytes {
                try Task.checkCancellation()
                guard data.count < maxBytes else { throw CloudFailure.invalidResponse }
                data.append(byte)
            }
            var headers: [String: String] = [:]
            if let retry = response.value(forHTTPHeaderField: "Retry-After") { headers["retry-after"] = retry }
            return CloudHTTPResponse(status: response.statusCode, headers: headers, body: data)
        } catch let error as URLError {
            #if DEBUG
            diagnosticResult = .urlError(error.code.rawValue)
            #endif
            throw CloudFailure.unavailable
        }
        catch is CancellationError { throw CancellationError() }
        catch let error as CloudFailure { throw error }
        catch { throw CloudFailure.unavailable }
    }
}
