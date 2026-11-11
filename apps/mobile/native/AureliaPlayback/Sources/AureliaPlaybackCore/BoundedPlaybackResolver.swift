import Foundation

/// A cancelled/timed-out caller does not free a slot while upstream work is
/// still running. New requests fail busy instead of accumulating physical work.
public actor BoundedPlaybackResolver: PlaybackResolving {
    private let underlying: any PlaybackResolving
    private var active = false

    public init(underlying: any PlaybackResolving) { self.underlying = underlying }

    public func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        guard !active else { throw PlaybackFailure.busy }
        try Task.checkCancellation()
        active = true
        defer { active = false }
        return try await underlying.resolve(track)
    }
}
