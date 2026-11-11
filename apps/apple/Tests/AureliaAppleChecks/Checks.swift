import Foundation
import AureliaAppleUI
import AureliaPlaybackCore
import Darwin

private enum CheckFailure: Error { case failed(String) }
private func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw CheckFailure.failed(message) }
}
@MainActor private func eventually(_ predicate: () -> Bool) async throws {
    for _ in 0..<200 {
        if predicate() { return }
        try await Task.sleep(for: .milliseconds(5))
    }
    throw CheckFailure.failed("state deadline")
}

/// No AVFoundation import or AVPlayer/AVAudioSession creation in this executable.
@MainActor private final class MockDriver: PlaybackDriving {
    var onEvent: (@MainActor (UInt64, PlaybackDriverEvent) -> Void)?
    var operations: [String] = []
    var volumes: [Float] = []
    var generation: UInt64 = 0
    var loaded: [PlaybackTrack] = []
    var plays = 0
    var seeks: [Double] = []
    func load(_ source: ResolvedAudio, track: PlaybackTrack, generation: UInt64) throws {
        try check(source.isPlayable, "source validation")
        self.generation = generation; loaded.append(track); operations.append("load")
    }
    func setVolume(_ value: Float) { volumes.append(value); operations.append("volume") }
    func play() { plays += 1; operations.append("play") }
    func pause() { operations.append("pause") }
    func seek(to value: Double) { seeks.append(value) }
    func stop() { operations.append("stop") }
    func dispose() { operations.append("dispose") }
    func emit(_ event: PlaybackDriverEvent) { onEvent?(generation, event) }
}

@main private struct Checks {
    @MainActor static func main() async {
        let checks: [(String, @MainActor () async throws -> Void)] = [
            ("catalogue_and_bundled_sources", catalogue),
            ("bundled_path_boundary", boundaries),
            ("legacy_and_studio_track_contract", tracks),
            ("local_profile_validation", profile),
            ("silent_restore_and_persistence", restore),
            ("queue_controls_and_failure_regression", queue),
            ("empty_player_requires_explicit_selection", emptyPlayer),
            ("model_queue_edits_and_stale_revision", queueEdits),
            ("forced_mute_every_operation", forcedMute)
        ] + NativeYouTubeModelChecks.cases + QueueParityChecks.cases + RecorderPaletteChecks.cases + AssetsBridgeChecks.cases + AudioExportChecks.cases + VolumeControlChecks.cases
        for (name, operation) in checks {
            do { try await operation(); print("PASS \(name)") }
            catch { print("FAIL \(name): \(error)"); exit(1) }
        }
        print("Apple checks passed: \(checks.count). Playback uses mock drivers; native AVFoundation export fixtures are checked without playback or GUI.")
    }

