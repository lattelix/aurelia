import Foundation

public enum PlaybackFailure: String, Error, Sendable, Codable {
    case invalidTrack, invalidSource, unavailable, busy, network, expired, decoder, audioSession
    case scriptRequired, sourceDenied, invalidResponse
    case staleRequest = "stale-request"
    case invalidRequest = "invalid-request"
    public var canRetry: Bool { self == .network || self == .expired }
}

public enum PlaybackProvider: String, Sendable, Codable { case youtube, studio, device }

public struct PlaybackTrack: Sendable, Equatable, Codable, Identifiable {
    /// Entry identity is separate from video identity: one recording may occur twice.
    public let id: UUID
    public let videoID: String
    public let trackID: String
    public let title: String
    public let artist: String
    public let provider: PlaybackProvider
    public var deviceID: UUID? {
        guard provider == .device, trackID.hasPrefix("device:") else { return nil }
        return UUID(uuidString: String(trackID.dropFirst(7)))
    }

    public init(id: UUID = UUID(), videoID: String, title: String, artist: String, trackID: String? = nil) throws {
        let trackID = trackID ?? "youtube:\(videoID)"
        guard videoID.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil,
              !trackID.isEmpty, trackID.count <= 160,
              title.count <= 500, artist.count <= 500 else { throw PlaybackFailure.invalidTrack }
        self.id = id; self.videoID = videoID; self.title = title; self.artist = artist; self.trackID = trackID
        self.provider = .youtube
    }

    /// Original bundled recordings have no YouTube identity.
    public init(id: UUID = UUID(), studioID: String, title: String, artist: String) throws {
        guard studioID.range(of: "^studio:[a-z0-9-]{1,80}$", options: .regularExpression) != nil,
              title.count <= 500, artist.count <= 500 else { throw PlaybackFailure.invalidTrack }
        self.id = id; self.trackID = studioID; self.videoID = ""
        self.title = title; self.artist = artist; self.provider = .studio
    }
    /// Imported audio is identified solely by a private library UUID, never a path.
    public init(id: UUID = UUID(), deviceID: UUID, title: String, artist: String) throws {
        guard !title.isEmpty, title.utf16.count <= 500, !artist.isEmpty, artist.utf16.count <= 500,
              [title, artist].allSatisfy({ !$0.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) }) else {
            throw PlaybackFailure.invalidTrack
        }
        self.id = id; self.trackID = "device:" + deviceID.uuidString.lowercased(); self.videoID = ""
        self.title = title; self.artist = artist; self.provider = .device
    }

    private enum CodingKeys: String, CodingKey { case id, videoID, trackID, title, artist, provider }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        if try values.decodeIfPresent(PlaybackProvider.self, forKey: .provider) == .device {
            let trackID = try values.decode(String.self, forKey: .trackID)
            guard try values.decode(String.self, forKey: .videoID).isEmpty,
                  trackID.hasPrefix("device:"), let deviceID = UUID(uuidString: String(trackID.dropFirst(7))),
                  trackID == "device:" + deviceID.uuidString.lowercased() else { throw PlaybackFailure.invalidTrack }
            try self.init(id: values.decode(UUID.self, forKey: .id), deviceID: deviceID,
                          title: values.decode(String.self, forKey: .title), artist: values.decode(String.self, forKey: .artist))
            return
        }
        if try values.decodeIfPresent(PlaybackProvider.self, forKey: .provider) == .studio {
            guard try values.decode(String.self, forKey: .videoID).isEmpty else { throw PlaybackFailure.invalidTrack }
            try self.init(id: values.decode(UUID.self, forKey: .id),
                          studioID: values.decode(String.self, forKey: .trackID),
                          title: values.decode(String.self, forKey: .title),
                          artist: values.decode(String.self, forKey: .artist))
            return
        }
        try self.init(
            id: values.decode(UUID.self, forKey: .id),
            videoID: values.decode(String.self, forKey: .videoID),
            title: values.decode(String.self, forKey: .title),
            artist: values.decode(String.self, forKey: .artist),
            trackID: values.decodeIfPresent(String.self, forKey: .trackID)
        )
    }
}

public struct ResolvedAudio: Sendable {
    public let url: URL
    public let expiresAt: Date
    public let bitrate: Int?
    public let contentLength: Int?
    /// Present only for verified native YouTube sources; never serialized.
    public let youtubeLease: VerifiedYouTubeStreamLease?
    private let resourceRoot: URL?
    private let offlineCopy: OfflineLocalCopy?
    private let deviceCopy: LocalAudioCopy?

    public init(url: URL, expiresAt: Date, bitrate: Int? = nil, contentLength: Int? = nil) throws {
        guard Self.isAllowed(url), expiresAt.timeIntervalSince1970.isFinite,
              bitrate.map({ $0 > 0 && $0 <= 10_000_000 }) ?? true,
              contentLength.map({ $0 > 0 && $0 <= 128 * 1024 * 1024 }) ?? true else {
            throw PlaybackFailure.invalidSource
        }
        self.url = url; self.expiresAt = expiresAt
        self.bitrate = bitrate; self.contentLength = contentLength
        self.resourceRoot = nil
        self.youtubeLease = nil
        self.offlineCopy = nil
        self.deviceCopy = nil
    }

    public static func youtube(lease: VerifiedYouTubeStreamLease) throws -> ResolvedAudio {
        guard lease.expiresAt > Date() else { throw PlaybackFailure.expired }
        return ResolvedAudio(lease: lease)
    }

