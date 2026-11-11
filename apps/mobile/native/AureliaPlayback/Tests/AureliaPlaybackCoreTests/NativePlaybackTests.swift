import Foundation
import AureliaPlaybackCore

private let future = Date(timeIntervalSince1970: 4_000_000_000)
private func source(expiresAt: Date = future) throws -> ResolvedAudio {
    try ResolvedAudio(
        url: URL(string: "https://test.googlevideo.com/videoplayback")!,
        expiresAt: expiresAt, bitrate: 128_000, contentLength: 10_000
    )
}
private func track(_ number: Int = 0, id: UUID = UUID()) throws -> PlaybackTrack {
    try PlaybackTrack(id: id, videoID: String(format: "%011d", number), title: "Test", artist: "Test")
}

private actor ControlledResolver: PlaybackResolving {
    private var requests: [PlaybackTrack] = []
    private var continuations: [Int: CheckedContinuation<ResolvedAudio, any Error>] = [:]
    var count: Int { requests.count }
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        let index = requests.count
        requests.append(track)
        // Intentionally ignore cancellation to simulate a late upstream result.
        return try await withCheckedThrowingContinuation { continuations[index] = $0 }
    }
    func succeed(_ index: Int, with source: ResolvedAudio) { continuations.removeValue(forKey: index)?.resume(returning: source) }
    func fail(_ index: Int, with error: PlaybackFailure) { continuations.removeValue(forKey: index)?.resume(throwing: error) }
}

private struct ImmediateResolver: PlaybackResolving {
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio { try source() }
}

@MainActor
private final class TestDriver: PlaybackDriving {
    var onEvent: (@MainActor (UInt64, PlaybackDriverEvent) -> Void)?
    var generations: [UInt64] = []
    var loaded: [PlaybackTrack] = []
    var seeks: [Double] = []
    var playCount = 0
    var volume: Float = 0
    var playedVolumes: [Float] = []
    var playedTracks: [UUID] = []
    var pauseCount = 0
    var stopCount = 0
    var onLoad: (() -> Void)?
    func load(_ source: ResolvedAudio, track: PlaybackTrack, generation: UInt64) throws {
        loaded.append(track); generations.append(generation); onLoad?()
    }
    func play() {
        playCount += 1; playedVolumes.append(volume)
        if let track = loaded.last { playedTracks.append(track.id) }
    }
    func pause() { pauseCount += 1 }
    func seek(to position: Double) { seeks.append(position) }
    func setVolume(_ volume: Float) { self.volume = volume }
    func stop() { stopCount += 1 }
    func dispose() {}
    func emit(_ event: PlaybackDriverEvent, generation: UInt64? = nil) {
        guard let current = generation ?? generations.last else { return }
        onEvent?(current, event)
    }
}

private enum TestFailure: Error { case deadline, assertion }
private func expectTrue(_ value: @autoclosure () -> Bool) throws {
    guard value() else { throw TestFailure.assertion }
}
private func expectEqual<T: Equatable>(_ first: T, _ second: T) throws {
    guard first == second else { throw TestFailure.assertion }
}
private func expectThrows(_ expected: PlaybackFailure, operation: () throws -> Void) throws {
    var caught: PlaybackFailure?
    do { try operation() } catch { caught = error as? PlaybackFailure }
    try expectEqual(caught, expected)
}

@MainActor
private func eventually(_ condition: @MainActor () async -> Bool) async throws {
    for _ in 0..<500 {
        if await condition() { return }
        try await Task.sleep(for: .milliseconds(2))
    }
    throw TestFailure.deadline
}

