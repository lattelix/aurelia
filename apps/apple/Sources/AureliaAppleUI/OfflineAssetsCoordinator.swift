import Foundation
import AureliaCloud
import AureliaPlaybackCore

/// One finite foreground pass, separate from audio transfer. Every optional
/// asset uses the same owner capability and a compare-and-swap payload revision.
@MainActor final class OfflineAssetsCoordinator {
    private let engine: ManagedOfflineEngine
    private let music: CloudMusicStore
    private let cover: any AudioExportCoverProviding
    private let selectedLyrics: @Sendable (String) async -> LyricsDTO?
    private var owner: OfflineOwnerScope?
    private var work: Task<Void, Never>?
    private var workID: UUID?
    private var generation = UUID()
    private var attempted = Set<UUID>()
    private var metadata: [String: TrackDTO] = [:]
    private var selections: [String: UUID] = [:]
    private var seeding = false
    var onUpdate: (@MainActor () -> Void)?

    init(engine: ManagedOfflineEngine, music: CloudMusicStore, cover: any AudioExportCoverProviding = YouTubeExportCover(),
         selectedLyrics: @escaping @Sendable (String) async -> LyricsDTO? = OfflineAssetsCoordinator.globalSelection) {
        self.engine = engine; self.music = music; self.cover = cover; self.selectedLyrics = selectedLyrics
    }
    deinit { work?.cancel() }
    nonisolated static func globalSelection(_ trackID: String) async -> LyricsDTO? {
        await LyricsSelectionCache.shared.selection(for: trackID)
    }
    func activate(_ next: OfflineOwnerScope?) {
        guard owner != next else { return }
        stop(); owner = next; attempted = []; metadata = [:]; selections = [:]
    }
    func stop() { work?.cancel(); generation = UUID() }
    func cancelEnrichment() { if let work, !work.isCancelled { stop() } }
    func retainMetadata(for trackIDs: Set<String>, itemIDs: Set<UUID>) {
        metadata = metadata.filter { trackIDs.contains($0.key) }
        attempted.formIntersection(itemIDs)
        selections = selections.filter { trackIDs.contains($0.key) }
    }
    func register(_ tracks: [TrackDTO]) {
        for track in tracks where track.provider == "youtube" && track.id == "youtube:" + track.externalId {
            guard track.album.utf16.count <= 500, !track.album.contains("://"),
                  !track.album.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { continue }
            guard metadata[track.id] != nil || metadata.count < 1000 else { continue }
            let previous = metadata[track.id]
            // A sparse library refresh must not erase richer metadata captured
            // by the user's Save offline action before its first index commit.
            let album = track.album.isEmpty ? previous?.album ?? "" : track.album
            let duration = track.duration > 0 ? track.duration : previous?.duration ?? 0
            metadata[track.id] = try? TrackDTO(id: track.id, title: track.title, artist: track.artist, album: album,
                provider: track.provider, externalId: track.externalId, duration: duration, artwork: track.artwork)
        }
    }
    @discardableResult func seedMetadata(_ snapshot: OfflineSnapshot, owner expected: OfflineOwnerScope) async -> Bool {
        let ticket = generation
        var changed = false
        guard expected == owner, !seeding else { return false }
        seeding = true
        defer {
            // A second refresh coalesces while this physical read/write pass
            // finishes. Keep the gate across cancellation/owner changes.
            seeding = false
            if changed || generation != ticket || owner != expected || Task.isCancelled { onUpdate?() }
        }
        for item in snapshot.items {
            guard admitted(expected, ticket), let track = metadata[item.track.trackID] else { continue }
            let album = track.album.isEmpty ? item.album : track.album
            let duration = track.duration > 0 ? track.duration : item.duration
            // The index already carries these metadata fields. Do not SHA/read
            // a thousand optional payloads again on every progress snapshot.
            guard item.album != album || item.duration != duration else { continue }
            do {
                let old: OfflineStoredAssets?
                do { old = try await engine.readAssets(item.id, owner: expected) }
                catch OfflineFailure.corrupt { old = nil }
                guard admitted(expected, ticket) else { return changed }
                if old?.payload.album == album, old?.payload.duration == duration { changed = true; continue }
                let payload = try OfflineAssetsPayload(album: album, duration: duration,
                    coverJPEG: old?.payload.coverJPEG, plainLyrics: old?.payload.plainLyrics,
                    syncedLyrics: old?.payload.syncedLyrics, enrichmentComplete: old?.payload.isEnriched ?? false)
                _ = try await engine.saveAssets(payload, for: item.id, owner: expected, expectedRevision: old?.revision ?? item.assetsRevision)
                changed = true
            } catch { /* Optional metadata never changes audio readiness. */ }
        }
        return changed
    }
    func enrich(_ snapshot: OfflineSnapshot, owner expected: OfflineOwnerScope, allowNetwork: Bool) {
        guard owner == expected, allowNetwork, work == nil else { return }
        // Persisted enrichment markers avoid cold-start refetches for completed
        // attempts, including sources which returned no optional cover or text.
        let ready = snapshot.items.filter { $0.state == .ready && !$0.assetsEnriched && !attempted.contains($0.id) }
        guard !ready.isEmpty else { return }
        let ticket = generation
        let jobID = UUID(); workID = jobID
        work = Task { [weak self] in
            guard let self else { return }
            defer {
                // Keep physical admission until a cancellation-ignoring cover
                // request actually returns; an owner switch cannot overlap it.
                if self.workID == jobID { self.work = nil; self.workID = nil; self.onUpdate?() }
            }
            for item in ready {
                guard self.admitted(expected, ticket) else { return }
                do {
                    let old: OfflineStoredAssets?
                    do { old = try await self.engine.readAssets(item.id, owner: expected) }
                    catch OfflineFailure.corrupt { old = nil }
                    guard self.admitted(expected, ticket) else { return }
                    if old?.payload.isEnriched == true { self.attempted.insert(item.id); continue }
                    let remote = self.metadata[item.track.trackID]
                    let savedAlbum = old?.payload.album ?? "", savedDuration = old?.payload.duration ?? 0
                    let album = savedAlbum.isEmpty ? remote?.album ?? item.album : savedAlbum
                    let duration = savedDuration > 0 ? savedDuration : remote?.duration ?? item.duration
                    var image = old?.payload.coverJPEG
                    if image == nil {
                        do { image = try await self.cover.jpeg(forVideoID: item.track.videoID) }
                        catch is CancellationError { return }
                        catch { image = nil }
                    }
                    guard self.admitted(expected, ticket) else { return }
                    let hasManagedText = Self.safeText(old?.payload.plainLyrics) != nil || Self.safeText(old?.payload.syncedLyrics) != nil
                    // Managed text includes explicit owner-local selections.
                    // A cold cover-enrichment pass must not replace that choice
                    // after the separate fifty-record cache has evicted it.
                    var lyrics: LyricsDTO?
                    if !hasManagedText { lyrics = await self.selectedLyrics(item.track.trackID) }
                    guard self.admitted(expected, ticket) else { return }
                    if !hasManagedText, lyrics == nil, duration > 0 {
                        let session = self.music.makeLyricsSession()
                        await session.search(String((item.track.title + " " + item.track.artist).prefix(200)))
                        guard self.admitted(expected, ticket) else { session.reset(); return }
                        let title = Self.normalized(item.track.title), artist = Self.normalized(item.track.artist)
                        let exact = session.records.filter {
                            !title.isEmpty && !artist.isEmpty && Self.normalized($0.trackName) == title &&
                            Self.normalized($0.artistName) == artist && abs($0.duration - duration) <= 3
                        }
                        if exact.count == 1 { lyrics = exact[0] }
                        session.reset()
                    }
                    guard self.admitted(expected, ticket) else { return }
                    let payload = try OfflineAssetsPayload(album: album, duration: duration,
                        coverJPEG: image.flatMap { $0.count <= 512 * 1024 ? $0 : nil },
                        plainLyrics: Self.safeText(lyrics?.plainLyrics) ?? old?.payload.plainLyrics,
                        syncedLyrics: Self.safeText(lyrics?.syncedLyrics) ?? old?.payload.syncedLyrics, enrichmentComplete: true)
                    _ = try await self.engine.saveAssets(payload, for: item.id, owner: expected, expectedRevision: old?.revision ?? item.assetsRevision)
                    guard self.admitted(expected, ticket) else { return }
                    self.attempted.insert(item.id); self.onUpdate?()
                } catch is CancellationError { return }
                catch {
                    guard self.admitted(expected, ticket) else { return }
                    // A concurrent user lyric choice wins its CAS. Never replace
                    // that payload using the older automatic enrichment result.
                    self.attempted.insert(item.id)
                }
            }
        }
    }
    func storeLyrics(_ record: LyricsDTO, trackID: String, snapshot: OfflineSnapshot, owner expected: OfflineOwnerScope) async -> Bool {
        let ticket = generation
        guard admitted(expected, ticket), let item = snapshot.items.first(where: { $0.track.trackID == trackID }),
              Self.safeText(record.plainLyrics) != nil || Self.safeText(record.syncedLyrics) != nil else { return false }
        let selection = UUID(); selections[trackID] = selection
        // One retry merges a user selection with a cover committed while its
        // first read was in flight. A new owner/generation never gets that retry.
        for _ in 0..<2 {
            do {
                let old: OfflineStoredAssets?
                do { old = try await engine.readAssets(item.id, owner: expected) }
                catch OfflineFailure.corrupt { old = nil }
                guard admitted(expected, ticket), selections[trackID] == selection else { return false }
                let remote = metadata[trackID]
                let payload = try OfflineAssetsPayload(album: old?.payload.album ?? remote?.album ?? item.album,
                    duration: old?.payload.duration ?? remote?.duration ?? item.duration, coverJPEG: old?.payload.coverJPEG,
                    plainLyrics: Self.safeText(record.plainLyrics), syncedLyrics: Self.safeText(record.syncedLyrics),
                    enrichmentComplete: old?.payload.isEnriched ?? false)
                _ = try await engine.saveAssets(payload, for: item.id, owner: expected, expectedRevision: old?.revision ?? item.assetsRevision)
                guard admitted(expected, ticket), selections[trackID] == selection else { return false }
                onUpdate?(); return true
            } catch OfflineFailure.staleOwner {
                guard admitted(expected, ticket), selections[trackID] == selection else { return false }
            } catch { return false }
        }
        return false
    }
    private func admitted(_ expected: OfflineOwnerScope, _ ticket: UUID) -> Bool {
        owner == expected && generation == ticket && !Task.isCancelled
    }
    private static func safeText(_ value: String?) -> String? {
        guard let value, !value.isEmpty, value.utf16.count <= 100_000,
              !value.contains("://"), !value.unicodeScalars.contains(where: { $0.value == 0 }) else { return nil }
        return value
    }
    private static func normalized(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.joined(separator: " ")
    }
}
