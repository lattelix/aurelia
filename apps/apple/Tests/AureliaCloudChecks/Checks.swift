import Foundation
@testable import AureliaCloud
import Darwin

private enum Failure: Error { case assertion(String) }
private func expect(_ condition: @autoclosure () -> Bool, _ label: String) throws {
    if !condition() { throw Failure.assertion(label) }
}
private func json(_ value: Any, status: Int = 200, headers: [String: String] = [:]) -> CloudHTTPResponse {
    CloudHTTPResponse(status: status, headers: headers, body: try! JSONSerialization.data(withJSONObject: value))
}
private func user(_ id: String) -> [String: Any] {
    ["id": id, "name": "Cloud listener", "email": NSNull(), "identities": ["telegram", "google"]]
}
private let playlistID = "00000000-0000-0000-0000-000000000001"
private func track(_ youtube: Bool) -> [String: Any] {
    ["id": youtube ? "youtube:00000000001" : "studio:afterglow-1", "title": youtube ? "Cloud recording" : "Golden Hour",
     "artist": "Test artist", "album": "Test album", "provider": youtube ? "youtube" : "studio",
     "externalId": youtube ? "00000000001" : "1", "duration": 72, "artwork": "/art/afterglow.svg"]
}
private func bootstrap(_ id: String, count: Int = 2) -> CloudHTTPResponse {
    let tracks: [[String: Any]] = count == 0 ? [] : [track(true), track(false)]
    return json(["user": user(id), "library": ["likes": tracks, "playlists": [
        ["id": playlistID, "name": "Across devices", "description": "", "tracks": tracks, "createdAt": "2026-11-07T00:00:00Z"]
    ], "queue": ["playing": true, "volume": 1]], "capabilities": ["telegram": true]])
}
private func publicTrack(_ id: String = "00000000001", title: String = "Public recording") -> [String: Any] {
    var result = track(true)
    result["id"] = "youtube:\(id)"; result["externalId"] = id; result["title"] = title
    result["artwork"] = "https://i.ytimg.com/vi/\(id)/hqdefault.jpg"
    result["sourceUrl"] = "https://www.youtube.com/watch?v=\(id)"
    return result
}
private func discovery(_ tracks: [[String: Any]]? = nil, fetchedAt: String = "2026-11-09T00:00:00.000Z") -> CloudHTTPResponse {
    json(["source": "youtube-music", "fetchedAt": fetchedAt, "sections": [
        ["id": "public-music", "title": "Public music", "tracks": tracks ?? [publicTrack()]]
    ]])
}
private func searchResponse(_ id: String = "00000000001", title: String = "Public recording") -> CloudHTTPResponse {
    json(["source": "youtube", "tracks": [publicTrack(id, title: title)], "albums": [], "artists": [], "playlists": []])
}
private let validGrant = json(["deviceCode": String(repeating: "d", count: 43), "userCode": "ABCD-EFGH",
    "verificationUri": "https://aurelia.lattelix.com/account?connect=ABCD-EFGH", "expiresIn": 600, "interval": 3])
private func approved(_ id: String) -> CloudHTTPResponse {
    json(["status": "approved", "token": String(repeating: id == "a" ? "a" : "b", count: 43), "user": user(id), "expiresIn": 2_592_000])
}

private actor ScriptTransport: CloudHTTPTransport {
    enum Step: Sendable { case response(CloudHTTPResponse), hold }
    private let steps: [Step]
    private(set) var requests: [URLRequest] = []
    private var held: [Int: CheckedContinuation<CloudHTTPResponse, Error>] = [:]
    init(_ responses: [CloudHTTPResponse]) { self.steps = responses.map(Step.response) }
    init(steps: [Step]) { self.steps = steps }
    func send(_ request: URLRequest, maxBytes: Int) async throws -> CloudHTTPResponse {
        let index = requests.count; requests.append(request)
        guard steps.indices.contains(index) else { throw CloudFailure.unavailable }
        switch steps[index] {
        case .response(let response): return response
        case .hold: return try await withCheckedThrowingContinuation { held[index] = $0 }
        }
    }
    func finish(_ index: Int, response: CloudHTTPResponse) { held.removeValue(forKey: index)?.resume(returning: response) }
    var count: Int { requests.count }
}
private actor ManualSleep {
    private(set) var intervals: [Double] = []
    private var waiting: [CheckedContinuation<Void, Error>] = []
    func sleep(_ interval: Double) async throws {
        intervals.append(interval)
        try await withCheckedThrowingContinuation { waiting.append($0) }
    }
    func resume() { if !waiting.isEmpty { waiting.removeFirst().resume() } }
    var count: Int { intervals.count }
}
@MainActor private final class FakeCredentials: CredentialStoring {
    var value: CloudCredential?
    var loadFailure: CloudFailure?
    var saveFailure: CloudFailure?
    var deleteFailure: CloudFailure?
    var loads = 0, saves = 0, deletes = 0
    init(_ value: CloudCredential? = nil) { self.value = value }
    func load() throws -> CloudCredential? { loads += 1; if let loadFailure { throw loadFailure }; return value }
    func save(_ credential: CloudCredential) throws { if let saveFailure { throw saveFailure }; value = credential; saves += 1 }
    func delete() throws { if let deleteFailure { throw deleteFailure }; value = nil; deletes += 1 }
}
private let date = Date(timeIntervalSince1970: 1_800_000_000)
private func credential(_ id: String) throws -> CloudCredential {
    try CloudCredential(token: String(repeating: id, count: 43), accountID: id, expiresAt: date.addingTimeInterval(86400))
}
@MainActor private func eventually(_ predicate: @MainActor () async -> Bool) async throws {
    for _ in 0..<500 { if await predicate() { return }; try await Task.sleep(for: .milliseconds(2)) }
    throw Failure.assertion("state deadline")
}
@MainActor private func store(_ transport: ScriptTransport, _ credentials: FakeCredentials, _ sleeper: ManualSleep = ManualSleep()) -> CloudAccountStore {
    CloudAccountStore(client: CloudAPIClient(transport: transport), credentials: credentials, now: { date }, sleep: { try await sleeper.sleep($0) })
}

