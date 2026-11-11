import Foundation

public actor CloudAPIClient {
    public static let origin = URL(string: "https://aurelia.lattelix.com")!
    private let transport: any CloudHTTPTransport
    public init(transport: any CloudHTTPTransport) { self.transport = transport }

    public nonisolated static func isAccountURL(_ url: URL) -> Bool { sameOrigin(url) && url.path == "/account" }
    public nonisolated static func isVerificationURL(_ url: URL, userCode: String) -> Bool {
        guard isAccountURL(url), let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return false }
        return items.count == 1 && items[0].name == "connect" && items[0].value == userCode
    }
    nonisolated static func isAPIURL(_ url: URL) -> Bool {
        guard sameOrigin(url), url.path.hasPrefix("/api/") else { return false }
        if url.path.hasPrefix("/api/music/catalogue") { return validCatalogueRequest(url) }
        guard url.query != nil else { return !["/api/search", "/api/lyrics"].contains(url.path) }
        guard let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return false }
        if url.path == "/api/lyrics" {
            guard items.count == 1, items[0].name == "q", let query = items[0].value else { return false }
            return lyricsQuery(query) == query
        }
        guard url.path == "/api/search",
              items.count == 2, items.filter({ $0.name == "q" }).count == 1,
              items.filter({ $0.name == "provider" && $0.value == "youtube" }).count == 1,
              let query = items.first(where: { $0.name == "q" })?.value else { return false }
        return musicQuery(query) == query
    }
    /// Only authenticated metadata files and exact CAS order payloads exceed 16 KiB.
    nonisolated static func requestBodyLimit(_ request: URLRequest) -> Int {
        let standard = 16 * 1024
        if request.httpMethod == "POST", request.url?.path == "/api/import/file",
           let url = request.url, isAPIURL(url), url.query == nil,
           request.value(forHTTPHeaderField: "Authorization").map({ $0.hasPrefix("Bearer ") }) == true,
           let owner = request.value(forHTTPHeaderField: "X-Aurelia-Account"), validID(owner),
           let data = request.httpBody, !data.isEmpty, data.count <= 2_000_000,
           (try? JSONSerialization.jsonObject(with: data)) is [String: Any] { return 2_000_000 }
        guard let data = request.httpBody, data.count > standard, data.count <= 1_700_000,
              request.httpMethod == "PUT", let url = request.url, isAPIURL(url), url.query == nil else { return standard }
        let path = url.path.split(separator: "/")
        guard path.count == 5, path[0] == "api", path[1] == "library", path[2] == "playlists", path[4] == "order",
              UUID(uuidString: String(path[3])) != nil,
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(body.keys) == Set(["trackIds", "expectedTrackIds"]),
              let ids = body["trackIds"] as? [String], let expected = body["expectedTrackIds"] as? [String],
              validPlaylistOrder(ids, expectedTrackIDs: expected) else { return standard }
        return 1_700_000
    }
    private nonisolated static func sameOrigin(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return parts.scheme == origin.scheme && parts.host == origin.host && parts.port == nil
            && parts.user == nil && parts.password == nil && parts.fragment == nil
    }
    public nonisolated static func accountURL(expectedAccountID: String) -> URL? {
        guard validID(expectedAccountID) else { return nil }
        var parts = URLComponents(url: origin.appendingPathComponent("account"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "expectedUserId", value: expectedAccountID)]
        return parts.url
    }
    public func discovery() async throws -> DiscoveryDTO {
        let result: DiscoveryDTO = try await request("discovery", maxBytes: 512 * 1024)
        try result.validate(); return result
    }
    public func search(_ query: String) async throws -> [TrackDTO] {
        guard let query = musicQuery(query) else { throw CloudFailure.invalidResponse }
        let result: SearchDTO = try await request("search", query: [URLQueryItem(name: "q", value: query), URLQueryItem(name: "provider", value: "youtube")], maxBytes: 512 * 1024)
        try result.validate(); return result.tracks
    }
    public func searchCatalogue(_ query: String, kind: MusicSearchKind) async throws -> MusicCatalogueSearchResult {
        guard let query = musicQuery(query) else { throw CloudFailure.invalidResponse }
        let result: MusicCatalogueDTO = try await request("music/catalogue/search", query: [
            .init(name: "q", value: query), .init(name: "kind", value: kind.rawValue)
        ], maxBytes: 8 * 1024 * 1024)
        try result.validate(expectedKind: kind.rawValue, query: query)
        return .init(catalogue: result, usesLegacySongs: false)
    }
    public func browseCatalogue(kind: MusicCollectionKind, id: String) async throws -> MusicCatalogueDTO {
        guard kind.accepts(id) else { throw CloudFailure.invalidResponse }
        let result: MusicCatalogueDTO = try await request("music/catalogue/browse", query: [
            .init(name: "kind", value: kind.rawValue), .init(name: "id", value: id)
        ], maxBytes: 8 * 1024 * 1024)
        try result.validate(expectedKind: kind.rawValue); return result
    }
    public func chartsCatalogue(country: String) async throws -> MusicCatalogueDTO {
        guard validCatalogueCountry(country) else { throw CloudFailure.invalidResponse }
        let result: MusicCatalogueDTO = try await request("music/catalogue/charts", query: [.init(name: "country", value: country)], maxBytes: 8 * 1024 * 1024)
        try result.validate(expectedKind: "charts", country: country); return result
    }
    public func lyrics(_ query: String) async throws -> [LyricsDTO] {
        guard let query = lyricsQuery(query) else { throw CloudFailure.invalidResponse }
        let result: [LyricsDTO] = try await request("lyrics", query: [URLQueryItem(name: "q", value: query)], maxBytes: 8 * 1024 * 1024)
        guard result.allSatisfy({ $0.provenance == .lrclib }) else { throw CloudFailure.invalidResponse }
        guard result.count <= 10, Set(result.map(\.id)).count == result.count else { throw CloudFailure.invalidResponse }
        try result.forEach { try $0.validate() }; return result
    }
    public func recommendations(_ credential: CloudCredential) async throws -> [RecommendationDTO] {
        let result: [RecommendationDTO] = try await request("recommendations", token: credential.token,
            expectedAccountID: credential.accountID, maxBytes: 512 * 1024)
        try validateRecommendations(result); return result
    }
    public func recordHistory(trackID: String, playID: UUID, completion: Double, credential: CloudCredential) async throws {
        guard validID(trackID), completion.isFinite, (0...1).contains(completion) else { throw CloudFailure.invalidResponse }
        struct History: Encodable { let trackId: String; let playId: UUID; let completion: Double }
        let body = try JSONEncoder().encode(History(trackId: trackID, playId: playID, completion: completion))
        let _: OK = try await request("library/history", method: "POST", token: credential.token,
            expectedAccountID: credential.accountID, serializedBody: body)
    }
    public func recordSignal(_ kind: CloudSignalKind, trackID: String? = nil, query: String? = nil,
                             value: Double = 1, credential: CloudCredential) async throws {
        guard trackID.map(validID) ?? true, value.isFinite, (0...1).contains(value),
              query.map({ musicQuery($0) == $0 }) ?? true,
              kind != .search || query != nil,
              kind == .search || trackID != nil else { throw CloudFailure.invalidResponse }
        struct Signal: Encodable { let trackId: String?; let kind: CloudSignalKind; let value: Double; let query: String? }
        let body = try JSONEncoder().encode(Signal(trackId: trackID, kind: kind, value: value, query: query))
        let _: OK = try await request("library/signals", method: "POST", token: credential.token,
            expectedAccountID: credential.accountID, serializedBody: body)
    }
    public func startDevice(challenge: String, deviceName: String) async throws -> DeviceStartDTO {
        guard challenge.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              ["Aurelia for Mac", "Aurelia for iPhone"].contains(deviceName) else { throw CloudFailure.invalidResponse }
        let response: DeviceStartDTO = try await request("auth/device/start", method: "POST", body: ["codeChallenge": challenge, "deviceName": deviceName])
        try response.validate(); return response
    }
    public func pollDevice(_ grant: DeviceStartDTO, verifier: String, now: Date = Date()) async throws -> DevicePoll {
        _ = try PKCE.challenge(verifier)
        let result: DeviceTokenDTO = try await request("auth/device/token", method: "POST", body: ["deviceCode": grant.deviceCode, "codeVerifier": verifier])
        if result.status == "pending" { return .pending }
        guard result.status == "approved", let token = result.token, let user = result.user,
              let ttl = result.expiresIn, (1...2_678_400).contains(ttl) else { throw CloudFailure.invalidResponse }
        try user.validate()
        return .approved(try CloudCredential(token: token, accountID: user.id, expiresAt: now.addingTimeInterval(Double(ttl))), user)
    }
    public func bootstrap(_ credential: CloudCredential) async throws -> BootstrapDTO {
        let result: BootstrapDTO = try await request("bootstrap", token: credential.token, maxBytes: 8 * 1024 * 1024)
        try result.validate()
        guard let user = result.user else { throw CloudFailure.unauthorized }
        guard user.id == credential.accountID, result.library != nil else { throw CloudFailure.invalidResponse }
        return result
    }
    public func me(_ credential: CloudCredential) async throws -> AccountDTO {
        struct Response: Decodable { let user: AccountDTO }
        let result: Response = try await request("auth/me", token: credential.token)
        try result.user.validate()
        guard result.user.id == credential.accountID else { throw CloudFailure.invalidResponse }
        return result.user
    }
    public func logout(_ credential: CloudCredential) async throws {
        let _: OK = try await request("auth/logout", method: "POST", token: credential.token)
    }
    public func setLiked(_ id: String, liked: Bool, credential: CloudCredential) async throws {
        guard validID(id) else { throw CloudFailure.invalidResponse }
        let _: OK = try await request("library/likes", method: liked ? "POST" : "DELETE", token: credential.token, expectedAccountID: credential.accountID, body: ["trackId": id])
    }
    public func createPlaylist(_ name: String, description: String = "", credential: CloudCredential) async throws -> String {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf16.count <= 120, description.utf16.count <= 1000 else { throw CloudFailure.invalidResponse }
        struct Created: Decodable { let id: String }
        let result: Created = try await request("library/playlists", method: "POST", token: credential.token, expectedAccountID: credential.accountID, body: ["name": name, "description": description])
        guard validID(result.id) else { throw CloudFailure.invalidResponse }; return result.id
    }
    public func updatePlaylist(_ playlistID: String, name: String, description: String, credential: CloudCredential) async throws {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard UUID(uuidString: playlistID) != nil, !name.isEmpty, name.utf16.count <= 120,
              description.utf16.count <= 1000 else { throw CloudFailure.invalidResponse }
        let _: OK = try await request("library/playlists/\(playlistID)", method: "PATCH", token: credential.token, expectedAccountID: credential.accountID, body: ["name": name, "description": description])
    }
    public func deletePlaylist(_ playlistID: String, credential: CloudCredential) async throws {
        guard UUID(uuidString: playlistID) != nil else { throw CloudFailure.invalidResponse }
        let _: OK = try await request("library/playlists/\(playlistID)", method: "DELETE", token: credential.token,
                                      expectedAccountID: credential.accountID)
    }
    public func exportLibrary(_ credential: CloudCredential) async throws -> Data {
        let data = try await requestData("library/export", token: credential.token,
            expectedAccountID: credential.accountID, maxBytes: 2_000_000)
        try validatePortableExport(data)
        return data
    }
    public func importLibrary(_ data: Data, credential: CloudCredential) async throws -> CloudImportResultDTO {
        guard !data.isEmpty, data.count <= 2_000_000,
              (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else { throw CloudFailure.invalidResponse }
        let result: CloudImportResultDTO = try await request("import/file", method: "POST", token: credential.token,
            expectedAccountID: credential.accountID, serializedBody: data, maxBytes: 8 * 1024 * 1024)
        try result.validate(); return result
    }
    public func imports(_ credential: CloudCredential) async throws -> CloudImportResultDTO {
        let result: CloudImportResultDTO = try await request("import", token: credential.token,
            expectedAccountID: credential.accountID, maxBytes: 8 * 1024 * 1024)
        try result.validate(); return result
    }
    public func resolveImport(itemID: String, trackID: String, credential: CloudCredential) async throws -> CloudImportResultDTO {
        guard UUID(uuidString: itemID) != nil, validID(trackID) else { throw CloudFailure.invalidResponse }
        let result: CloudImportResultDTO = try await request("import/resolve", method: "POST", token: credential.token,
            expectedAccountID: credential.accountID, body: ["itemId": itemID, "trackId": trackID], maxBytes: 8 * 1024 * 1024)
        try result.validate(); return result
    }
    public func reorderPlaylist(_ playlistID: String, trackIDs: [String], expectedTrackIDs: [String], credential: CloudCredential) async throws {
        guard UUID(uuidString: playlistID) != nil,
              validPlaylistOrder(trackIDs, expectedTrackIDs: expectedTrackIDs) else { throw CloudFailure.invalidResponse }
        struct Order: Encodable { let trackIds: [String]; let expectedTrackIds: [String] }
        let body = try JSONEncoder().encode(Order(trackIds: trackIDs, expectedTrackIds: expectedTrackIDs))
        let _: OK = try await request("library/playlists/\(playlistID)/order", method: "PUT", token: credential.token, expectedAccountID: credential.accountID, serializedBody: body)
    }
    public func playlistTrack(_ trackID: String, playlistID: String, adding: Bool, credential: CloudCredential) async throws {
        guard validID(trackID), UUID(uuidString: playlistID) != nil else { throw CloudFailure.invalidResponse }
        let _: OK = try await request("library/playlists/\(playlistID)/tracks", method: adding ? "POST" : "DELETE", token: credential.token, expectedAccountID: credential.accountID, body: ["trackId": trackID])
    }
    private struct OK: Decodable {
        private enum CodingKeys: CodingKey { case ok }
        init(from decoder: Decoder) throws {
            guard try decoder.container(keyedBy: CodingKeys.self).decode(Bool.self, forKey: .ok) else { throw CloudFailure.invalidResponse }
        }
    }
    private func request<T: Decodable>(_ path: String, method: String = "GET", token: String? = nil,
                                       expectedAccountID: String? = nil, body: [String: String]? = nil,
                                       serializedBody: Data? = nil, query: [URLQueryItem] = [], maxBytes: Int = 256 * 1024) async throws -> T {
        let data = try await requestData(path, method: method, token: token, expectedAccountID: expectedAccountID,
            body: body, serializedBody: serializedBody, query: query, maxBytes: maxBytes)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw CloudFailure.invalidResponse }
    }
    private func requestData(_ path: String, method: String = "GET", token: String? = nil,
                              expectedAccountID: String? = nil, body: [String: String]? = nil,
                              serializedBody: Data? = nil, query: [URLQueryItem] = [], maxBytes: Int = 256 * 1024) async throws -> Data {
        var parts = URLComponents(url: Self.origin.appendingPathComponent("api/" + path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { parts.queryItems = query }
        guard let url = parts.url, Self.isAPIURL(url), body == nil || serializedBody == nil else { throw CloudFailure.invalidResponse }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = method; request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            guard validSecret(token) else { throw CloudFailure.invalidResponse }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let expectedAccountID {
            guard validID(expectedAccountID) else { throw CloudFailure.invalidResponse }
            request.setValue(expectedAccountID, forHTTPHeaderField: "X-Aurelia-Account")
        }
        if body != nil || serializedBody != nil {
            if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
            else { request.httpBody = serializedBody }
            guard (request.httpBody?.count ?? 0) <= Self.requestBodyLimit(request) else { throw CloudFailure.invalidResponse }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        request.timeoutInterval = CloudRequestPolicy.policy(for: request).requestTimeout
        let response: CloudHTTPResponse
        do { response = try await transport.send(request, maxBytes: maxBytes) }
        catch is CancellationError { throw CancellationError() }
        catch let error as CloudFailure { throw error }
        catch { throw CloudFailure.unavailable }
        guard response.body.count <= maxBytes, !(300...399).contains(response.status) else { throw CloudFailure.invalidResponse }
        if response.status == 429 {
            let retry = response.headers["retry-after"].flatMap(Double.init) ?? 5
            throw CloudFailure.slowDown(retry.isFinite ? min(60, max(3, retry)) : 5)
        }
        if response.status == 401 { throw CloudFailure.unauthorized }
        if response.status == 403 { throw CloudFailure.denied }
        if response.status == 409 { throw CloudFailure.conflict }
        if response.status == 410 { throw CloudFailure.expired }
        if [404, 501].contains(response.status), path.hasPrefix("music/catalogue/") { throw CloudCatalogueFailure.endpointUnavailable }
        if let error = try? JSONDecoder().decode([String: String].self, from: response.body) {
            if error["error"] == "slow_down" { throw CloudFailure.slowDown(5) }
            if error["error"] == "expired_token" || error["error"] == "invalid_grant" { throw CloudFailure.expired }
        }
        guard (200...299).contains(response.status) else { throw CloudFailure.unavailable }
        return response.body
    }
}
