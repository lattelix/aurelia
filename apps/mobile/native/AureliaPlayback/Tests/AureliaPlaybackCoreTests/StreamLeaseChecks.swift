import Foundation
import AureliaPlaybackCore

private enum LeaseCheckFailure: Error { case assertion }
private func leaseRequire(_ value: @autoclosure () throws -> Bool) throws {
    guard try value() else { throw LeaseCheckFailure.assertion }
}

private let leaseFixtureQuery = "id=opaque-recording&itag=140&clen=1048576&expire=4000000000&lmt=1000&mime=audio%2Fmp4&source=youtube"
private func leaseFixture(
    _ locator: String? = nil,
    playerVideoID: String = "00000000001",
    expiry: Date = Date(timeIntervalSince1970: 4_000_000_000)
) throws -> VerifiedYouTubeStreamLease {
    guard let url = URL(string: locator ?? "https://r1.googlevideo.com/videoplayback?\(leaseFixtureQuery)") else {
        throw LeaseCheckFailure.assertion
    }
    return try VerifiedYouTubeStreamLease(
        requestedVideoID: "00000000001", playerVideoID: playerVideoID,
        itag: 140, mimeType: "audio/mp4; codecs=\"mp4a.40.2\"", contentLength: 1_048_576,
        url: url, expiresAt: expiry
    )
}

private func leaseExpectFailure(_ expected: PlaybackFailure, _ run: () throws -> Void) throws {
    var failure: PlaybackFailure?
    do { try run() } catch { failure = error as? PlaybackFailure }
    try leaseRequire(failure == expected)
}

func checkVerifiedYouTubeStreamLeases() throws {
    let original = try leaseFixture()
    try leaseRequire(original.requestedVideoID == "00000000001" && original.itag == 140)
    try leaseRequire(try ResolvedAudio.youtube(lease: original).youtubeLease?.contentLength == 1_048_576)
    try leaseExpectFailure(.invalidSource) { _ = try leaseFixture(playerVideoID: "00000000002") }
    let badLocators = [
        "http://r1.googlevideo.com/videoplayback?\(leaseFixtureQuery)",
        "https://r1.googlevideo.com.evil.example/videoplayback?\(leaseFixtureQuery)",
        "https://googlevideo.com/videoplayback?\(leaseFixtureQuery)",
        "https://user@r1.googlevideo.com/videoplayback?\(leaseFixtureQuery)",
        "https://r1.googlevideo.com:443/videoplayback?\(leaseFixtureQuery)",
        "https://r1.googlevideo.com/videoplayback/extra?\(leaseFixtureQuery)",
        "https://r1.googlevideo.com/%76ideoplayback?\(leaseFixtureQuery)",
        "https://r1.googlevideo.com/videoplayback?\(leaseFixtureQuery)#fragment",
        "https://r1.googlevideo.com/videoplayback?\(leaseFixtureQuery)&itag=140",
        "https://r1.googlevideo.com/videoplayback?\(leaseFixtureQuery)&%69tag=140",
        "https://r1.googlevideo.com/videoplayback?\(leaseFixtureQuery)&CLEN=1048576",
        "https://r1.googlevideo.com/videoplayback?\(leaseFixtureQuery)&range=0-15",
        "https://r1.googlevideo.com/videoplayback?\(leaseFixtureQuery)&begin=15",
        "https://r1.googlevideo.com/videoplayback?\(leaseFixtureQuery)&Cookie=forbidden"
    ]
    for value in badLocators { try leaseExpectFailure(.invalidSource) { _ = try leaseFixture(value) } }
    for change in [
        ("id=opaque-recording", "id="), ("itag=140", "itag=141"),
        ("clen=1048576", "clen=1048575"), ("clen=1048576", "clen=9999999999999999999999"),
        ("expire=4000000000", "expire=4000000001"),
        ("mime=audio%2Fmp4", "mime=video%2Fmp4"), ("lmt=1000", "lmt=not-numeric")
    ] {
        try leaseExpectFailure(.invalidSource) {
            _ = try leaseFixture("https://r1.googlevideo.com/videoplayback?" +
                leaseFixtureQuery.replacingOccurrences(of: change.0, with: change.1))
        }
    }
    try leaseExpectFailure(.expired) {
        let old = leaseFixtureQuery.replacingOccurrences(of: "expire=4000000000", with: "expire=1000")
        _ = try leaseFixture("https://r1.googlevideo.com/videoplayback?\(old)", expiry: Date(timeIntervalSince1970: 1000))
    }
    let redirected = URL(string: "https://r2.googlevideo.com/videoplayback?\(leaseFixtureQuery)&sig=new-signature")!
    try original.validatingRedirect(to: redirected)
    let renewed = try leaseFixture(redirected.absoluteString)
    try original.validatingRenewal(renewed)
    for (old, replacement) in [("id=opaque-recording", "id=another-recording"),
                               ("lmt=1000", "lmt=1001"), ("source=youtube", "source=other")] {
        let changed = "https://r2.googlevideo.com/videoplayback?" +
            leaseFixtureQuery.replacingOccurrences(of: old, with: replacement)
        try leaseExpectFailure(.invalidSource) { try original.validatingRedirect(to: URL(string: changed)!) }
        try leaseExpectFailure(.invalidSource) { try original.validatingRenewal(leaseFixture(changed)) }
    }
    try leaseExpectFailure(.invalidSource) {
        let withoutLMT = "https://r1.googlevideo.com/videoplayback?" +
            leaseFixtureQuery.replacingOccurrences(of: "&lmt=1000", with: "")
        try original.validatingRenewal(leaseFixture(withoutLMT))
    }

    let bounds = GuardedYouTubeByteSource.requestBounds
    try leaseRequire(try bounds(10, 15, 30, false, 100) == 15...39)
    try leaseRequire(try bounds(90, 90, 30, false, 100) == 90...99)
    try leaseRequire(try bounds(10, 20, 1, true, 100) == 20...99)
    try leaseRequire(try bounds(100, 100, 20, false, 100) == nil)
    try leaseExpectFailure(.invalidRequest) { _ = try bounds(-1, 0, 1, false, 100) }
    try leaseExpectFailure(.invalidRequest) { _ = try bounds(1, 1, Int.max, false, 100) }
}

