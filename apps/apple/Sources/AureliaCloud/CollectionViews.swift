import Foundation

public enum CloudPlaylistSort: String, CaseIterable, Identifiable, Sendable {
    case saved = "Saved order", name = "Name", songs = "Song count"
    public var id: Self { self }
}
public enum CloudTrackSort: String, CaseIterable, Identifiable, Sendable {
    case saved = "Saved order", title = "Title", artist = "Artist", duration = "Duration"
    public var id: Self { self }
}

/// Display transformations never mutate the server's saved order or the current queue.
public enum CloudCollectionView {
    public static func playlists(_ playlists: [PlaylistDTO], query: String, sort: CloudPlaylistSort) -> [PlaylistDTO] {
        let query = normalized(query)
        let matching = playlists.enumerated().filter { query.isEmpty || normalized($0.element.name + " " + $0.element.description).contains(query) }
        return matching.sorted { left, right in
            switch sort {
            case .saved: return left.offset < right.offset
            case .name:
                let comparison = compare(left.element.name, right.element.name)
                return comparison == .orderedSame ? left.offset < right.offset : comparison == .orderedAscending
            case .songs:
                return left.element.tracks.count == right.element.tracks.count ? left.offset < right.offset : left.element.tracks.count > right.element.tracks.count
            }
        }.map(\.element)
    }
    public static func tracks(_ tracks: [TrackDTO], query: String, sort: CloudTrackSort) -> [TrackDTO] {
        let query = normalized(query)
        let matching = tracks.enumerated().filter {
            query.isEmpty || normalized($0.element.title + " " + $0.element.artist + " " + $0.element.album).contains(query)
        }
        return matching.sorted { left, right in
            let comparison: ComparisonResult
            switch sort {
            case .saved: return left.offset < right.offset
            case .title: comparison = compare(left.element.title, right.element.title)
            case .artist:
                let artist = compare(left.element.artist, right.element.artist)
                comparison = artist == .orderedSame ? compare(left.element.title, right.element.title) : artist
            case .duration:
                return left.element.duration == right.element.duration ? left.offset < right.offset : left.element.duration < right.element.duration
            }
            return comparison == .orderedSame ? left.offset < right.offset : comparison == .orderedAscending
        }.map(\.element)
    }
    public static func recentTracks(_ history: [HistoryEntryDTO]) -> [TrackDTO] {
        var seen = Set<String>()
        return history.compactMap { seen.insert($0.track.id).inserted ? $0.track : nil }
    }
    private static func normalized(_ value: String) -> String {
        value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private static func compare(_ left: String, _ right: String) -> ComparisonResult {
        normalized(left).compare(normalized(right), options: [.numeric], locale: Locale(identifier: "en_US_POSIX"))
    }
}
