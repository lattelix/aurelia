import Foundation
import Combine
import Network
import AureliaCloud
import AureliaPlaybackCore

/// Native URLs stay behind this resolver. The UI receives metadata and progress.
actor OfflinePreferredResolver: PlaybackResolving {
    let engine: ManagedOfflineEngine
    private let upstream: any PlaybackResolving
    private var owner: OfflineOwnerScope?
    private var generation: UInt64 = 0
    init(engine: ManagedOfflineEngine, upstream: any PlaybackResolving) { self.engine = engine; self.upstream = upstream }
    func activate(_ next: OfflineOwnerScope?) async throws {
        try Task.checkCancellation()
        generation &+= 1; let ticket = generation; owner = nil
        try await engine.activateOwner(next)
        guard ticket == generation, !Task.isCancelled else { throw PlaybackFailure.staleRequest }
        owner = next
    }
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        let ticket = generation, scope = owner
        if track.provider == .youtube {
            // Authorization is distinct from a missing copy. Cold restoration
            // cannot turn a pending/revoked owner into an upstream request.
            guard let scope else { throw PlaybackFailure.staleRequest }
            do {
                let copy = try await engine.openReady(track, owner: scope)
                guard ticket == generation, owner == scope else { throw PlaybackFailure.staleRequest }
                return try .offline(copy)
            } catch OfflineFailure.notReady { /* A missing copy can stream. A damaged copy cannot. */ }
            catch let failure as PlaybackFailure { throw failure }
            catch { throw PlaybackFailure.invalidSource }
        }
        let source = try await upstream.resolve(track)
        guard ticket == generation, owner == scope, !Task.isCancelled else { throw PlaybackFailure.staleRequest }
        return source
    }
}

@MainActor public final class AppleOfflineStore: ObservableObject {
    @Published public private(set) var snapshot: OfflineSnapshot?
    @Published public private(set) var message: String?
    @Published public private(set) var busy = false
    @Published public private(set) var onWiFi = false
    public var onAuthorizationRevoked: (@MainActor () -> Void)?
    private let resolver: OfflinePreferredResolver
    private let cloud: CloudAccountStore
    private let assets: OfflineAssetsCoordinator
    private let allowAssetNetwork: Bool
    private var assetCache: [UUID: OfflineStoredAssets] = [:]
    private var assetCacheOrder: [UUID] = []
    private var refreshGeneration: UInt64 = 0
    private var scope: OfflineOwnerScope?
    private var identity: String?
    private var foreground = true
    private var epoch: UInt64 = 0
    private var subscriptions = Set<AnyCancellable>()
    private var ownerTask: Task<Void, Never>?
    private var revocationTask: Task<Void, Never>?
    private var progressTask: Task<Void, Never>?
    private var authorizationTask: Task<Void, Never>?
    private var scheduledDeadline: Date?
    private var scheduledRevision: UUID?
    private let now: @Sendable () -> Date
    private let sleep: @Sendable (TimeInterval) async throws -> Void
    private let pathMonitor = NWPathMonitor()