@MainActor
final class NativePlaybackTests {
    func testQueueEditPreservesCurrentLoadAndPauseIntent() async throws {
        let driver = TestDriver()
        let controller = NativePlaybackController(resolver: ImmediateResolver(), driver: driver)
        defer { controller.dispose() }
        let first = try track(1), duplicate = try track(1), last = try track(2)
        try controller.setQueue([first, duplicate, last], playing: true)
        try await eventually { driver.loaded.count == 1 }
        driver.emit(.progress(position: 42, duration: 120))
        let stops = driver.stopCount, seeks = driver.seeks.count, plays = driver.playCount
        try controller.replaceQueue([last, first, duplicate], expectedRevision: controller.snapshot.queueRevision)
        try expectEqual(controller.snapshot.index, 1)
        try expectEqual(controller.snapshot.currentTrack?.id, first.id)
        try expectEqual(controller.snapshot.position, 42)
        try expectEqual(controller.snapshot.duration, 120)
        try expectEqual(controller.snapshot.status, .playing)
        try expectEqual(driver.loaded.count, 1)
        try expectEqual(driver.stopCount, stops)
        try expectEqual(driver.seeks.count, seeks)
        try expectEqual(driver.playCount, plays)
        controller.pause()
        try controller.replaceQueue([first, duplicate], expectedRevision: controller.snapshot.queueRevision)
        try expectEqual(controller.snapshot.status, .paused)
        try expectEqual(controller.snapshot.position, 42)
        try expectEqual(driver.loaded.count, 1)
        driver.emit(.control(.play))
        try expectEqual(controller.snapshot.status, .playing)
        try expectEqual(driver.loaded.count, 1)
        driver.emit(.ended)
        try await eventually { driver.loaded.count == 2 }
        try expectEqual(controller.snapshot.currentTrack?.id, duplicate.id)
    }

    func testQueueEditRevisionIdentityAndCapacity() throws {
        let controller = NativePlaybackController(resolver: ImmediateResolver(), driver: TestDriver())
        defer { controller.dispose() }
        let first = try track(1), second = try track(2)
        try controller.setQueue([first, second])
        let revision = controller.snapshot.queueRevision
        try controller.replaceQueue([first, second], expectedRevision: revision)
        try expectEqual(controller.snapshot.queueRevision, revision)
        try controller.replaceQueue([second, first], expectedRevision: revision)
        let snapshot = controller.snapshot
        try expectThrows(.staleRequest) { try controller.replaceQueue([], expectedRevision: revision) }
        try expectEqual(controller.snapshot, snapshot)
        let changed = try PlaybackTrack(id: first.id, videoID: first.videoID, title: "Changed", artist: first.artist)
        try expectThrows(.invalidRequest) {
            try controller.replaceQueue([changed, second], expectedRevision: snapshot.queueRevision)
        }
        try expectThrows(.invalidRequest) {
            try controller.replaceQueue([first, first], expectedRevision: snapshot.queueRevision)
        }
        let oversized = try (0..<501).map { try track($0) }
        try expectThrows(.invalidRequest) {
            try controller.replaceQueue(oversized, expectedRevision: snapshot.queueRevision)
        }
        try expectThrows(.invalidTrack) { try controller.setQueue(oversized) }
        try expectEqual(controller.snapshot, snapshot)
    }

    func testQueueEditDuringResolutionDoesNotRestartOrAutoplay() async throws {
        let resolver = ControlledResolver(), driver = TestDriver()
        let controller = NativePlaybackController(resolver: resolver, driver: driver)
        defer { controller.dispose() }
        let first = try track(1), second = try track(2)
        try controller.setQueue([first, second], playing: true)
        try await eventually { await resolver.count == 1 }
        try controller.replaceQueue([second, first], expectedRevision: controller.snapshot.queueRevision)
        controller.pause()
        await resolver.succeed(0, with: try source())
        try await eventually { driver.loaded.count == 1 }
        try expectEqual(controller.snapshot.currentTrack?.id, first.id)
        try expectEqual(controller.snapshot.index, 1)
        try expectEqual(controller.snapshot.status, .paused)
        try expectEqual(driver.playCount, 0)
        let requests = await resolver.count
        try expectEqual(requests, 1)
    }

