import Foundation
import CryptoKit

public enum CloudFailure: Error, Equatable, Sendable {
    case invalidResponse, unavailable, unauthorized, denied, conflict, expired
    case slowDown(Double), credentialLocked, credentialUnavailable
    public var message: String {
        switch self {
        case .unauthorized, .expired: "Your connection expired. Sign in again."
        case .denied: "This account operation was not approved."
        case .conflict: "The account changed. Refresh before trying again."
        case .credentialLocked: "Secure storage is locked. Unlock it and retry."
        case .credentialUnavailable: "Secure storage is unavailable. Your session was not stored."
        case .invalidResponse: "Aurelia returned an unsupported response. Please retry."
        case .slowDown: "Please wait before trying again."
        default: "Cannot reach Aurelia. Check your connection and retry."
        }
    }
}

public struct AccountDTO: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let email: String?
    public let identities: [String]
    func validate() throws {
        guard validID(id), !name.isEmpty, name.count <= 500,
              email.map({ $0.count <= 254 }) ?? true,
              identities.count <= 32, identities.allSatisfy({ !$0.isEmpty && $0.count <= 80 }) else { throw CloudFailure.invalidResponse }
    }
}

public struct TrackDTO: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let artist: String
    public let album: String
    public let provider: String
    public let externalId: String
    public let duration: Double
    public let artwork: String
    public init(id: String, title: String, artist: String, album: String, provider: String,
                externalId: String, duration: Double, artwork: String = "") throws {
        self.id = id; self.title = title; self.artist = artist; self.album = album
        self.provider = provider; self.externalId = externalId; self.duration = duration; self.artwork = artwork
        try validate()
    }
    /// A display image only; never uses a media locator supplied by a response.
    public var safeArtworkURL: URL? {
        if provider == "youtube" {
            guard validYouTubeID(externalId), id == "youtube:\(externalId)" else { return nil }
            return URL(string: "https://i.ytimg.com/vi/\(externalId)/hqdefault.jpg")
        }
        guard provider == "studio", artwork.range(of: "^/art/[A-Za-z0-9_-]+\\.(svg|png|jpg|jpeg|webp)$", options: .regularExpression) != nil else { return nil }
        return URL(string: artwork, relativeTo: CloudAPIClient.origin)?.absoluteURL
    }
    func validate() throws {
        guard validID(id), !title.isEmpty, title.count <= 500, !artist.isEmpty, artist.count <= 500,
              album.count <= 500, ["studio", "youtube"].contains(provider), externalId.count <= 160,
              duration.isFinite, (0...86400).contains(duration), artwork.count <= 2048,
              provider != "youtube" || (validYouTubeID(externalId) && id == "youtube:\(externalId)") else { throw CloudFailure.invalidResponse }
    }
}

public struct DiscoverySectionDTO: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let tracks: [TrackDTO]
    private enum CodingKeys: CodingKey { case id, title, tracks }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        title = try values.decode(String.self, forKey: .title)
        let metadata = try values.decode([DiscoveryTrack].self, forKey: .tracks)
        tracks = metadata.map(\.track)
        guard id.range(of: "^[a-z0-9-]{1,80}$", options: .regularExpression) != nil,
              !title.isEmpty, title.utf16.count <= 120, tracks.count <= 24,
              Set(tracks.map(\.id)).count == tracks.count else { throw CloudFailure.invalidResponse }
    }
}

public struct DiscoveryDTO: Decodable, Sendable, Equatable {
    public let source: String
    public let fetchedAt: String
    public let sections: [DiscoverySectionDTO]
    func validate() throws {
        guard source == "youtube-music", validDiscoveryTimestamp(fetchedAt),
              sections.count <= 4, Set(sections.map(\.id)).count == sections.count else { throw CloudFailure.invalidResponse }
    }
}
private func validDiscoveryTimestamp(_ value: String) -> Bool {
    guard value.utf8.count <= 100, value.hasSuffix("Z"),
          value.range(of: "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?Z$", options: .regularExpression) != nil else { return false }
    let date = value.prefix(10).split(separator: "-")
    guard date.count == 3, let year = Int(date[0]), let month = Int(date[1]), let day = Int(date[2]) else { return false }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
    let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return day <= days[month - 1]
}

/// Validates the wire-only watch link, then discards it instead of exposing a locator.
private struct DiscoveryTrack: Decodable {
    let track: TrackDTO
    private enum CodingKeys: CodingKey { case sourceUrl }
    init(from decoder: Decoder) throws {
        track = try TrackDTO(from: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let link = try values.decode(String.self, forKey: .sourceUrl)
        try track.validate()
        guard track.provider == "youtube",
              track.artwork == "https://i.ytimg.com/vi/\(track.externalId)/hqdefault.jpg",
              link == "https://www.youtube.com/watch?v=\(track.externalId)" else { throw CloudFailure.invalidResponse }
    }
}

/// Other search collections and any extra locator fields are deliberately not decoded.
struct SearchDTO: Decodable, Sendable {
    let source: String
    let tracks: [TrackDTO]
    func validate() throws {
        guard source == "youtube", tracks.count <= 100,
              Set(tracks.map(\.id)).count == tracks.count else { throw CloudFailure.invalidResponse }
        for track in tracks {
            try track.validate()
            guard track.provider == "youtube" else { throw CloudFailure.invalidResponse }
        }
    }
}

public struct PlaylistDTO: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let description: String
    public let tracks: [TrackDTO]
    public let createdAt: String
    func validate() throws {
        guard validID(id), !name.isEmpty, name.count <= 120, description.count <= 1000,
              tracks.count <= 20_000, Set(tracks.map(\.id)).count == tracks.count,
              createdAt.count <= 100 else { throw CloudFailure.invalidResponse }
        try tracks.forEach { try $0.validate() }
    }
}