    init(resolver: OfflinePreferredResolver, cloud: CloudAccountStore, monitorNetwork: Bool = true,
         assetsCover: any AudioExportCoverProviding = YouTubeExportCover(), allowAssetNetwork: Bool? = nil,
         selectedLyrics: @escaping @Sendable (String) async -> LyricsDTO? = OfflineAssetsCoordinator.globalSelection,
         now: @escaping @Sendable () -> Date = { Date() },
         sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) }) {
        self.resolver = resolver; self.cloud = cloud
        self.assets = OfflineAssetsCoordinator(engine: resolver.engine, music: cloud.music, cover: assetsCover, selectedLyrics: selectedLyrics)
        self.allowAssetNetwork = allowAssetNetwork ?? monitorNetwork
        self.now = now; self.sleep = sleep
        assets.onUpdate = { [weak self] in Task { @MainActor [weak self] in await self?.refresh() } }
        cloud.$phase.combineLatest(cloud.$account.map { $0?.id }).sink { [weak self] phase, accountID in
            guard let self else { return }
            if accountID != self.cloud.account?.id || [.restoring, .authorizing, .expired, .secureStorageLocked].contains(phase) ||
                (phase == .signedOut && self.identity?.hasPrefix("account:") == true) {
                self.suspendAuthorization()
            } else { self.identityMayHaveChanged() }
        }.store(in: &subscriptions)
        cloud.$isMutating.dropFirst().sink { [weak self] _ in self?.identityMayHaveChanged() }.store(in: &subscriptions)
        cloud.$library.dropFirst().sink { [weak self] _ in
            Task { @MainActor [weak self] in await Task.yield(); await self?.reconcileCurrent() }
        }.store(in: &subscriptions)
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let available = path.status == .satisfied && (path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet))
            Task { @MainActor [weak self] in await self?.setWiFi(available) }
        }
        if monitorNetwork { pathMonitor.start(queue: DispatchQueue(label: "Aurelia.offline.network-path")) }
    }
    deinit { pathMonitor.cancel(); ownerTask?.cancel(); revocationTask?.cancel(); progressTask?.cancel(); authorizationTask?.cancel() }

    /// The account hook invokes this before sign-out awaits the server. Remove
    /// displayed metadata synchronously, then revoke native read admission.
    public func suspendAuthorization() {
        cancelAuthorizationDeadline()
        assets.activate(nil); assetCache = [:]; assetCacheOrder = []
        snapshot = nil; scope = nil; identity = nil; busy = false; message = nil
        progressTask?.cancel(); progressTask = nil; ownerTask?.cancel()
        let resolver = resolver
        revocationTask = Task { try? await resolver.activate(nil) }
        identityMayHaveChanged()
    }

    private func identityMayHaveChanged() {
        // Same-owner refreshes publish account/phase as well. Resolve the key
        // after assignment and retain that owner's scope, reads and downloads.
        epoch &+= 1; let ticket = epoch
        ownerTask?.cancel()
        let revocation = revocationTask
        ownerTask = Task { [weak self] in
            guard let self else { return }
            await revocation?.value
            await Task.yield()
            guard ticket == self.epoch, !Task.isCancelled else { return }
            // A sign-out in flight has already cleared scope. Library writes
            // retain an existing scope and cannot accidentally revoke it.
            if self.cloud.isMutating && self.scope == nil { return }
            let key = self.authorizedKey
            if key == self.identity, let scope = self.scope { self.scheduleAuthorizationDeadline(scope); return }
            self.snapshot = nil; self.scope = nil; self.identity = nil
            self.assets.activate(nil); self.assetCache = [:]; self.assetCacheOrder = []
            self.progressTask?.cancel(); self.progressTask = nil
            guard let key, let next = try? OfflineOwnerScope(ownerID: key) else {
                try? await self.resolver.activate(nil); return
            }
            do {
                try await self.resolver.activate(next)
                guard ticket == self.epoch, !Task.isCancelled else { return }
                self.scope = next; self.identity = key
                self.assets.activate(next)
                self.scheduleAuthorizationDeadline(next)
                try await self.resolver.engine.setEnvironment(foreground: self.foreground, onWiFi: self.onWiFi)
                await self.refresh()
                await self.reconcileCurrent()
            } catch { if ticket == self.epoch { self.message = "Offline storage could not be opened." } }
        }
    }
    private var authorizedKey: String? {
        if let id = cloud.authorizedOwnerID { return "account:" + id }
        return cloud.phase == .signedOut ? "guest" : nil
    }
    private var authorizedScope: OfflineOwnerScope? { identity == authorizedKey ? scope : nil }
    public var ownerRevision: UUID? { authorizedScope?.revision }
    private func cancelAuthorizationDeadline() {
        authorizationTask?.cancel(); authorizationTask = nil
        scheduledDeadline = nil; scheduledRevision = nil
    }
    private func scheduleAuthorizationDeadline(_ owner: OfflineOwnerScope) {
        guard identity?.hasPrefix("account:") == true else { cancelAuthorizationDeadline(); return }
        guard let deadline = cloud.authorizationExpiresAt else { revokeExpiredAuthorization(); return }
        guard scheduledDeadline != deadline || scheduledRevision != owner.revision || authorizationTask == nil else { return }
        cancelAuthorizationDeadline(); scheduledDeadline = deadline; scheduledRevision = owner.revision
        let sleep = sleep, now = now
        authorizationTask = Task { [weak self] in
            do {
                while !Task.isCancelled {
                    let delay = deadline.timeIntervalSince(now())
                    if delay <= 0 { break }
                    try await sleep(delay)
                }
            } catch { return }
            guard !Task.isCancelled, let self, self.scope == owner,
                  self.scheduledDeadline == deadline, self.scheduledRevision == owner.revision else { return }
            self.authorizationTask = nil
            // A real same-owner credential renewal may move the deadline.
            if self.cloud.authorizationExpiresAt != nil, self.identity == self.authorizedKey {
                self.scheduleAuthorizationDeadline(owner)
            } else { self.revokeExpiredAuthorization() }
        }
    }
    private func revokeExpiredAuthorization() {
        guard scope != nil, identity?.hasPrefix("account:") == true else { return }
        cancelAuthorizationDeadline(); epoch &+= 1
        ownerTask?.cancel(); ownerTask = nil; progressTask?.cancel(); progressTask = nil
        snapshot = nil; scope = nil; identity = nil; busy = false; message = nil
        assets.activate(nil); assetCache = [:]; assetCacheOrder = []
        let resolver = resolver
        revocationTask = Task { try? await resolver.activate(nil) }
        onAuthorizationRevoked?()
    }
    /// Commands enforce the current deadline even before a sleeping timer or
    /// suspended application has received CPU time to process its wakeup.
    private func currentOwner() -> OfflineOwnerScope? {
        guard let scope else { return nil }
        guard identity == authorizedKey else { revokeExpiredAuthorization(); return nil }
        return scope
    }
    public func isReadyForPlayback(expectedAccountID: String?) -> Bool {
        expectedAccountID == cloud.authorizedOwnerID && scope != nil && identity == authorizedKey
    }
    public func prepareForPlayback(expectedAccountID: String?) async -> Bool {
        let pending = ownerTask
        await pending?.value
        return !Task.isCancelled && isReadyForPlayback(expectedAccountID: expectedAccountID)
    }
    public var canManage: Bool { scope != nil && identity == authorizedKey }
    public func requireCurrentOwner(expectedRevision: UUID?) throws {
        guard let expectedRevision, let owner = currentOwner(), owner.revision == expectedRevision,
              identity == authorizedKey else { throw OfflineFailure.staleOwner }
    }
    public func copyForExport(_ track: TrackDTO, expectedRevision: UUID? = nil) async throws -> OfflineLocalCopy {
        try requireCurrentOwner(expectedRevision: expectedRevision)
        guard let owner = scope, track.provider == "youtube", track.id == "youtube:\(track.externalId)" else {
            throw OfflineFailure.invalidRequest
        }
        let entry = try PlaybackTrack(videoID: track.externalId, title: track.title, artist: track.artist, trackID: track.id)
        let copy = try await resolver.engine.openReady(entry, owner: owner)
        try requireCurrentOwner(expectedRevision: expectedRevision)
        guard copy.isValid else { throw OfflineFailure.staleOwner }
        return copy
    }
    public func item(for track: TrackDTO) -> OfflineItemSnapshot? { canManage ? snapshot?.items.first { $0.track.trackID == track.id } : nil }
    public func item(forTrackID id: String) -> OfflineItemSnapshot? { canManage ? snapshot?.items.first { $0.track.trackID == id } : nil }
    public func savedAssets(for trackID: String, expectedRevision: UUID?) async -> OfflineStoredAssets? {
        do {
            try requireCurrentOwner(expectedRevision: expectedRevision)
            guard let owner = currentOwner(), let item = snapshot?.items.first(where: { $0.track.trackID == trackID }), item.hasAssets else { return nil }
            if let cached = assetCache[item.id], cached.revision == item.assetsRevision { return cached }
            let value = try await resolver.engine.readAssets(item.id, owner: owner)
            try requireCurrentOwner(expectedRevision: expectedRevision)
            guard let value else { return nil }
            assetCache[item.id] = value; assetCacheOrder.removeAll { $0 == item.id }; assetCacheOrder.append(item.id)
            while assetCacheOrder.count > 24 { assetCache.removeValue(forKey: assetCacheOrder.removeFirst()) }
            return value
        } catch OfflineFailure.corrupt {
            // Core invalidates the optional marker while keeping audio ready.
            // Publish that change so a permitted finite pass can repair assets.
            await refresh(); return nil
        } catch { return nil }
    }
    public func savedLyrics(for track: TrackDTO, expectedRevision: UUID?) async -> LyricsDTO? {
        guard let stored = await savedAssets(for: track.id, expectedRevision: expectedRevision) else { return nil }
        return LyricsDTO.managed(trackName: track.title, artistName: track.artist, albumName: stored.payload.album,
            duration: stored.payload.duration, plainLyrics: stored.payload.plainLyrics, syncedLyrics: stored.payload.syncedLyrics)
    }
    public func saveLyrics(_ record: LyricsDTO, for track: TrackDTO, expectedRevision: UUID?) async -> Bool {
        do { try requireCurrentOwner(expectedRevision: expectedRevision) } catch { return false }
        guard let owner = currentOwner(), let snapshot else { return false }
        assets.register([track])
        let saved = await assets.storeLyrics(record, trackID: track.id, snapshot: snapshot, owner: owner)
        guard owner == currentOwner(), !Task.isCancelled else { return false }
        if let id = snapshot.items.first(where: { $0.track.trackID == track.id })?.id { assetCache.removeValue(forKey: id) }
        await refresh(); return saved
    }
    public func refresh() async {
        refreshGeneration &+= 1; let ticket = refreshGeneration
        guard let owner = currentOwner() else { snapshot = nil; return }
        do {
            var result = try await resolver.engine.snapshot(owner: owner)
            guard owner == currentOwner(), ticket == refreshGeneration else { return }
            let ids = Set(result.items.map { $0.track.trackID })
            assets.retainMetadata(for: ids, itemIDs: Set(result.items.map(\.id)))
            assets.register((cloud.library?.likes ?? []).filter { ids.contains($0.id) })
            for playlist in cloud.library?.playlists ?? [] { assets.register(playlist.tracks.filter { ids.contains($0.id) }) }
            if await assets.seedMetadata(result, owner: owner) {
                guard owner == currentOwner(), ticket == refreshGeneration, !Task.isCancelled else { return }
                result = try await resolver.engine.snapshot(owner: owner)
            }
            guard owner == currentOwner(), ticket == refreshGeneration else { return }
            let retained = Set(result.items.map(\.id)); assetCache = assetCache.filter { retained.contains($0.key) }
            snapshot = result
            let permitted = allowAssetNetwork && foreground && (!result.settings.wifiOnly || onWiFi)
            if !permitted { assets.cancelEnrichment() }
            else { assets.enrich(result, owner: owner, allowNetwork: true) }
        } catch { if owner == scope, ticket == refreshGeneration { message = "Offline storage is unavailable. Try again." } }
    }
    public func setForeground(_ active: Bool) async {
        foreground = active
        if !active { assets.stop() }
        if scope != nil && currentOwner() == nil { return }
        try? await resolver.engine.setEnvironment(foreground: active, onWiFi: onWiFi)
        if !active { progressTask?.cancel(); progressTask = nil }
        else { await resumeEnvironmentWaits(); startProgressUpdates() }
        await refresh()
    }
    private func setWiFi(_ available: Bool) async {
        onWiFi = available
        if !available && snapshot?.settings.wifiOnly != false { assets.stop() }
        if scope != nil && currentOwner() == nil { return }
        try? await resolver.engine.setEnvironment(foreground: foreground, onWiFi: available)
        if available { await resumeEnvironmentWaits(); startProgressUpdates() }
        await refresh()
    }
    private func resumeEnvironmentWaits() async {
        guard foreground, let owner = currentOwner() else { return }
        if let result = try? await resolver.engine.snapshot(owner: owner) {
            for item in result.items where item.state == .paused && (item.failure == .foregroundRequired || (onWiFi && item.failure == .waitingForWiFi)) {
                try? await resolver.engine.resume(item.id, owner: owner)
            }
        }
    }
    public func download(_ track: TrackDTO, expectedOwnerRevision: UUID) async {
        guard let owner = currentOwner(), owner.revision == expectedOwnerRevision, identity == authorizedKey,
              track.provider == "youtube", track.id == "youtube:\(track.externalId)",
              let entry = try? PlaybackTrack(videoID: track.externalId, title: track.title, artist: track.artist, trackID: track.id) else { return }
        assets.register([track])
        await operation(owner) { try await self.resolver.engine.enqueue(entry, owner: owner) }
    }
    public func pause(_ id: UUID) async {
        guard let owner = currentOwner() else { return }
        await operation(owner) { try await self.resolver.engine.pause(id, owner: owner) }
    }
    public func resume(_ id: UUID) async {
        guard let owner = currentOwner() else { return }
        await operation(owner) { try await self.resolver.engine.resume(id, owner: owner) }
    }
    public func restart(_ id: UUID) async {
        guard let owner = currentOwner() else { return }
        await operation(owner) { try await self.resolver.engine.restart(id, owner: owner) }
    }
    public func remove(_ id: UUID) async {
        guard let owner = currentOwner() else { return }
        await operation(owner) { try await self.resolver.engine.remove(id, owner: owner) }
    }
    public func pauseAll() async {
        guard let owner = currentOwner() else { return }
        for item in snapshot?.items ?? [] where item.state != .ready { try? await resolver.engine.pause(item.id, owner: owner) }
        await refresh()
    }
    public func resumeAll() async {
        guard let owner = currentOwner() else { return }
        for item in snapshot?.items ?? [] where item.state == .paused || item.state == .failed { try? await resolver.engine.resume(item.id, owner: owner) }
        await refresh(); startProgressUpdates()
    }
    public func setBudget(_ bytes: Int64) async {
        guard let owner = currentOwner(), let policy = try? OfflineStoragePolicy(budgetBytes: bytes) else { return }
        await operation(owner) { try await self.resolver.engine.setPolicy(policy, owner: owner) }
    }
    public func setSync(_ settings: OfflineSyncSettings) async {
        guard let owner = currentOwner() else { return }
        await operation(owner) { try await self.resolver.engine.reconcile(settings: settings, collections: self.collections(), owner: owner) }
    }
    private func reconcileCurrent() async {
        guard let owner = currentOwner(), let settings = snapshot?.settings, cloud.library != nil else { return }
        do {
            try await resolver.engine.reconcile(settings: settings, collections: collections(), owner: owner)
            await refresh(); startProgressUpdates()
        } catch { if owner == scope { message = "The selected collection exceeds the offline limits. Choose fewer playlists or increase storage." } }
    }
    private func collections() -> OfflineCollectionSnapshot {
        func entries(_ tracks: [TrackDTO]) -> [PlaybackTrack] {
            tracks.compactMap { track in
                guard track.provider == "youtube", track.id == "youtube:\(track.externalId)" else { return nil }
                return try? PlaybackTrack(videoID: track.externalId, title: track.title, artist: track.artist, trackID: track.id)
            }
        }
        let likes = entries(cloud.library?.likes ?? [])
        let playlists = Dictionary(uniqueKeysWithValues: (cloud.library?.playlists ?? []).map { ($0.id, entries($0.tracks)) })
        var seen = Set<String>()
        let all = (likes + playlists.values.flatMap { $0 }).filter { seen.insert($0.trackID).inserted }
        return OfflineCollectionSnapshot(library: all, likes: likes, playlists: playlists)
    }
    private func operation<T>(_ owner: OfflineOwnerScope, _ action: () async throws -> T) async {
        guard owner == currentOwner() else { return }
        busy = true; message = nil
        defer { if owner == scope { busy = false } }
        do { _ = try await action() }
        catch let error as OfflineFailure {
            guard owner == scope else { return }
            switch error {
            case .inUse: message = "This copy is in use. Clear the playback queue, then remove it."
            case .storageLimit: message = "The storage limit was reached. Increase the limit or remove saved copies."
            case .insufficientSpace: message = "Not enough free space on this device."
            case .identityChanged, .corrupt: message = "The saved partial cannot be resumed safely. Choose Restart download."
            default: message = "The offline operation could not be completed. Try again."
            }
        } catch { if owner == scope { message = "The offline operation could not be completed." } }
        await refresh(); startProgressUpdates()
    }
    private func startProgressUpdates() {
        guard progressTask == nil, foreground, scope != nil,
              snapshot?.settings.wifiOnly != true || onWiFi,
              snapshot?.items.contains(where: { [.queued, .resolving, .downloading, .verifying].contains($0.state) }) == true else { return }
        progressTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, !Task.isCancelled else { return }
                await self.refresh()
                guard self.foreground, self.snapshot?.items.contains(where: { [.queued, .resolving, .downloading, .verifying].contains($0.state) }) == true else { break }
            }
            self?.progressTask = nil
        }
    }
}