    func testQueueRemovalAndClearRejectLateDriverEvents() async throws {
        let driver = TestDriver()
        let controller = NativePlaybackController(resolver: ImmediateResolver(), driver: driver)
        defer { controller.dispose() }
        let first = try track(1), second = try track(2), third = try track(3)
        try controller.setQueue([first, second, third], playing: true)
        try await eventually { driver.loaded.count == 1 }
        let oldGeneration = driver.generations[0]
        driver.emit(.progress(position: 20, duration: 90))
        try controller.replaceQueue([third, second], expectedRevision: controller.snapshot.queueRevision)
        try await eventually { driver.loaded.count == 2 }
        try expectEqual(controller.snapshot.currentTrack?.id, second.id)
        try expectEqual(controller.snapshot.position, 0)
        try expectEqual(controller.snapshot.status, .playing)
        driver.emit(.ended, generation: oldGeneration)
        try expectEqual(controller.snapshot.currentTrack?.id, second.id)
        controller.pause()
        try controller.replaceQueue([third], expectedRevision: controller.snapshot.queueRevision)
        try await eventually { driver.loaded.count == 3 }
        try expectEqual(controller.snapshot.currentTrack?.id, third.id)
        try expectEqual(controller.snapshot.status, .paused)
        let generation = driver.generations.last!
        try controller.replaceQueue([], expectedRevision: controller.snapshot.queueRevision)
        try expectEqual(controller.snapshot.currentTrack, nil)
        try expectEqual(controller.snapshot.status, .idle)
        driver.emit(.progress(position: 75, duration: 90), generation: generation)
        driver.emit(.ended, generation: generation)
        controller.play()
        try expectEqual(controller.snapshot.status, .idle)
        try expectEqual(controller.snapshot.position, 0)
        try expectEqual(driver.loaded.count, 3)
    }

    func testQueueClearInvalidatesPendingResolution() async throws {
        let resolver = ControlledResolver(), driver = TestDriver()
        let controller = NativePlaybackController(resolver: resolver, driver: driver)
        defer { controller.dispose() }
        try controller.setQueue([track(1)], playing: true)
        try await eventually { await resolver.count == 1 }
        try controller.replaceQueue([], expectedRevision: controller.snapshot.queueRevision)
        await resolver.succeed(0, with: try source())
        try await Task.sleep(for: .milliseconds(15))
        try expectEqual(driver.loaded.count, 0)
        try expectEqual(driver.playCount, 0)
        try expectEqual(controller.snapshot.status, .idle)
    }

    func testShuffledQueueEditsDoNotRevisitPlayedEntries() throws {
        let driver = TestDriver()
        let controller = NativePlaybackController(resolver: ImmediateResolver(), driver: driver)
        defer { controller.dispose() }
        let tracks = try (0..<5).map { try track($0) }
        let added = try track(5)
        try controller.setQueue(tracks)
        controller.setShuffle(true)
        var visited = [controller.snapshot.currentTrack!.id]
        controller.next()
        visited.append(controller.snapshot.currentTrack!.id)
        try controller.replaceQueue(tracks.reversed() + [added], expectedRevision: controller.snapshot.queueRevision)
        controller.setShuffle(true) // An idempotent settings update must not reshuffle history.
        for _ in 0..<8 {
            controller.next()
            if controller.snapshot.status == .ended { break }
            visited.append(controller.snapshot.currentTrack!.id)
        }
        try expectEqual(visited.count, 6)
        try expectEqual(Set(visited), Set((tracks + [added]).map(\.id)))
    }

