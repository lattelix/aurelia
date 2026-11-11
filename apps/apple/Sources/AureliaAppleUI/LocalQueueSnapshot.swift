import Foundation
import AureliaPlaybackCore
import AureliaCloud

/// Recording metadata only. Locators, credentials, playback intent, audible
/// volume and timer state have no representation in this persistence schema.
public struct LocalQueueEntry: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let provider: PlaybackProvider
    public let trackID: String
    public let title: String
    public let artist: String
    public let album: String
    public let duration: Double

    public init(track: PlaybackTrack, album: String, duration: Double) {
        id = track.id; provider = track.provider; trackID = track.trackID
        title = track.title; artist = track.artist; self.album = album; self.duration = duration
    }

    public func playbackTrack() throws -> PlaybackTrack {
        guard Self.validText(title, required: true), Self.validText(artist, required: true),
              Self.validText(album), duration.isFinite, (0...86400).contains(duration) else {
            throw PlaybackFailure.invalidTrack
        }
        switch provider {
        case .youtube:
            guard trackID.hasPrefix("youtube:") else { throw PlaybackFailure.invalidTrack }
            let videoID = String(trackID.dropFirst(8))
            return try PlaybackTrack(id: id, videoID: videoID, title: title, artist: artist, trackID: trackID)
        case .studio:
            guard let local = StudioCatalogue.track(trackID), title == local.title, artist == local.artist else {
                throw PlaybackFailure.invalidTrack
            }
            return try PlaybackTrack(id: id, studioID: trackID, title: title, artist: artist)
        case .device:
            guard trackID.hasPrefix("device:"), let deviceID = UUID(uuidString: String(trackID.dropFirst(7))) else { throw PlaybackFailure.invalidTrack }
            return try PlaybackTrack(id: id, deviceID: deviceID, title: title, artist: artist)
        }
    }

    /// Rebuilds a metadata DTO for like/download/lyrics actions. Artwork is
    /// derived by the existing safeArtworkURL contract, never restored as a URL.
    public var cloudTrack: TrackDTO? {
        guard (try? playbackTrack()) != nil else { return nil }
        let externalID: String
        if provider == .youtube { externalID = String(trackID.dropFirst(8)) }
        else if let local = StudioCatalogue.track(trackID) { externalID = String(local.audioNumber) }
        else { return nil }
        let object: [String: Any] = ["id": trackID, "provider": provider.rawValue, "externalId": externalID,
                                     "title": title, "artist": artist, "album": album, "duration": duration, "artwork": ""]
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return try? JSONDecoder().decode(TrackDTO.self, from: data)
    }

    private static func validText(_ text: String, required: Bool = false) -> Bool {
        (!required || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) && text.utf16.count <= 500 &&
            !text.contains("://") && !text.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }
}

public struct LocalQueueSnapshot: Codable, Sendable {
    public let version: Int
    public let ownerID: String?
    public let entries: [LocalQueueEntry]
    public let index: Int
    public let position: Double
    public let repeatMode: RepeatMode
    public let shuffle: Bool

    public init(ownerID: String?, entries: [LocalQueueEntry], index: Int, position: Double,
                repeatMode: RepeatMode, shuffle: Bool) {
        version = 1; self.ownerID = ownerID; self.entries = entries; self.index = index
        self.position = position; self.repeatMode = repeatMode; self.shuffle = shuffle
    }

    public func validated() -> LocalQueueSnapshot? {
        guard version == 1, ownerID.map(Self.validOwnerID) ?? true,
              entries.count <= 500, Set(entries.map(\.id)).count == entries.count,
              entries.allSatisfy({ (try? $0.playbackTrack()) != nil }),
              entries.isEmpty ? index == 0 : entries.indices.contains(index) else { return nil }
        let limit = entries.isEmpty ? 0 : (entries[index].duration > 0 ? entries[index].duration : 86400)
        return LocalQueueSnapshot(ownerID: ownerID, entries: entries, index: index,
                                  position: position.isFinite ? min(limit, max(0, position)) : 0,
                                  repeatMode: repeatMode, shuffle: shuffle)
    }

    static func validOwnerID(_ value: String) -> Bool {
        !value.isEmpty && value.utf16.count <= 160 &&
            value.range(of: "^[A-Za-z0-9:_-]+$", options: .regularExpression) != nil
    }
}