    private init(lease: VerifiedYouTubeStreamLease) {
        self.url = lease.url; self.expiresAt = lease.expiresAt
        self.bitrate = lease.bitrate; self.contentLength = lease.contentLength
        self.resourceRoot = nil; self.youtubeLease = lease
        self.offlineCopy = nil
        self.deviceCopy = nil
    }

    /// This separate construction path never relaxes the remote HTTPS boundary.
    /// Only an existing MP3 inside the supplied application resource bundle is accepted.
    public static func bundled(_ url: URL, in bundle: Bundle) throws -> ResolvedAudio {
        guard let root = bundle.resourceURL, isBundled(url, under: root) else { throw PlaybackFailure.invalidSource }
        return ResolvedAudio(bundledURL: url.resolvingSymlinksInPath(), root: root.resolvingSymlinksInPath())
    }

    private init(bundledURL: URL, root: URL) {
        self.url = bundledURL; self.resourceRoot = root; self.expiresAt = .distantFuture
        self.bitrate = nil; self.contentLength = nil
        self.youtubeLease = nil
        self.offlineCopy = nil
        self.deviceCopy = nil
    }

    /// Only a complete, checked copy issued by the owner-isolated offline
    /// store can enter this file path. Generic remote URL admission is intact.
    public static func offline(_ copy: OfflineLocalCopy) throws -> ResolvedAudio {
        guard copy.isValid else { throw PlaybackFailure.invalidSource }
        return ResolvedAudio(offlineCopy: copy)
    }

    private init(offlineCopy copy: OfflineLocalCopy) {
        url = copy.url; expiresAt = .distantFuture; bitrate = nil; contentLength = copy.contentLength
        youtubeLease = nil; resourceRoot = nil; offlineCopy = copy
        deviceCopy = nil
    }
    public static func device(_ copy: LocalAudioCopy) throws -> ResolvedAudio {
        guard copy.isValid else { throw PlaybackFailure.invalidSource }
        return ResolvedAudio(deviceCopy: copy)
    }
    private init(deviceCopy copy: LocalAudioCopy) {
        url = copy.url; expiresAt = .distantFuture; bitrate = nil; contentLength = copy.contentLength
        youtubeLease = nil; resourceRoot = nil; offlineCopy = nil; deviceCopy = copy
    }
    public var deviceID: UUID? { deviceCopy?.deviceID }
    public var isDeviceFile: Bool { deviceCopy != nil }

    public var isOffline: Bool { offlineCopy != nil }
    public var offlineVideoID: String? { offlineCopy?.videoID }

    public var isPlayable: Bool {
        if let deviceCopy { return deviceCopy.isValid }
        if let offlineCopy { return offlineCopy.isValid }
        if let resourceRoot { return Self.isBundled(url, under: resourceRoot) }
        return Self.isAllowed(url)
    }

    private static func isBundled(_ url: URL, under root: URL) -> Bool {
        guard url.isFileURL, root.isFileURL, url.query == nil, url.fragment == nil,
              url.host == nil || url.host == "" || url.host == "localhost",
              url.pathExtension.lowercased() == "mp3" else { return false }
        let target = url.resolvingSymlinksInPath().standardizedFileURL
        let canonicalRoot = root.resolvingSymlinksInPath().standardizedFileURL
        guard target.pathExtension.lowercased() == "mp3",
              target.path.hasPrefix(canonicalRoot.path + "/") else { return false }
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: target.path, isDirectory: &directory) && !directory.boolValue
    }

    public static func isAllowed(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", let host = parts.host?.lowercased(),
              host.hasSuffix(".googlevideo.com"), host.count > ".googlevideo.com".count,
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.fragment == nil else { return false }
        return true
    }
}

public protocol PlaybackResolving: Sendable {
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio
}

public enum RepeatMode: String, Sendable, Codable { case off, all, one }
public enum PlaybackStatus: String, Sendable, Codable { case idle, loading, playing, paused, ended, failed }
public enum PlaybackControl: Sendable { case play, pause, next, previous, seek(Double) }
public enum PlaybackDriverEvent: Sendable {
    case progress(position: Double, duration: Double)
    case ended
    case failed(PlaybackFailure)
    case control(PlaybackControl)
}

public struct PlaybackSnapshot: Sendable, Equatable {
    public internal(set) var queue: [PlaybackTrack] = []
    /// Changes only when queue contents/order change. Progress does not stale an edit.
    public internal(set) var queueRevision: UInt64 = 0
    public internal(set) var index: Int?
    public internal(set) var position: Double = 0
    public internal(set) var duration: Double = 0
    public internal(set) var status: PlaybackStatus = .idle
    public internal(set) var repeatMode: RepeatMode = .off
    public internal(set) var shuffle = false
    public internal(set) var failure: PlaybackFailure?
    public var currentTrack: PlaybackTrack? {
        guard let index, queue.indices.contains(index) else { return nil }
        return queue[index]
    }
}

@MainActor
public protocol PlaybackDriving: AnyObject {
    /// All asynchronous events identify the load that produced them.
    var onEvent: (@MainActor (UInt64, PlaybackDriverEvent) -> Void)? { get set }
    func load(_ source: ResolvedAudio, track: PlaybackTrack, generation: UInt64) throws
    func play()
    func pause()
    func seek(to position: Double)
    func stop()
    func dispose()
    func setVolume(_ value: Float)
}

public extension PlaybackDriving { func setVolume(_ value: Float) {} }