    @MainActor static func catalogue() async throws {
        try check(StudioCatalogue.tracks.count == 12, "original track count")
        try check(Set(StudioCatalogue.tracks.map(\.id)).count == 12, "unique ids")
        try check(StudioCatalogue.search(" ambient ").count == 3, "genre search trims whitespace")
        try check(StudioCatalogue.search("GOLDEN HOUR").count == 1, "case insensitive title search")
        try check(StudioCatalogue.search("nonexistent").isEmpty, "empty search result")
        for track in StudioCatalogue.tracks {
            let source = try await StudioResolver().resolve(track.queueEntry())
            try check(source.url.isFileURL && source.isPlayable, "bundled source")
            try check(!ResolvedAudio.isAllowed(source.url), "remote boundary not relaxed")
            let data = try Data(contentsOf: source.url)
            try check(data.count > 100_000 && data.count < 8_000_000, "bounded bundled recording")
            try check(StudioCatalogue.artworkURL(track.albumID) != nil, "bundled original artwork")
        }
    }
    @MainActor static func boundaries() async throws {
        let fm = FileManager.default
        let scratch = fm.temporaryDirectory.appendingPathComponent("aurelia-boundary-\(UUID().uuidString)")
        let bundleURL = scratch.appendingPathComponent("Fixture.bundle")
        let resources = bundleURL.appendingPathComponent("Contents/Resources")
        try fm.createDirectory(at: resources, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: scratch) }
        let plist: [String: String] = ["CFBundleIdentifier": "com.lattelix.aurelia.boundary", "CFBundlePackageType": "BNDL"]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            .write(to: bundleURL.appendingPathComponent("Contents/Info.plist"))
        guard let bundle = Bundle(url: bundleURL) else { throw CheckFailure.failed("fixture bundle") }
        let valid = resources.appendingPathComponent("original.mp3")
        let outside = scratch.appendingPathComponent("outside.mp3")
        let wrong = resources.appendingPathComponent("image.png")
        try Data([0]).write(to: valid); try Data([0]).write(to: outside); try Data([0]).write(to: wrong)
        let inside = try ResolvedAudio.bundled(valid, in: bundle)
        try check(inside.isPlayable, "inside bundle accepted")
        let link = resources.appendingPathComponent("escape.mp3")
        try fm.createSymbolicLink(at: link, withDestinationURL: outside)
        for url in [outside, wrong, link, resources.appendingPathComponent("missing.mp3")] {
            do { _ = try ResolvedAudio.bundled(url, in: bundle); throw CheckFailure.failed("invalid bundle path accepted") }
            catch PlaybackFailure.invalidSource {}
        }
        for value in ["file:///etc/passwd", "http://r1.googlevideo.com/file", "https://evil.test/file"] {
            try check(!ResolvedAudio.isAllowed(URL(string: value)!), "legacy remote rejection")
        }
    }
    @MainActor static func tracks() async throws {
        let legacy = Data("{\"id\":\"00000000-0000-0000-0000-000000000001\",\"videoID\":\"00000000001\",\"title\":\"Test\",\"artist\":\"Test\"}".utf8)
        let old = try JSONDecoder().decode(PlaybackTrack.self, from: legacy)
        try check(old.provider == .youtube && old.videoID == "00000000001", "legacy default YouTube")
        let original = try StudioCatalogue.tracks[0].queueEntry()
        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(PlaybackTrack.self, from: encoded)
        try check(original == decoded && decoded.videoID.isEmpty && decoded.provider == .studio, "Studio roundtrip")
        do { _ = try PlaybackTrack(videoID: "bad", title: "", artist: ""); throw CheckFailure.failed("invalid YouTube id") }
        catch PlaybackFailure.invalidTrack {}
        do { _ = try await HTTPOnlyYouTubeResolver().resolve(original); throw CheckFailure.failed("YouTube accepted Studio") }
        catch PlaybackFailure.invalidTrack {}
    }
    @MainActor static func profile() async throws {
        var dirty = LocalProfile()
        let id = StudioCatalogue.tracks[0].id
        let duplicate = UUID()
        dirty.likes = [id, "unknown"]
        dirty.queueIDs = [id, "file:///private/example.mp3"]
        dirty.queueIndex = 500; dirty.position = .infinity
        dirty.playlists = [.init(id: duplicate, name: "  Focus  ", trackIDs: [id, id, "unknown"]), .init(id: duplicate, name: "Duplicate")]
        let clean = dirty.sanitized()
        try check(clean.likes == [id] && clean.queueIDs == [id], "unknown ids removed")
        try check(clean.queueIndex == 0 && clean.position == 0, "invalid restore state clamped")
        try check(clean.playlists.count == 1 && clean.playlists[0].trackIDs == [id], "playlist dedupe")
        try check(clean.playlists[0].name == "Focus", "trimmed playlist name")
    }
    @MainActor static func restore() async throws {
        let name = "aurelia-checks-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let store = LocalProfileStore(defaults: defaults)
        var saved = LocalProfile()
        saved.queueIDs = StudioCatalogue.tracks.prefix(3).map(\.id)
        saved.queueIndex = 1; saved.position = 21; saved.appearance = .dark
        store.save(saved)
        let driver = MockDriver()
        let model = AureliaModel(driver: driver, store: store)
        defer { model.dispose() }
        try await eventually { model.playback.status == .paused }
        try check(driver.operations.first == "volume" && driver.volumes.allSatisfy { $0 == 0 }, "mute before preparation")
        try check(driver.plays == 0 && model.playback.position == 21, "paused restore preserves position")
        try check(model.current?.id == saved.queueIDs[1], "restored queue selection")
        let song = StudioCatalogue.tracks[0]
        model.toggleLike(song)
        guard let playlist = model.createPlaylist("Night walks") else { throw CheckFailure.failed("playlist creation") }
        model.add(song, to: playlist); model.add(song, to: playlist)
        let reloaded = store.load()
        try check(reloaded.likes.contains(song.id), "persisted like")
        try check(reloaded.playlists[0].trackIDs == [song.id], "persisted playlist no duplicate")
        try check(reloaded.appearance == .dark, "persisted theme")
        let text = String(decoding: try JSONEncoder().encode(reloaded), as: UTF8.self)
        try check(!text.contains("://") && !text.contains("volume") && !text.contains("playing") && !text.contains("url"), "metadata-only persistence")
        model.remove(song, from: playlist); model.deletePlaylist(playlist)
        try check(store.load().playlists.isEmpty, "playlist deletion persists")
    }
    @MainActor static func queue() async throws {
        let driver = MockDriver()
        let model = AureliaModel(driver: driver, store: LocalProfileStore(defaults: nil))
        defer { model.dispose() }
        model.play(Array(StudioCatalogue.tracks.prefix(3)))
        try await eventually { model.isPlaying }
        try check(model.current?.id == StudioCatalogue.tracks[0].id, "first track")
        model.seek(25); try check(driver.seeks.last == 25, "seek")
        model.next(); try await eventually { model.isPlaying && driver.loaded.count == 2 }
        try check(model.current?.id == StudioCatalogue.tracks[1].id, "next")
        model.previous(); try await eventually { driver.loaded.count == 3 }
        try check(model.current?.id == StudioCatalogue.tracks[0].id, "previous")
        model.toggleShuffle(); try check(model.playback.shuffle, "shuffle toggles")
        model.cycleRepeat(); model.cycleRepeat(); try check(model.playback.repeatMode == .one, "repeat cycles")
        driver.emit(.ended); try await eventually { driver.loaded.count == 4 }
        try check(model.current?.id == StudioCatalogue.tracks[0].id, "repeat one")
        driver.emit(.failed(.decoder)); try check(model.playback.status == .failed, "terminal decoder failure")
        driver.emit(.failed(.decoder)); try check(model.playback.status == .failed, "duplicate failure remains failed")
        driver.emit(.ended)
        try check(model.playback.status == .failed && model.playback.failure == .decoder, "late end preserves terminal failure")
        try check(model.current?.id == StudioCatalogue.tracks[0].id && driver.loaded.count == 4, "late end cannot advance or repeat queue")
        model.togglePlayback()
        try await eventually { model.isPlaying && driver.loaded.count == 5 }
        try check(model.current?.id == StudioCatalogue.tracks[0].id && model.playback.failure == nil, "deliberate retry remains available")
        driver.emit(.ended); try await eventually { model.isPlaying && driver.loaded.count == 6 }
        try check(model.current?.id == StudioCatalogue.tracks[0].id, "repeat one works after retry")
        model.pause(); try check(model.playback.status == .paused, "deliberate pause remains available")
    }
    @MainActor static func forcedMute() async throws {
        let driver = MockDriver()
        let model = AureliaModel(driver: driver, store: LocalProfileStore(defaults: nil), forceMuted: true)
        defer { model.dispose() }
        model.setVolume(1); model.setVolume(.nan)
        model.play(StudioCatalogue.tracks)
        try await eventually { model.isPlaying }
        model.togglePlayback(); model.togglePlayback(); model.setVolume(0.7)
        model.selectQueue(2); try await eventually { driver.loaded.count == 2 }
        try check(model.volume == 0 && driver.volumes.allSatisfy { $0 == 0 }, "forced mute cannot be raised")
        let firstSurface = UUID(), secondSurface = UUID()
        try check(!model.glassRendered, "unmounted glass not advertised")
        model.setGlassRendered(true, surface: firstSurface); model.setGlassRendered(true, surface: secondSurface)
        model.setGlassRendered(false, surface: firstSurface)
        try check(model.glassRendered, "one mounted native surface remains")
        model.setGlassRendered(false, surface: secondSurface)
        try check(!model.glassRendered, "unmounted native surfaces clear capability")
    }

    @MainActor static func emptyPlayer() async throws {
        let driver = MockDriver()
        let model = AureliaModel(driver: driver, store: LocalProfileStore(defaults: nil))
        defer { model.dispose() }
        model.togglePlayback(); model.next(); model.previous()
        try await Task.sleep(for: .milliseconds(10))
        try check(model.playback.queue.isEmpty && model.playback.status == .idle, "empty transport remains idle")
        try check(driver.loaded.isEmpty && driver.plays == 0, "empty transport never selects demo music")
        model.play([StudioCatalogue.tracks[0]])
        try await eventually { driver.loaded.count == 1 && model.isPlaying }
        try check(model.current?.id == StudioCatalogue.tracks[0].id, "explicit selection still plays")
        model.clearQueue(expectedRevision: model.playback.queueRevision)
        model.togglePlayback()
        try check(model.playback.queue.isEmpty && driver.loaded.count == 1, "cleared transport stays empty")
    }

    @MainActor static func queueEdits() async throws {
        let driver = MockDriver()
        let model = AureliaModel(driver: driver, store: LocalProfileStore(defaults: nil))
        defer { model.dispose() }
        model.play(Array(StudioCatalogue.tracks.prefix(3)))
        try await eventually { driver.loaded.count == 1 && model.isPlaying }
        driver.emit(.progress(position: 18, duration: 72))
        let current = model.playback.currentTrack!.id
        let last = model.playback.queue[2].id
        let revision = model.playback.queueRevision
        let operations = driver.operations.count, seeks = driver.seeks.count
        model.moveQueueEntry(last, by: -1, expectedRevision: revision)
        try check(model.playback.queue[1].id == last && model.playback.currentTrack?.id == current, "move preserves current occurrence")
        try check(model.playback.position == 18 && model.isPlaying && driver.loaded.count == 1, "move preserves playback")
        try check(driver.operations.count == operations && driver.seeks.count == seeks, "move has no transport side effect")
        let moved = model.playback.queue
        model.removeQueueEntry(last, expectedRevision: revision)
        try check(model.playback.queue == moved && model.notice != nil, "stale edit rejected visibly")
        model.pause()
        model.removeQueueEntry(last, expectedRevision: model.playback.queueRevision)
        try check(model.playback.queue.count == 2 && model.playback.status == .paused, "remove respects paused intent")
        try check(model.playback.position == 18 && driver.loaded.count == 1, "remove retains load")
        model.clearQueue(expectedRevision: model.playback.queueRevision)
        try check(model.playback.queue.isEmpty && model.playback.status == .idle, "clear empties model")
        try check(driver.operations.last == "stop", "clear stops native driver")
    }
}