@main private struct Checks {
    @MainActor static func main() async {
        if CommandLine.arguments.contains("--public-metadata-live") {
            await livePublicMetadata()
            return
        }
        let checks: [(String, @MainActor () async throws -> Void)] = [
            ("pkce_s256", pkce), ("approval_url_and_response_boundary", boundary),
            ("bearer_account_headers_and_id_only_mutations", requests),
            ("restore_keeps_cloud_youtube_metadata", restore), ("locked_storage_preserves_credential", locked),
            ("poll_pending_slow_down_approval", polling), ("cancelled_grant_cannot_replace_new_account", cancelled),
            ("stale_401_cannot_delete_new_account", stale401), ("stale_snapshot_cannot_undo_mutation_refresh", staleRead),
            ("expiry_storage_failure_and_revocation", failures),
            ("public_metadata_timeout_policy_and_diagnostic_privacy", timeoutPolicy),
            ("anonymous_music_fixed_query_and_artwork", publicRequests), ("public_music_validation_bounds", publicValidation),
            ("public_music_last_request_cancel_and_reset", publicRaces), ("account_transition_invalidates_public_music", publicOwnerReset),
            ("independent_search_window_results_and_cancellation", independentSearchSessions),
            ("playlist_metadata_and_exact_order_cas", playlistMetadata), ("playlist_write_refresh_failure_is_visible", playlistFailures),
            ("lyrics_listening_transfer_and_offline_owner", runCloudParityChecks)
        ] + CloudCatalogueChecks.cases + CloudManagedLyricsChecks.cases
        for (name, operation) in checks {
            do { try await operation(); print("PASS \(name)") }
            catch { print("FAIL \(name): \(error)"); exit(1) }
        }
        print("Cloud deterministic checks passed: \(checks.count). Mock HTTP and credentials only; no Keychain, network, GUI or audio.")
    }
    static func pkce() async throws {
        let challenge = try PKCE.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        try expect(challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "RFC S256 vector")
        let values = (0..<20).map { _ in PKCE.verifier() }
        try expect(Set(values).count == 20 && values.allSatisfy { $0.count == 43 }, "random verifier shape")
    }
    static func boundary() async throws {
        for uri in ["http://aurelia.lattelix.com/account?connect=ABCD-EFGH",
                    "https://aurelia-music.vercel.app/account?connect=ABCD-EFGH",
                    "https://evil.test/account?connect=ABCD-EFGH", "https://aurelia.lattelix.com/other?connect=ABCD-EFGH",
                    "https://aurelia.lattelix.com/account?connect=OTHER", "https://aurelia.lattelix.com/account?connect=ABCD-EFGH&next=evil",
                    "https://user@aurelia.lattelix.com/account?connect=ABCD-EFGH", "https://aurelia.lattelix.com:443/account?connect=ABCD-EFGH"] {
            let transport = ScriptTransport([json(["deviceCode": String(repeating: "x", count: 43), "userCode": "ABCD-EFGH", "verificationUri": uri, "expiresIn": 600, "interval": 3])])
            do { _ = try await CloudAPIClient(transport: transport).startDevice(challenge: String(repeating: "a", count: 43), deviceName: "Aurelia for Mac"); throw Failure.assertion("bad approval URL accepted") }
            catch CloudFailure.invalidResponse {}
        }
        for response in [CloudHTTPResponse(status: 200, body: Data(repeating: 0, count: 256 * 1024 + 1)), json([:], status: 302)] {
            do { _ = try await CloudAPIClient(transport: ScriptTransport([response])).startDevice(challenge: String(repeating: "a", count: 43), deviceName: "Aurelia for Mac"); throw Failure.assertion("bad transport response") }
            catch CloudFailure.invalidResponse {}
        }
        let manage = CloudAPIClient.accountURL(expectedAccountID: "a")!
        try expect(manage.absoluteString == "https://aurelia.lattelix.com/account?expectedUserId=a", "fixed account guard hint")
    }
    static func requests() async throws {
        let transport = ScriptTransport([bootstrap("a"), json(["ok": true]), json(["id": playlistID]), json(["ok": true]), json(["ok": true]), json(["ok": true]), json(["user": user("a")])])
        let client = CloudAPIClient(transport: transport), auth = try credential("a")
        _ = try await client.bootstrap(auth)
        try await client.setLiked("studio:afterglow-1", liked: true, credential: auth)
        _ = try await client.createPlaylist(" Name ", credential: auth)
        try await client.playlistTrack("youtube:00000000001", playlistID: playlistID, adding: true, credential: auth)
        try await client.playlistTrack("youtube:00000000001", playlistID: playlistID, adding: false, credential: auth)
        try await client.logout(auth); _ = try await client.me(auth)
        let calls = await transport.requests
        for request in calls {
            try expect(request.timeoutInterval == 15, "auth and mutation requests keep 15 second timeout")
            try expect(request.url?.host == "aurelia.lattelix.com" && request.url?.scheme == "https", "fixed HTTPS")
            try expect(request.value(forHTTPHeaderField: "Cookie") == nil && request.value(forHTTPHeaderField: "Origin") == nil, "no cookie/origin spoof")
            try expect(request.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true, "native bearer")
        }
        for index in [1, 2, 3, 4] { try expect(calls[index].value(forHTTPHeaderField: "X-Aurelia-Account") == "a", "captured expected account") }
        try expect(calls[4].httpMethod == "DELETE" && calls[4].url?.path == "/api/library/playlists/\(playlistID)/tracks", "existing delete route")
        let body = try JSONSerialization.jsonObject(with: calls[4].httpBody!) as! [String: String]
        try expect(body == ["trackId": "youtube:00000000001"], "ID-only delete body")
        try expect(calls[5].value(forHTTPHeaderField: "X-Aurelia-Account") == nil, "logout bearer only")
    }
    @MainActor static func restore() async throws {
        let vault = try FakeCredentials(credential("a")), transport = ScriptTransport([bootstrap("a")])
        let model = store(transport, vault)
        await model.restore()
        try expect(model.phase == .signedIn && model.account?.id == "a", "restored real account")
        try expect(model.library?.likes.count == 2 && model.library?.likes.first?.provider == "youtube", "cloud metadata not Studio-filtered")
        try expect(vault.deletes == 0 && vault.saves == 0, "restore does not rewrite credential")
        let wrongVault = try FakeCredentials(credential("a")), wrong = store(ScriptTransport([bootstrap("b")]), wrongVault)
        await wrong.restore()
        try expect(wrong.account == nil && wrong.library == nil && wrongVault.deletes == 0 && wrongVault.value?.accountID == "a", "wrong account payload rejected without erasing A")
        let absentVault = try FakeCredentials(credential("a")), absent = store(ScriptTransport([json(["user": NSNull(), "library": NSNull(), "capabilities": [:]])]), absentVault)
        await absent.restore()
        try expect(absent.phase == .expired && absentVault.deletes == 1, "anonymous bootstrap expires current native session")
    }
    @MainActor static func locked() async throws {
        let vault = try FakeCredentials(credential("a")), transport = ScriptTransport([bootstrap("a")])
        vault.loadFailure = .credentialLocked
        let model = store(transport, vault)
        await model.restore()
        try expect(model.phase == .secureStorageLocked && vault.value?.accountID == "a" && vault.deletes == 0, "locked Keychain preserved")
        let lockedRequests = await transport.count
        try expect(lockedRequests == 0, "locked storage never uses HTTP")
        vault.loadFailure = nil; await model.restore()
        try expect(model.account?.id == "a", "unlock retry")
    }
    @MainActor static func polling() async throws {
        let transport = ScriptTransport([validGrant, json(["status": "pending"]), json(["error": "slow_down"], status: 429, headers: ["retry-after": "9"]), approved("a"), bootstrap("a")])
        let vault = FakeCredentials(), sleeper = ManualSleep(), model = store(transport, vault, sleeper)
        _ = await model.beginSignIn(deviceName: "Aurelia for Mac")
        for expectedCount in 1...3 {
            try await eventually { await sleeper.count == expectedCount }
            await sleeper.resume()
        }
        try await eventually { model.phase == .signedIn && model.library != nil }
        let intervals = await sleeper.intervals
        try expect(intervals == [3, 3, 9], "minimum interval and slowdown")
        try expect(vault.saves == 1 && model.approval == nil, "secure credential commit only on approval")
        let calls = await transport.requests
        let initial = try JSONSerialization.jsonObject(with: calls[0].httpBody!) as! [String: String]
        let poll = try JSONSerialization.jsonObject(with: calls[1].httpBody!) as! [String: String]
        let pollChallenge = try PKCE.challenge(poll["codeVerifier"]!)
        try expect(pollChallenge == initial["codeChallenge"], "poll proves initial verifier")
    }
    @MainActor static func cancelled() async throws {
        let transport = ScriptTransport(steps: [.response(validGrant), .hold, .response(validGrant), .response(approved("b")), .response(bootstrap("b")), .response(json(["ok": true]))])
        let vault = FakeCredentials(), sleeper = ManualSleep(), model = store(transport, vault, sleeper)
        _ = await model.beginSignIn(deviceName: "Aurelia for Mac")
        try await eventually { await sleeper.count == 1 }; await sleeper.resume()
        try await eventually { await transport.count == 2 }
        model.cancelSignIn()
        _ = await model.beginSignIn(deviceName: "Aurelia for Mac")
        try await eventually { await sleeper.count == 2 }; await sleeper.resume()
        try await eventually { model.account?.id == "b" && model.library != nil }
        await transport.finish(1, response: approved("a"))
        try await eventually { await transport.count == 6 }
        try expect(model.account?.id == "b" && vault.value?.accountID == "b" && vault.saves == 1, "cancelled A cannot replace B")
        await model.setLiked("studio:afterglow-1", liked: true, expectedAccountID: "a")
        await model.signOut(expectedAccountID: "a")
        let callsAfterStaleAction = await transport.count
        try expect(callsAfterStaleAction == 6, "old account UI cannot send a mutation as B")
    }
    @MainActor static func stale401() async throws {
        let transport = ScriptTransport(steps: [.hold, .response(json(["ok": true])), .response(validGrant), .response(approved("b")), .response(bootstrap("b"))])
        let vault = try FakeCredentials(credential("a")), sleeper = ManualSleep(), model = store(transport, vault, sleeper)
        let oldRestore = Task { await model.restore() }
        try await eventually { await transport.count == 1 }
        await model.signOut(expectedAccountID: "a")
        _ = await model.beginSignIn(deviceName: "Aurelia for Mac")
        try await eventually { await sleeper.count == 1 }; await sleeper.resume()
        try await eventually { model.account?.id == "b" && model.library != nil }
        await transport.finish(0, response: json(["error": "expired"], status: 401)); await oldRestore.value
        try expect(model.account?.id == "b" && vault.value?.accountID == "b" && vault.deletes == 1, "stale unauthorized cannot erase B")
    }
    @MainActor static func staleRead() async throws {
        let transport = ScriptTransport(steps: [.response(bootstrap("a", count: 0)), .hold, .response(json(["ok": true])), .response(bootstrap("a"))])
        let vault = try FakeCredentials(credential("a")), model = store(transport, vault)
        await model.restore()
        let oldRead = Task { await model.refresh() }
        try await eventually { await transport.count == 2 }
        await model.setLiked("studio:afterglow-1", liked: true, expectedAccountID: "a")
        await transport.finish(1, response: bootstrap("a", count: 0)); await oldRead.value
        try expect(model.library?.likes.count == 2, "old snapshot cannot undo fresh mutation read")
    }
    @MainActor static func failures() async throws {
        for code in ["expired_token", "invalid_grant"] {
            let client = CloudAPIClient(transport: ScriptTransport([validGrant, json(["error": code], status: 400)]))
            let grant = try await client.startDevice(challenge: String(repeating: "a", count: 43), deviceName: "Aurelia for Mac")
            do {
                _ = try await client.pollDevice(grant, verifier: String(repeating: "a", count: 43), now: date)
                throw Failure.assertion("expired/replayed server grant accepted")
            } catch CloudFailure.expired {}
        }
        let expiredGrant = json(["deviceCode": String(repeating: "d", count: 43), "userCode": "ABCD-EFGH", "verificationUri": "https://aurelia.lattelix.com/account?connect=ABCD-EFGH", "expiresIn": 1, "interval": 3])
        let vault = FakeCredentials(), model = store(ScriptTransport([expiredGrant]), vault)
        _ = await model.beginSignIn(deviceName: "Aurelia for Mac")
        try await eventually { model.phase == .signedOut }
        try expect(model.approval == nil && vault.saves == 0, "short expired flow clears grant")
        let rejected = try FakeCredentials(credential("a")), denied = store(ScriptTransport([json(["error": "expired"], status: 401)]), rejected)
        await denied.restore()
        try expect(denied.phase == .expired && rejected.deletes == 1, "same generation 401 removes invalid credential")
        let locked = FakeCredentials(), sleeper = ManualSleep(), transport = ScriptTransport([validGrant, approved("a"), json(["ok": true])])
        locked.saveFailure = .credentialLocked
        let uncommitted = store(transport, locked, sleeper)
        _ = await uncommitted.beginSignIn(deviceName: "Aurelia for Mac")
        try await eventually { await sleeper.count == 1 }; await sleeper.resume()
        try await eventually { uncommitted.phase == .signedOut }
        try expect(uncommitted.account == nil && locked.saves == 0 && locked.deletes == 0, "failed secure save never commits account")
        let revokeCalls = await transport.count
        try expect(revokeCalls == 3, "unpersistable newly approved token revoked")
    }
    @MainActor static func publicRequests() async throws {
        let transport = ScriptTransport([discovery(), searchResponse()]), vault = FakeCredentials()
        let model = store(transport, vault)
        await model.music.loadDiscovery()
        await model.music.search("  Artist & provider=studio?/# % +  ")
        try expect(model.music.discovery?.sections.first?.tracks.first?.id == "youtube:00000000001", "discovery metadata available to guests")
        try expect(model.music.searchResults.first?.safeArtworkURL?.absoluteString == "https://i.ytimg.com/vi/00000000001/hqdefault.jpg", "safe derived YouTube artwork")
        try expect(vault.loads == 0 && vault.saves == 0 && vault.deletes == 0 && model.phase == .signedOut, "public music never touches secure storage")
        let calls = await transport.requests
        try expect(calls[0].url?.absoluteString == "https://aurelia.lattelix.com/api/discovery", "fixed anonymous discovery route")
        let parts = URLComponents(url: calls[1].url!, resolvingAgainstBaseURL: false)!
        try expect(parts.path == "/api/search" && parts.queryItems == [URLQueryItem(name: "q", value: "Artist & provider=studio?/# % +"), URLQueryItem(name: "provider", value: "youtube")], "query is data, never endpoint or extra parameters")
        for call in calls {
            try expect(call.timeoutInterval == 30, "anonymous music request gets cold-load timeout")
            try expect(call.httpMethod == "GET" && call.httpBody == nil && !call.httpShouldHandleCookies, "anonymous metadata GET only")
            for header in ["Authorization", "Cookie", "Origin", "X-Aurelia-Account"] {
                try expect(call.value(forHTTPHeaderField: header) == nil, "no account material in music request")
            }
        }
        var unsafe = publicTrack(); unsafe["artwork"] = "https://evil.test/signed?token=secret"
        let unsafeClient = CloudAPIClient(transport: ScriptTransport([json(["source": "youtube", "tracks": [unsafe]])]))
        let safeTracks = try await unsafeClient.search("music")
        try expect(safeTracks.first?.safeArtworkURL?.host == "i.ytimg.com", "response artwork cannot select remote host")
        for path in ["/api/discovery?next=evil", "/api/search?q=ok&provider=studio", "/api/search?q=ok&provider=youtube&next=evil", "/api/search?q=ok&q=other&provider=youtube", "/api/search", "/api/stream?id=youtube:00000000001"] {
            let request = URLRequest(url: URL(string: "https://aurelia.lattelix.com\(path)")!)
            do { _ = try await URLSessionCloudTransport().send(request, maxBytes: 1024); throw Failure.assertion("non-whitelisted query reached transport") }
            catch CloudFailure.invalidResponse {}
        }
    }
    @MainActor static func publicValidation() async throws {
        var mismatch = publicTrack(); mismatch["externalId"] = "00000000002"
        var badArtwork = publicTrack(); badArtwork["artwork"] = "https://evil.test/image.jpg"
        var badLink = publicTrack(); badLink["sourceUrl"] = "https://evil.test/watch"
        var shortID = publicTrack(); shortID["id"] = "youtube:short"; shortID["externalId"] = "short"
        let section: [String: Any] = ["id": "music", "title": "Music", "tracks": [publicTrack()]]
        let badDiscovery = [discovery([mismatch]), discovery([badArtwork]), discovery([badLink]), discovery([shortID]), discovery(fetchedAt: "yesterday"),
            discovery(fetchedAt: "2026-02-30T00:00:00Z"), discovery(fetchedAt: "2026-11-09T24:00:00Z"),
            discovery(Array(repeating: publicTrack(), count: 25)),
            json(["source": "youtube-music", "fetchedAt": "2026-11-09T00:00:00Z", "sections": Array(repeating: section, count: 5)]),
            CloudHTTPResponse(status: 200, body: Data(repeating: 0, count: 512 * 1024 + 1)), json([:], status: 302)]
        for response in badDiscovery {
            do { _ = try await CloudAPIClient(transport: ScriptTransport([response])).discovery(); throw Failure.assertion("invalid discovery accepted") }
            catch CloudFailure.invalidResponse {}
        }
        for response in [json(["source": "studio", "tracks": [publicTrack()]]), json(["source": "youtube", "tracks": [mismatch]]), json(["source": "youtube", "tracks": [track(false)]]), json(["source": "youtube", "tracks": Array(repeating: publicTrack(), count: 101)])] {
            do { _ = try await CloudAPIClient(transport: ScriptTransport([response])).search("music"); throw Failure.assertion("invalid public search accepted") }
            catch CloudFailure.invalidResponse {}
        }
        let empty = ScriptTransport([]), client = CloudAPIClient(transport: empty)
        for query in ["", " \n ", String(repeating: "x", count: 201), String(repeating: "🎵", count: 101), "bad\u{0}query"] {
            do { _ = try await client.search(query); throw Failure.assertion("invalid query accepted") }
            catch CloudFailure.invalidResponse {}
        }
        let count = await empty.count
        try expect(count == 0, "invalid query cannot send HTTP")
    }
    static func timeoutPolicy() async throws {
        func request(_ path: String, method: String = "GET") -> URLRequest {
            var request = URLRequest(url: URL(string: "https://aurelia.lattelix.com\(path)")!)
            request.httpMethod = method; request.httpShouldHandleCookies = false
            return request
        }
        let discovery = request("/api/discovery")
        let search = request("/api/search?q=private-query-sentinel&provider=youtube")
        for value in [discovery, search] {
            let policy = CloudRequestPolicy.policy(for: value)
            try expect(policy.requestTimeout == 30 && policy.resourceTimeout == 45, "both anonymous public routes get bounded cold-load headroom")
        }
        var protectedRequests = [request("/api/auth/me"), request("/api/bootstrap"), request("/api/auth/device/start", method: "POST"),
            request("/api/library/likes", method: "POST"), request("/api/library/playlists/\(playlistID)/order", method: "PUT"),
            request("/api/discovery", method: "POST"), request("/api/discovery?next=private-query-sentinel"),
            request("/api/search?q=music&provider=studio"), request("/api/search?q=music&provider=youtube&extra=private-query-sentinel"),
            request("/api/search?q=music&q=other&provider=youtube"), request("/api/search")]
        for base in [discovery, search] {
            for header in ["Authorization", "Proxy-Authorization", "X-Aurelia-Account", "Cookie", "Origin"] {
                var value = base; value.setValue("private-header-sentinel", forHTTPHeaderField: header)
                protectedRequests.append(value)
            }
            var body = base; body.httpBody = Data(); protectedRequests.append(body)
            var stream = base; stream.httpBodyStream = InputStream(data: Data([0])); protectedRequests.append(stream)
            var cookies = base; cookies.httpShouldHandleCookies = true; protectedRequests.append(cookies)
        }
        for url in ["https://evil.test/api/discovery", "http://aurelia.lattelix.com/api/discovery",
                    "https://private-user-sentinel@aurelia.lattelix.com/api/discovery",
                    "https://aurelia.lattelix.com:443/api/discovery", "https://aurelia.lattelix.com/api/discovery#private-fragment-sentinel"] {
            var value = URLRequest(url: URL(string: url)!); value.httpShouldHandleCookies = false
            protectedRequests.append(value)
        }
        for value in protectedRequests {
            let policy = CloudRequestPolicy.policy(for: value)
            try expect(policy.requestTimeout == 15 && policy.resourceTimeout == 20, "auth/write/unexpected metadata never expands timeout")
        }
        #if DEBUG
        let error = URLError(.timedOut, userInfo: [NSLocalizedDescriptionKey: "private-exception-sentinel", NSURLErrorFailingURLErrorKey: search.url!])
        let lines = [
            CloudHTTPDiagnostics.line(route: .discovery, result: .httpStatus(502), elapsedMilliseconds: 20_123),
            CloudHTTPDiagnostics.line(route: CloudRequestPolicy.policy(for: search).route, result: .urlError(error.code.rawValue), elapsedMilliseconds: 30_001),
            CloudHTTPDiagnostics.line(route: .other, result: .failure, elapsedMilliseconds: -1)
        ]
        try expect(lines == ["AureliaCloud route=discovery http_status=502 elapsed_ms=20123",
                             "AureliaCloud route=search url_error=-1001 elapsed_ms=30001",
                             "AureliaCloud route=other failure elapsed_ms=0"], "diagnostics expose only fixed tags and numeric outcomes")
        for line in lines {
            try expect(line.range(of: "^AureliaCloud route=(discovery|search|other) (http_status=[0-9]+|url_error=-?[0-9]+|failure) elapsed_ms=[0-9]+$", options: .regularExpression) != nil,
                       "diagnostic output has closed grammar")
            try expect(!line.contains("private-") && !line.contains("https:") && !line.contains("Bearer") && !line.contains("Cookie"),
                       "query, identity, headers and raw exception text never enter diagnostic output")
        }
        #endif
    }
    @MainActor static func publicRaces() async throws {
        let transport = ScriptTransport(steps: [.hold, .response(searchResponse("00000000002", title: "New")), .hold, .hold, .hold, .response(discovery([publicTrack("00000000002")]))])
        let music = CloudMusicStore(client: CloudAPIClient(transport: transport))
        let old = Task { await music.search("old") }
        try await eventually { await transport.count == 1 }
        await music.search("new")
        await transport.finish(0, response: searchResponse("00000000001", title: "Old")); await old.value
        try expect(music.searchResults.first?.title == "New" && !music.searchLoading && music.searchError == nil, "late cancelled search cannot undo latest")
        let cleared = Task { await music.search("clear") }
        try await eventually { await transport.count == 3 }
        await music.search(String(repeating: "x", count: 201))
        await transport.finish(2, response: searchResponse()); await cleared.value
        try expect(music.searchResults.isEmpty && !music.searchLoading && music.searchError == nil, "invalid query clears and invalidates")
        let cancelled = Task { await music.search("cancel") }
        try await eventually { await transport.count == 4 }; cancelled.cancel()
        await transport.finish(3, response: searchResponse()); await cancelled.value
        try expect(music.searchResults.isEmpty && !music.searchLoading && music.searchError == nil, "parent cancellation does not render response")
        let staleDiscovery = Task { await music.loadDiscovery() }
        try await eventually { await transport.count == 5 }
        await music.loadDiscovery()
        await transport.finish(4, response: discovery()); await staleDiscovery.value
        try expect(music.discovery?.sections.first?.tracks.first?.externalId == "00000000002" && !music.discoveryLoading, "discovery last request wins")
        music.reset()
        try expect(music.discovery == nil && music.searchResults.isEmpty && music.discoveryError == nil, "reset clears metadata")
    }
    @MainActor static func independentSearchSessions() async throws {
        let transport = ScriptTransport(steps: [.hold, .response(searchResponse("00000000002", title: "Window B")), .hold])
        let shared = CloudMusicStore(client: CloudAPIClient(transport: transport))
        let first = shared.makeSearchSession(), second = shared.makeSearchSession()
        let heldFirst = Task { await first.search("window A") }
        try await eventually { await transport.count == 1 }
        await second.search("window B")
        try expect(second.searchResults.first?.title == "Window B" && first.searchResults.isEmpty && first.searchLoading,
                   "second window cannot replace first pending results")
        await transport.finish(0, response: searchResponse("00000000001", title: "Window A"))
        await heldFirst.value
        try expect(first.searchResults.first?.title == "Window A" && second.searchResults.first?.title == "Window B",
                   "late first result belongs only to first window")
        let heldSecond = Task { await second.search("window B next") }
        try await eventually { await transport.count == 3 }
        first.reset(); shared.reset()
        await transport.finish(2, response: searchResponse("00000000003", title: "Window B next"))
        await heldSecond.value
        try expect(second.searchResults.first?.title == "Window B next" && first.searchResults.isEmpty && shared.searchResults.isEmpty,
                   "reset in one screen cannot cancel another screen")
    }

