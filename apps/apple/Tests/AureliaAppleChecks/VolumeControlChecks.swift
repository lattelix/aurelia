import Foundation
@testable import AureliaAppleUI
import AureliaPlaybackCore

private enum VolumeCheckFailure: Error { case failed(String) }
private func requireVolume(_ value: @autoclosure () -> Bool, _ message: String) throws {
    if !value() { throw VolumeCheckFailure.failed(message) }
}
@MainActor private func waitVolume(_ predicate: () -> Bool) async throws {
    for _ in 0..<200 {
        if predicate() { return }
        try await Task.sleep(for: .milliseconds(5))
    }
    throw VolumeCheckFailure.failed("volume state deadline")
}

/// All preference IO is intercepted; no real profile or OS audio is accessed.
private final class VolumeMemoryDefaults: UserDefaults, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    init(inMemory: Bool) { super.init(suiteName: "aurelia-in-memory-volume-check")! }
    override func data(forKey key: String) -> Data? {
        lock.lock(); defer { lock.unlock() }; return values[key]
    }
    override func set(_ value: Any?, forKey key: String) {
        lock.lock(); defer { lock.unlock() }; values[key] = value as? Data
    }
}

@MainActor private final class VolumeDriver: PlaybackDriving {
    var onEvent: (@MainActor (UInt64, PlaybackDriverEvent) -> Void)?
    var gains: [Float] = []
    var gainAtPlay: [Float] = []
    var generation: UInt64 = 0
    func load(_ source: ResolvedAudio, track: PlaybackTrack, generation: UInt64) throws { self.generation = generation }
    func setVolume(_ value: Float) { gains.append(value) }
    func play() { gainAtPlay.append(gains.last ?? -1) }
    func pause() {}
    func seek(to position: Double) {}
    func stop() {}
    func dispose() {}
    func control(_ control: PlaybackControl) { onEvent?(generation, .control(control)) }
}

enum VolumeControlChecks {
    static let cases: [(String, @MainActor () async throws -> Void)] = [
        ("volume_legacy_profile_and_device_preferences", preferences),
        ("volume_platform_gain_policy", gainPolicy),
        ("volume_toggles_preserve_playback_and_independent_level", playback),
        ("volume_forced_mute_with_linked_preferences", forcedMute)
    ]