    func testShuffledQueueRefillAndReplacementVisitEveryNewEntry() throws {
        // Multiple runs cover shuffled permutations, not a fixed random order.
        for _ in 0..<12 {
            let controller = NativePlaybackController(resolver: ImmediateResolver(), driver: TestDriver())
            defer { controller.dispose() }
            controller.setShuffle(true)
            let tracks = try (0..<4).map { try track($0) }
            try controller.replaceQueue(tracks, expectedRevision: controller.snapshot.queueRevision)
            try expectEqual(controller.snapshot.currentTrack?.id, tracks[0].id)
            var visited = [controller.snapshot.currentTrack!.id]
            for _ in 0..<4 {
                controller.next()
                if controller.snapshot.status == .ended { break }
                visited.append(controller.snapshot.currentTrack!.id)
            }
            try expectEqual(visited.count, tracks.count)
            try expectEqual(Set(visited), Set(tracks.map(\.id)))
            let replacement = try (4..<8).map { try track($0) }
            try controller.replaceQueue(replacement, expectedRevision: controller.snapshot.queueRevision)
            visited = [controller.snapshot.currentTrack!.id]
            for _ in 0..<4 {
                controller.next()
                if controller.snapshot.status == .ended { break }
                visited.append(controller.snapshot.currentTrack!.id)
            }
            try expectEqual(visited.count, replacement.count)
            try expectEqual(Set(visited), Set(replacement.map(\.id)))
        }
    }

    func testDuplicateTerminalFailureRemainsFailed() async throws {
        let driver = TestDriver()
        let controller = NativePlaybackController(resolver: ImmediateResolver(), driver: driver)
        defer { controller.dispose() }
        try controller.setQueue([track()], playing: true)
        try await eventually { driver.loaded.count == 1 }
        driver.emit(.failed(.decoder))
        try expectEqual(controller.snapshot.status, .failed)
        driver.emit(.failed(.decoder))
        try expectEqual(controller.snapshot.status, .failed)
        try expectEqual(controller.snapshot.failure, .decoder)
    }

    func testEndedAfterTerminalFailurePreservesQueueAndAllowsRetry() async throws {
        let driver = TestDriver()
        let controller = NativePlaybackController(resolver: ImmediateResolver(), driver: driver)
        defer { controller.dispose() }
        let first = try track(1), second = try track(2)
        try controller.setQueue([first, second], playing: true)
        try await eventually { driver.loaded.count == 1 }
        driver.emit(.failed(.decoder))
        driver.emit(.ended)
        try expectEqual(controller.snapshot.status, .failed)
        try expectEqual(controller.snapshot.failure, .decoder)
        try expectEqual(controller.snapshot.currentTrack?.id, first.id)
        try expectEqual(driver.loaded.count, 1)

        // A deliberate remote play still retries the failed recording, and a
        // genuine end from that fresh load may advance normally afterward.
        driver.emit(.control(.play))
        try await eventually { driver.loaded.count == 2 && controller.snapshot.status == .playing }
        try expectEqual(controller.snapshot.currentTrack?.id, first.id)
        try expectEqual(controller.snapshot.failure, nil)
        driver.emit(.ended)
        try await eventually { driver.loaded.count == 3 && controller.snapshot.status == .playing }
        try expectEqual(controller.snapshot.currentTrack?.id, second.id)
    }

    func testMediaURLBoundary() throws {
        try expectTrue(ResolvedAudio.isAllowed(URL(string: "https://r1.googlevideo.com/videoplayback?expire=123")!))
        for value in [
            "http://r1.googlevideo.com/file", "https://googlevideo.com/file",
            "https://r1.googlevideo.com.evil.test/file", "https://evil.test/googlevideo.com",
            "https://user:pass@r1.googlevideo.com/file", "https://r1.googlevideo.com:443/file",
            "https://r1.googlevideo.com/file#fragment", "file:///etc/passwd"
        ] { try expectTrue(!ResolvedAudio.isAllowed(URL(string: value)!)) }
        try expectThrows(.invalidSource) {
            _ = try ResolvedAudio(url: URL(string: "https://r1.googlevideo.com/file")!, expiresAt: future, contentLength: 129 * 1024 * 1024)
        }
    }