private struct FixtureMediaHTTP: YouTubeHTTPTransport {
    enum Malice: Sendable, Equatable { case none, fullResponse, wrongRange, unknownTotal, wrongLength, duplicateLength, wrongMIME, redirect }
    let malice: Malice
    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        guard request.httpMethod == "GET", request.httpBody == nil,
              request.value(forHTTPHeaderField: "Authorization") == nil,
              request.value(forHTTPHeaderField: "Cookie") == nil,
              request.value(forHTTPHeaderField: "Accept-Encoding") == "identity",
              let range = PartialMediaSample.requestedRange(request.value(forHTTPHeaderField: "Range")),
              maxBytes == range.count, maxBytes <= 256 * 1024 else { throw LeaseCheckFailure.assertion }
        var headers = ["content-length": String(range.count),
                       "content-range": "bytes \(range.lowerBound)-\(range.upperBound)/1048576",
                       "content-type": "audio/mp4"]
        switch malice {
        case .wrongRange: headers["content-range"] = "bytes 1-16/1048576"
        case .unknownTotal: headers["content-range"] = "bytes \(range.lowerBound)-\(range.upperBound)/*"
        case .wrongLength: headers["content-length"] = String(range.count + 1)
        case .duplicateLength: headers["Content-Length"] = String(range.count)
        case .wrongMIME: headers["content-type"] = "video/mp4"
        default: break
        }
        return BoundedHTTPResponse(status: malice == .fullResponse ? 200 : malice == .redirect ? 302 : 206,
                                   headers: headers, body: Data(repeating: 7, count: range.count))
    }
}

/// Ignores cancellation intentionally so checks can prove physical admission.
private actor HoldingMediaHTTP: YouTubeHTTPTransport {
    private var pending: [CheckedContinuation<BoundedHTTPResponse, Never>] = []
    private var started = 0
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []
    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        started += 1
        let ready = waiters.filter { $0.0 <= started }
        waiters.removeAll { $0.0 <= started }
        ready.forEach { $0.1.resume() }
        return await withCheckedContinuation { pending.append($0) }
    }
    func waitForStarted(_ count: Int) async {
        if started >= count { return }
        await withCheckedContinuation { waiters.append((count, $0)) }
    }
    func finish() {
        let callbacks = pending; pending.removeAll()
        callbacks.forEach { $0.resume(returning: BoundedHTTPResponse(
            status: 206, headers: ["content-length": "16", "content-range": "bytes 0-15/1048576",
                                  "content-type": "audio/mp4"], body: Data(repeating: 7, count: 16)
        )) }
    }
}

private actor CountingMediaHTTP: YouTubeHTTPTransport {
    private var calls = 0
    private var malice: FixtureMediaHTTP.Malice
    init(_ malice: FixtureMediaHTTP.Malice = .none) { self.malice = malice }
    func setMalice(_ value: FixtureMediaHTTP.Malice) { malice = value }
    func count() -> Int { calls }
    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        calls += 1
        return try await FixtureMediaHTTP(malice: malice).request(request, maxBytes: maxBytes)
    }
}

private final class LeaseCheckClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date(timeIntervalSince1970: 3_999_999_990)
    func now() -> Date { lock.lock(); defer { lock.unlock() }; return value }
    func advancePastExpiry() { lock.lock(); value = Date(timeIntervalSince1970: 4_000_000_001); lock.unlock() }
}