    @MainActor private static func preferences() async throws {
        let legacy = try JSONDecoder().decode(LocalProfile.self, from: Data("{\"version\":1,\"appearance\":\"dark\"}".utf8))
        try requireVolume(legacy.showVolumeControl && legacy.matchSystemVolume == VolumeControlPolicy.systemVolumeSupported,
                          "legacy profiles get visible control and the platform default linking")
        try requireVolume(legacy.appearance == .dark, "legacy appearance survives migration")
        let store = LocalProfileStore(defaults: VolumeMemoryDefaults(inMemory: true))
        let driver = VolumeDriver(), model = AureliaModel(driver: VolumeDriver(), store: store)
        let other = AureliaModel(driver: driver, store: LocalProfileStore(defaults: nil))
        defer { model.dispose(); other.dispose() }
        try requireVolume(model.profile.showVolumeControl && model.usesSystemVolume == VolumeControlPolicy.systemVolumeSupported,
                          "fresh defaults use the same platform contract")
        model.setMatchSystemVolume(false); model.setVolume(0.23); model.setShowVolumeControl(false)
        let saved = store.load()
        try requireVolume(!saved.showVolumeControl && !saved.matchSystemVolume, "both device toggles persist")
        try requireVolume(other.profile.showVolumeControl && driver.gains == [0], "preferences remain in their device store")
        guard let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(saved)) as? [String: Any] else {
            throw VolumeCheckFailure.failed("profile encoding is an object")
        }
        try requireVolume(object["showVolumeControl"] as? Bool == false && object["matchSystemVolume"] as? Bool == false,
                          "only the toggle choices are serialized")
        try requireVolume(Set(object.keys).isDisjoint(with: ["volume", "playerVolume", "systemVolume", "outputVolume"]),
                          "no audible or OS level is persisted")
        let restoredDriver = VolumeDriver(), restored = AureliaModel(driver: restoredDriver, store: store)
        defer { restored.dispose() }
        try requireVolume(!restored.profile.showVolumeControl && !restored.usesSystemVolume && restored.volume == 0.75,
                          "restoration retains toggles and starts a new independent volume session")
        let before = restoredDriver.gains.count
        restored.setShowVolumeControl(true); restored.setMatchSystemVolume(true)
        try requireVolume(restoredDriver.gains.count == before && restoredDriver.gainAtPlay.isEmpty,
                          "preference changes on an idle player never apply audible gain or play")
    }

    @MainActor private static func gainPolicy() async throws {
        for level in [0.0, 0.23, 1, Double.nan] {
            try requireVolume(VolumeControlPolicy.playerGain(level, matchSystemVolume: true, forceMuted: false, systemVolumeSupported: true) == 1,
                              "linked iOS output is never attenuated twice")
            for supported in [false, true] {
                for linked in [false, true] {
                    try requireVolume(VolumeControlPolicy.playerGain(level, matchSystemVolume: linked, forceMuted: true, systemVolumeSupported: supported) == 0,
                                      "forced mute wins over every level, platform and linkage")
                }
            }
        }
        try requireVolume(VolumeControlPolicy.playerGain(0.23, matchSystemVolume: false, forceMuted: false, systemVolumeSupported: true) == Float(0.23), "unlinked iOS keeps player gain")
        try requireVolume(VolumeControlPolicy.playerGain(0.23, matchSystemVolume: true, forceMuted: false, systemVolumeSupported: false) == Float(0.23), "unsupported platforms never simulate system volume")
        try requireVolume(VolumeControlPolicy.playerGain(.nan, matchSystemVolume: false, forceMuted: false) == 0, "invalid gain fails silent")
        try requireVolume(VolumeControlPolicy.playerGain(-1, matchSystemVolume: false, forceMuted: false) == 0 && VolumeControlPolicy.playerGain(2, matchSystemVolume: false, forceMuted: false) == 1, "independent gain is bounded")
    }

    @MainActor private static func playback() async throws {
        let driver = VolumeDriver()
        let player = AureliaModel(driver: driver, store: LocalProfileStore(defaults: nil))
        defer { player.dispose() }
        player.setMatchSystemVolume(false); player.setVolume(0)
        player.play(Array(StudioCatalogue.tracks.prefix(2)))
        try await waitVolume { player.isPlaying }
        try requireVolume(driver.gainAtPlay == [0] && player.statusText.contains("silently"), "unlinked zero remains a deliberate player mute")
        let writes = driver.gains.count, plays = driver.gainAtPlay.count
        player.setShowVolumeControl(false)
        try requireVolume(driver.gains.count == writes && driver.gainAtPlay.count == plays && !player.usesSystemVolume,
                          "hiding the slider cannot change gain, mode or playback")
        player.setMatchSystemVolume(true)
        let linkedGain: Float = VolumeControlPolicy.systemVolumeSupported ? 1 : 0
        try requireVolume(driver.gains.last == linkedGain && player.volume == 0 && driver.gainAtPlay.count == plays,
                          "link toggle preserves the independent level and never starts playback")
        try requireVolume(player.statusText.contains("silently") == !VolumeControlPolicy.systemVolumeSupported,
                          "linked status cannot mistake the independent zero for system silence")
        player.next()
        try await waitVolume { driver.gainAtPlay.count == plays + 1 }
        try requireVolume(driver.gainAtPlay.last == linkedGain, "queue transitions apply the current volume mode")
        player.setMatchSystemVolume(false)
        try requireVolume(driver.gains.last == 0 && player.volume == 0, "unlink restores the deliberate independent mute")
        player.setVolume(0.37); player.setVolume(.infinity)
        try requireVolume(player.volume == 0.37 && driver.gains.last == Float(0.37), "independent volume accepts finite changes only")
        player.pause()
        let pausedWrites = driver.gains.count, pausedPlays = driver.gainAtPlay.count
        player.setShowVolumeControl(true); player.setMatchSystemVolume(true)
        try requireVolume(driver.gains.count == pausedWrites && driver.gainAtPlay.count == pausedPlays && !player.isPlaying,
                          "paused preference changes preserve paused intent and gain")
        driver.control(.play)
        try requireVolume(driver.gainAtPlay.last == (VolumeControlPolicy.systemVolumeSupported ? 1 : Float(0.37)),
                          "system transport applies the latest mode at its final play boundary")
    }

    @MainActor private static func forcedMute() async throws {
        let store = LocalProfileStore(defaults: VolumeMemoryDefaults(inMemory: true))
        var saved = LocalProfile(); saved.queueIDs = [StudioCatalogue.tracks[0].id]; saved.matchSystemVolume = true
        store.save(saved)
        let driver = VolumeDriver(), model = AureliaModel(driver: driver, store: store, forceMuted: true)
        defer { model.dispose() }
        try await waitVolume { model.playback.status == .paused }
        model.setMatchSystemVolume(false); model.setVolume(1); model.setShowVolumeControl(false)
        model.setMatchSystemVolume(true); model.setShowVolumeControl(true)
        try requireVolume(driver.gainAtPlay.isEmpty && driver.gains.allSatisfy { $0 == 0 }, "restoration and toggles stay silent")
        driver.control(.play)
        model.setMatchSystemVolume(false); model.setVolume(0.8); model.setMatchSystemVolume(true)
        model.pause(); model.togglePlayback()
        try requireVolume(model.volume == 0 && driver.gainAtPlay == [0, 0] && driver.gains.allSatisfy { $0 == 0 },
                          "linked, unlinked and remote play paths cannot lift forced mute")
    }
}
