import AureliaPlaybackCore

/// Native-only composition. A missing YouTube source stays unavailable; there is
/// no gateway, web player or demo-audio fallback for a YouTube recording.
public struct ApplePlaybackResolver: PlaybackResolving {
    private let youtube: (any PlaybackResolving)?
    private let localFiles: LocalAudioLibrary?
    public init(youtube: (any PlaybackResolving)? = nil, localFiles: LocalAudioLibrary? = nil) { self.youtube = youtube; self.localFiles = localFiles }
    public func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        switch track.provider {
        case .studio: return try await StudioResolver().resolve(track)
        case .device:
            guard let localFiles, let id = track.deviceID else { throw PlaybackFailure.unavailable }
            return try await .device(localFiles.open(id))
        case .youtube:
            guard let youtube else { throw PlaybackFailure.unavailable }
            return try await youtube.resolve(track)
        }
    }
}
