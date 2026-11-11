import Foundation
import AureliaPlaybackCore

public struct StudioTrack: Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let albumID: String
    public let album: String
    public let genre: String
    public let audioNumber: Int
    public var artist: String { "Aurelia Studio" }
    public var duration: Double { 72 }
    public func queueEntry() throws -> PlaybackTrack {
        try PlaybackTrack(studioID: id, title: title, artist: artist)
    }
}

public struct StudioRelease: Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let subtitle: String
    public let genre: String
    public let titles: [String]
    public let start: Int
    public var tracks: [StudioTrack] {
        titles.enumerated().map { i, title in
            StudioTrack(id: "studio:\(id)-\(i + 1)", title: title, albumID: id,
                        album: self.title, genre: genre, audioNumber: start + i)
        }
    }
}

public enum StudioCatalogue {
    public static let releases: [StudioRelease] = [
        .init(id: "afterglow", title: "Afterglow", subtitle: "Let the day linger.", genre: "Electronic",
              titles: ["Golden Hour", "Weightless", "The Last Light"], start: 1),
        .init(id: "blue-hours", title: "Blue Hours", subtitle: "A little room to breathe.", genre: "Ambient",
              titles: ["Slow Motion", "Between the Tides", "Blue Hour"], start: 4),
        .init(id: "parallel", title: "Parallel Worlds", subtitle: "For the hours that belong to you.", genre: "Electronic",
              titles: ["Parallel", "Soft Focus", "Night Drive"], start: 7),
        .init(id: "still-life", title: "Still Life", subtitle: "Nowhere to be. Nothing to rush.", genre: "Lo-fi",
              titles: ["Sunday Morning", "Paper Planes", "Somewhere Quiet"], start: 10)
    ]
    public static let tracks = releases.flatMap(\.tracks)
    public static func track(_ id: String) -> StudioTrack? { tracks.first { $0.id == id } }
    public static func search(_ text: String) -> [StudioTrack] {
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return tracks }
        return tracks.filter {
            "\($0.title) \($0.artist) \($0.album) \($0.genre)".localizedStandardContains(query)
        }
    }
    public static func artworkURL(_ id: String) -> URL? {
        guard releases.contains(where: { $0.id == id }) else { return nil }
        return Bundle.module.url(forResource: id, withExtension: "png")
    }
    public static func audioSource(_ track: StudioTrack) throws -> ResolvedAudio {
        guard let known = self.track(track.id), known == track,
              let url = Bundle.module.url(forResource: String(track.audioNumber), withExtension: "mp3", subdirectory: "Audio") else {
            throw PlaybackFailure.unavailable
        }
        return try ResolvedAudio.bundled(url, in: .module)
    }
}

public struct StudioResolver: PlaybackResolving {
    public init() {}
    public func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        try Task.checkCancellation()
        guard track.provider == .studio, let recording = StudioCatalogue.track(track.trackID) else {
            throw PlaybackFailure.invalidTrack
        }
        return try StudioCatalogue.audioSource(recording)
    }
}