func checkValidatedByteSourceCache() async throws {
    let lease = try leaseFixture()
    let transport = CountingMediaHTTP()
    let source = GuardedYouTubeByteSource(lease: lease, transport: transport)
    _ = try await source.read(0...15)
    _ = try await source.read(16...31)
    let stitched = try await source.read(4...27)
    try leaseRequire(stitched == Data(repeating: 7, count: 24))
    let reused = await transport.count()
    try leaseRequire(reused == 2)
    try await source.renew(lease)
    _ = try await source.read(4...27)
    let refreshed = await transport.count()
    try leaseRequire(refreshed == 3)
    await source.invalidate()
    try await expectByteFailure(.staleRequest, source: source, range: 4...27)

    let poisonedTransport = CountingMediaHTTP(.wrongRange)
    let poisoned = GuardedYouTubeByteSource(lease: lease, transport: poisonedTransport)
    try await expectByteFailure(.invalidResponse, source: poisoned)
    await poisonedTransport.setMalice(.none)
    _ = try await poisoned.read(0...15)
    _ = try await poisoned.read(4...11)
    let validated = await poisonedTransport.count()
    try leaseRequire(validated == 2)
    await poisoned.invalidate()

    let clock = LeaseCheckClock()
    let timedTransport = CountingMediaHTTP()
    let timed = GuardedYouTubeByteSource(lease: lease, transport: timedTransport, now: { clock.now() })
    _ = try await timed.read(0...15)
    clock.advancePastExpiry()
    try await expectByteFailure(.expired, source: timed, range: 4...11)
    let expiryCalls = await timedTransport.count()
    try leaseRequire(expiryCalls == 1)
    await timed.invalidate()
}

private func expectByteFailure(
    _ expected: PlaybackFailure, source: GuardedYouTubeByteSource, range: ClosedRange<Int> = 0...15
) async throws {
    var failure: PlaybackFailure?
    do { _ = try await source.read(range) } catch { failure = error as? PlaybackFailure }
    try leaseRequire(failure == expected)
}

func checkGuardedYouTubeByteSource() async throws {
    let lease = try leaseFixture()
    let valid = GuardedYouTubeByteSource(lease: lease, transport: FixtureMediaHTTP(malice: .none))
    let first = try await valid.read(0...15)
    let middle = try await valid.read(524_288...524_303)
    let tail = try await valid.read(1_048_560...1_048_575)
    try leaseRequire(first == middle && middle == tail && tail.count == 16)
    try await expectByteFailure(.invalidRequest, source: valid, range: 0...262_144)
    try await expectByteFailure(.invalidRequest, source: valid, range: 1_048_575...1_048_576)
    for malice in [FixtureMediaHTTP.Malice.fullResponse, .wrongRange, .unknownTotal,
                   .wrongLength, .duplicateLength, .wrongMIME, .redirect] {
        let source = GuardedYouTubeByteSource(lease: lease, transport: FixtureMediaHTTP(malice: malice))
        try await expectByteFailure(.invalidResponse, source: source)
        await source.invalidate()
    }
    let expired = GuardedYouTubeByteSource(lease: lease, transport: FixtureMediaHTTP(malice: .none),
                                         now: { Date(timeIntervalSince1970: 4_000_000_001) })
    try await expectByteFailure(.expired, source: expired)

    let transport = HoldingMediaHTTP()
    let source = GuardedYouTubeByteSource(lease: lease, transport: transport)
    let reads = (0..<4).map { _ in Task { try await source.read(0...15) } }
    await transport.waitForStarted(4)
    try await expectByteFailure(.busy, source: source)
    reads[0].cancel()
    try await expectByteFailure(.busy, source: source)
    await transport.finish()
    var cancelled = false
    do { _ = try await reads[0].value } catch is CancellationError { cancelled = true }
    try leaseRequire(cancelled)
    for read in reads.dropFirst() { _ = try await read.value }
    await source.invalidate()
    try await expectByteFailure(.staleRequest, source: source)

    let lateTransport = HoldingMediaHTTP()
    let lateSource = GuardedYouTubeByteSource(lease: lease, transport: lateTransport)
    let late = Task { try await lateSource.read(0...15) }
    await lateTransport.waitForStarted(1)
    await lateSource.invalidate()
    await lateTransport.finish()
    var stale: PlaybackFailure?
    do { _ = try await late.value } catch { stale = error as? PlaybackFailure }
    try leaseRequire(stale == .staleRequest)

    let renewalTransport = HoldingMediaHTTP()
    let renewing = GuardedYouTubeByteSource(lease: lease, transport: renewalTransport)
    let oldRead = Task { try await renewing.read(0...15) }
    await renewalTransport.waitForStarted(1)
    try await renewing.renew(leaseFixture("https://r2.googlevideo.com/videoplayback?\(leaseFixtureQuery)"))
    await renewalTransport.finish()
    var oldGeneration: PlaybackFailure?
    do { _ = try await oldRead.value } catch { oldGeneration = error as? PlaybackFailure }
    try leaseRequire(oldGeneration == .staleRequest)
    await renewing.invalidate()
}
