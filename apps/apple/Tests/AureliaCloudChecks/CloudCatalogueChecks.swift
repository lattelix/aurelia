import Foundation
@testable import AureliaCloud

private enum CatalogueCheckFailure: Error { case failed(String) }
private func requireCatalogue(_ value: @autoclosure () -> Bool, _ message: String) throws {
    if !value() { throw CatalogueCheckFailure.failed(message) }
}
@MainActor private func waitCatalogue(_ predicate: () async -> Bool) async throws {
    for _ in 0..<200 { if await predicate() { return }; try await Task.sleep(for: .milliseconds(5)) }
    throw CatalogueCheckFailure.failed("catalogue deadline")
}
private func catalogueTrack(_ number: Int = 1) -> [String: Any] {
    let id = String(format: "%011d", number)
    return ["id": "youtube:\(id)", "externalId": id, "provider": "youtube", "title": "Song \(number)", "artist": "Fixture artist", "album": "Fixture album",
            "duration": 180, "artwork": "https://i.ytimg.com/vi/\(id)/hqdefault.jpg", "audioUrl": "https://r1.googlevideo.com/ignored?token=private"]
}
private func catalogueCollection(_ kind: String = "album", id: String = "MPREb_fixture") -> [String: Any] {
    ["id": id, "kind": kind, "title": "Fixture collection", "subtitle": "Fixture artist", "artwork": "https://lh3.googleusercontent.com/fixture"]
}
private func cataloguePayload(kind: String = "songs", query: String? = nil, country: String? = nil,
                              tracks: [[String: Any]] = [], collections: [[String: Any]] = [], sections: [[String: Any]] = [],
                              overrides: [String: Any] = [:]) -> [String: Any] {
    var value: [String: Any] = ["source": "youtube-music", "fetchedAt": "2026-11-10T09:30:00.000Z", "kind": kind,
        "title": "Fixture catalogue", "subtitle": "Public metadata", "tracks": tracks, "collections": collections, "sections": sections, "truncated": false]
    if let query { value["query"] = query }
    if let country { value["country"] = country; value["countryName"] = country == "ZZ" ? "Global" : "United States" }
    for (key, replacement) in overrides { value[key] = replacement }
    return value
}
private func catalogueHTTP(_ value: [String: Any] = [:], status: Int = 200) throws -> CloudHTTPResponse {
    .init(status: status, body: try JSONSerialization.data(withJSONObject: value))
}
private actor CatalogueTransport: CloudHTTPTransport {
    private let steps: [CloudHTTPResponse?]
    private var requests: [(URLRequest, Int)] = []
    private var held: [Int: CheckedContinuation<CloudHTTPResponse, Error>] = [:]
    init(_ steps: [CloudHTTPResponse?]) { self.steps = steps }
    func send(_ request: URLRequest, maxBytes: Int) async throws -> CloudHTTPResponse {
        let index = requests.count; requests.append((request, maxBytes))
        guard steps.indices.contains(index) else { throw CloudFailure.unavailable }
        if let response = steps[index] { return response }
        // Deliberately ignore cancellation until release to verify generations.
        return try await withCheckedThrowingContinuation { held[index] = $0 }
    }
    func finish(_ index: Int, _ response: CloudHTTPResponse) { held.removeValue(forKey: index)?.resume(returning: response) }
    func calls() -> [(URLRequest, Int)] { requests }
    var count: Int { requests.count }
}

