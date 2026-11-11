import Foundation

/// Bounded local public-text cache. A selected recording stores metadata and text,
/// never request URLs, credentials, media locators or account identifiers.
public actor LyricsSelectionCache {
    public static let shared = LyricsSelectionCache()
    public static let maximumRecords = 50
    public static let maximumBytes = 5 * 1024 * 1024
    private struct Entry: Codable {
        let trackID: String
        let record: LyricsDTO
        let selectedAt: Double
    }
    private struct Snapshot: Codable {
        let version: Int
        let entries: [Entry]
    }
    private let directory: URL?
    private var entries: [String: Entry] = [:]
    private var loaded = false
    public init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Aurelia", isDirectory: true).appendingPathComponent("Lyrics", isDirectory: true)
    }
    public func selection(for trackID: String) -> LyricsDTO? {
        guard validID(trackID) else { return nil }
        loadIfNeeded()
        return entries[trackID]?.record
    }
    @discardableResult public func save(_ record: LyricsDTO, for trackID: String) -> Bool {
        guard validID(trackID), let directory, (try? record.validate()) != nil else { return false }
        loadIfNeeded()
        let entry = Entry(trackID: trackID, record: record, selectedAt: Date().timeIntervalSince1970)
        var next = entries
        next[trackID] = entry
        var ordered = next.values.sorted {
            $0.selectedAt == $1.selectedAt ? $0.trackID < $1.trackID : $0.selectedAt > $1.selectedAt
        }
        if ordered.count > Self.maximumRecords { ordered = Array(ordered.prefix(Self.maximumRecords)) }
        while !ordered.isEmpty {
            guard let data = try? JSONEncoder().encode(Snapshot(version: 1, entries: ordered)) else { return false }
            if data.count > Self.maximumBytes { ordered.removeLast(); continue }
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try data.write(to: directory.appendingPathComponent("selected-lyrics.json"), options: [.atomic])
                entries = Dictionary(uniqueKeysWithValues: ordered.map { ($0.trackID, $0) })
                return entries[trackID]?.record.id == record.id
            } catch { return false }
        }
        return false
    }
    private func loadIfNeeded() {
        guard !loaded else { return }
        loaded = true
        guard let url = directory?.appendingPathComponent("selected-lyrics.json"),
              let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size > 0, size <= Self.maximumBytes,
              let data = try? Self.readBounded(url), data.count <= Self.maximumBytes,
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data), snapshot.version == 1,
              snapshot.entries.count <= Self.maximumRecords,
              Set(snapshot.entries.map(\.trackID)).count == snapshot.entries.count,
              snapshot.entries.allSatisfy({ validID($0.trackID) && $0.selectedAt.isFinite && (try? $0.record.validate()) != nil }) else { return }
        entries = Dictionary(uniqueKeysWithValues: snapshot.entries.map { ($0.trackID, $0) })
    }
    private static func readBounded(_ url: URL) throws -> Data {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        return try handle.read(upToCount: maximumBytes + 1) ?? Data()
    }
}
