import Foundation
@preconcurrency import AVFoundation
@preconcurrency import MediaPlayer

/// Resource ownership remains independent of the controller's/UI's lifetime.
private final class PlayerObservations {
    var notifications: [NSObjectProtocol] = []
    var status: NSKeyValueObservation?
    var periodic: (AVPlayer, Any)?
    var commands: [(MPRemoteCommand, Any)] = []
    func clear() {
        status?.invalidate(); status = nil
        notifications.forEach { NotificationCenter.default.removeObserver($0) }
        notifications.removeAll()
        if let (player, token) = periodic { player.removeTimeObserver(token) }
        periodic = nil
        commands.forEach { $0.0.removeTarget($0.1) }; commands.removeAll()
    }
    deinit { clear() }
}

@MainActor
public final class AVPlayerDriver: PlaybackDriving {
    public var onEvent: (@MainActor (UInt64, PlaybackDriverEvent) -> Void)?
    private let player = AVPlayer()
    private let diagnostic: (@MainActor (NativeMediaDiagnostic) -> Void)?
    private let itemObservations = PlayerObservations()
    private let systemObservations = PlayerObservations()
    private var resourceLoader: GuardedYouTubeResourceLoader?
    // Retain the local read capability for as long as AVPlayer owns its file.
    private var localSource: ResolvedAudio?
    private var generation: UInt64 = 0
    private var metadata: [String: Any] = [:]
    private var systemControls = false
    #if os(iOS)
    private var audioSessionActive = false
    #endif

    public init(
        volume: Float = 0.75, enableSystemControls: Bool = false,
        diagnostic: (@MainActor (NativeMediaDiagnostic) -> Void)? = nil
    ) {
        self.diagnostic = diagnostic
        player.volume = min(1, max(0, volume.isFinite ? volume : 0.75))
        player.actionAtItemEnd = .pause
        if enableSystemControls { setSystemControlsEnabled(true) }
    }

