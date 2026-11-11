import Foundation
import AureliaPlaybackCore

public enum AppearanceMode: String, CaseIterable, Codable, Sendable {
    case system, light, dark
    public var title: String { rawValue.capitalized }
}

public struct LocalPlaylist: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID
    public var name: String
    public var trackIDs: [String]
    public init(id: UUID = UUID(), name: String, trackIDs: [String] = []) {
        self.id = id; self.name = name; self.trackIDs = trackIDs
    }
}

/// Metadata and intent only. Audio locations and audible volume are never persisted.
public struct LocalProfile: Codable, Sendable {
    public var version = 1
    public var likes: Set<String> = []
    public var playlists: [LocalPlaylist] = []
    public var queueIDs: [String] = []
    public var queueIndex = 0
    public var position: Double = 0
    public var repeatMode: RepeatMode = .off
    public var shuffle = false
    public var appearance: AppearanceMode = .system
    public var palette: ThemePalette = .base
    public var showVolumeControl = true
    public var matchSystemVolume = VolumeControlPolicy.systemVolumeSupported
    public init() {}

    private enum CodingKeys: String, CodingKey {
        case version, likes, playlists, queueIDs, queueIndex, position, repeatMode, shuffle, appearance, palette
        case showVolumeControl, matchSystemVolume
    }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decodeIfPresent(Int.self, forKey: .version) ?? 1
        likes = try values.decodeIfPresent(Set<String>.self, forKey: .likes) ?? []
        playlists = try values.decodeIfPresent([LocalPlaylist].self, forKey: .playlists) ?? []
        queueIDs = try values.decodeIfPresent([String].self, forKey: .queueIDs) ?? []
        queueIndex = try values.decodeIfPresent(Int.self, forKey: .queueIndex) ?? 0
        position = try values.decodeIfPresent(Double.self, forKey: .position) ?? 0
        repeatMode = try values.decodeIfPresent(RepeatMode.self, forKey: .repeatMode) ?? .off
        shuffle = try values.decodeIfPresent(Bool.self, forKey: .shuffle) ?? false
        appearance = try values.decodeIfPresent(AppearanceMode.self, forKey: .appearance) ?? .system
        palette = try values.decodeIfPresent(ThemePalette.self, forKey: .palette) ?? .base
        showVolumeControl = try values.decodeIfPresent(Bool.self, forKey: .showVolumeControl) ?? true
        matchSystemVolume = try values.decodeIfPresent(Bool.self, forKey: .matchSystemVolume) ?? VolumeControlPolicy.systemVolumeSupported
    }

    public func sanitized() -> LocalProfile {
        var clean = self
        clean.version = 1
        clean.likes = Set(likes.filter { StudioCatalogue.track($0) != nil })
        var seen = Set<UUID>()
        clean.playlists = playlists.prefix(100).compactMap { playlist in
            let name = playlist.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, seen.insert(playlist.id).inserted else { return nil }
            var ids = Set<String>()
            return LocalPlaylist(id: playlist.id, name: String(name.prefix(80)), trackIDs:
                playlist.trackIDs.prefix(500).filter { StudioCatalogue.track($0) != nil && ids.insert($0).inserted })
        }
        clean.queueIDs = Array(queueIDs.prefix(500).filter { StudioCatalogue.track($0) != nil })
        clean.queueIndex = clean.queueIDs.indices.contains(queueIndex) ? queueIndex : 0
        clean.position = position.isFinite ? min(72, max(0, position)) : 0
        return clean
    }
}

@MainActor
public final class LocalProfileStore {
    private let defaults: UserDefaults?
    private let key = "aurelia.native.local-profile.v1"
    private let queueByteLimit = 4 * 1_048_576
    public init(defaults: UserDefaults? = .standard) { self.defaults = defaults }
    public func load() -> LocalProfile {
        guard let data = defaults?.data(forKey: key), data.count <= 1_048_576,
              let profile = try? JSONDecoder().decode(LocalProfile.self, from: data), profile.version == 1 else {
            return LocalProfile()
        }
        return profile.sanitized()
    }
    public func save(_ profile: LocalProfile) {
        guard let data = try? JSONEncoder().encode(profile.sanitized()), data.count <= 1_048_576 else { return }
        defaults?.set(data, forKey: key)
    }

    /// Every identity has a distinct device-local queue. A nil owner is the
    /// guest, never a fallback for a signed-in account.
    public func loadQueue(ownerID: String?) -> LocalQueueSnapshot? {
        guard let queueKey = queueKey(ownerID) else { return nil }
        if let data = defaults?.data(forKey: queueKey) {
            guard data.count <= queueByteLimit,
                  let queue = try? JSONDecoder().decode(LocalQueueSnapshot.self, from: data),
                  queue.ownerID == ownerID else { return nil }
            return queue.validated()
        }
        // The first native release saved only Studio IDs. Migrate that intent
        // solely into the guest queue; it cannot become an account's queue.
        guard ownerID == nil else { return nil }
        let profile = load()
        guard !profile.queueIDs.isEmpty else { return nil }
        let entries = profile.queueIDs.compactMap { id -> LocalQueueEntry? in
            guard let track = StudioCatalogue.track(id), let playback = try? track.queueEntry() else { return nil }
            return LocalQueueEntry(track: playback, album: track.album, duration: track.duration)
        }
        return LocalQueueSnapshot(ownerID: nil, entries: entries, index: profile.queueIndex,
                                  position: profile.position, repeatMode: profile.repeatMode,
                                  shuffle: profile.shuffle).validated()
    }

    public func saveQueue(_ queue: LocalQueueSnapshot) {
        guard let clean = queue.validated(), let queueKey = queueKey(clean.ownerID),
              let data = try? JSONEncoder().encode(clean), data.count <= queueByteLimit else { return }
        defaults?.set(data, forKey: queueKey)
    }

    private func queueKey(_ ownerID: String?) -> String? {
        guard let ownerID else { return "aurelia.native.queue.v1.guest" }
        guard LocalQueueSnapshot.validOwnerID(ownerID) else { return nil }
        return "aurelia.native.queue.v1.account." + Data(ownerID.utf8).base64EncodedString()
    }
}