    func testDecodedTracksUseValidation() throws {
        let invalid = "{\"id\":\"00000000-0000-0000-0000-000000000001\",\"videoID\":\"bad\",\"title\":\"Test\",\"artist\":\"Test\"}"
        try expectThrows(.invalidTrack) {
            _ = try JSONDecoder().decode(PlaybackTrack.self, from: Data(invalid.utf8))
        }
    }

    func testQueueAcceptsDuplicateRecordingsButNotDuplicateEntries() throws {
        let driver = TestDriver()
        let controller = NativePlaybackController(resolver: ImmediateResolver(), driver: driver)
        defer { controller.dispose() }
        let first = try track()
        let second = try track()
        try controller.setQueue([first, second])
        controller.next()
        try expectTrue(controller.snapshot.currentTrack?.id == second.id)
        try expectThrows(.invalidTrack) { try controller.setQueue([first, first]) }
        try expectThrows(.invalidTrack) { try controller.setQueue([first], index: 3) }
    }

    func testLateResolutionCannotReplaceSelectedTrack() async throws {
        let resolver = ControlledResolver(); let driver = TestDriver()
        let controller = NativePlaybackController(resolver: resolver, driver: driver)
        defer { controller.dispose() }
        let first = try track(1), second = try track(2)
        try controller.setQueue([first, second], playing: true)
        try await eventually { await resolver.count == 1 }
        controller.next()
        try await eventually { await resolver.count == 2 }
        await resolver.succeed(0, with: try source())
        await resolver.succeed(1, with: try source())
        try await eventually { driver.loaded.count == 1 }
        try expectTrue(driver.loaded.map(\.id) == [second.id])
        try expectTrue(controller.snapshot.currentTrack?.id == second.id)
        try expectTrue(driver.playCount == 1)
    }

    func testPauseWhileResolvingCannotStartPlayback() async throws {
        let resolver = ControlledResolver(); let driver = TestDriver()
        let controller = NativePlaybackController(resolver: resolver, driver: driver)
        defer { controller.dispose() }
        try controller.setQueue([try track()], playing: true)
        try await eventually { await resolver.count == 1 }
        controller.pause()
        await resolver.succeed(0, with: try source())
        try await eventually { driver.loaded.count == 1 }
        try expectTrue(driver.playCount == 0)
        try expectTrue(controller.snapshot.status == .paused)
    }

    func testStopInvalidatesLateSuccess() async throws {
        let resolver = ControlledResolver(); let driver = TestDriver()
        let controller = NativePlaybackController(resolver: resolver, driver: driver)
        defer { controller.dispose() }
        try controller.setQueue([try track()], playing: true)
        try await eventually { await resolver.count == 1 }
        controller.stop()
        await resolver.succeed(0, with: try source())
        for _ in 0..<10 { await Task.yield() }
        try expectTrue(driver.loaded.isEmpty)
        try expectTrue(driver.playCount == 0)
        try expectTrue(controller.snapshot.status == .idle)
    }

    func testNativeEndAdvancesWithoutUICallback() async throws {
        let driver = TestDriver()
        let controller = NativePlaybackController(resolver: ImmediateResolver(), driver: driver)
        defer { controller.dispose() }
        let first = try track(1), second = try track(2)
        try controller.setQueue([first, second], playing: true)
        try await eventually { driver.loaded.count == 1 }
        driver.emit(.ended)
        try await eventually { driver.loaded.count == 2 }
        try expectTrue(controller.snapshot.currentTrack?.id == second.id)
        driver.emit(.ended)
        try expectTrue(controller.snapshot.status == .ended)
    }

