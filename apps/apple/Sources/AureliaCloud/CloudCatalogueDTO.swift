import Foundation

public enum MusicSearchKind: String, CaseIterable, Codable, Sendable {
    case songs, albums, artists, playlists
    public var title: String { rawValue.capitalized }
    var collectionKind: MusicCollectionKind? {
        switch self { case .songs: nil; case .albums: .album; case .artists: .artist; case .playlists: .playlist }
    }
}
public enum MusicCollectionKind: String, Codable, Sendable {
    case album, artist, playlist
    public var title: String { rawValue.capitalized }
    public func accepts(_ id: String) -> Bool {
        guard id.utf8.count <= 160 else { return false }
        let pattern: String
        switch self {
        case .album: pattern = "^MPRE[bB]_[A-Za-z0-9_-]{1,150}$"
        case .artist: pattern = "^UC[A-Za-z0-9_-]{22}$"
        case .playlist: pattern = "^(?:VL)?(?:PL|OLAK5uy_|RDCLAK5uy_|UU)[A-Za-z0-9_-]{6,150}$"
        }
        return id.range(of: pattern, options: .regularExpression) != nil
    }
}
public struct MusicCollectionDTO: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let kind: MusicCollectionKind
    public let title: String
    public let subtitle: String
    public let artwork: String
    public var safeArtworkURL: URL? { catalogueArtwork(artwork) }
    func validate() throws {
        guard kind.accepts(id), catalogueText(title, required: true), catalogueText(subtitle, maximum: 1000),
              artwork.isEmpty || catalogueArtwork(artwork) != nil else { throw CloudFailure.invalidResponse }
    }
}
public struct MusicCatalogueSectionDTO: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let tracks: [TrackDTO]
    public let collections: [MusicCollectionDTO]
    func validate() throws {
        guard id.range(of: "^[a-z0-9-]{1,80}$", options: .regularExpression) != nil,
              catalogueText(title, required: true, maximum: 120) else { throw CloudFailure.invalidResponse }
        try validateCatalogueArrays(tracks: tracks, collections: collections)
    }
}
public struct MusicCatalogueDTO: Decodable, Sendable, Equatable {
    public let source: String
    public let fetchedAt: String
    public let kind: String
    public let title: String
    public let subtitle: String
    public let tracks: [TrackDTO]
    public let collections: [MusicCollectionDTO]
    public let sections: [MusicCatalogueSectionDTO]
    public let truncated: Bool
    public let query: String?
    public let country: String?
    public let countryName: String?
    public var fetchedDate: Date? { catalogueDate(fetchedAt) }
    public var isEmpty: Bool { tracks.isEmpty && collections.isEmpty && sections.allSatisfy { $0.tracks.isEmpty && $0.collections.isEmpty } }

    func validate(expectedKind: String, query expectedQuery: String? = nil, country expectedCountry: String? = nil) throws {
        guard source == "youtube-music", fetchedDate != nil, kind == expectedKind,
              catalogueText(title, required: true), catalogueText(subtitle, maximum: 1000), sections.count <= 12,
              Set(sections.map(\.id)).count == sections.count,
              query == expectedQuery, country == expectedCountry,
              countryName.map({ catalogueText($0, required: true, maximum: 120) }) ?? true else { throw CloudFailure.invalidResponse }
        try validateCatalogueArrays(tracks: tracks, collections: collections)
        try sections.forEach { try $0.validate() }
        let allTracks = tracks + sections.flatMap(\.tracks)
        let allCollections = collections + sections.flatMap(\.collections)
        guard allTracks.count <= 1_000, allCollections.count <= 100 else { throw CloudFailure.invalidResponse }
        if let search = MusicSearchKind(rawValue: expectedKind) {
            guard allTracks.count + allCollections.count <= 100 else { throw CloudFailure.invalidResponse }
            if search == .songs { guard allCollections.isEmpty else { throw CloudFailure.invalidResponse } }
            else { guard allTracks.isEmpty, allCollections.allSatisfy({ $0.kind == search.collectionKind }) else { throw CloudFailure.invalidResponse } }
        }
    }

