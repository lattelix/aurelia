import Foundation
import Combine
import CryptoKit

public enum LyricsProvenance: String, Codable, Sendable { case lrclib, managed }

/// Public LRCLIB records and saved text have distinct provenance. A managed
/// payload has no LRCLIB recording identity; zero is only its explicit sentinel.
public struct LyricsDTO: Codable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let trackName: String
    public let artistName: String
    public let albumName: String
    public let duration: Double
    public let instrumental: Bool
    public let plainLyrics: String?
    public let syncedLyrics: String?
    public let provenance: LyricsProvenance
    private enum CodingKeys: CodingKey {
        case id, trackName, artistName, albumName, duration, instrumental, plainLyrics, syncedLyrics, provenance
    }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(Int.self, forKey: .id)
        trackName = try values.decode(String.self, forKey: .trackName)
        artistName = try values.decode(String.self, forKey: .artistName)
        albumName = try values.decode(String.self, forKey: .albumName)
        duration = try values.decode(Double.self, forKey: .duration)
        instrumental = try values.decode(Bool.self, forKey: .instrumental)
        plainLyrics = try values.decodeIfPresent(String.self, forKey: .plainLyrics)
        syncedLyrics = try values.decodeIfPresent(String.self, forKey: .syncedLyrics)
        provenance = try values.decodeIfPresent(LyricsProvenance.self, forKey: .provenance) ?? .lrclib
        try validate()
    }
    private init(trackName: String, artistName: String, albumName: String, duration: Double,
                 plainLyrics: String?, syncedLyrics: String?) {
        id = 0; self.trackName = trackName; self.artistName = artistName; self.albumName = albumName
        self.duration = duration; instrumental = false; self.plainLyrics = plainLyrics; self.syncedLyrics = syncedLyrics
        provenance = .managed
    }
    public static func managed(trackName: String, artistName: String, albumName: String, duration: Double,
                               plainLyrics: String?, syncedLyrics: String?) -> LyricsDTO? {
        guard duration.isFinite, (0...86400).contains(duration),
              plainLyrics?.isEmpty == false || syncedLyrics?.isEmpty == false else { return nil }
        let record = Self(trackName: trackName, artistName: artistName, albumName: albumName,
            duration: duration, plainLyrics: plainLyrics, syncedLyrics: syncedLyrics)
        return (try? record.validate()) != nil ? record : nil
    }
    /// Used by presentation/cancellation fences instead of treating id0 as a
    /// shared recording identity for every independently saved text selection.
    public var selectionID: String {
        if provenance == .lrclib { return "lrclib:\(id)" }
        struct Content: Encodable {
            let track: String; let artist: String; let album: String; let duration: Double
            let plain: String?; let synced: String?
        }
        let content = Content(track: trackName, artist: artistName, album: albumName, duration: duration,
            plain: plainLyrics, synced: syncedLyrics)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let data = (try? encoder.encode(content)) ?? Data()
        return "managed:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    func validate() throws {
        guard (provenance == .lrclib ? id > 0 : id == 0),
              provenance != .managed || (duration <= 86400 && (plainLyrics?.isEmpty == false || syncedLyrics?.isEmpty == false)),
              [trackName, artistName, albumName].allSatisfy({ $0.utf16.count <= 1000 }),
              duration.isFinite, duration >= 0,
              plainLyrics.map({ $0.utf16.count <= 100_000 }) ?? true,
              syncedLyrics.map({ $0.utf16.count <= 100_000 }) ?? true else { throw CloudFailure.invalidResponse }
    }
    public var lines: [LyricsLine] { LyricsLine.parse(syncedLyrics ?? "") }
}

