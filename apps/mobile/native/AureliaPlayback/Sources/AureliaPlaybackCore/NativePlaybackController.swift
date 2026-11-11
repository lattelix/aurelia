import Foundation

/// Queue, resolution and playback intent live in Swift, independently of WebView JS.
@MainActor
public final class NativePlaybackController {
    public private(set) var snapshot = PlaybackSnapshot()
    public var onSnapshot: (@MainActor (PlaybackSnapshot) -> Void)?
    /// Applies caller-owned settings only when native playback is admitted.
    /// The callback may reenter; cancellation/selection is checked again after it.
    public var onWillPlay: (@MainActor () -> Void)?
    /// A session policy (for example a sleep timer) may stop a natural track end
    /// before repeat or queue advancement. Only current-generation ends reach it.
    public var shouldStopAtTrackEnd: (@MainActor (PlaybackTrack) -> Bool)?
    private let resolver: any PlaybackResolving
    private let driver: any PlaybackDriving
    private let now: @Sendable () -> Date
    private let resolutionTimeout: UInt64
    private let startTimeout: UInt64
    private let progressTimeout: UInt64
    private var order: [UUID] = []
    private var generation: UInt64 = 0
    private var resolution: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var playbackWatchdog: Task<Void, Never>?
    private var lastDriverPosition: Double = 0
    private var desiredPlaying = false
    private var loadedSource: ResolvedAudio?
    private var previousYouTubeLease: (occurrence: UUID, lease: VerifiedYouTubeStreamLease)?
    private var retryUsed = false

    public init(
        resolver: any PlaybackResolving,
        driver: any PlaybackDriving,
        now: @escaping @Sendable () -> Date = { Date() },
        resolutionTimeoutSeconds: Double = 30,
        startTimeoutSeconds: Double = 20,
        progressTimeoutSeconds: Double = 15
    ) {
        self.resolver = resolver; self.driver = driver; self.now = now
        self.resolutionTimeout = Self.nanoseconds(resolutionTimeoutSeconds, fallback: 30)
        self.startTimeout = Self.nanoseconds(startTimeoutSeconds, fallback: 20)
        self.progressTimeout = Self.nanoseconds(progressTimeoutSeconds, fallback: 15)
        driver.onEvent = { [weak self] generation, event in self?.receive(generation, event) }
    }

    deinit { resolution?.cancel(); deadline?.cancel(); playbackWatchdog?.cancel() }

    public func setQueue(_ tracks: [PlaybackTrack], index: Int = 0, playing: Bool = false) throws {
        guard tracks.count <= 500, Set(tracks.map(\.id)).count == tracks.count,
              tracks.isEmpty ? index == 0 : tracks.indices.contains(index) else {
            throw PlaybackFailure.invalidTrack
        }
        let selectedID = tracks.isEmpty ? nil : tracks[index].id
        if previousYouTubeLease?.occurrence != selectedID { previousYouTubeLease = nil }
        invalidate()
        snapshot.queue = tracks; snapshot.index = tracks.isEmpty ? nil : index
        snapshot.queueRevision &+= 1
        snapshot.position = 0; snapshot.duration = 0; snapshot.failure = nil
        desiredPlaying = playing && !tracks.isEmpty
        rebuildOrder()
        if tracks.isEmpty { snapshot.status = .idle; publish() }
        else { beginResolve(resetRetry: true) }
    }