enum CloudCatalogueChecks {
    @MainActor static var cases: [(String, @MainActor () async throws -> Void)] {
        var checks: [(String, @MainActor () async throws -> Void)] = [("catalogue_fixed_anonymous_routes_and_query_bounds", requestBounds),
         ("catalogue_response_types_ids_artwork_and_size_validation", validation),
         ("catalogue_unavailable_never_falls_back_to_general_video_search", noFallback),
         ("catalogue_browse_charts_region_order_and_truncation", browseAndCharts),
         ("catalogue_generation_races_and_separate_sessions", races)]
        if ProcessInfo.processInfo.arguments.contains("--catalogue-contract-fixtures") {
            checks.append(("catalogue_backend_synthetic_wire_fixture_parity_not_live", backendFixtureParity))
        }
        return checks
    }
    @MainActor private static func requestBounds() async throws {
        let query = "Artist & song /?🙂"
        let transport = CatalogueTransport([try catalogueHTTP(cataloguePayload(query: query, tracks: [catalogueTrack()]))])
        let client = CloudAPIClient(transport: transport)
        _ = try await client.searchCatalogue("  " + query + "  ", kind: .songs)
        let calls = await transport.calls(), request = calls[0].0
        let parts = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        try requireCatalogue(request.httpMethod == "GET" && parts.scheme == "https" && parts.host == "aurelia.lattelix.com" && parts.path == "/api/music/catalogue/search", "fixed metadata endpoint")
        try requireCatalogue(parts.queryItems?.first(where: { $0.name == "q" })?.value == query && calls[0].1 == 8 * 1024 * 1024, "URLQueryItem escaping and response byte cap")
        let policy = CloudRequestPolicy.policy(for: request)
        try requireCatalogue(request.timeoutInterval == 30 && policy.requestTimeout == 30 && policy.resourceTimeout == 45 && policy.route == .other, "validated public catalogue has bounded cold-start allowance and closed diagnostic tag")
        try requireCatalogue(request.httpBody == nil && !request.httpShouldHandleCookies && ["Authorization", "Cookie", "Origin", "X-Aurelia-Account"].allSatisfy { request.value(forHTTPHeaderField: $0) == nil }, "anonymous metadata cannot carry credentials")
        for query in ["", "\n", "a\u{1}b", String(repeating: "🙂", count: 101)] {
            do { _ = try await client.searchCatalogue(query, kind: .songs); throw CatalogueCheckFailure.failed("invalid query admitted") }
            catch CloudFailure.invalidResponse {}
        }
        do { _ = try await client.browseCatalogue(kind: .artist, id: "MPREb_wrong_kind"); throw CatalogueCheckFailure.failed("wrong kind id") }
        catch CloudFailure.invalidResponse {}
        do { _ = try await client.chartsCatalogue(country: "AA"); throw CatalogueCheckFailure.failed("non ISO country") }
        catch CloudFailure.invalidResponse {}
        let count = await transport.count
        try requireCatalogue(count == 1, "invalid arguments rejected before I/O")
        var authenticated = request; authenticated.setValue("Bearer fixture", forHTTPHeaderField: "Authorization")
        try requireCatalogue(CloudRequestPolicy.policy(for: authenticated).requestTimeout == 15, "adding account credentials never gains public metadata policy")
        try requireCatalogue(!validCatalogueCountry("EU") && validCatalogueCountry("ZZ") && validCatalogueCountry("JP"), "chart countries exclude CLDR macroregions and keep explicit global scope")
        for suffix in ["search?q=a&kind=songs&kind=albums", "browse?kind=artist&id=https%3A%2F%2Fevil.invalid", "charts?country=us", "charts?country=US&url=https%3A%2F%2Fevil.invalid", "unknown?q=a", "search"] {
            let url = URL(string: "https://aurelia.lattelix.com/api/music/catalogue/" + suffix)!
            try requireCatalogue(!CloudAPIClient.isAPIURL(url), "exact route/query admission")
        }
    }

    @MainActor private static func validation() async throws {
        let base = cataloguePayload(kind: "albums", query: "Fixture", collections: [catalogueCollection()])
        let valid = try JSONDecoder().decode(MusicCatalogueDTO.self, from: JSONSerialization.data(withJSONObject: base))
        try valid.validate(expectedKind: "albums", query: "Fixture")
        try requireCatalogue(valid.collections[0].safeArtworkURL?.host == "lh3.googleusercontent.com", "allowlisted collection artwork")
        let bad: [[String: Any]] = [
            cataloguePayload(query: "Fixture", tracks: [catalogueTrack()], overrides: ["source": "explore"]),
            cataloguePayload(query: "Fixture", tracks: [catalogueTrack()], overrides: ["fetchedAt": "2026-02-30T09:30:00Z"]),
            cataloguePayload(query: "Fixture", tracks: [catalogueTrack(), catalogueTrack()]),
            cataloguePayload(query: "Fixture", tracks: (0...100).map(catalogueTrack)),
            cataloguePayload(query: "Fixture", collections: [catalogueCollection()]),
            cataloguePayload(query: "Fixture", tracks: [catalogueTrack().merging(["externalId": "00000000002"]) { _, new in new }]),
            cataloguePayload(query: "Fixture", tracks: [catalogueTrack().merging(["artwork": "https://r1.googlevideo.com/audio?token=private"]) { _, new in new }])
        ]
        for value in bad {
            do {
                let result = try JSONDecoder().decode(MusicCatalogueDTO.self, from: JSONSerialization.data(withJSONObject: value))
                try result.validate(expectedKind: "songs", query: "Fixture")
                throw CatalogueCheckFailure.failed("invalid catalogue admitted")
            } catch CloudFailure.invalidResponse {}
        }
        for artwork in ["https://evil.invalid/image", "https://i.ytimg.com.evil.invalid/image", "https://user@i.ytimg.com/image", "http://i.ytimg.com/image", "https://i.ytimg.com:443/image", "https://i.ytimg.com/image#fragment"] {
            let object = catalogueCollection().merging(["artwork": artwork]) { _, new in new }
            let collection = try JSONDecoder().decode(MusicCollectionDTO.self, from: JSONSerialization.data(withJSONObject: object))
            do { try collection.validate(); throw CatalogueCheckFailure.failed("bad artwork admitted") }
            catch CloudFailure.invalidResponse {}
        }
        let decoded = try JSONDecoder().decode(MusicCatalogueDTO.self, from: JSONSerialization.data(withJSONObject: cataloguePayload(query: "Fixture", tracks: [catalogueTrack()])))
        try decoded.validate(expectedKind: "songs", query: "Fixture")
        try requireCatalogue(!String(reflecting: decoded).contains("googlevideo") && !String(reflecting: decoded).contains("token=private"), "unknown signed audio fields are not retained")
    }

