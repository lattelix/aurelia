import Foundation
import CryptoKit

/// App-private managed copies, completely separate from the streaming RAM
/// cache. No timers, automatic retries, background-session promises, exports,
/// credentials or signed locators are persisted by this foreground engine.
public actor ManagedOfflineEngine {
    private let root: URL
    private let resolver: any PlaybackResolving
    private let transport: any YouTubeHTTPTransport
    private let availableSpace: @Sendable (URL) -> Int64
    private var defaultPolicy: OfflineStoragePolicy
    private var owner: OfflineOwnerScope?
    private var index: OfflineIndex?
    private var directory: URL?
    private var admission = OfflineReadAdmission()
    private var reads: [UUID: [OfflineWeakCopy]] = [:]
    private var foreground = false
    private var wifi = false
    private var job: Task<Void, Never>?
    private var jobID: UUID?
    private var jobRecordID: UUID?
    private var byteSource: GuardedYouTubeByteSource?

    public init(rootDirectory: URL, resolver: any PlaybackResolving, policy: OfflineStoragePolicy,
                transport: any YouTubeHTTPTransport = BoundedYouTubeHTTP(),
                availableSpace: (@Sendable (URL) -> Int64)? = nil) throws {
        try OfflineFiles.prepareDirectory(rootDirectory)
        root = rootDirectory.standardizedFileURL; self.resolver = resolver; defaultPolicy = policy
        self.transport = transport; self.availableSpace = availableSpace ?? { OfflineFiles.freeBytes($0) }
    }

    /// Activating an owner never starts audio or retries interrupted downloads.
    /// A new revision revokes every previously issued local read capability.
    public func activateOwner(_ next: OfflineOwnerScope?) throws {
        if owner == next { return }
        cancelJob(); admission.invalidate(); admission = OfflineReadAdmission(); reads.removeAll()
        owner = nil; index = nil; directory = nil
        guard let next else { return }
        let hash = OfflineFiles.ownerHash(next.ownerID)
        let path = root.appendingPathComponent(hash, isDirectory: true)
        try OfflineFiles.prepareDirectory(path)
        let indexURL = path.appendingPathComponent("index.json")
        var loaded: OfflineIndex
        if FileManager.default.fileExists(atPath: indexURL.path) {
            guard try OfflineFiles.size(indexURL, root: path) <= OfflineFiles.maximumIndexBytes else { throw OfflineFailure.corrupt }
            do { loaded = try JSONDecoder().decode(OfflineIndex.self, from: Data(contentsOf: indexURL)) }
            catch { throw OfflineFailure.corrupt }
            try Self.validateIndex(loaded, ownerHash: hash)
        } else { loaded = OfflineIndex(ownerHash: hash, policy: defaultPolicy) }
        try pruneAssetStages(loaded, directory: path)
        for position in loaded.records.indices {
            var record = loaded.records[position]
            if record.state == .ready || record.state == .verifying {
                let final = file(record.id, extension: "m4a", in: path)
                if let total = record.totalBytes, let checksum = record.checksum,
                   (try? OfflineFiles.validateReady(final, root: path, length: total, checksum: checksum)) != nil {
                    record.state = .ready; record.failure = nil; record.receivedBytes = total
                } else { record.state = .failed; record.failure = .corrupt }
            } else if [.queued, .resolving, .downloading].contains(record.state) {
                record.state = .paused; record.failure = .foregroundRequired
            }
            loaded.records[position] = record
        }
        try OfflineFiles.write(loaded, directory: path)
        owner = next; index = loaded; directory = path
    }

    public func snapshot(owner expected: OfflineOwnerScope) throws -> OfflineSnapshot {
        let current = try checked(expected)
        return OfflineSnapshot(items: current.records.map(\.snapshot), usedBytes: try OfflineFiles.usedBytes(root),
                               freeBytes: max(0, availableSpace(root)), policy: current.policy, settings: current.settings)
    }

    public func setPolicy(_ policy: OfflineStoragePolicy, owner expected: OfflineOwnerScope) throws {
        _ = try checked(expected); index?.policy = policy; try persist(); pump()
    }

    /// The platform bridge reports lifecycle and current Wi-Fi. Unknown Wi-Fi
    /// is false. Leaving foreground pauses physical work without claiming an
    /// OS-managed background download will continue after process death.
    public func setEnvironment(foreground: Bool, onWiFi: Bool) throws {
        self.foreground = foreground; wifi = onWiFi
        guard index != nil else { return }
        if !foreground || (index?.settings.wifiOnly == true && !onWiFi) {
            if let id = jobRecordID, let position = index?.records.firstIndex(where: { $0.id == id }),
               index?.records[position].state != .ready {
                index?.records[position].state = .paused
                index?.records[position].failure = !foreground ? .foregroundRequired : .waitingForWiFi
            }
            cancelJob(); try persist()
        } else { pump() }
    }

    @discardableResult
    public func enqueue(_ track: PlaybackTrack, owner expected: OfflineOwnerScope) throws -> UUID {
        let current = try checked(expected); try Self.validateTrack(track)
        if let position = current.records.firstIndex(where: { $0.track.videoID == track.videoID }) {
            index?.records[position].manual = true
            index?.suppressedVideoIDs.removeAll { $0 == track.videoID }
            try persist(); pump(); return current.records[position].id
        }
        guard current.records.count < OfflineStoragePolicy.maximumRecords else { throw OfflineFailure.storageLimit }
        let id = UUID()
        index?.records.append(OfflineRecord(id: id, track: track, manual: true))
        index?.suppressedVideoIDs.removeAll { $0 == track.videoID }
        try persist(); pump(); return id
    }

    public func pause(_ id: UUID, owner expected: OfflineOwnerScope) throws {
        let position = try recordPosition(id, owner: expected)
        guard index?.records[position].state != .ready else { return }
        index?.records[position].state = .paused; index?.records[position].failure = nil
        index?.records[position].selectionPaused = false
        if jobRecordID == id { cancelJob() }
        try persist(); pump()
    }

    public func resume(_ id: UUID, owner expected: OfflineOwnerScope) throws {
        let position = try recordPosition(id, owner: expected)
        guard let record = index?.records[position], record.state != .ready else { return }
        guard record.failure != .identityChanged, record.failure != .corrupt else {
            throw record.failure ?? .corrupt
        }
        guard ![.queued, .resolving, .downloading, .verifying].contains(record.state) else { return }
        index?.records[position].state = .queued; index?.records[position].failure = nil
        index?.records[position].selectionPaused = false
        try persist(); pump()
    }

    /// Changed identity and damaged partials require this explicit destructive
    /// restart; a normal resume never appends bytes from a different recording.
    public func restart(_ id: UUID, owner expected: OfflineOwnerScope) throws {
        let position = try recordPosition(id, owner: expected)
        try ensureNotReading(id)
        if jobRecordID == id { cancelJob() }
        try deleteFiles(id)
        index?.records[position].receivedBytes = 0; index?.records[position].totalBytes = nil
        index?.records[position].checksum = nil; index?.records[position].sourceFingerprint = nil
        index?.records[position].state = .queued; index?.records[position].failure = nil
        index?.records[position].selectionPaused = false
        try persist(); pump()
    }

    public func remove(_ id: UUID, owner expected: OfflineOwnerScope) throws {
        let position = try recordPosition(id, owner: expected)
        try ensureNotReading(id)
        if jobRecordID == id { cancelJob() }
        let video = index!.records[position].track.videoID
        let wasSelected = !index!.records[position].selectedScopes.isEmpty
        // Remove metadata only after owned file deletion succeeds. A failed
        // write/deletion is visible and never touches source files or exports.
        try deleteFiles(id, includingAssets: true)
        index?.records.remove(at: position)
        if wasSelected, index?.suppressedVideoIDs.contains(video) == false { index?.suppressedVideoIDs.append(video) }
        try persist(); pump()
    }

    /// Ready copies survive deselection/disable. Unfinished managed jobs pause,
    /// manual copies remain pinned, and intersecting scopes deduplicate by the
    /// immutable YouTube recording ID. This method does not mutate cloud data.
    public func reconcile(settings: OfflineSyncSettings, collections: OfflineCollectionSnapshot,
                          owner expected: OfflineOwnerScope) throws {
        let current = try checked(expected); try settings.validate()
        var selected: [String: (PlaybackTrack, [String])] = [:]
        func select(_ tracks: [PlaybackTrack], scope: String) throws {
            guard tracks.count <= OfflineStoragePolicy.maximumRecords else { throw OfflineFailure.storageLimit }
            for track in tracks {
                guard track.provider == .youtube else { continue }
                try Self.validateTrack(track)
                if var existing = selected[track.videoID] {
                    if !existing.1.contains(scope) { existing.1.append(scope) }; selected[track.videoID] = existing
                } else { selected[track.videoID] = (track, [scope]) }
            }
        }
        if settings.enabled {
            switch settings.scope {
            case .library: try select(collections.library, scope: "library")
            case .likes: try select(collections.likes, scope: "likes")
            case .playlists:
                for id in settings.playlistIDs { try select(collections.playlists[id] ?? [], scope: "playlist:" + id) }
            }
        }
        guard selected.count <= OfflineStoragePolicy.maximumRecords else { throw OfflineFailure.storageLimit }
        let existing = Set(current.records.map { $0.track.videoID })
        let additional = selected.keys.filter { !existing.contains($0) && !current.suppressedVideoIDs.contains($0) }
        guard current.records.count + additional.count <= OfflineStoragePolicy.maximumRecords else { throw OfflineFailure.storageLimit }
        index?.settings = settings
        // Disabling does not forget an explicit removal. Only absence from an
        // enabled collection clears its tombstone for a later re-addition.
        if settings.enabled { index?.suppressedVideoIDs.removeAll { selected[$0] == nil } }
        for position in current.records.indices {
            let record = current.records[position]
            let scopes = selected[record.track.videoID]?.1.sorted() ?? []
            index?.records[position].selectedScopes = scopes
            if scopes.isEmpty && !record.manual && [.queued, .resolving, .downloading].contains(record.state) {
                index?.records[position].state = .paused; index?.records[position].failure = nil
                index?.records[position].selectionPaused = true
                if jobRecordID == record.id { cancelJob() }
            } else if !scopes.isEmpty && record.selectionPaused {
                index?.records[position].state = .queued; index?.records[position].failure = nil
                index?.records[position].selectionPaused = false
            }
        }
        for video in additional.sorted() {
            guard let entry = selected[video] else { continue }
            var record = OfflineRecord(id: UUID(), track: entry.0, manual: false)
            record.selectedScopes = entry.1.sorted(); index?.records.append(record)
        }
        try persist()
        if settings.wifiOnly && !wifi { try setEnvironment(foreground: foreground, onWiFi: wifi) }
        else { pump() }
    }

    /// Cache-only resolution. Missing, corrupt or wrong-owner copies return a
    /// fixed failure and never invoke the network resolver as a fallback.
    public func openReady(_ track: PlaybackTrack, owner expected: OfflineOwnerScope) throws -> OfflineLocalCopy {
        let current = try checked(expected)
        guard let record = current.records.first(where: { $0.track.videoID == track.videoID }) else { throw OfflineFailure.notReady }
        if record.failure == .corrupt || record.failure == .identityChanged { throw record.failure! }
        guard record.state == .ready, let total = record.totalBytes, let checksum = record.checksum,
              let directory else { throw OfflineFailure.notReady }
        let url = file(record.id, extension: "m4a", in: directory)
        do { try OfflineFiles.validateReady(url, root: directory, length: total, checksum: checksum) }
        catch {
            if let position = index?.records.firstIndex(where: { $0.id == record.id }) {
                index?.records[position].state = .failed; index?.records[position].failure = .corrupt; try persist()
            }
            throw OfflineFailure.corrupt
        }
        let copy = OfflineLocalCopy(videoID: record.track.videoID, contentLength: total, url: url,
                                    root: directory, checksum: checksum, admission: admission)
        reads[record.id, default: []].removeAll { $0.value == nil }
        reads[record.id, default: []].append(OfflineWeakCopy(copy)); return copy
    }

    /// Asset readiness is independent of audio readiness. A late cover/lyrics
    /// response must compare its prior revision rather than overwrite a newer
    /// user selection. nil is accepted only for an item with no previous assets.
    @discardableResult
    public func saveAssets(_ payload: OfflineAssetsPayload, for id: UUID, owner expected: OfflineOwnerScope,
                           expectedRevision: UUID?) throws -> UUID {
        let position = try recordPosition(id, owner: expected)
        guard let directory, let current = index,
              current.records[position].assetsRevision == expectedRevision else { throw OfflineFailure.staleOwner }
        let data = try OfflineAssetsCodec.encode(payload)
        let headroom = Int64(OfflineFiles.maximumIndexBytes)
        guard try OfflineFiles.usedBytes(root) + Int64(data.count) + headroom <= current.policy.budgetBytes else { throw OfflineFailure.storageLimit }
        guard availableSpace(root) >= Int64(data.count) + headroom + current.policy.reserveBytes else { throw OfflineFailure.insufficientSpace }
        let prior = current.records[position], revision = UUID()
        let oldURL = assetURL(prior, in: directory)
        let url = file(id, extension: revision.uuidString.lowercased() + ".assets.json", in: directory)
        try OfflineFiles.checkedFile(url, root: directory, allowMissing: true)
        do {
            try data.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            index?.records[position].album = payload.album; index?.records[position].duration = payload.duration
            index?.records[position].assetsChecksum = OfflineFiles.hash(data); index?.records[position].assetsRevision = revision
            index?.records[position].assetsEnriched = payload.isEnriched
            do { try persist() } catch { index?.records[position] = prior; throw error }
        } catch {
            try? FileManager.default.removeItem(at: url)
            throw (error as? OfflineFailure) ?? .storage
        }
        // A crash before index commit leaves only an unreferenced new file;
        // after commit it leaves only an unreferenced old file. Startup prunes
        // both without ever replacing the previous committed payload in place.
        if let oldURL, oldURL != url { try? FileManager.default.removeItem(at: oldURL) }
        return revision
    }

    public func readAssets(_ id: UUID, owner expected: OfflineOwnerScope) throws -> OfflineStoredAssets? {
        let position = try recordPosition(id, owner: expected)
        guard let directory, let record = index?.records[position],
              let checksum = record.assetsChecksum, let revision = record.assetsRevision else { return nil }
        do {
            guard let url = assetURL(record, in: directory),
                  try OfflineFiles.size(url, root: directory) <= OfflineAssetsCodec.maximumBytes else { throw OfflineFailure.corrupt }
            let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
            let data = try handle.read(upToCount: OfflineAssetsCodec.maximumBytes + 1) ?? Data()
            guard data.count <= OfflineAssetsCodec.maximumBytes, OfflineFiles.hash(data) == checksum else { throw OfflineFailure.corrupt }
            let payload = try OfflineAssetsCodec.decode(data)
            if record.assetsEnriched != payload.isEnriched {
                index?.records[position].assetsEnriched = payload.isEnriched; try? persist()
            }
            return OfflineStoredAssets(payload: payload, revision: revision)
        } catch {
            index?.records[position].assetsEnriched = false; try? persist()
            throw (error as? OfflineFailure) ?? .corrupt
        }
    }

    private func checked(_ expected: OfflineOwnerScope) throws -> OfflineIndex {
        guard owner == expected, let index else { throw OfflineFailure.staleOwner }; return index
    }
    private func recordPosition(_ id: UUID, owner expected: OfflineOwnerScope) throws -> Int {
        guard let position = try checked(expected).records.firstIndex(where: { $0.id == id }) else { throw OfflineFailure.invalidRequest }
        return position
    }
    private func persist() throws {
        guard let index, let directory else { throw OfflineFailure.staleOwner }
        do { try OfflineFiles.write(index, directory: directory) }
        catch let failure as OfflineFailure { throw failure }
        catch { throw OfflineFailure.storage }
    }
    private func file(_ id: UUID, extension suffix: String, in directory: URL) -> URL {
        directory.appendingPathComponent(id.uuidString.lowercased() + "." + suffix)
    }
    private func assetURL(_ record: OfflineRecord, in directory: URL) -> URL? {
        guard let revision = record.assetsRevision else { return nil }
        let current = file(record.id, extension: revision.uuidString.lowercased() + ".assets.json", in: directory)
        if FileManager.default.fileExists(atPath: current.path) { return current }
        // Compatibility with the first optional-assets index format.
        return file(record.id, extension: "assets.json", in: directory)
    }
    private func pruneAssetStages(_ loaded: OfflineIndex, directory: URL) throws {
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        guard files.count <= OfflineStoragePolicy.maximumRecords * 3 + 8 else { throw OfflineFailure.storageLimit }
        let keep = Set(loaded.records.compactMap { record -> String? in
            guard let revision = record.assetsRevision else { return nil }
            let name = record.id.uuidString.lowercased() + "." + revision.uuidString.lowercased() + ".assets.json"
            if FileManager.default.fileExists(atPath: directory.appendingPathComponent(name).path) { return name }
            return record.id.uuidString.lowercased() + ".assets.json"
        })
        for url in files {
            let name = url.lastPathComponent
            var ownedStage = false
            if name.hasSuffix(".index.tmp") {
                ownedStage = UUID(uuidString: String(name.dropLast(".index.tmp".count))) != nil
            } else if name.hasSuffix(".assets.json") {
                let pieces = name.dropLast(".assets.json".count).split(separator: ".")
                ownedStage = (1...2).contains(pieces.count) && pieces.allSatisfy { UUID(uuidString: String($0)) != nil }
            }
            if ownedStage && !keep.contains(name) {
                try OfflineFiles.checkedFile(url, root: directory)
                try FileManager.default.removeItem(at: url)
            }
        }
    }
    private func ensureNotReading(_ id: UUID) throws {
        reads[id]?.removeAll { $0.value == nil }
        guard reads[id]?.isEmpty ?? true else { throw OfflineFailure.inUse }
    }
    private func deleteFiles(_ id: UUID, includingAssets: Bool = false) throws {
        guard let directory else { throw OfflineFailure.staleOwner }
        let revision = index?.records.first(where: { $0.id == id })?.assetsRevision
        let assetSuffixes = includingAssets ? ["assets.json"] + (revision.map { [$0.uuidString.lowercased() + ".assets.json"] } ?? []) : []
        for suffix in ["partial", "m4a"] + assetSuffixes {
            let url = file(id, extension: suffix, in: directory)
            try OfflineFiles.checkedFile(url, root: directory, allowMissing: true)
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        }
    }
    private func cancelJob() {
        job?.cancel()
        if let byteSource { Task { await byteSource.invalidate() } }
        // The physical admission slot is retained until an uncooperative
        // resolver/transport returns. No second transfer is started meanwhile.
    }
    private func pump() {
        guard job == nil, foreground, let owner, let index else { return }
        guard !index.settings.wifiOnly || wifi else { return }
        guard let next = index.records.first(where: { $0.state == .queued }) else { return }
        let token = UUID(); jobID = token; jobRecordID = next.id
        job = Task { await self.download(next.id, owner: owner, token: token) }
    }
    private func currentPosition(_ id: UUID, owner expected: OfflineOwnerScope, token: UUID) throws -> Int {
        try Task.checkCancellation()
        guard jobID == token, jobRecordID == id, foreground else { throw CancellationError() }
        let position = try recordPosition(id, owner: expected)
        guard let state = index?.records[position].state, [.queued, .resolving, .downloading, .verifying].contains(state) else {
            throw CancellationError()
        }
        return position
    }
    private func download(_ id: UUID, owner expected: OfflineOwnerScope, token: UUID) async {
        defer {
            if jobID == token { job = nil; jobID = nil; jobRecordID = nil; byteSource = nil; pump() }
        }
        do {
            var position = try currentPosition(id, owner: expected, token: token)
            index?.records[position].state = .resolving; index?.records[position].failure = nil; try persist()
            let source = try await resolver.resolve(index!.records[position].track)
            position = try currentPosition(id, owner: expected, token: token)
            guard let lease = source.youtubeLease,
                  lease.requestedVideoID == index?.records[position].track.videoID,
                  let policy = index?.policy,
                  let directory else { throw OfflineFailure.unavailable }
            guard lease.contentLength <= policy.maximumFileBytes else { throw OfflineFailure.storageLimit }
            let fingerprint = try OfflineFiles.sourceFingerprint(lease)
            var record = index!.records[position]
            guard record.sourceFingerprint == nil || (record.sourceFingerprint == fingerprint && record.totalBytes == lease.contentLength) else {
                throw OfflineFailure.identityChanged
            }
            let used = try OfflineFiles.usedBytes(root)
            let remaining = Int64(lease.contentLength - record.receivedBytes)
            let indexHeadroom = Int64(OfflineFiles.maximumIndexBytes)
            guard used + remaining + indexHeadroom <= policy.budgetBytes else { throw OfflineFailure.storageLimit }
            guard availableSpace(root) >= remaining + policy.reserveBytes + indexHeadroom else { throw OfflineFailure.insufficientSpace }
            let partial = file(id, extension: "partial", in: directory)
            try OfflineFiles.checkedFile(partial, root: directory, allowMissing: true)
            if !FileManager.default.fileExists(atPath: partial.path) {
                guard record.receivedBytes == 0,
                      FileManager.default.createFile(atPath: partial.path, contents: Data(), attributes: [.posixPermissions: 0o600]) else {
                    throw OfflineFailure.corrupt
                }
            }
            var hasher = try OfflineFiles.prefixHasher(partial, root: directory, length: record.receivedBytes,
                                                      checksum: record.checksum, discardUncommittedTail: true)
            record.sourceFingerprint = fingerprint; record.totalBytes = lease.contentLength
            record.state = .downloading; index?.records[position] = record; try persist()
            let guarded = GuardedYouTubeByteSource(lease: lease, transport: transport)
            byteSource = guarded
            let handle = try FileHandle(forWritingTo: partial)
            defer { try? handle.close(); Task { await guarded.invalidate() } }
            try handle.seek(toOffset: UInt64(record.receivedBytes))
            while record.receivedBytes < lease.contentLength {
                let start = record.receivedBytes
                let end = min(lease.contentLength - 1, start + GuardedYouTubeByteSource.maximumChunkBytes - 1)
                let bytes = try await guarded.read(start...end)
                position = try currentPosition(id, owner: expected, token: token)
                // Metadata/manual pins may have changed while I/O was in
                // flight. Only merge progress into the currently owned record.
                record = index!.records[position]
                guard availableSpace(root) >= Int64(bytes.count) + index!.policy.reserveBytes + indexHeadroom else { throw OfflineFailure.insufficientSpace }
                guard try OfflineFiles.usedBytes(root) + Int64(bytes.count) + indexHeadroom <= index!.policy.budgetBytes else { throw OfflineFailure.storageLimit }
                try OfflineFiles.checkedFile(partial, root: directory)
                try handle.write(contentsOf: bytes); try handle.synchronize()
                hasher.update(data: bytes); record.receivedBytes += bytes.count
                let checkpointHash = hasher
                record.checksum = OfflineFiles.hex(checkpointHash.finalize())
                index?.records[position] = record; try persist()
            }
            record.state = .verifying; index?.records[position] = record; try persist()
            guard let checksum = record.checksum else { throw OfflineFailure.corrupt }
            _ = try OfflineFiles.prefixHasher(partial, root: directory, length: lease.contentLength, checksum: checksum)
            try OfflineFiles.validateM4A(partial, length: lease.contentLength)
            _ = try currentPosition(id, owner: expected, token: token)
            let final = file(id, extension: "m4a", in: directory)
            try OfflineFiles.checkedFile(final, root: directory, allowMissing: true)
            guard !FileManager.default.fileExists(atPath: final.path) else { throw OfflineFailure.corrupt }
            try handle.close()
            // Same-directory rename publishes only a fully checked complete file.
            try FileManager.default.moveItem(at: partial, to: final)
            record.state = .ready; record.failure = nil; index?.records[position] = record; try persist()
        } catch is CancellationError {
            // The command that cancelled this job already persisted its state.
        } catch {
            guard owner == expected, jobID == token,
                  let position = index?.records.firstIndex(where: { $0.id == id }),
                  index?.records[position].state != .paused else { return }
            index?.records[position].state = .failed
            index?.records[position].failure = Self.safeFailure(error)
            try? persist()
        }
    }
    private static func safeFailure(_ error: Error) -> OfflineFailure {
        if let failure = error as? OfflineFailure { return failure }
        if let failure = error as? PlaybackFailure {
            switch failure {
            case .network: return .network
            case .expired: return .expired
            case .sourceDenied: return .sourceDenied
            default: return .unavailable
            }
        }
        return .storage
    }
    private static func validateTrack(_ track: PlaybackTrack) throws {
        guard track.provider == .youtube,
              track.videoID.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil,
              track.title.count <= 500, track.artist.count <= 500,
              track.trackID == "youtube:" + track.videoID,
              [track.title, track.artist].allSatisfy({ text in
                  !text.contains("://") && !text.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
              }) else { throw OfflineFailure.invalidRequest }
    }
    private static func validateIndex(_ index: OfflineIndex, ownerHash: String) throws {
        guard index.version == 1, index.ownerHash == ownerHash,
              index.records.count <= OfflineStoragePolicy.maximumRecords,
              Set(index.records.map(\.id)).count == index.records.count,
              Set(index.records.map { $0.track.videoID }).count == index.records.count,
              index.suppressedVideoIDs.count <= OfflineStoragePolicy.maximumRecords,
              Set(index.suppressedVideoIDs).count == index.suppressedVideoIDs.count,
              index.suppressedVideoIDs.allSatisfy({ $0.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil }) else {
            throw OfflineFailure.corrupt
        }
        _ = try OfflineStoragePolicy(budgetBytes: index.policy.budgetBytes, reserveBytes: index.policy.reserveBytes,
                                     maximumFileBytes: index.policy.maximumFileBytes)
        try index.settings.validate()
        for record in index.records {
            try validateTrack(record.track)
            guard record.receivedBytes >= 0, record.receivedBytes <= 128 * 1024 * 1024,
                  record.totalBytes.map({ $0 > 0 && $0 <= 128 * 1024 * 1024 && record.receivedBytes <= $0 }) ?? (record.receivedBytes == 0),
                  record.checksum.map(OfflineFiles.validHash) ?? (record.receivedBytes == 0),
                  record.sourceFingerprint.map(OfflineFiles.validHash) ?? (record.totalBytes == nil),
                  record.selectedScopes.count <= 100,
                  record.selectedScopes.allSatisfy({ $0.utf8.count <= 180 }),
                  record.album.map({ $0.utf16.count <= 500 && !$0.contains("://") && !$0.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) }) ?? true,
                  record.duration.map({ $0.isFinite && (0...86400).contains($0) }) ?? true,
                  record.assetsChecksum.map(OfflineFiles.validHash) ?? true,
                  (record.assetsChecksum == nil) == (record.assetsRevision == nil) else { throw OfflineFailure.corrupt }
        }
    }
}