    /// Applies a UI edit to occurrence identities, without interrupting a retained
    /// current load. The revision guards commands from an out-of-date queue sheet.
    /// Retained occurrences are immutable; a different recording needs a new UUID.
    public func replaceQueue(_ tracks: [PlaybackTrack], expectedRevision: UInt64) throws {
        guard expectedRevision == snapshot.queueRevision else { throw PlaybackFailure.staleRequest }
        guard tracks.count <= 500, Set(tracks.map(\.id)).count == tracks.count else {
            throw PlaybackFailure.invalidRequest
        }
        let previous = Dictionary(uniqueKeysWithValues: snapshot.queue.map { ($0.id, $0) })
        // Explicitly compare metadata as well as identity: a UUID cannot silently
        // switch the source behind the current AVPlayer item or pending resolve.
        for track in tracks {
            if let retained = previous[track.id], retained != track { throw PlaybackFailure.invalidRequest }
        }
        guard tracks != snapshot.queue else { return }
        let currentID = snapshot.currentTrack?.id
        let nextIDs = Set(tracks.map(\.id))
        let previousOrder = order
        var editedOrder = tracks.map(\.id)
        if snapshot.shuffle {
            editedOrder = previousOrder.filter { nextIDs.contains($0) }
            editedOrder.append(contentsOf: tracks.filter { previous[$0.id] == nil }.map(\.id).shuffled())
        }
        var replacementID = currentID.flatMap { nextIDs.contains($0) ? $0 : nil }
        if replacementID == nil, let currentID, let position = previousOrder.firstIndex(of: currentID) {
            replacementID = previousOrder.dropFirst(position + 1).first { nextIDs.contains($0) }
        }
        // Prefer new entries after an exhausted tail; otherwise select the last
        // remaining occurrence. A fresh queue begins at its first presented row.
        // Clearing always stops. All selections retain the old play/pause intent.
        replacementID = replacementID ?? (currentID == nil ? tracks.first?.id :
            editedOrder.first { previous[$0] == nil } ?? tracks.last?.id)
        if previousYouTubeLease?.occurrence != replacementID { previousYouTubeLease = nil }
        if currentID == nil, let replacementID, snapshot.shuffle {
            editedOrder = [replacementID] + editedOrder.filter { $0 != replacementID }
        }
        snapshot.queue = tracks
        snapshot.index = replacementID.flatMap { id in tracks.firstIndex { $0.id == id } }
        snapshot.queueRevision &+= 1
        order = editedOrder
        if let currentID, replacementID == currentID {
            publish(); return
        }
        snapshot.position = 0; snapshot.duration = 0; snapshot.failure = nil
        if tracks.isEmpty {
            invalidate(); desiredPlaying = false; snapshot.status = .idle; publish()
        } else { beginResolve(resetRetry: true) }
    }

    /// A new occurrence is queued without interrupting the current source. Play
    /// next also updates the actual shuffle traversal, not only the visible rows.
    public func insertQueueEntry(_ track: PlaybackTrack, afterCurrent: Bool, expectedRevision: UInt64) throws {
        guard expectedRevision == snapshot.queueRevision else { throw PlaybackFailure.staleRequest }
        var tracks = snapshot.queue
        let index = afterCurrent ? min(tracks.count, (snapshot.index ?? -1) + 1) : tracks.count
        tracks.insert(track, at: index)
        try replaceQueue(tracks, expectedRevision: expectedRevision)
        if afterCurrent, snapshot.queueRevision == expectedRevision &+ 1,
           snapshot.queue.contains(track), snapshot.shuffle, let current = snapshot.currentTrack?.id, current != track.id,
           let position = order.firstIndex(of: current) {
            order.removeAll { $0 == track.id }
            order.insert(track.id, at: min(position + 1, order.count))
        }
    }

    public func play() {
        guard snapshot.currentTrack != nil else { return }
        desiredPlaying = true
        if let source = loadedSource, source.expiresAt > now().addingTimeInterval(30),
           snapshot.status != .ended && snapshot.status != .failed {
            let attempt = generation
            snapshot.status = .playing; lastDriverPosition = snapshot.position
            armPlaybackWatchdog(start: true); playDriver(attempt: attempt)
            if generation == attempt && desiredPlaying { publish() }
        } else if resolution == nil {
            if snapshot.status == .ended { snapshot.position = 0 }
            beginResolve(resetRetry: true)
        }
    }

    public func pause() {
        desiredPlaying = false
        playbackWatchdog?.cancel(); playbackWatchdog = nil
        driver.pause()
        snapshot.status = snapshot.currentTrack == nil ? .idle : .paused
        publish()
    }

    public func seek(to position: Double) {
        guard position.isFinite, snapshot.currentTrack != nil else { return }
        snapshot.position = max(0, snapshot.duration > 0 ? min(position, snapshot.duration) : position)
        lastDriverPosition = snapshot.position
        armPlaybackWatchdog(start: true)
        driver.seek(to: snapshot.position); publish()
    }

    public func next() { advance(ended: false) }

    /// UI selection retains native play intent, including while a resolver is
    /// pending. Reconstructing the queue from status == playing loses that intent.
    public func selectQueueEntry(_ id: UUID, expectedRevision: UInt64) throws {
        guard expectedRevision == snapshot.queueRevision else { throw PlaybackFailure.staleRequest }
        guard snapshot.queue.contains(where: { $0.id == id }) else { throw PlaybackFailure.invalidTrack }
        select(id)
    }

