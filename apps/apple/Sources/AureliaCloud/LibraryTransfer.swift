import Foundation

public struct CloudImportResultDTO: Decodable, Sendable {
    public let id: String?
    public let jobs: [CloudImportJobDTO]
    public let items: [CloudImportItemDTO]
    func validate() throws {
        guard id.map({ UUID(uuidString: $0) != nil }) ?? true, jobs.count <= 10_000,
              items.count <= 100, Set(jobs.map(\.id)).count == jobs.count,
              Set(items.map(\.id)).count == items.count else { throw CloudFailure.invalidResponse }
        try jobs.forEach { try $0.validate() }; try items.forEach { try $0.validate() }
    }
}
public struct CloudImportJobDTO: Decodable, Sendable, Identifiable {
    public let id: String
    public let provider: String
    public let status: String
    public let total: Int
    public let imported: Int
    public let matched: Int
    public let unmatched: Int
    public let failed: Int
    public let notice: String?
    func validate() throws {
        guard UUID(uuidString: id) != nil, ["spotify", "file", "fixture", "aurelia"].contains(provider),
              ["running", "complete", "failed"].contains(status),
              [total, imported, matched, unmatched, failed].allSatisfy({ (0...1_000_000).contains($0) }),
              notice.map({ $0.utf16.count <= 100_000 }) ?? true else { throw CloudFailure.invalidResponse }
    }
}
public struct CloudImportSourceDTO: Decodable, Sendable {
    public let id: String
    public let title: String
    public let artist: String
    public let album: String
    public let duration: Double
    func validate() throws {
        guard validID(id), !title.isEmpty, title.utf16.count <= 500,
              !artist.isEmpty, artist.utf16.count <= 500, album.utf16.count <= 500,
              duration.isFinite, (0...86400).contains(duration) else { throw CloudFailure.invalidResponse }
    }
}
public struct CloudImportCandidateDTO: Decodable, Sendable, Identifiable {
    public var id: String { track.id }
    public let track: TrackDTO
    public let confidence: Double
    func validate() throws {
        try track.validate()
        guard confidence.isFinite, (0...1).contains(confidence) else { throw CloudFailure.invalidResponse }
    }
}
public struct CloudImportMatchDTO: Decodable, Sendable {
    public let candidates: [CloudImportCandidateDTO]
    public let confidence: Double
    public let status: String
    func validate() throws {
        guard candidates.count <= 3, confidence.isFinite, (0...1).contains(confidence),
              ["matched", "review", "unmatched"].contains(status), Set(candidates.map(\.id)).count == candidates.count else { throw CloudFailure.invalidResponse }
        try candidates.forEach { try $0.validate() }
    }
}
public struct CloudImportItemDTO: Decodable, Sendable, Identifiable {
    public let id: String
    public let source: CloudImportSourceDTO
    public let match: CloudImportMatchDTO
    public let status: String
    func validate() throws {
        guard UUID(uuidString: id) != nil, ["review", "unmatched", "failed"].contains(status) else { throw CloudFailure.invalidResponse }
        try source.validate(); try match.validate()
    }
}

/// Only the documented metadata export envelope can be offered as an Aurelia library file.
func validatePortableExport(_ data: Data) throws {
    let keys: Set<String> = ["format", "version", "exportedAt", "tracks", "likes", "playlists", "artists", "history", "searches", "notices"]
    guard data.count <= 2_000_000, let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          Set(value.keys) == keys, value["format"] as? String == "aurelia-library", value["version"] as? Int == 1,
          let timestamp = value["exportedAt"] as? String, timestamp.utf8.count <= 100,
          let tracks = value["tracks"] as? [[String: Any]], tracks.count <= 1000,
          let likes = value["likes"] as? [String], likes.count <= 1000,
          let playlists = value["playlists"] as? [[String: Any]], playlists.count <= 100,
          let artists = value["artists"] as? [[String: Any]], artists.count <= 1000,
          let history = value["history"] as? [[String: Any]], history.count <= 1000,
          let searches = value["searches"] as? [String], searches.count <= 1000,
          let notices = value["notices"] as? [String], notices.count <= 20 else { throw CloudFailure.invalidResponse }
    for track in tracks {
        let required: Set<String> = ["id", "provider", "externalId", "title", "artist", "album", "duration"]
        guard required.isSubset(of: Set(track.keys)), Set(track.keys).isSubset(of: required.union(["isrc"])),
              let id = track["id"] as? String, let title = track["title"] as? String,
              let artist = track["artist"] as? String, let album = track["album"] as? String,
              let provider = track["provider"] as? String, let externalID = track["externalId"] as? String,
              let duration = track["duration"] as? Double else { throw CloudFailure.invalidResponse }
        _ = try TrackDTO(id: id, title: title, artist: artist, album: album, provider: provider, externalId: externalID, duration: duration)
        guard track["isrc"].map({ ($0 as? String).map { $0.utf16.count <= 30 } ?? false }) ?? true,
              provider != "studio" || (externalID.range(of: "^(?:[1-9]|1[0-2])$", options: .regularExpression) != nil
                && id.range(of: "^studio:[A-Za-z0-9_-]+$", options: .regularExpression) != nil) else { throw CloudFailure.invalidResponse }
    }
    let trackIDs = Set(tracks.compactMap { $0["id"] as? String })
    guard trackIDs.count == tracks.count, Set(likes).count == likes.count, likes.allSatisfy({ trackIDs.contains($0) }),
          validTransferTimestamp(timestamp), searches.allSatisfy({ musicQuery($0) == $0 }),
          notices.allSatisfy({ $0.utf16.count <= 1000 }) else { throw CloudFailure.invalidResponse }
    var playlistIDs = Set<String>(), artistIDs = Set<String>(), historyIDs = Set<String>()
    for playlist in playlists {
        guard Set(playlist.keys) == ["id", "name", "description", "trackIds"],
              let id = playlist["id"] as? String, validID(id), playlistIDs.insert(id).inserted,
              let name = playlist["name"] as? String, !name.isEmpty, name.utf16.count <= 120,
              let description = playlist["description"] as? String, description.utf16.count <= 1000,
              let ids = playlist["trackIds"] as? [String], ids.count <= 1000, Set(ids).count == ids.count,
              ids.allSatisfy({ trackIDs.contains($0) }) else { throw CloudFailure.invalidResponse }
    }
    for artist in artists {
        guard Set(artist.keys) == ["id", "name"], let id = artist["id"] as? String, validID(id), artistIDs.insert(id).inserted,
              let name = artist["name"] as? String, !name.isEmpty, name.utf16.count <= 500 else { throw CloudFailure.invalidResponse }
    }
    for entry in history {
        guard Set(entry.keys) == ["id", "trackId", "playedAt", "completion"],
              let id = entry["id"] as? String, validID(id), historyIDs.insert(id).inserted,
              let trackID = entry["trackId"] as? String, trackIDs.contains(trackID),
              let playedAt = entry["playedAt"] as? String, validTransferTimestamp(playedAt),
              let completion = entry["completion"] as? Double, completion.isFinite, (0...1).contains(completion) else { throw CloudFailure.invalidResponse }
    }
}

private func validTransferTimestamp(_ value: String) -> Bool {
    guard value.utf8.count <= 100 else { return false }
    let formatter = ISO8601DateFormatter()
    if formatter.date(from: value) != nil { return true }
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) != nil
}
