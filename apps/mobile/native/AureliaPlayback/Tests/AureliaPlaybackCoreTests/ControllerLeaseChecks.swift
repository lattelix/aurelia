import Foundation
import AureliaPlaybackCore

private enum ControllerLeaseCheckFailure: Error {
    case assertion(String)
    case deadline(String)
}

private func leaseRequire(_ value: @autoclosure () -> Bool, _ label: String) throws {
    guard value() else { throw ControllerLeaseCheckFailure.assertion(label) }
}

private let leaseFixtureNow = Date(timeIntervalSince1970: 2_000_000_000)
private let leaseFixtureExpiry: TimeInterval = 4_000_000_000

private func leaseTrack(_ videoID: String = "00000000001") throws -> PlaybackTrack {
    try PlaybackTrack(videoID: videoID, title: "Lease fixture", artist: "Fixture")
}

private func leaseSource(
    videoID: String = "00000000001", opaqueID: String = "recording-a", itag: Int = 140,
    length: Int = 10000, modified: String = "123", expiry: TimeInterval = leaseFixtureExpiry,
    signature: String = "signature-a", host: String = "r1.googlevideo.com"
) throws -> ResolvedAudio {
    var parts = URLComponents()
    parts.scheme = "https"; parts.host = host; parts.path = "/videoplayback"
    parts.queryItems = [
        URLQueryItem(name: "id", value: opaqueID), URLQueryItem(name: "itag", value: String(itag)),
        URLQueryItem(name: "clen", value: String(length)), URLQueryItem(name: "lmt", value: modified),
        URLQueryItem(name: "expire", value: String(Int(expiry))), URLQueryItem(name: "mime", value: "audio/mp4"),
        URLQueryItem(name: "source", value: "youtube"), URLQueryItem(name: "sig", value: signature)
    ]
    let lease = try VerifiedYouTubeStreamLease(
        requestedVideoID: videoID, playerVideoID: videoID, itag: itag,
        mimeType: "audio/mp4; codecs=\"mp4a.40.2\"", contentLength: length,
        url: parts.url!, expiresAt: Date(timeIntervalSince1970: expiry), bitrate: 128000, now: leaseFixtureNow
    )
    return try ResolvedAudio.youtube(lease: lease)
}

private func genericLeaseFixtureSource() throws -> ResolvedAudio {
    try ResolvedAudio(url: URL(string: "https://fixture.googlevideo.com/videoplayback")!,
                      expiresAt: Date(timeIntervalSince1970: leaseFixtureExpiry), contentLength: 10000)
}

private actor LeaseSequenceResolver: PlaybackResolving {
    private let sources: [ResolvedAudio]
    private var requestCount = 0
    init(_ sources: [ResolvedAudio]) { self.sources = sources }
    func count() -> Int { requestCount }
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        let index = requestCount
        requestCount += 1
        guard sources.indices.contains(index) else { throw PlaybackFailure.unavailable }
        return sources[index]
    }
}

@MainActor
private final class LeaseFixtureDriver: PlaybackDriving {
    var onEvent: (@MainActor (UInt64, PlaybackDriverEvent) -> Void)?
    private(set) var sources: [ResolvedAudio] = []
    private(set) var tracks: [PlaybackTrack] = []
    private(set) var generations: [UInt64] = []
    private(set) var seeks: [Double] = []
    private(set) var stops = 0
    func load(_ source: ResolvedAudio, track: PlaybackTrack, generation: UInt64) throws {
        sources.append(source); tracks.append(track); generations.append(generation)
    }
    func play() {}
    func pause() {}
    func seek(to position: Double) { seeks.append(position) }
    func stop() { stops += 1 }
    func dispose() {}
    func emit(_ event: PlaybackDriverEvent) {
        guard let generation = generations.last else { return }
        onEvent?(generation, event)
    }
}

@MainActor
private func leaseEventually(_ label: String, _ condition: @MainActor () async -> Bool) async throws {
    for _ in 0..<1000 {
        if await condition() { return }
        try await Task.sleep(nanoseconds: 1_000_000)
    }
    throw ControllerLeaseCheckFailure.deadline(label)
}