/// Cloud metadata only. Queue/volume and source locators are deliberately not decoded.
public struct LibraryDTO: Codable, Sendable, Equatable {
    public let likes: [TrackDTO]
    public let playlists: [PlaylistDTO]
    public let history: [HistoryEntryDTO]
    public let searches: [String]
    private enum CodingKeys: CodingKey { case likes, playlists, history, searches }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        likes = try values.decode([TrackDTO].self, forKey: .likes)
        playlists = try values.decode([PlaylistDTO].self, forKey: .playlists)
        history = try values.decodeIfPresent([HistoryEntryDTO].self, forKey: .history) ?? []
        searches = try values.decodeIfPresent([String].self, forKey: .searches) ?? []
    }
    func validate() throws {
        guard likes.count <= 20_000, playlists.count <= 1000,
              Set(likes.map(\.id)).count == likes.count,
              Set(playlists.map(\.id)).count == playlists.count,
              history.count <= 100, Set(history.map(\.id)).count == history.count,
              searches.count <= 8, searches.allSatisfy({ musicQuery($0) == $0 }) else { throw CloudFailure.invalidResponse }
        try likes.forEach { try $0.validate() }; try playlists.forEach { try $0.validate() }
        try history.forEach { try $0.validate() }
    }
}
public struct BootstrapDTO: Decodable, Sendable {
    public let user: AccountDTO?
    public let library: LibraryDTO?
    public let capabilities: [String: Bool]
    public let recommendations: [RecommendationDTO]
    private enum CodingKeys: CodingKey { case user, library, capabilities, recommendations }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        user = try values.decodeIfPresent(AccountDTO.self, forKey: .user)
        library = try values.decodeIfPresent(LibraryDTO.self, forKey: .library)
        capabilities = try values.decode([String: Bool].self, forKey: .capabilities)
        recommendations = try values.decodeIfPresent([RecommendationDTO].self, forKey: .recommendations) ?? []
    }
    func validate() throws {
        try user?.validate(); try library?.validate()
        guard capabilities.count <= 64 else { throw CloudFailure.invalidResponse }
        try validateRecommendations(recommendations)
    }
}
public struct DeviceStartDTO: Decodable, Sendable {
    let deviceCode: String
    public let userCode: String
    public let verificationUri: String
    public let expiresIn: Int
    public let interval: Int
    func validate() throws {
        guard deviceCode.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              userCode.range(of: "^[A-Za-z0-9-]{4,32}$", options: .regularExpression) != nil,
              (1...600).contains(expiresIn), (3...60).contains(interval),
              let url = URL(string: verificationUri), CloudAPIClient.isVerificationURL(url, userCode: userCode) else { throw CloudFailure.invalidResponse }
    }
}
struct DeviceTokenDTO: Decodable, Sendable {
    let status: String
    let token: String?
    let user: AccountDTO?
    let expiresIn: Int?
}
public struct CloudCredential: Codable, Sendable {
    let token: String
    public let accountID: String
    public let expiresAt: Date
    public init(token: String, accountID: String, expiresAt: Date) throws {
        guard validSecret(token), validID(accountID), expiresAt.timeIntervalSince1970.isFinite else { throw CloudFailure.invalidResponse }
        self.token = token; self.accountID = accountID; self.expiresAt = expiresAt
    }
    func validate() throws { _ = try Self(token: token, accountID: accountID, expiresAt: expiresAt) }
}
public enum DevicePoll: Sendable { case pending, approved(CloudCredential, AccountDTO) }

func validID(_ value: String) -> Bool {
    !value.isEmpty && value.count <= 160 && !value.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
}
func validSecret(_ value: String) -> Bool {
    value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
}
func validYouTubeID(_ value: String) -> Bool {
    value.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil
}
func validPlaylistOrder(_ trackIDs: [String], expectedTrackIDs: [String]) -> Bool {
    trackIDs.count <= 5000 && expectedTrackIDs.count <= 5000
        && trackIDs.allSatisfy { validID($0) && $0.utf16.count <= 160 }
        && expectedTrackIDs.allSatisfy { validID($0) && $0.utf16.count <= 160 }
        && Set(trackIDs).count == trackIDs.count && Set(expectedTrackIDs).count == expectedTrackIDs.count
        && Set(trackIDs) == Set(expectedTrackIDs)
}
func musicQuery(_ value: String) -> String? {
    let query = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty, query.utf16.count <= 200,
          !query.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }
    return query
}
public enum PKCE {
    public static func verifier() -> String {
        var random = SystemRandomNumberGenerator()
        return Data((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &random) }).base64URL
    }
    public static func challenge(_ verifier: String) throws -> String {
        guard verifier.range(of: "^[A-Za-z0-9._~-]{43,128}$", options: .regularExpression) != nil else { throw CloudFailure.invalidResponse }
        return Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
    }
}
private extension Data {
    var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
}
