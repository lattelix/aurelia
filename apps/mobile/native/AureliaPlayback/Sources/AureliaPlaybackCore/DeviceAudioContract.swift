import Foundation

public struct DeviceQueueEntry: Codable, Sendable {
    public let entryId: UUID
    public let trackId: String
    public let provider: String
    public let externalId: String
    public let title: String
    public let artist: String
    public init(entryId: UUID, trackId: String, provider: String, externalId: String, title: String, artist: String) {
        self.entryId = entryId; self.trackId = trackId; self.provider = provider
        self.externalId = externalId; self.title = title; self.artist = artist
    }
    public func track() throws -> PlaybackTrack {
        guard provider == "youtube" else { throw PlaybackFailure.invalidTrack }
        return try PlaybackTrack(id: entryId, videoID: externalId, title: title, artist: artist, trackID: trackId)
    }
}

public struct DeviceQueueRequest: Codable, Sendable {
    public let revision: String
    public let ownerId: String
    public let tracks: [DeviceQueueEntry]
    public let index: Int
    public let position: Double
    public let playing: Bool
    public let `repeat`: RepeatMode
    public let shuffle: Bool
    public let volume: Double
}

public enum DeviceAudioCapability {
    // HTTP-only coverage is gated on the bounded whole/range/decoder proof.
    public static let available = false
    public static let unavailableReason = "source-unverified"
    public static var data: [String: Any] {
        ["apiVersion": 1, "transport": "device", "nativeQueue": true,
         "available": available, "supportedProviders": available ? ["youtube"] : [],
         "reason": available ? NSNull() : unavailableReason,
         "coverage": "direct-aac-only", "javascriptExecution": false,
         "automaticWebFallback": false, "physicalDeviceVerified": false]
    }
}

/// Revision checks run natively before every command. Old JS promises/dispose
/// calls cannot stop a replacement queue or reveal another account's queue.
@MainActor
public final class DeviceAudioCoordinator {
    public var onSnapshot: (([String: Any]) -> Void)?
    private let playback: NativePlaybackController
    private let driver: any PlaybackDriving
    private var revision = ""
    private var ownerId: String?
    private var sequence = 0
    private var volume = 0.75
    private var suppressPublish = false

    public init(resolver: any PlaybackResolving, driver: any PlaybackDriving) {
        self.driver = driver
        playback = NativePlaybackController(resolver: resolver, driver: driver)
        playback.onSnapshot = { [weak self] _ in self?.publish() }
    }

    public func loadQueue(_ request: DeviceQueueRequest) throws {
        let tracks = try Self.validateQueue(request)
        suppressPublish = true
        defer { suppressPublish = false; publish() }
        playback.stop()
        revision = request.revision; ownerId = request.ownerId; volume = request.volume
        driver.setVolume(Float(volume))
        try playback.setQueue(tracks, index: request.index, playing: false)
        playback.setRepeat(request.repeat); playback.setShuffle(request.shuffle)
        playback.seek(to: request.position)
        if request.playing { playback.play() }
    }

    public static func validateQueue(_ request: DeviceQueueRequest) throws -> [PlaybackTrack] {
        guard request.revision.range(of: "^[A-Za-z0-9:_-]{1,128}$", options: .regularExpression) != nil,
              !request.ownerId.isEmpty, request.ownerId.count <= 160,
              request.tracks.count <= 500, request.position.isFinite,
              (0...86400).contains(request.position), request.volume.isFinite,
              (0...1).contains(request.volume),
              request.tracks.isEmpty ? request.index == 0 : request.tracks.indices.contains(request.index) else {
            throw PlaybackFailure.invalidRequest
        }
        let tracks = try request.tracks.map { try $0.track() }
        guard Set(tracks.map(\.id)).count == tracks.count else { throw PlaybackFailure.invalidRequest }
        return tracks
    }

    public func validateRevision(_ expected: String) throws { try check(expected) }

    public func play(revision: String) throws { try check(revision); playback.play() }
    public func pause(revision: String) throws { try check(revision); playback.pause() }
    public func next(revision: String) throws { try check(revision); playback.next() }
    public func previous(revision: String) throws { try check(revision); playback.previous() }
    public func seek(revision: String, position: Double) throws {
        try check(revision)
        guard position.isFinite, (0...86400).contains(position) else { throw PlaybackFailure.invalidRequest }
        playback.seek(to: position)
    }
    public func setRepeat(revision: String, mode: RepeatMode) throws { try check(revision); playback.setRepeat(mode) }
    public func setShuffle(revision: String, enabled: Bool) throws { try check(revision); playback.setShuffle(enabled) }
    public func setVolume(revision: String, value: Double) throws {
        try check(revision)
        guard value.isFinite, (0...1).contains(value) else { throw PlaybackFailure.invalidRequest }
        volume = value; driver.setVolume(Float(value)); publish()
    }
    public func stop(revision: String) throws { try check(revision); clear() }
    public func releaseOwnership() { clear() }
    public func dispose() { clear(); playback.dispose(); onSnapshot = nil }

    public func snapshot() -> [String: Any] {
        let state = playback.snapshot
        return [
            "apiVersion": 1, "transport": "device", "revision": revision, "sequence": sequence,
            "ownerId": ownerId as Any? ?? NSNull(),
            "queue": state.queue.map {
                ["entryId": $0.id.uuidString.lowercased(), "trackId": $0.trackID, "provider": "youtube",
                 "externalId": $0.videoID, "title": $0.title, "artist": $0.artist]
            },
            "index": state.index as Any? ?? NSNull(), "entryId": state.currentTrack?.id.uuidString.lowercased() as Any? ?? NSNull(),
            "trackId": state.currentTrack?.trackID as Any? ?? NSNull(),
            "position": state.position, "duration": state.duration, "status": state.status.rawValue,
            "playing": state.status == .playing, "repeat": state.repeatMode.rawValue, "shuffle": state.shuffle,
            "volume": volume, "error": state.failure?.rawValue as Any? ?? NSNull()
        ]
    }

    private func check(_ expected: String) throws {
        guard !expected.isEmpty, expected == revision else { throw PlaybackFailure.staleRequest }
    }
    private func clear() {
        suppressPublish = true
        defer { suppressPublish = false; publish() }
        // Invalidate before publishing or stopping: reentrant old commands fail.
        revision = "superseded-\(UUID().uuidString.lowercased())"; ownerId = nil
        try? playback.setQueue([], playing: false)
        playback.stop()
    }
    private func publish() {
        guard !suppressPublish else { return }
        sequence += 1; onSnapshot?(snapshot())
    }
}
