import Foundation
import Darwin
import Combine
import AureliaPlaybackCore
import AureliaCloud

@MainActor
public final class AureliaModel: ObservableObject {
    @Published public private(set) var playback: PlaybackSnapshot
    @Published public private(set) var profile: LocalProfile
    @Published public var searchText = ""
    @Published public var notice: String?
    @Published public private(set) var volume: Double = 0
    @Published public private(set) var glassRendered = false
    @Published public private(set) var sleepTimer: SleepTimerState?
    public let forceMuted: Bool
    /// Enabled only by an explicit resolver injection; discovery alone is not a source.
    public let youtubePlaybackAvailable: Bool
    public let cloud: CloudAccountStore?
    public let offline: AppleOfflineStore?
    public let localFiles: AppleLocalFilesStore?
    private let controller: NativePlaybackController
    private let driver: any PlaybackDriving
    private let store: LocalProfileStore
    private var restoring = false
    private var queueDurations: [UUID: Double] = [:]
    private var queueAlbums: [UUID: String] = [:]
    private var queueOwnerID: String?
    private var identityRevision: UInt64 = 0
    private var sleepTask: Task<Void, Never>?
    private let timerNow: @Sendable () -> Date
    private let timerSleep: @Sendable (Double) async throws -> Void
    private var accountObservation: AnyCancellable?
    private var glassSurfaces = Set<UUID>()
    #if DEBUG
    private var diagnosticEvents = 0
    #endif