    public func load(_ source: ResolvedAudio, track: PlaybackTrack, generation: UInt64) throws {
        guard source.isPlayable else { throw PlaybackFailure.invalidSource }
        if track.provider == .youtube {
            if source.isOffline {
                guard source.offlineVideoID == track.videoID, source.youtubeLease == nil else { throw PlaybackFailure.invalidSource }
            } else {
                guard let lease = source.youtubeLease, lease.requestedVideoID == track.videoID,
                  lease.playerVideoID == track.videoID else { throw PlaybackFailure.invalidSource }
                guard lease.expiresAt > Date() else { throw PlaybackFailure.expired }
            }
        } else if track.provider == .device {
            guard source.isDeviceFile, source.deviceID == track.deviceID, source.youtubeLease == nil else { throw PlaybackFailure.invalidSource }
        } else {
            guard source.youtubeLease == nil, source.url.isFileURL, !source.isDeviceFile, !source.isOffline else { throw PlaybackFailure.invalidSource }
        }
        stop()
        if source.isOffline || source.isDeviceFile { localSource = source }
        self.generation = generation
        let item: AVPlayerItem
        if let lease = source.youtubeLease {
            let loader = GuardedYouTubeResourceLoader(lease: lease, diagnostic: { [weak self] observation in
                guard let self, self.generation == generation else { return }
                self.diagnostic?(observation)
            })
            loader.onFailure = { [weak self] failure in
                guard let self, self.generation == generation else { return }
                self.onEvent?(generation, .failed(failure))
            }
            resourceLoader = loader
            item = AVPlayerItem(asset: loader.makeAsset())
        } else {
            item = AVPlayerItem(url: source.url)
        }
        item.preferredForwardBufferDuration = 5
        item.canUseNetworkResourcesForLiveStreamingWhilePaused = false
        // AVPlayer's automatic network-buffer prediction does not model a
        // client-controlled resource loader (AVPlayer.h). Our guarded loader
        // and controller own buffering/stall recovery for YouTube.
        player.automaticallyWaitsToMinimizeStalling = source.youtubeLease == nil
        player.replaceCurrentItem(with: item)
        metadata = [MPMediaItemPropertyTitle: track.title, MPMediaItemPropertyArtist: track.artist]
        itemObservations.status = item.observe(\.status, options: [.new]) { [weak self, weak item] _, _ in
            Task { @MainActor [weak self, weak item] in
                guard let self, let item, self.generation == generation, self.player.currentItem === item else { return }
                self.diagnostic?(.status(item.status.rawValue))
                guard self.generation == generation, self.player.currentItem === item, item.status == .failed else { return }
                let failure = Self.classify(item.error)
                for observation in Self.errorDiagnostics(item.error) {
                    guard self.generation == generation, self.player.currentItem === item else { return }
                    self.diagnostic?(observation)
                }
                guard self.generation == generation, self.player.currentItem === item else { return }
                self.diagnostic?(.failure(failure))
                guard self.generation == generation, self.player.currentItem === item else { return }
                self.onEvent?(generation, .failed(failure))
            }
        }
        itemObservations.notifications.append(NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self, weak item] _ in
            Task { @MainActor [weak self, weak item] in
                guard let self, let item, self.generation == generation, self.player.currentItem === item else { return }
                self.onEvent?(generation, .ended)
            }
        })
        itemObservations.notifications.append(NotificationCenter.default.addObserver(
            forName: .AVPlayerItemPlaybackStalled, object: item, queue: .main
        ) { [weak self, weak item] _ in
            Task { @MainActor [weak self, weak item] in
                guard let self, let item, self.generation == generation, self.player.currentItem === item else { return }
                self.onEvent?(generation, .failed(.network))
            }
        })
        let token = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.generation == generation else { return }
                let duration = self.player.currentItem?.duration.seconds ?? 0
                let time = self.player.currentTime().seconds
                let position = time.isFinite ? max(0, time) : 0
                let safeDuration = duration.isFinite ? max(0, duration) : 0
                self.onEvent?(generation, .progress(position: position, duration: safeDuration))
                self.publishSystem(position: position, duration: safeDuration)
            }
        }
        itemObservations.periodic = (player, token)
    }

    public func play() {
        #if os(iOS)
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
            audioSessionActive = true
        } catch { onEvent?(generation, .failed(.audioSession)); return }
        #endif
        player.play()
    }
    public func setVolume(_ volume: Float) {
        guard volume.isFinite else { return }
        player.volume = min(1, max(0, volume))
    }
    public func pause() { player.pause(); publishSystem() }
    public func seek(to position: Double) {
        guard position.isFinite else { return }
        player.seek(to: CMTime(seconds: max(0, position), preferredTimescale: 600))
    }
    public func stop() {
        generation &+= 1
        resourceLoader?.invalidate(); resourceLoader = nil
        player.pause(); itemObservations.clear(); player.replaceCurrentItem(with: nil)
        localSource = nil
        metadata.removeAll()
        #if os(iOS)
        if audioSessionActive {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            audioSessionActive = false
        }
        #endif
        if systemControls { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil }
    }
    public func dispose() { stop(); setSystemControlsEnabled(false); onEvent = nil }

    /// Desktop CLI/unit tests do not take over system transport controls by default.
    public func setSystemControlsEnabled(_ enabled: Bool) {
        if systemControls && !enabled { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil }
        systemObservations.clear(); systemControls = enabled
        guard enabled else { return }
        let center = MPRemoteCommandCenter.shared()
        bind(center.playCommand, action: .play)
        bind(center.pauseCommand, action: .pause)
        bind(center.nextTrackCommand, action: .next)
        bind(center.previousTrackCommand, action: .previous)
        let target = center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let position = (event as? MPChangePlaybackPositionCommandEvent)?.positionTime,
                  position.isFinite else { return .commandFailed }
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.onEvent?(self.generation, .control(.seek(position)))
            }
            return .success
        }
        systemObservations.commands.append((center.changePlaybackPositionCommand, target))
        #if os(iOS)
        systemObservations.notifications.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] notification in
            let began = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt)
                == AVAudioSession.InterruptionType.began.rawValue
            guard began else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }; self.onEvent?(self.generation, .control(.pause))
            }
        })
        systemObservations.notifications.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] notification in
            let removed = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt)
                == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue
            guard removed else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }; self.onEvent?(self.generation, .control(.pause))
            }
        })
        #endif
    }

    private func bind(_ command: MPRemoteCommand, action: PlaybackControl) {
        let target = command.addTarget { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }; self.onEvent?(self.generation, .control(action))
            }
            return .success
        }
        systemObservations.commands.append((command, target))
    }

    private func publishSystem(position: Double? = nil, duration: Double? = nil) {
        guard systemControls else { return }
        let time = position ?? player.currentTime().seconds
        metadata[MPNowPlayingInfoPropertyElapsedPlaybackTime] = time.isFinite ? max(0, time) : 0
        if let duration { metadata[MPMediaItemPropertyPlaybackDuration] = duration }
        metadata[MPNowPlayingInfoPropertyPlaybackRate] = player.rate
        MPNowPlayingInfoCenter.default().nowPlayingInfo = metadata
    }

    private static func errorDiagnostics(_ error: Error?) -> [NativeMediaDiagnostic] {
        var current = error as NSError?
        var result: [NativeMediaDiagnostic] = []
        for _ in 0..<5 {
            guard let error = current else { break }
            let domain: NativeMediaErrorDomain
            switch error.domain {
            case AVFoundationErrorDomain: domain = .avFoundation
            case NSURLErrorDomain: domain = .url
            case NSOSStatusErrorDomain: domain = .osStatus
            case "CoreMediaErrorDomain": domain = .coreMedia
            default: domain = .other
            }
            result.append(.error(domain: domain, code: error.code))
            // Only traverse the documented underlying-error link. Never emit
            // raw domains, descriptions or the surrounding userInfo dictionary.
            current = error.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return result
    }

    private static func classify(_ error: Error?) -> PlaybackFailure {
        var current = error as NSError?
        for _ in 0..<5 {
            guard let error = current else { break }
            if error.domain == NSURLErrorDomain { return .network }
            current = error.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return .decoder
    }
}