    init(legacyTracks: [TrackDTO], query: String) {
        source = "youtube"; fetchedAt = ISO8601DateFormatter().string(from: Date()); kind = "songs"
        title = "Song results"; subtitle = ""; tracks = legacyTracks; collections = []; sections = []
        truncated = false; self.query = query; country = nil; countryName = nil
    }
}
public struct MusicCatalogueSearchResult: Sendable {
    public let catalogue: MusicCatalogueDTO
    public let usesLegacySongs: Bool
}
public enum CloudCatalogueFailure: Error, Sendable {
    case endpointUnavailable
    public var message: String { "The music catalogue is unavailable. Please try again later." }
}

func validCatalogueCountry(_ value: String) -> Bool {
    catalogueCountryCodes.contains(value)
}
// Same finite ISO 3166-1 alpha-2 set as the metadata API; ZZ is its explicit
// global chart scope. Avoid accepting CLDR macroregions such as EU as countries.
private let catalogueCountryCodes = Set("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW ZZ".split(separator: " ").map(String.init))
func validCatalogueRequest(_ url: URL) -> Bool {
    guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), let items = parts.queryItems else { return false }
    var fields: [String: String] = [:]
    for item in items {
        guard fields[item.name] == nil, let value = item.value else { return false }
        fields[item.name] = value
    }
    switch url.path {
    case "/api/music/catalogue/search":
        guard Set(fields.keys) == ["q", "kind"], let query = fields["q"], musicQuery(query) == query,
              let kind = fields["kind"], MusicSearchKind(rawValue: kind) != nil else { return false }
    case "/api/music/catalogue/browse":
        guard Set(fields.keys) == ["id", "kind"], let raw = fields["kind"], let kind = MusicCollectionKind(rawValue: raw),
              let id = fields["id"], kind.accepts(id) else { return false }
    case "/api/music/catalogue/charts":
        guard Set(fields.keys) == ["country"], let country = fields["country"], validCatalogueCountry(country) else { return false }
    default: return false
    }
    return true
}
private func catalogueText(_ value: String, required: Bool = false, maximum: Int = 500) -> Bool {
    (!required || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) && value.utf16.count <= maximum &&
        !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
}
private func catalogueArtwork(_ value: String) -> URL? {
    guard value.utf8.count <= 2048, let url = URL(string: value), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
          parts.scheme == "https", let host = parts.host,
          ["lh3.googleusercontent.com", "yt3.googleusercontent.com", "yt3.ggpht.com", "i.ytimg.com"].contains(host),
          parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil else { return nil }
    return url
}
private func catalogueDate(_ value: String) -> Date? {
    guard value.utf8.count <= 64, value.range(of: "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?Z$", options: .regularExpression) != nil else { return nil }
    let pieces = value.prefix(10).split(separator: "-")
    guard pieces.count == 3, let year = Int(pieces[0]), let month = Int(pieces[1]), let day = Int(pieces[2]) else { return nil }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
    let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    guard day <= days[month - 1] else { return nil }
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}
private func validateCatalogueArrays(tracks: [TrackDTO], collections: [MusicCollectionDTO]) throws {
    guard tracks.count <= 1_000, collections.count <= 100,
          Set(tracks.map(\.id)).count == tracks.count, Set(collections.map(\.id)).count == collections.count else { throw CloudFailure.invalidResponse }
    for track in tracks {
        try track.validate()
        guard track.provider == "youtube", catalogueText(track.title, required: true), catalogueText(track.artist, required: true), catalogueText(track.album),
              track.artwork == "https://i.ytimg.com/vi/\(track.externalId)/hqdefault.jpg" else { throw CloudFailure.invalidResponse }
    }
    try collections.forEach { try $0.validate() }
}