    public func previous() {
        guard let track = snapshot.currentTrack else { return }
        if snapshot.position > 3 { select(track.id); return }
        guard let position = order.firstIndex(of: track.id) else { return }
        if position > 0 { select(order[position - 1]) }
        else if snapshot.repeatMode == .all, let last = order.last { select(last) }
        else { select(track.id) }
    }

    public func setRepeat(_ mode: RepeatMode) { snapshot.repeatMode = mode; publish() }
    public func setShuffle(_ enabled: Bool) {
        guard enabled != snapshot.shuffle else { return }
        snapshot.shuffle = enabled; rebuildOrder(); publish()
    }

    public func stop() {
        previousYouTubeLease = nil
        invalidate(); desiredPlaying = false
        snapshot.position = 0; snapshot.status = .idle; snapshot.failure = nil; publish()
    }

    public func dispose() {
        onWillPlay = nil
        shouldStopAtTrackEnd = nil
        stop(); onSnapshot = nil; driver.onEvent = nil; driver.dispose()
    }

    private func publish() { onSnapshot?(snapshot) }

    private func playDriver(attempt: UInt64) {
        guard generation == attempt, let occurrence = snapshot.currentTrack?.id,
              desiredPlaying else { return }
        onWillPlay?()
        guard generation == attempt, snapshot.currentTrack?.id == occurrence,
              desiredPlaying else { return }
        driver.play()
    }

    private static func nanoseconds(_ value: Double, fallback: Double) -> UInt64 {
        UInt64((value.isFinite ? min(60, max(0.01, value)) : fallback) * 1_000_000_000)
    }