@MainActor
func checkControllerLeaseContinuity() async throws {
    // A transport retry may renew signing material, never switch the recording
    // or downgrade an already-verified occurrence to a generic source.
    for replacement in [
        try leaseSource(opaqueID: "recording-b"), try leaseSource(itag: 141),
        try leaseSource(length: 11000), try leaseSource(modified: "124"),
        try leaseSource(expiry: leaseFixtureExpiry - 1), try genericLeaseFixtureSource()
    ] {
        let resolver = LeaseSequenceResolver([try leaseSource(), replacement])
        let driver = LeaseFixtureDriver()
        let controller = NativePlaybackController(resolver: resolver, driver: driver, now: { leaseFixtureNow })
        defer { controller.dispose() }
        let track = try leaseTrack()
        try controller.setQueue([track], playing: true)
        try await leaseEventually("initial lease") { driver.sources.count == 1 && controller.snapshot.status == .playing }
        driver.emit(.progress(position: 42, duration: 120))
        let stopsBeforeRetry = driver.stops
        driver.emit(.failed(.network))
        try await leaseEventually("invalid renewal reaches terminal state") {
            controller.snapshot.status == .failed || driver.sources.count > 1
        }
        let calls = await resolver.count()
        try leaseRequire(calls == 2, "invalid renewal attempted once")
        try leaseRequire(driver.sources.count == 1, "invalid renewal rejected before driver load")
        try leaseRequire(controller.snapshot.failure == .invalidSource, "invalid renewal failure")
        try leaseRequire(driver.stops > stopsBeforeRetry, "invalid renewal stops driver")
        try leaseRequire(controller.snapshot.position == 42, "invalid renewal retains position")
    }

    try await leaseAcceptsRenewalAndRetainsPosition()
    try await leaseRejectsWrongVideoBeforeLoad()
    try await leaseStopReleasesIdentity()
    try await leaseOccurrenceReleasesIdentity()
    try await leaseTerminalFailureStopsAndRejectsProgress()
    try await leaseGenericFixtureWithoutPriorLeaseIsAllowed()
}

@MainActor
private func leaseAcceptsRenewalAndRetainsPosition() async throws {
    let resolver = LeaseSequenceResolver([
        try leaseSource(), try leaseSource(expiry: leaseFixtureExpiry + 3600, signature: "signature-b", host: "r2.googlevideo.com")
    ])
    let driver = LeaseFixtureDriver()
    let controller = NativePlaybackController(resolver: resolver, driver: driver, now: { leaseFixtureNow })
    defer { controller.dispose() }
    try controller.setQueue([leaseTrack()], playing: true)
    try await leaseEventually("initial renewable lease") { driver.sources.count == 1 && controller.snapshot.status == .playing }
    driver.emit(.progress(position: 37.5, duration: 120))
    driver.emit(.failed(.expired))
    try await leaseEventually("same recording renews") { driver.sources.count == 2 && controller.snapshot.status == .playing }
    let calls = await resolver.count()
    try leaseRequire(calls == 2, "one successful renewal")
    try leaseRequire(controller.snapshot.failure == nil, "renewal has no terminal failure")
    try leaseRequire(controller.snapshot.position == 37.5 && driver.seeks.last == 37.5, "renewal seeks retained position")
    try leaseRequire(driver.sources[1].expiresAt > driver.sources[0].expiresAt, "renewal uses later expiry")
}

@MainActor
private func leaseRejectsWrongVideoBeforeLoad() async throws {
    // Each lease is internally valid, but belongs to a different player ID.
    let resolver = LeaseSequenceResolver([try leaseSource(videoID: "00000000002")])
    let driver = LeaseFixtureDriver()
    let controller = NativePlaybackController(resolver: resolver, driver: driver, now: { leaseFixtureNow })
    defer { controller.dispose() }
    try controller.setQueue([leaseTrack()], playing: true)
    try await leaseEventually("wrong video lease rejected") { controller.snapshot.status == .failed || !driver.sources.isEmpty }
    let calls = await resolver.count()
    try leaseRequire(calls == 1 && driver.sources.isEmpty, "wrong video rejected before initial load")
    try leaseRequire(controller.snapshot.failure == .invalidSource, "wrong video source failure")
}

