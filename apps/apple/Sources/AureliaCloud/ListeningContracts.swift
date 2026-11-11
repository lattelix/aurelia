import Foundation

public struct HistoryEntryDTO: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let track: TrackDTO
    public let playedAt: String
    public let completion: Double
    func validate() throws {
        guard UUID(uuidString: id) != nil, playedAt.utf8.count <= 100,
              ISO8601DateFormatter().date(from: playedAt) != nil || fractionalISODate(playedAt) != nil,
              completion.isFinite, (0...1).contains(completion) else { throw CloudFailure.invalidResponse }
        try track.validate()
    }
}

private func fractionalISODate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value)
}

public struct RecommendationDTO: Decodable, Sendable, Equatable, Identifiable {
    public var id: String { track.id }
    public let track: TrackDTO
    public let score: Double
    public let reason: String
    func validate() throws {
        try track.validate()
        guard score.isFinite, reason.utf16.count <= 1000 else { throw CloudFailure.invalidResponse }
    }
}

func validateRecommendations(_ entries: [RecommendationDTO]) throws {
    guard entries.count <= 12, Set(entries.map(\.id)).count == entries.count else { throw CloudFailure.invalidResponse }
    try entries.forEach { try $0.validate() }
}

public enum CloudSignalKind: String, Sendable, Encodable { case skip, complete, hide, search }