    public init(driver: any PlaybackDriving, resolver: any PlaybackResolving = StudioResolver(),
                store: LocalProfileStore = LocalProfileStore(), forceMuted: Bool = false, cloud: CloudAccountStore? = nil,
                youtubePlaybackAvailable: Bool = false, offline: AppleOfflineStore? = nil, localFiles: AppleLocalFilesStore? = nil,
                timerNow: @escaping @Sendable () -> Date = { Date() },
                timerSleep: @escaping @Sendable (Double) async throws -> Void = { try await Task.sleep(for: .seconds($0)) }) {
        self.driver = driver; self.store = store; self.forceMuted = forceMuted
        self.youtubePlaybackAvailable = youtubePlaybackAvailable
        self.cloud = cloud
        self.offline = offline
        self.localFiles = localFiles
        self.queueOwnerID = cloud?.authorizedOwnerID
        self.timerNow = timerNow; self.timerSleep = timerSleep
        // This must precede queue restoration, prepare and every possible play.
        driver.setVolume(0)
        let controller = NativePlaybackController(resolver: resolver, driver: driver)
        self.controller = controller
        self.playback = controller.snapshot
        self.profile = store.load()
        // A normal explicit play should be audible. This session preference is
        // separate from the muted driver used during startup/paused restoration.
        self.volume = forceMuted ? 0 : 0.75
        controller.onWillPlay = { [weak self] in
            guard let self else { return }
            guard self.queueOwnerID == self.cloud?.authorizedOwnerID else {
                self.invalidateAccountPlayback(); return
            }
            // A suspended app may resume via system controls before a sleeping
            // Task gets CPU time. Expired intent wins at the final play boundary.
            if self.expireSleepTimerIfNeeded() { return }
            // System transport commands enter the controller directly. Apply the
            // session preference at the same final boundary as an in-app play.
            self.driver.setVolume(self.playerGain)
        }
        controller.shouldStopAtTrackEnd = { [weak self] track in
            guard let self, self.sleepTimer == .trackEnd(track.id) else { return false }
            self.cancelSleepTimer()
            self.notice = "Sleep timer finished."
            return true
        }
        controller.onSnapshot = { [weak self] snapshot in
            guard let self else { return }
            if !self.restoring, !snapshot.queue.isEmpty,
               self.queueOwnerID != self.cloud?.authorizedOwnerID {
                self.invalidateAccountPlayback(); return
            }
            #if DEBUG
            // Opt-in development output contains closed enums only, never
            // source locators, track metadata, credentials or upstream errors.
            if ProcessInfo.processInfo.arguments.contains("--native-playback-diagnostics"),
               self.diagnosticEvents < 64,
               snapshot.status != self.playback.status || snapshot.failure != self.playback.failure {
                self.diagnosticEvents += 1
                var event = ["status": snapshot.status.rawValue]
                if let failure = snapshot.failure { event["failure"] = failure.rawValue }
                if let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]) {
                    print("AURELIA_PLAYBACK_CHECK " + String(decoding: data, as: UTF8.self))
                    fflush(nil)
                }
            }
            #endif
            self.playback = snapshot
            let retained = Set(snapshot.queue.map(\.id))
            self.queueDurations = self.queueDurations.filter { retained.contains($0.key) }
            self.queueAlbums = self.queueAlbums.filter { retained.contains($0.key) }
            if let id = snapshot.currentTrack?.id, snapshot.duration.isFinite, (0.01...86400).contains(snapshot.duration) {
                self.queueDurations[id] = snapshot.duration
            }
            if case .trackEnd(let id) = self.sleepTimer, snapshot.currentTrack?.id != id {
                self.cancelSleepTimer()
            }
            if snapshot.queue.isEmpty { self.cancelSleepTimer() }
            if !self.restoring { self.savePlayback() }
        }
        cloud?.onIdentityChange = { [weak self] in self?.invalidateAccountPlayback() }
        offline?.onAuthorizationRevoked = { [weak self] in self?.invalidateAccountPlayback(suspendOffline: false) }
        // Restoring a stored credential sets account only after a validated bootstrap.
        // The existing identity callback also fires at sign-out start, before awaits.
        if let cloud {
            accountObservation = cloud.$account.map { $0?.id }.combineLatest(cloud.$phase, cloud.$isMutating).dropFirst().sink { [weak self, weak cloud] accountID, phase, _ in
                guard let self, let cloud else { return }
                // These publications happen before the stored values change.
                if accountID != cloud.account?.id || [.signedOut, .expired, .secureStorageLocked, .authorizing].contains(phase) {
                    self.invalidateAccountPlayback()
                }
                self.scheduleOwnerRestore()
            }
        }
        if offline != nil { scheduleOwnerRestore() }
        else { restorePaused() }
    }

    deinit { sleepTask?.cancel() }

    public static func live(forceMuted: Bool = false, youtubeResolver: (any PlaybackResolving)? = nil) -> AureliaModel {
        let cloud = CloudAccountStore.live()
        let support = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))?.resolvingSymlinksInPath().standardizedFileURL
        let localLibrary = support.flatMap { try? LocalAudioLibrary(rootDirectory: $0.appendingPathComponent("AureliaImportedAudio-v1", isDirectory: true)) }
        let localFiles = AppleLocalFilesStore(library: localLibrary)
        let upstream = ApplePlaybackResolver(youtube: youtubeResolver, localFiles: localLibrary)
        var playbackResolver: any PlaybackResolving = upstream
        var offline: AppleOfflineStore?
        if youtubeResolver != nil,
           let support,
           let policy = try? OfflineStoragePolicy(budgetBytes: 512 * 1024 * 1024),
           let engine = try? ManagedOfflineEngine(rootDirectory: support.appendingPathComponent("AureliaOffline-v1", isDirectory: true), resolver: upstream, policy: policy) {
            let preferred = OfflinePreferredResolver(engine: engine, upstream: upstream)
            playbackResolver = preferred
            offline = AppleOfflineStore(resolver: preferred, cloud: cloud)
        }
        return AureliaModel(driver: AVPlayerDriver(volume: 0, enableSystemControls: true), resolver: playbackResolver,
                            forceMuted: forceMuted, cloud: cloud, youtubePlaybackAvailable: youtubeResolver != nil, offline: offline, localFiles: localFiles)
    }
    public var current: StudioTrack? { playback.currentTrack.flatMap { StudioCatalogue.track($0.trackID) } }
    public var currentPlaybackTrack: PlaybackTrack? { playback.currentTrack }
    public var currentAlbum: String? { currentPlaybackTrack.flatMap { queueAlbums[$0.id] } ?? current?.album }
    public var cloudCurrentTrack: TrackDTO? {
        guard let track = currentPlaybackTrack else { return nil }
        return LocalQueueEntry(track: track, album: currentAlbum ?? "", duration: currentDuration).cloudTrack
    }
    public var currentDuration: Double {
        if playback.duration > 0 { return playback.duration }
        return currentPlaybackTrack.flatMap { queueDurations[$0.id] } ?? current?.duration ?? 0
    }
    public var queuePersistenceText: String? {
        playback.queue.contains { $0.provider == .youtube } ? "This queue is saved on this device for the current profile and restores paused." : nil
    }
    public var sleepTimerText: String? { sleepTimer?.title }
    public var results: [StudioTrack] { StudioCatalogue.search(searchText) }
    public var likedTracks: [StudioTrack] { StudioCatalogue.tracks.filter { profile.likes.contains($0.id) } }
    public var isPlaying: Bool { playback.status == .playing }
    public var usesSystemVolume: Bool { VolumeControlPolicy.systemVolumeSupported && profile.matchSystemVolume }
    private var playerGain: Float {
        VolumeControlPolicy.playerGain(volume, matchSystemVolume: profile.matchSystemVolume, forceMuted: forceMuted)
    }
    public var statusText: String {
        if playback.failure != nil { return "Playback unavailable. Try again." }
        switch playback.status {
        case .loading: return currentPlaybackTrack?.provider == .youtube ? "Preparing YouTube audio…" : currentPlaybackTrack?.provider == .device ? "Opening local file…" : "Preparing Studio recording…"
        case .playing: return playerGain == 0 ? "Playing silently · volume 0" : currentPlaybackTrack?.provider == .youtube ? "Playing from YouTube / saved copy" : currentPlaybackTrack?.provider == .device ? "Playing from this device" : "Playing from Studio"
        case .ended: return "Queue finished"
        case .idle: return "Choose something for this moment"
        default: return "Paused · on this device"
        }
    }

    public func play(_ tracks: [StudioTrack], at index: Int = 0) {
        guard !tracks.isEmpty, tracks.indices.contains(index) else { return }
        prepareQueueOwner()
        do {
            let queue = try tracks.map { try $0.queueEntry() }
            queueDurations = Dictionary(uniqueKeysWithValues: zip(queue, tracks).map { ($0.0.id, $0.1.duration) })
            queueAlbums = Dictionary(uniqueKeysWithValues: zip(queue, tracks).map { ($0.0.id, $0.1.album) })
            driver.setVolume(playerGain)
            try controller.setQueue(queue, index: index, playing: true)
        } catch { notice = "This recording could not be added to the queue." }
    }
    public func canPlayCloudTrack(_ track: TrackDTO) -> Bool {
        guard let entry = try? cloudQueueEntry(track) else { return false }
        return entry.provider == .studio || youtubePlaybackAvailable
    }
    /// Called only by an explicit song selection. Account ownership is captured by
    /// the row so a late tap cannot start a previous account's displayed collection.
    public func playCloudTracks(_ tracks: [TrackDTO], at index: Int = 0, expectedAccountID: String? = nil) {
        guard expectedAccountID == cloud?.authorizedOwnerID, cloud?.isMutating != true else { notice = "The account changed. Choose music again."; return }
        guard !tracks.isEmpty, tracks.count <= 20_000, tracks.indices.contains(index) else {
            notice = "This collection cannot be played. Refresh your library and choose a song again."; return
        }
        // Large cloud collections remain browsable without becoming an unbounded
        // native queue. Start at the selected song and keep up to 499 following it.
        let start = tracks.count > 500 ? index : 0
        let selected = tracks.count > 500 ? 0 : index
        let window = Array(tracks[start..<min(tracks.count, start + 500)])
        prepareQueueOwner()
        do {
            let queue = try window.map(cloudQueueEntry)
            guard youtubePlaybackAvailable || !queue.contains(where: { $0.provider == .youtube }) else {
                notice = "YouTube playback is not available in this build. Open the song in YouTube."; return
            }
            queueDurations = Dictionary(uniqueKeysWithValues: zip(queue, window).map { ($0.0.id, $0.1.duration) })
            queueAlbums = Dictionary(uniqueKeysWithValues: zip(queue, window).map { ($0.0.id, $0.1.album) })
            driver.setVolume(playerGain)
            try controller.setQueue(queue, index: selected, playing: true)
        } catch { notice = "This collection contains an unsupported song. Nothing was played." }
    }

    public func playNext(_ track: StudioTrack) { insertStudio(track, next: true) }
    public func playLocalFiles(_ tracks: [LocalAudioRecord], at index: Int = 0) {
        guard !tracks.isEmpty, tracks.count <= 1000, tracks.indices.contains(index) else { return }
        let start = tracks.count > 500 ? index : 0
        let selected = tracks.count > 500 ? 0 : index
        let tracks = Array(tracks[start..<min(tracks.count, start + 500)])
        prepareQueueOwner()
        do {
            let queue = try tracks.map { try $0.playbackTrack() }
            queueDurations = Dictionary(uniqueKeysWithValues: zip(queue, tracks).map { ($0.0.id, $0.1.duration) })
            queueAlbums = Dictionary(uniqueKeysWithValues: zip(queue, tracks).map { ($0.0.id, $0.1.album) })
            try controller.setQueue(queue, index: selected, playing: true)
        } catch { notice = "This file could not be played." }
    }
    public func playLocalNext(_ track: LocalAudioRecord) {
        if let entry = try? track.playbackTrack() { insert(entry, album: track.album, duration: track.duration, next: true) }
    }
    public func addLocalToQueue(_ track: LocalAudioRecord) {
        if let entry = try? track.playbackTrack() { insert(entry, album: track.album, duration: track.duration, next: false) }
    }
    public func stopLocalPlayback() {
        guard playback.queue.contains(where: { $0.provider == .device }) else { return }
        controller.pause()
        replaceQueue(playback.queue.filter { $0.provider != .device }, expectedRevision: playback.queueRevision)
    }
    public func addToQueue(_ track: StudioTrack) { insertStudio(track, next: false) }
    public func playCloudNext(_ track: TrackDTO, expectedAccountID: String? = nil) {
        insertCloud(track, next: true, expectedAccountID: expectedAccountID)
    }
    public func addCloudToQueue(_ track: TrackDTO, expectedAccountID: String? = nil) {
        insertCloud(track, next: false, expectedAccountID: expectedAccountID)
    }
    private func insertStudio(_ track: StudioTrack, next: Bool) {
        guard let entry = try? track.queueEntry() else { notice = "This song cannot be queued."; return }
        insert(entry, album: track.album, duration: track.duration, next: next)
    }
    private func insertCloud(_ track: TrackDTO, next: Bool, expectedAccountID: String?) {
        guard expectedAccountID == cloud?.authorizedOwnerID, cloud?.isMutating != true else { notice = "The account changed. Choose music again."; return }
        guard let entry = try? cloudQueueEntry(track) else { notice = "This song cannot be queued."; return }
        guard entry.provider == .studio || youtubePlaybackAvailable else {
            notice = "YouTube playback is not available in this build."; return
        }
        insert(entry, album: track.album, duration: track.duration, next: next)
    }
    private func insert(_ entry: PlaybackTrack, album: String, duration: Double, next: Bool) {
        prepareQueueOwner()
        guard playback.queue.count < 500 else { notice = "The queue is full. Remove a song before adding another."; return }
        queueDurations[entry.id] = duration; queueAlbums[entry.id] = album
        do {
            try controller.insertQueueEntry(entry, afterCurrent: next, expectedRevision: playback.queueRevision)
            notice = next ? "Playing next." : "Added to queue."
        } catch {
            queueDurations.removeValue(forKey: entry.id); queueAlbums.removeValue(forKey: entry.id)
            notice = "The queue changed. Try adding the song again."
        }
    }

    private func cloudQueueEntry(_ track: TrackDTO) throws -> PlaybackTrack {
        guard !track.title.isEmpty, !track.artist.isEmpty, track.title.utf16.count <= 500, track.artist.utf16.count <= 500,
              track.album.utf16.count <= 500, track.artwork.utf16.count <= 2048, track.externalId.utf16.count <= 160,
              track.duration.isFinite, (0...86400).contains(track.duration),
              [track.title, track.artist, track.album].allSatisfy({ text in
                  !text.contains("://") && !text.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
              }) else { throw PlaybackFailure.invalidTrack }
        switch track.provider {
        case "youtube":
            guard track.id == "youtube:\(track.externalId)",
                  track.externalId.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil else { throw PlaybackFailure.invalidTrack }
            return try PlaybackTrack(videoID: track.externalId, title: track.title, artist: track.artist, trackID: track.id)
        case "studio":
            guard let local = StudioCatalogue.track(track.id), track.externalId == String(local.audioNumber) else { throw PlaybackFailure.invalidTrack }
            return try local.queueEntry()
        default: throw PlaybackFailure.invalidTrack
        }
    }
    public func togglePlayback() {
        if isPlaying { controller.pause() }
        else {
            guard currentPlaybackTrack != nil else { return }
            driver.setVolume(playerGain)
            controller.play()
        }
    }
    public func pause() { controller.pause() }
    public func next() { controller.next() }
    public func previous() { controller.previous() }
    public func seek(_ position: Double) { controller.seek(to: position) }
    public func selectQueue(_ index: Int) {
        guard playback.queue.indices.contains(index) else { return }
        selectQueueEntry(playback.queue[index].id, expectedRevision: playback.queueRevision)
    }
    public func selectQueueEntry(_ id: UUID, expectedRevision: UInt64) {
        do {
            driver.setVolume(playerGain)
            try controller.selectQueueEntry(id, expectedRevision: expectedRevision)
        } catch { notice = "The queue changed. Choose the song again from the current list." }
    }
    public func removeQueueEntry(_ id: UUID, expectedRevision: UInt64) {
        replaceQueue(playback.queue.filter { $0.id != id }, expectedRevision: expectedRevision)
    }
    public func moveQueueEntry(_ id: UUID, by offset: Int, expectedRevision: UInt64) {
        guard offset == -1 || offset == 1,
              let index = playback.queue.firstIndex(where: { $0.id == id }), playback.queue.indices.contains(index + offset) else { return }
        var reordered = playback.queue
        reordered.swapAt(index, index + offset)
        replaceQueue(reordered, expectedRevision: expectedRevision)
    }
    public func clearQueue(expectedRevision: UInt64) { replaceQueue([], expectedRevision: expectedRevision) }
    private func replaceQueue(_ queue: [PlaybackTrack], expectedRevision: UInt64) {
        do { try controller.replaceQueue(queue, expectedRevision: expectedRevision) }
        catch { notice = "The queue changed. Check the current list before trying again." }
    }
    public func toggleShuffle() { controller.setShuffle(!playback.shuffle) }
    public func cycleRepeat() {
        controller.setRepeat(playback.repeatMode == .off ? .all : playback.repeatMode == .all ? .one : .off)
    }
    public func setVolume(_ value: Double) {
        guard value.isFinite, !usesSystemVolume || forceMuted else { return }
        volume = forceMuted ? 0 : min(1, max(0, value))
        driver.setVolume(playerGain)
    }
    public func setShowVolumeControl(_ visible: Bool) {
        profile.showVolumeControl = visible; store.save(profile)
    }
    public func setMatchSystemVolume(_ linked: Bool) {
        profile.matchSystemVolume = linked && VolumeControlPolicy.systemVolumeSupported
        store.save(profile)
        // A restored/paused player stays at zero until an explicit play. Linking
        // during playback changes only AVPlayer gain, never the OS media level.
        if isPlaying { driver.setVolume(playerGain) }
    }
    public func setSleepTimer(minutes: Int) {
        guard (1...180).contains(minutes), currentPlaybackTrack != nil else { return }
        cancelSleepTimer()
        let deadline = timerNow().addingTimeInterval(Double(minutes) * 60)
        sleepTimer = .deadline(deadline)
        let sleep = timerSleep
        sleepTask = Task { [weak self] in
            do { try await sleep(Double(minutes) * 60) } catch { return }
            guard !Task.isCancelled, let self, self.sleepTimer == .deadline(deadline) else { return }
            self.cancelSleepTimer(); self.controller.pause(); self.notice = "Sleep timer finished."
        }
    }
    public func setSleepTimerAtTrackEnd() {
        guard let id = currentPlaybackTrack?.id else { return }
        cancelSleepTimer(); sleepTimer = .trackEnd(id)
    }
    public func cancelSleepTimer() {
        sleepTask?.cancel(); sleepTask = nil; sleepTimer = nil
    }
    @discardableResult private func expireSleepTimerIfNeeded() -> Bool {
        guard case .deadline(let deadline) = sleepTimer, deadline <= timerNow() else { return false }
        cancelSleepTimer(); controller.pause(); notice = "Sleep timer finished."; return true
    }
    public func toggleLike(_ track: StudioTrack) {
        if profile.likes.contains(track.id) { profile.likes.remove(track.id) } else { profile.likes.insert(track.id) }
        store.save(profile)
    }
    @discardableResult public func createPlaylist(_ name: String) -> UUID? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, profile.playlists.count < 100 else { return nil }
        let playlist = LocalPlaylist(name: String(trimmed.prefix(80)))
        profile.playlists.append(playlist); store.save(profile); return playlist.id
    }
    public func add(_ track: StudioTrack, to id: UUID) {
        guard let i = profile.playlists.firstIndex(where: { $0.id == id }),
              !profile.playlists[i].trackIDs.contains(track.id) else { return }
        profile.playlists[i].trackIDs.append(track.id); store.save(profile)
        notice = "Added to \(profile.playlists[i].name)."
    }
    public func remove(_ track: StudioTrack, from id: UUID) {
        guard let i = profile.playlists.firstIndex(where: { $0.id == id }) else { return }
        profile.playlists[i].trackIDs.removeAll { $0 == track.id }; store.save(profile)
    }
    public func deletePlaylist(_ id: UUID) {
        profile.playlists.removeAll { $0.id == id }; store.save(profile)
    }
    public func setAppearance(_ mode: AppearanceMode) { profile.appearance = mode; store.save(profile) }
    public func setPalette(_ palette: ThemePalette) { profile.palette = palette; store.save(profile) }
    public func setGlassRendered(_ active: Bool, surface: UUID) {
        if active { glassSurfaces.insert(surface) } else { glassSurfaces.remove(surface) }
        glassRendered = !glassSurfaces.isEmpty
    }
    public func dispose() {
        cancelSleepTimer()
        // Controller teardown publishes its stopped position; it is not a user
        // request to overwrite the resume position already saved on progress.
        restoring = true; controller.dispose(); restoring = false
    }

    private func invalidateAccountPlayback(suspendOffline: Bool = true) {
        // Clearing the controller invalidates resolver generations, including
        // transports which return after cancellation. It never copies the queue
        // to a guest/new owner or overwrites the saved local Studio selection.
        restoring = true
        if suspendOffline { offline?.suspendAuthorization() }
        cancelSleepTimer()
        controller.pause(); driver.setVolume(0)
        try? controller.setQueue([], playing: false)
        queueDurations.removeAll(); queueAlbums.removeAll()
        restoring = false
    }

    private func scheduleOwnerRestore() {
        identityRevision &+= 1
        let revision = identityRevision
        // @Published emits before its stored account changes. Restore after the
        // synchronous identity callback; that callback can also clear playback.
        Task { @MainActor [weak self] in
            guard let self, self.identityRevision == revision else { return }
            let ownerID = self.cloud?.authorizedOwnerID
            if self.queueOwnerID != ownerID {
                self.invalidateAccountPlayback(suspendOffline: false); self.queueOwnerID = ownerID
            }
            if let offline = self.offline {
                guard await offline.prepareForPlayback(expectedAccountID: ownerID),
                      self.identityRevision == revision, self.queueOwnerID == ownerID else { return }
            }
            if self.playback.queue.isEmpty { self.restorePaused() }
        }
    }

    private func prepareQueueOwner() {
        let ownerID = cloud?.authorizedOwnerID
        guard queueOwnerID != ownerID else { return }
        invalidateAccountPlayback(suspendOffline: false); queueOwnerID = ownerID
        if offline == nil { restorePaused() }
    }

    private func restorePaused() {
        guard let saved = store.loadQueue(ownerID: queueOwnerID), !saved.entries.isEmpty else { return }
        restoring = true
        defer { restoring = false }
        do {
            driver.setVolume(0)
            let queue = try saved.entries.map { try $0.playbackTrack() }
            queueDurations = Dictionary(uniqueKeysWithValues: saved.entries.map { ($0.id, $0.duration) })
            queueAlbums = Dictionary(uniqueKeysWithValues: saved.entries.map { ($0.id, $0.album) })
            try controller.setQueue(queue, index: saved.index, playing: false)
            controller.setRepeat(saved.repeatMode); controller.setShuffle(saved.shuffle)
            controller.seek(to: saved.position)
        } catch { notice = "The saved queue could not be restored." }
    }
    private func savePlayback() {
        guard queueOwnerID == cloud?.authorizedOwnerID else { return }
        let entries = playback.queue.map { track in
            LocalQueueEntry(track: track, album: queueAlbums[track.id] ?? StudioCatalogue.track(track.trackID)?.album ?? "",
                            duration: queueDurations[track.id] ?? StudioCatalogue.track(track.trackID)?.duration ?? 0)
        }
        store.saveQueue(LocalQueueSnapshot(ownerID: queueOwnerID, entries: entries, index: playback.index ?? 0,
                                          position: playback.position, repeatMode: playback.repeatMode, shuffle: playback.shuffle))
        // Keep the old Studio-only profile interoperable, but account queues
        // never overwrite the guest's local collections or queue migration.
        guard queueOwnerID == nil else { return }
        var updated = profile
        updated.queueIDs = playback.queue.allSatisfy { $0.provider == .studio } ? playback.queue.map(\.trackID) : []
        updated.queueIndex = updated.queueIDs.isEmpty ? 0 : playback.index ?? 0
        updated.position = updated.queueIDs.isEmpty ? 0 : playback.position
        updated.repeatMode = playback.repeatMode; updated.shuffle = playback.shuffle
        profile = updated; store.save(updated)
    }
}