@MainActor
private func leaseStopReleasesIdentity() async throws {
    let resolver = LeaseSequenceResolver([try leaseSource(), try leaseSource(opaqueID: "new-explicit-session")])
    let driver = LeaseFixtureDriver()
    let controller = NativePlaybackController(resolver: resolver, driver: driver, now: { leaseFixtureNow })
    defer { controller.dispose() }
    try controller.setQueue([leaseTrack()], playing: true)
    try await leaseEventually("initial explicit session") { driver.sources.count == 1 && controller.snapshot.status == .playing }
    driver.emit(.progress(position: 25, duration: 120))
    controller.stop()
    controller.play()
    try await leaseEventually("explicit stop releases identity") { driver.sources.count == 2 || controller.snapshot.status == .failed }
    try leaseRequire(driver.sources.count == 2 && controller.snapshot.status == .playing, "new source accepted after explicit stop")
    try leaseRequire(controller.snapshot.position == 0 && driver.seeks.last == 0, "explicit stop resets position")
}

@MainActor
private func leaseOccurrenceReleasesIdentity() async throws {
    let resolver = LeaseSequenceResolver([try leaseSource(), try leaseSource(opaqueID: "another-occurrence")])
    let driver = LeaseFixtureDriver()
    let controller = NativePlaybackController(resolver: resolver, driver: driver, now: { leaseFixtureNow })
    defer { controller.dispose() }
    let first = try leaseTrack(), second = try leaseTrack()
    try controller.setQueue([first, second], playing: true)
    try await leaseEventually("first occurrence") { driver.sources.count == 1 && controller.snapshot.status == .playing }
    driver.emit(.progress(position: 20, duration: 120))
    controller.next()
    try await leaseEventually("different occurrence releases identity") { driver.sources.count == 2 || controller.snapshot.status == .failed }
    try leaseRequire(driver.sources.count == 2 && driver.tracks.last?.id == second.id, "new occurrence loads independent source")
    try leaseRequire(controller.snapshot.status == .playing && controller.snapshot.position == 0, "new occurrence starts at beginning")
}

@MainActor
private func leaseTerminalFailureStopsAndRejectsProgress() async throws {
    let resolver = LeaseSequenceResolver([try leaseSource()])
    let driver = LeaseFixtureDriver()
    let controller = NativePlaybackController(resolver: resolver, driver: driver, now: { leaseFixtureNow })
    defer { controller.dispose() }
    let first = try leaseTrack(), second = try leaseTrack("00000000002")
    try controller.setQueue([first, second], playing: true)
    try await leaseEventually("terminal fixture loaded") { driver.sources.count == 1 && controller.snapshot.status == .playing }
    driver.emit(.progress(position: 42, duration: 120))
    let stopsBeforeFailure = driver.stops
    driver.emit(.failed(.decoder))
    try leaseRequire(driver.stops == stopsBeforeFailure + 1, "terminal failure stops actual driver")
    let failedSnapshot = controller.snapshot
    driver.emit(.progress(position: 99, duration: 999))
    driver.emit(.ended)
    driver.emit(.failed(.network))
    try leaseRequire(controller.snapshot == failedSnapshot, "late terminal notifications cannot mutate snapshot")
    let calls = await resolver.count()
    try leaseRequire(calls == 1 && driver.sources.count == 1, "terminal notifications cannot retry or advance")
}

@MainActor
private func leaseGenericFixtureWithoutPriorLeaseIsAllowed() async throws {
    let driver = LeaseFixtureDriver()
    let controller = NativePlaybackController(resolver: LeaseSequenceResolver([try genericLeaseFixtureSource()]), driver: driver)
    defer { controller.dispose() }
    try controller.setQueue([leaseTrack()], playing: true)
    try await leaseEventually("generic fixture without cached lease") { !driver.sources.isEmpty || controller.snapshot.status == .failed }
    try leaseRequire(driver.sources.count == 1 && controller.snapshot.status == .playing, "generic test double remains usable without cached lease")
}