    func testRepeatOneAndExplicitNextDiffer() async throws {
        let driver = TestDriver()
        let controller = NativePlaybackController(resolver: ImmediateResolver(), driver: driver)
        defer { controller.dispose() }
        let first = try track(1), second = try track(2)
        try controller.setQueue([first, second], playing: true)
        controller.setRepeat(.one)
        try await eventually { driver.loaded.count == 1 }
        driver.emit(.ended)
        try await eventually { driver.loaded.count == 2 }
        try expectTrue(controller.snapshot.currentTrack?.id == first.id)
        controller.next()
        try expectTrue(controller.snapshot.currentTrack?.id == second.id)
        controller.setRepeat(.all)
        controller.next()
        try expectTrue(controller.snapshot.currentTrack?.id == first.id)
    }

    func testShuffleVisitsEveryEntryBeforeEnding() throws {
        let driver = TestDriver()
        let controller = NativePlaybackController(resolver: ImmediateResolver(), driver: driver)
        defer { controller.dispose() }
        let tracks = try (0..<5).map { try track($0) }
        try controller.setQueue(tracks)
        controller.setShuffle(true)
        var visited: [UUID] = []
        for _ in tracks {
            visited.append(controller.snapshot.currentTrack!.id)
            controller.next()
        }
        try expectTrue(Set(visited) == Set(tracks.map(\.id)))
        try expectTrue(controller.snapshot.status == .ended)
        controller.previous()
        try expectTrue(controller.snapshot.currentTrack?.id == visited[visited.count - 2])
    }

    func testNetworkRetryPreservesPositionAndStopsAfterOneRetry() async throws {
        let resolver = ControlledResolver(); let driver = TestDriver()
        let controller = NativePlaybackController(resolver: resolver, driver: driver)
        defer { controller.dispose() }
        let selected = try track(1)
        try controller.setQueue([selected], playing: true)
        try await eventually { await resolver.count == 1 }
        await resolver.succeed(0, with: try source())
        try await eventually { driver.loaded.count == 1 }
        driver.emit(.progress(position: 42, duration: 100))
        let staleGeneration = driver.generations.last!
        driver.emit(.failed(.network))
        try await eventually { await resolver.count == 2 }
        await resolver.succeed(1, with: try source())
        try await eventually { driver.loaded.count == 2 }
        try expectTrue(driver.seeks.last == 42)
        try expectTrue(controller.snapshot.currentTrack?.id == selected.id)
        driver.emit(.ended, generation: staleGeneration)
        try expectTrue(controller.snapshot.status == .playing)
        driver.emit(.failed(.network))
        try expectTrue(controller.snapshot.status == .failed)
        try expectTrue(controller.snapshot.failure == .network)
        let count = await resolver.count
        try expectEqual(count, 2)
    }

    func testExpiredSourcesRetryOnlyOnce() async throws {
        let resolver = ControlledResolver(); let driver = TestDriver()
        let controller = NativePlaybackController(resolver: resolver, driver: driver)
        defer { controller.dispose() }
        try controller.setQueue([try track()], playing: true)
        try await eventually { await resolver.count == 1 }
        await resolver.succeed(0, with: try source(expiresAt: .distantPast))
        try await eventually { await resolver.count == 2 }
        await resolver.succeed(1, with: try source(expiresAt: .distantPast))
        try await eventually { controller.snapshot.status == .failed }
        try expectTrue(controller.snapshot.failure == .expired)
        try expectTrue(driver.loaded.isEmpty)
        let count = await resolver.count
        try expectEqual(count, 2)
    }

    func testSynchronousDriverReentryCannotPlaySupersededSource() async throws {
        let driver = TestDriver()
        let controller = NativePlaybackController(resolver: ImmediateResolver(), driver: driver)
        defer { controller.dispose() }
        let first = try track(1), second = try track(2)
        driver.onLoad = { if driver.loaded.last?.id == first.id { controller.next() } }
        defer { driver.onLoad = nil }
        try controller.setQueue([first, second], playing: true)
        try await eventually { driver.loaded.count == 2 }
        try expectTrue(controller.snapshot.currentTrack?.id == second.id)
        try expectTrue(driver.playCount == 1)
    }