    @MainActor private static func noFallback() async throws {
        for (kind, status) in [(MusicSearchKind.songs, 404), (.songs, 501), (.albums, 404), (.songs, 502)] {
            let transport = CatalogueTransport([try catalogueHTTP(status: status)])
            do { _ = try await CloudAPIClient(transport: transport).searchCatalogue("Fixture", kind: kind); throw CatalogueCheckFailure.failed("unsupported route unexpectedly succeeded") }
            catch is CloudCatalogueFailure {} catch CloudFailure.unavailable {}
            let count = await transport.count
            let calls = await transport.calls()
            try requireCatalogue(count == 1 && calls[0].0.url?.path == "/api/music/catalogue/search", "typed music failures never silently become general-video search")
        }
    }

    @MainActor private static func browseAndCharts() async throws {
        let artistID = "UC" + String(repeating: "a", count: 22)
        let sections: [[String: Any]] = [["id": "songs", "title": "Top songs", "tracks": [catalogueTrack(2), catalogueTrack(1)], "collections": []]]
        let transport = CatalogueTransport([
            try catalogueHTTP(cataloguePayload(kind: "artist", sections: sections, overrides: ["truncated": true])),
            try catalogueHTTP(cataloguePayload(kind: "charts", country: "US", sections: sections)),
            try catalogueHTTP(cataloguePayload(kind: "charts", country: "GB", sections: sections))
        ])
        let client = CloudAPIClient(transport: transport)
        let artist = try await client.browseCatalogue(kind: .artist, id: artistID)
        try requireCatalogue(artist.truncated && artist.sections[0].tracks.map(\.externalId) == ["00000000002", "00000000001"], "browse preserves source order and honest truncation")
        let charts = try await client.chartsCatalogue(country: "US")
        try requireCatalogue(charts.country == "US" && charts.fetchedDate != nil && charts.kind == "charts", "real chart region and observation date are explicit")
        do { _ = try await client.chartsCatalogue(country: "US"); throw CatalogueCheckFailure.failed("wrong chart region") }
        catch CloudFailure.invalidResponse {}
    }

    @MainActor private static func races() async throws {
        let transport = CatalogueTransport([nil, nil, nil, nil])
        let store = CloudCatalogueStore(client: .init(transport: transport))
        let old = Task { await store.search("Old", kind: .songs) }
        try await waitCatalogue { await transport.count == 1 }
        let latest = Task { await store.search("New", kind: .albums) }
        try await waitCatalogue { await transport.count == 2 }
        await transport.finish(1, try catalogueHTTP(cataloguePayload(kind: "albums", query: "New", collections: [catalogueCollection()])))
        await latest.value
        await transport.finish(0, try catalogueHTTP(cataloguePayload(query: "Old", tracks: [catalogueTrack()])))
        await old.value
        try requireCatalogue(store.result?.kind == "albums" && store.result?.query == "New" && store.error == nil, "late canceled result cannot replace typed latest query")
        let separate = store.makeSession()
        let independent = Task { await separate.charts(country: "ZZ") }
        try await waitCatalogue { await transport.count == 3 }
        let cleared = Task { await store.search("Cleared", kind: .songs) }
        try await waitCatalogue { await transport.count == 4 }
        store.clear()
        await transport.finish(3, try catalogueHTTP(cataloguePayload(query: "Cleared", tracks: [catalogueTrack()])))
        await cleared.value
        await transport.finish(2, try catalogueHTTP(cataloguePayload(kind: "charts", country: "ZZ", tracks: [catalogueTrack()])))
        await independent.value
        try requireCatalogue(store.result == nil && !store.loading && separate.result?.country == "ZZ", "separate sessions keep independent cancellation and result state")
    }

    @MainActor private static func backendFixtureParity() async throws {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "--catalogue-contract-fixtures"), arguments.indices.contains(index + 1),
              arguments[index + 1].hasPrefix("/") else { throw CatalogueCheckFailure.failed("absolute fixture directory required") }
        let directory = URL(fileURLWithPath: arguments[index + 1], isDirectory: true)
        for name in ["search-songs", "search-albums", "search-artists", "search-playlists", "charts"] {
            let path = directory.appendingPathComponent(name).appendingPathExtension("json")
            let size = try FileManager.default.attributesOfItem(atPath: path.path)[.size] as? NSNumber
            guard let size, size.intValue <= 8 * 1024 * 1024 else { throw CatalogueCheckFailure.failed("fixture byte bound") }
            let result = try JSONDecoder().decode(MusicCatalogueDTO.self, from: Data(contentsOf: path))
            let kind = name == "charts" ? "charts" : String(name.dropFirst(7))
            try result.validate(expectedKind: kind, query: name == "charts" ? nil : result.query, country: name == "charts" ? "ZZ" : nil)
            let provenance = result.title + " " + result.subtitle
            try requireCatalogue(provenance.contains("SYNTHETIC") && provenance.contains("NOT LIVE"), "fixtures must never be presented as live metadata proof")
        }
    }
}