    private func armPlaybackWatchdog(start: Bool) {
        playbackWatchdog?.cancel(); playbackWatchdog = nil
        guard desiredPlaying, loadedSource != nil else { return }
        let attempt = generation
        let timeout = start ? startTimeout : progressTimeout
        playbackWatchdog = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: timeout) } catch { return }
            guard !Task.isCancelled, let self, self.generation == attempt,
                  self.desiredPlaying, self.loadedSource != nil else { return }
            self.failed(.network)
        }
    }

    private func invalidate() {
        generation &+= 1
        resolution?.cancel(); resolution = nil
        deadline?.cancel(); deadline = nil
        playbackWatchdog?.cancel(); playbackWatchdog = nil
        loadedSource = nil; driver.stop()
    }

    private func rebuildOrder() {
        guard snapshot.shuffle, let current = snapshot.currentTrack else {
            order = snapshot.queue.map(\.id); return
        }
        order = [current.id] + snapshot.queue.filter { $0.id != current.id }.map(\.id).shuffled()
    }

    private func select(_ id: UUID) {
        guard let index = snapshot.queue.firstIndex(where: { $0.id == id }) else { return }
        if previousYouTubeLease?.occurrence != id { previousYouTubeLease = nil }
        invalidate(); snapshot.index = index; snapshot.position = 0; snapshot.duration = 0
        beginResolve(resetRetry: true)
    }

    private func advance(ended: Bool) {
        guard let track = snapshot.currentTrack,
              let position = order.firstIndex(of: track.id) else { return }
        if ended && snapshot.repeatMode == .one { select(track.id); return }
        if position + 1 < order.count { select(order[position + 1]); return }
        if snapshot.repeatMode == .all, let first = order.first { select(first); return }
        playbackWatchdog?.cancel(); playbackWatchdog = nil
        desiredPlaying = false; snapshot.status = .ended; driver.pause(); publish()
    }

    private func beginResolve(resetRetry: Bool) {
        guard let track = snapshot.currentTrack else { return }
        invalidate()
        if resetRetry { retryUsed = false }
        let attempt = generation
        snapshot.failure = nil; snapshot.status = .loading; publish()
        guard generation == attempt, snapshot.currentTrack?.id == track.id else { return }
        let resolver = self.resolver
        resolution = Task { [weak self] in
            do {
                let source = try await resolver.resolve(track)
                guard !Task.isCancelled, let self, self.generation == attempt,
                      self.snapshot.currentTrack?.id == track.id else { return }
                self.resolution = nil
                self.deadline?.cancel(); self.deadline = nil
                guard source.expiresAt > self.now().addingTimeInterval(30) else {
                    self.failed(.expired); return
                }
                do {
                    try self.validateYouTubeContinuity(source, track: track)
                    try self.driver.load(source, track: track, generation: attempt)
                }
                catch { self.failed((error as? PlaybackFailure) ?? .decoder); return }
                guard self.generation == attempt, self.snapshot.currentTrack?.id == track.id else { return }
                self.previousYouTubeLease = source.youtubeLease.map { (track.id, $0) }
                self.loadedSource = source
                self.lastDriverPosition = self.snapshot.position
                self.driver.seek(to: self.snapshot.position)
                guard self.generation == attempt else { return }
                if self.desiredPlaying {
                    self.snapshot.status = .playing; self.armPlaybackWatchdog(start: true); self.playDriver(attempt: attempt)
                }
                else { self.driver.pause(); self.snapshot.status = .paused }
                if self.generation == attempt { self.publish() }
            } catch is CancellationError {
                guard !Task.isCancelled, let self, self.generation == attempt else { return }
                self.resolution = nil; self.failed(.network)
            }
            catch {
                guard !Task.isCancelled, let self, self.generation == attempt,
                      self.snapshot.currentTrack?.id == track.id else { return }
                self.resolution = nil
                self.deadline?.cancel(); self.deadline = nil
                self.failed((error as? PlaybackFailure) ?? .unavailable)
            }
        }
        let timeout = resolutionTimeout
        deadline = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: timeout) } catch { return }
            guard !Task.isCancelled, let self, self.generation == attempt, self.resolution != nil else { return }
            self.resolution?.cancel(); self.resolution = nil
            self.failed(.network)
        }
    }

    private func failed(_ failure: PlaybackFailure) {
        deadline?.cancel(); deadline = nil
        playbackWatchdog?.cancel(); playbackWatchdog = nil
        if failure.canRetry && !retryUsed && desiredPlaying {
            retryUsed = true; beginResolve(resetRetry: false); return
        }
        driver.stop(); loadedSource = nil
        snapshot.failure = failure
        snapshot.status = desiredPlaying ? .failed : .paused
        desiredPlaying = false; publish()
    }

    private func receive(_ attempt: UInt64, _ event: PlaybackDriverEvent) {
        guard attempt == generation, snapshot.currentTrack != nil else { return }
        switch event {
        case .progress(let position, let duration):
            guard snapshot.status != .failed else { return }
            if position.isFinite {
                if position > lastDriverPosition + 0.05 { armPlaybackWatchdog(start: false) }
                lastDriverPosition = max(0, position)
                snapshot.position = max(0, position)
            }
            if duration.isFinite { snapshot.duration = max(0, duration) }
            publish()
        case .ended:
            // A terminal error wins over a queued end notification from the
            // same load. Remote/user controls may still retry or select a track.
            guard snapshot.status != .failed else { return }
            if let track = snapshot.currentTrack {
                let stop = shouldStopAtTrackEnd?(track) == true
                // The callback may reenter through an identity/queue change.
                guard attempt == generation, snapshot.currentTrack?.id == track.id else { return }
                if stop { pause(); return }
            }
            advance(ended: true)
        case .failed(let failure):
            // Multiple AV notifications may report the same terminal failure.
            // Preserve its failed state until a deliberate play/pause/selection.
            guard snapshot.status != .failed else { return }
            let expired = loadedSource.map { $0.expiresAt <= now().addingTimeInterval(30) } ?? false
            failed(expired ? .expired : failure)
        case .control(let action):
            switch action {
            case .play: play()
            case .pause: pause()
            case .next: next()
            case .previous: previous()
            case .seek(let position): seek(to: position)
            }
        }
    }

    private func validateYouTubeContinuity(_ source: ResolvedAudio, track: PlaybackTrack) throws {
        // A checked owner-scoped copy replaces an expiring stream for the
        // same recording. It has no signed locator to renew; it must retain
        // the native local admission and exact YouTube video identity.
        if source.isOffline {
            guard track.provider == .youtube, source.offlineVideoID == track.videoID,
                  source.youtubeLease == nil, source.isPlayable else { throw PlaybackFailure.invalidSource }
            return
        }
        if let lease = source.youtubeLease {
            guard track.provider == .youtube, lease.requestedVideoID == track.videoID,
                  lease.playerVideoID == track.videoID else { throw PlaybackFailure.invalidSource }
            if let previous = previousYouTubeLease, previous.occurrence == track.id {
                try previous.lease.validatingRenewal(lease, now: now())
            }
        } else if let previous = previousYouTubeLease, previous.occurrence == track.id {
            throw PlaybackFailure.invalidSource
        }
    }
}