    func testWillPlayHookAdmitsSystemPlayAndNativeAdvance() async throws {
        let driver = TestDriver()
        let controller = NativePlaybackController(resolver: ImmediateResolver(), driver: driver)
        defer { controller.dispose() }
        var hookCount = 0
        var preference: Float = 0.75
        controller.onWillPlay = {
            hookCount += 1
            driver.setVolume(preference)
        }
        controller.play()
        driver.emit(.control(.play), generation: 0)
        try expectEqual(hookCount, 0)
        try expectEqual(driver.playCount, 0)

        let first = try track(1), second = try track(2)
        try controller.setQueue([first, second], playing: false)
        try await eventually { driver.loaded.count == 1 && controller.snapshot.status == .paused }
        try expectEqual(hookCount, 0)
        try expectEqual(driver.volume, 0)
        try expectEqual(driver.playCount, 0)

        driver.emit(.control(.play))
        try expectEqual(hookCount, 1)
        try expectEqual(driver.playedVolumes, [0.75])
        try expectEqual(controller.snapshot.status, .playing)
        controller.pause()
        preference = 0
        driver.emit(.control(.play))
        try expectEqual(hookCount, 2)
        try expectEqual(driver.playedVolumes, [0.75, 0])

        preference = 0.4
        driver.emit(.ended)
        try await eventually { driver.playCount == 3 }
        try expectEqual(hookCount, 3)
        try expectEqual(driver.playedVolumes, [0.75, 0, 0.4])
        try expectEqual(driver.playedTracks, [first.id, first.id, second.id])
        controller.dispose()
        try expectTrue(controller.onWillPlay == nil)
    }

    func testWillPlayHookRejectsReentrantStopPauseAndReplacement() async throws {
        for duringResolution in [false, true] {
            for shouldPause in [false, true] {
                let driver = TestDriver()
                let controller = NativePlaybackController(resolver: ImmediateResolver(), driver: driver)
                var hookCount = 0
                controller.onWillPlay = {
                    hookCount += 1
                    if shouldPause { controller.pause() } else { controller.stop() }
                }
                try controller.setQueue([track(1)], playing: duringResolution)
                if !duringResolution {
                    try await eventually { driver.loaded.count == 1 && controller.snapshot.status == .paused }
                    driver.emit(.control(.play))
                }
                try await eventually { hookCount == 1 }
                try expectEqual(driver.playCount, 0)
                try expectEqual(controller.snapshot.status, shouldPause ? .paused : .idle)
                controller.dispose()
            }

            let driver = TestDriver()
            let controller = NativePlaybackController(resolver: ImmediateResolver(), driver: driver)
            let first = try track(1), replacement = try track(2)
            var selectedByHook = false
            controller.onWillPlay = {
                if controller.snapshot.currentTrack?.id == first.id {
                    selectedByHook = true
                    try? controller.setQueue([replacement], playing: true)
                }
            }
            try controller.setQueue([first], playing: duringResolution)
            if !duringResolution {
                try await eventually { driver.loaded.count == 1 && controller.snapshot.status == .paused }
                driver.emit(.control(.play))
            }
            try await eventually { driver.loaded.count == 2 && driver.playCount == 1 }
            try expectTrue(selectedByHook)
            try expectEqual(driver.playedTracks, [replacement.id])
            try expectEqual(controller.snapshot.currentTrack?.id, replacement.id)
            try expectEqual(controller.snapshot.status, .playing)
            controller.dispose()
        }
    }

    func testResolutionDeadlineRejectsLateCompletion() async throws {
        let resolver = ControlledResolver(); let driver = TestDriver()
        let controller = NativePlaybackController(
            resolver: resolver, driver: driver, resolutionTimeoutSeconds: 0.02
        )
        defer { controller.dispose() }
        try controller.setQueue([try track()])
        try await eventually { await resolver.count == 1 }
        try await eventually { controller.snapshot.failure == .network }
        await resolver.succeed(0, with: try source())
        for _ in 0..<10 { await Task.yield() }
        try expectTrue(driver.loaded.isEmpty)
        try expectTrue(controller.snapshot.status == .paused)
    }

