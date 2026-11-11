import Foundation

/// The application supplies a previously verified account (or an explicit guest
/// device scope). A failed cloud bootstrap must never invent this capability.
public struct OfflineOwnerScope: Sendable, Equatable {
    public let ownerID: String
    public let revision: UUID
    public init(ownerID: String, revision: UUID = UUID()) throws {
        guard !ownerID.isEmpty, ownerID.utf8.count <= 512,
              !ownerID.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            throw OfflineFailure.invalidRequest
        }
        self.ownerID = ownerID; self.revision = revision
    }
}

public enum OfflineFailure: String, Error, Codable, Sendable {
    case invalidRequest, staleOwner, notReady, storage, storageLimit, insufficientSpace
    case identityChanged, corrupt, network, expired, sourceDenied, unavailable, inUse
    case waitingForWiFi, foregroundRequired
}
public enum OfflineState: String, Codable, Sendable {
    case queued, resolving, downloading, verifying, ready, paused, failed
}
public enum OfflineSyncScope: String, Codable, Sendable, CaseIterable {
    case library, likes, playlists
}

/// These explicit MVP limits are configurable product settings, not a promise
/// that a whole library fits. One admitted foreground transfer runs at a time.
public struct OfflineStoragePolicy: Codable, Sendable, Equatable {
    public let budgetBytes: Int64
    public let reserveBytes: Int64
    public let maximumFileBytes: Int
    public static let maximumRecords = 1_000
    public init(budgetBytes: Int64, reserveBytes: Int64 = 128 * 1024 * 1024,
                maximumFileBytes: Int = 128 * 1024 * 1024) throws {
        guard budgetBytes > 0, budgetBytes <= 64 * 1024 * 1024 * 1024,
              reserveBytes >= 0, reserveBytes <= 64 * 1024 * 1024 * 1024,
              maximumFileBytes > 0, maximumFileBytes <= 128 * 1024 * 1024 else {
            throw OfflineFailure.invalidRequest
        }
        self.budgetBytes = budgetBytes; self.reserveBytes = reserveBytes
        self.maximumFileBytes = maximumFileBytes
    }
}

public struct OfflineSyncSettings: Codable, Sendable, Equatable {
    public var enabled: Bool
    public var scope: OfflineSyncScope
    public var playlistIDs: [String]
    public var wifiOnly: Bool
    public init(enabled: Bool = false, scope: OfflineSyncScope = .likes,
                playlistIDs: [String] = [], wifiOnly: Bool = true) {
        self.enabled = enabled; self.scope = scope; self.playlistIDs = playlistIDs; self.wifiOnly = wifiOnly
    }
    func validate() throws {
        guard playlistIDs.count <= 100, Set(playlistIDs).count == playlistIDs.count,
              playlistIDs.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 160 }) else {
            throw OfflineFailure.invalidRequest
        }
    }
}

public struct OfflineCollectionSnapshot: Sendable {
    public let library: [PlaybackTrack]
    public let likes: [PlaybackTrack]
    public let playlists: [String: [PlaybackTrack]]
    public init(library: [PlaybackTrack], likes: [PlaybackTrack], playlists: [String: [PlaybackTrack]]) {
        self.library = library; self.likes = likes; self.playlists = playlists
    }
}

public struct OfflineItemSnapshot: Sendable, Identifiable {
    public let id: UUID
    public let track: PlaybackTrack
    public let state: OfflineState
    public let receivedBytes: Int
    public let totalBytes: Int?
    public let failure: OfflineFailure?
    public let manual: Bool
    public let selectedScopes: [String]
    public let album: String
    public let duration: Double
    public let hasAssets: Bool
    public let assetsRevision: UUID?
    public let assetsEnriched: Bool
}

public struct OfflineSnapshot: Sendable {
    public let items: [OfflineItemSnapshot]
    /// Includes retained copies for other owners on this device. Their metadata
    /// and individual file identities are never returned to the active owner.
    public let usedBytes: Int64
    public let freeBytes: Int64
    public let policy: OfflineStoragePolicy
    public let settings: OfflineSyncSettings
    public let foregroundOnly = true
}

struct OfflineRecord: Codable, Sendable {
    var id: UUID
    var track: PlaybackTrack
    var state: OfflineState = .queued
    var receivedBytes = 0
    var totalBytes: Int?
    var sourceFingerprint: String?
    var checksum: String?
    var failure: OfflineFailure?
    var manual: Bool
    var selectedScopes: [String] = []
    var selectionPaused = false
    // Optional fields preserve compatibility with previously installed v1 indexes.
    var album: String?
    var duration: Double?
    var assetsChecksum: String?
    var assetsRevision: UUID?
    var assetsEnriched: Bool?
    var snapshot: OfflineItemSnapshot {
        OfflineItemSnapshot(id: id, track: track, state: state, receivedBytes: receivedBytes,
                            totalBytes: totalBytes, failure: failure, manual: manual, selectedScopes: selectedScopes,
                            album: album ?? "", duration: duration ?? 0, hasAssets: assetsChecksum != nil,
                            assetsRevision: assetsRevision, assetsEnriched: assetsChecksum != nil && assetsEnriched == true)
    }
}

struct OfflineIndex: Codable, Sendable {
    var version = 1
    var ownerHash: String
    var settings = OfflineSyncSettings()
    var policy: OfflineStoragePolicy
    var records: [OfflineRecord] = []
    /// Explicitly removed items stay removed while they remain in the selected
    /// collection. Leaving and later rejoining the scope permits a new job.
    var suppressedVideoIDs: [String] = []
}