    @MainActor static func publicOwnerReset() async throws {
        let transport = ScriptTransport(steps: [.hold, .response(bootstrap("a")), .hold, .response(json(["ok": true]))])
        let vault = try FakeCredentials(credential("a")), model = store(transport, vault)
        let guest = Task { await model.music.search("guest") }
        try await eventually { await transport.count == 1 }
        await model.restore()
        await transport.finish(0, response: searchResponse()); await guest.value
        try expect(model.account?.id == "a" && model.music.searchResults.isEmpty, "guest result cannot render across restoration")
        let oldAccount = Task { await model.music.loadDiscovery() }
        try await eventually { await transport.count == 3 }
        await model.signOut(expectedAccountID: "a")
        await transport.finish(2, response: discovery()); await oldAccount.value
        try expect(model.phase == .signedOut && model.music.discovery == nil && !model.music.discoveryLoading, "old account discovery cannot render after sign-out")
    }
    @MainActor static func playlistMetadata() async throws {
        let transport = ScriptTransport([json(["id": playlistID]), json(["ok": true]), json(["ok": true]), json(["ok": true]), json(["ok": true])])
        let client = CloudAPIClient(transport: transport), auth = try credential("a")
        _ = try await client.createPlaylist(" Name ", description: "A description", credential: auth)
        try await client.updatePlaylist(playlistID, name: " New name ", description: "Updated", credential: auth)
        let before = ["youtube:00000000001", "studio:afterglow-1"]
        try await client.reorderPlaylist(playlistID, trackIDs: before.reversed(), expectedTrackIDs: before, credential: auth)
        let calls = await transport.requests
        let create = try JSONSerialization.jsonObject(with: calls[0].httpBody!) as! [String: String]
        let edit = try JSONSerialization.jsonObject(with: calls[1].httpBody!) as! [String: String]
        let order = try JSONSerialization.jsonObject(with: calls[2].httpBody!) as! [String: [String]]
        try expect(create == ["name": "Name", "description": "A description"] && edit == ["name": "New name", "description": "Updated"], "description and trimmed name contract")
        try expect(calls[1].httpMethod == "PATCH" && calls[2].httpMethod == "PUT" && calls[2].url?.path == "/api/library/playlists/\(playlistID)/order", "metadata and order routes")
        try expect(order == ["trackIds": before.reversed(), "expectedTrackIds": before], "CAS carries exact original order")
        try expect(calls.allSatisfy { $0.value(forHTTPHeaderField: "X-Aurelia-Account") == "a" }, "captured owner for all writes")
        let fourHundred = (0..<400).map { "youtube:" + String(format: "%011d", $0) }
        try await client.reorderPlaylist(playlistID, trackIDs: fourHundred.reversed(), expectedTrackIDs: fourHundred, credential: auth)
        let maximum = (0..<5000).map { String(repeating: "x", count: 156) + String(format: "%04d", $0) }
        try await client.reorderPlaylist(playlistID, trackIDs: maximum.reversed(), expectedTrackIDs: maximum, credential: auth)
        let largeCalls = await transport.requests
        try expect(largeCalls[3].httpBody!.count > 16 * 1024 && largeCalls[4].httpBody!.count < 1_700_000, "400-track and maximum-size 5000-track CAS are supported")
        for ids in [[before[0], before[0]], [before[0]], ["other"]] {
            do { try await client.reorderPlaylist(playlistID, trackIDs: ids, expectedTrackIDs: before, credential: auth); throw Failure.assertion("invalid permutation accepted") }
            catch CloudFailure.invalidResponse {}
        }
        let tooMany = (0...5000).map { "youtube:" + String(format: "%011d", $0) }
        do { try await client.reorderPlaylist(playlistID, trackIDs: tooMany, expectedTrackIDs: tooMany, credential: auth); throw Failure.assertion("5001 order accepted") }
        catch CloudFailure.invalidResponse {}
        var oversized = URLRequest(url: CloudAPIClient.origin.appendingPathComponent("api/library/playlists"))
        oversized.httpMethod = "POST"; oversized.httpBody = Data(repeating: 32, count: 16 * 1024 + 1)
        do { _ = try await URLSessionCloudTransport().send(oversized, maxBytes: 1024); throw Failure.assertion("oversized generic body reached HTTP") }
        catch CloudFailure.invalidResponse {}
        oversized.url = CloudAPIClient.origin.appendingPathComponent("api/library/playlists/\(playlistID)/order")
        oversized.httpMethod = "PUT"
        do { _ = try await URLSessionCloudTransport().send(oversized, maxBytes: 1024); throw Failure.assertion("invalid oversized CAS payload reached HTTP") }
        catch CloudFailure.invalidResponse {}
        let count = await transport.count
        try expect(count == 5, "invalid order never sends HTTP")
    }
    @MainActor static func playlistFailures() async throws {
        let transport = ScriptTransport([bootstrap("a"), json(["error": "secret server error"], status: 409), json(["ok": true]), json([:], status: 503), json([:], status: 503), bootstrap("a"), json(["ok": true]), bootstrap("a")])
        let vault = try FakeCredentials(credential("a")), model = store(transport, vault)
        await model.restore()
        let original = model.library
        let denied = await model.updatePlaylist(playlistID, name: "New", description: "", expectedAccountID: "b")
        let conflict = await model.reorderPlaylist(playlistID, trackIDs: ["studio:afterglow-1", "youtube:00000000001"], expectedTrackIDs: ["youtube:00000000001", "studio:afterglow-1"], expectedAccountID: "a")
        try expect(!denied && !conflict && model.message == CloudFailure.conflict.message && model.library == original, "stale owner blocked and CAS conflict stays visible")
        let refreshed = await model.updatePlaylist(playlistID, name: "New", description: "Updated", expectedAccountID: "a")
        try expect(refreshed && model.libraryNeedsRefresh && model.message == "Saved. Refresh the library to see the latest changes." && model.library == original && !model.isMutating && !model.isRefreshing, "acknowledged write closes editor with visible pending refresh")
        let blocked = await model.createPlaylist("Do not repeat", expectedAccountID: "a")
        let count = await transport.count
        try expect(!blocked && count == 4, "stale snapshot blocks further writes without replay")
        await model.signOut(expectedAccountID: "a")
        try expect(model.libraryNeedsRefresh && model.account?.id == "a", "failed logout preserves stale snapshot gate for retained owner")
        model.cancelSignIn()
        let stillBlocked = await model.createPlaylist("Still do not repeat", expectedAccountID: "a")
        let afterFailedLogout = await transport.count
        try expect(!stillBlocked && model.libraryNeedsRefresh && afterFailedLogout == 5, "cancel and failed identity transition cannot reopen stale write gate")
        await model.refresh()
        try expect(!model.libraryNeedsRefresh && model.message == nil, "explicit successful refresh clears write gate")
        let saved = await model.updatePlaylist(playlistID, name: "Allowed again", description: "", expectedAccountID: "a")
        try expect(saved && !model.libraryNeedsRefresh, "write allowed after authoritative refresh")
    }
    @MainActor static func livePublicMetadata() async {
        let client = CloudAPIClient(transport: URLSessionCloudTransport())
        var failed = false
        do {
            let page = try await client.discovery()
            print("Public discovery: sections=\(page.sections.count) tracks=\(page.sections.reduce(0) { $0 + $1.tracks.count })")
        } catch { print("FAIL public discovery metadata"); failed = true }
        do {
            let tracks = try await client.search("Dua Lipa")
            print("Public search: tracks=\(tracks.count)")
        } catch { print("FAIL public search metadata"); failed = true }
        if failed { exit(1) }
    }
}