    func testNoErrorStartupStallRetriesOnce() async throws {
        let driver = TestDriver()
        let controller = NativePlaybackController(
            resolver: ImmediateResolver(), driver: driver, startTimeoutSeconds: 0.02
        )
        defer { controller.dispose() }
        try controller.setQueue([try track()], playing: true)
        try await eventually { controller.snapshot.status == .failed }
        try expectTrue(driver.loaded.count == 2)
        try expectTrue(controller.snapshot.failure == .network)
    }

    func testRepeatedPositionCannotHideProgressStall() async throws {
        let driver = TestDriver()
        let controller = NativePlaybackController(
            resolver: ImmediateResolver(), driver: driver,
            startTimeoutSeconds: 0.2, progressTimeoutSeconds: 0.02
        )
        defer { controller.dispose() }
        try controller.setQueue([try track()], playing: true)
        try await eventually { driver.loaded.count == 1 }
        driver.emit(.progress(position: 1, duration: 100))
        for _ in 0..<8 {
            driver.emit(.progress(position: 1, duration: 100))
            try await Task.sleep(for: .milliseconds(4))
        }
        try await eventually { driver.loaded.count == 2 }
        driver.emit(.progress(position: 2, duration: 100))
        try await eventually { controller.snapshot.status == .failed }
        try expectTrue(driver.loaded.count == 2)
        try expectTrue(driver.seeks.last == 1)
    }

    func testPauseAndStopCancelStartupWatchdog() async throws {
        let driver = TestDriver()
        let controller = NativePlaybackController(
            resolver: ImmediateResolver(), driver: driver, startTimeoutSeconds: 0.02
        )
        defer { controller.dispose() }
        try controller.setQueue([try track()], playing: true)
        try await eventually { driver.loaded.count == 1 }
        controller.pause()
        try await Task.sleep(for: .milliseconds(40))
        try expectTrue(driver.loaded.count == 1)
        try expectTrue(controller.snapshot.status == .paused)
        controller.play(); controller.stop()
        try await Task.sleep(for: .milliseconds(40))
        try expectTrue(driver.loaded.count == 1)
        try expectTrue(controller.snapshot.status == .idle)
    }

    func testCancelledCallerDoesNotFreePhysicalResolverSlot() async throws {
        let underlying = ControlledResolver()
        let admitted = BoundedPlaybackResolver(underlying: underlying)
        let firstTrack = try track(1), secondTrack = try track(2)
        let first = Task { try await admitted.resolve(firstTrack) }
        try await eventually { await underlying.count == 1 }
        first.cancel()
        var failure: PlaybackFailure?
        do { _ = try await admitted.resolve(secondTrack) }
        catch { failure = error as? PlaybackFailure }
        try expectEqual(failure, .busy)
        let count = await underlying.count
        try expectTrue(count == 1)
        await underlying.succeed(0, with: try source())
        _ = try? await first.value
        let next = Task { try await admitted.resolve(secondTrack) }
        try await eventually { await underlying.count == 2 }
        await underlying.succeed(1, with: try source())
        _ = try await next.value
    }

    func testEndedCallbackCannotCancelNewPlaybackWatchdog() async throws {
        let driver = TestDriver()
        let controller = NativePlaybackController(
            resolver: ImmediateResolver(), driver: driver, startTimeoutSeconds: 0.02
        )
        defer { controller.onSnapshot = nil; controller.dispose() }
        try controller.setQueue([try track()], playing: true)
        try await eventually { driver.loaded.count == 1 }
        controller.onSnapshot = { snapshot in
            if snapshot.status == .ended { controller.play() }
        }
        driver.emit(.ended)
        try await eventually { controller.snapshot.status == .failed }
        try expectTrue(driver.loaded.count == 3)
    }
}