public struct LyricsLine: Sendable, Equatable, Identifiable {
    public let id: Int
    public let time: Double
    public let text: String
    /// Multiple timestamps per row and fractional seconds follow the web LRC parser.
    public static func parse(_ input: String) -> [Self] {
        guard input.utf16.count <= 100_000,
              let stamps = try? NSRegularExpression(pattern: #"\[([0-9]{1,3}):([0-5][0-9])(?:[.:]([0-9]{1,3}))?\]"#),
              let tags = try? NSRegularExpression(pattern: #"\[[^\]]*\]"#) else { return [] }
        var result: [(time: Double, text: String, order: Int)] = []
        for row in input.components(separatedBy: .newlines) {
            let range = NSRange(row.startIndex..., in: row)
            let text = tags.stringByReplacingMatches(in: row, range: range, withTemplate: "").trimmingCharacters(in: .whitespacesAndNewlines)
            for stamp in stamps.matches(in: row, range: range) {
                func part(_ index: Int) -> String {
                    Range(stamp.range(at: index), in: row).map { String(row[$0]) } ?? "0"
                }
                let time = (Double(part(1)) ?? 0) * 60 + (Double(part(2)) ?? 0) + (Double("0." + part(3)) ?? 0)
                result.append((time, text, result.count))
            }
        }
        return result.sorted { $0.time == $1.time ? $0.order < $1.order : $0.time < $1.time }
            .enumerated().map { Self(id: $0.offset, time: $0.element.time, text: $0.element.text) }
    }
    public static func activeIndex(in lines: [Self], position: Double) -> Int? {
        guard position.isFinite, position >= 0 else { return nil }
        return lines.lastIndex { $0.time <= position }
    }
}

func lyricsQuery(_ value: String) -> String? {
    guard let query = musicQuery(value), query.utf16.count >= 2 else { return nil }
    return query
}

/// A lyrics sheet owns its request so different windows cannot replace each other's recording.
@MainActor public final class CloudLyricsStore: ObservableObject {
    @Published public private(set) var records: [LyricsDTO] = []
    @Published public private(set) var isLoading = false
    @Published public private(set) var error: String?
    private let client: CloudAPIClient
    private let selectionCache: LyricsSelectionCache
    private var generation: UInt64 = 0
    private var task: Task<[LyricsDTO], Error>?
    public init(client: CloudAPIClient, selectionCache: LyricsSelectionCache = .shared) {
        self.client = client; self.selectionCache = selectionCache
    }
    deinit { task?.cancel() }
    public func search(_ query: String) async {
        reset()
        guard let query = lyricsQuery(query) else { error = "Enter a song or artist using 2 to 200 characters."; return }
        let ticket = generation
        isLoading = true
        let client = client, task = Task { try await client.lyrics(query) }
        self.task = task
        defer { if ticket == generation { isLoading = false; self.task = nil } }
        do {
            let result = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
            guard ticket == generation, !Task.isCancelled, !task.isCancelled else { return }
            records = result
        } catch {
            guard ticket == generation, !Task.isCancelled, !task.isCancelled, !(error is CancellationError) else { return }
            self.error = (error as? CloudFailure ?? .unavailable).message
        }
    }
    public func reset() {
        generation &+= 1; task?.cancel(); task = nil
        records = []; isLoading = false; error = nil
    }
    public func restoreSelection(for trackID: String) async -> LyricsDTO? {
        await selectionCache.selection(for: trackID)
    }
    /// The downloaded recording owns its text. The small independent cache is
    /// a fallback only after that owner-scoped read has completed.
    public func restorePreferredSelection(for trackID: String,
        loadManaged: (@MainActor () async -> LyricsDTO?)? = nil) async -> LyricsDTO? {
        let ticket = generation
        if let loadManaged {
            let managed = await loadManaged()
            guard ticket == generation, !Task.isCancelled else { return nil }
            if let managed, managed.provenance == .managed, (try? managed.validate()) != nil { return managed }
        }
        let cached = await selectionCache.selection(for: trackID)
        guard ticket == generation, !Task.isCancelled else { return nil }
        return cached
    }
    @discardableResult public func cacheSelection(_ record: LyricsDTO, for trackID: String) async -> Bool {
        await selectionCache.save(record, for: trackID)
    }
}
