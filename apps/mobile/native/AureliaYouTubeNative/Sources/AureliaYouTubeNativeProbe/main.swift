import Foundation
import CryptoKit
import AureliaPlaybackCore
import AureliaYouTubeNative
import Darwin

private final class CipherWorkerObservation: @unchecked Sendable {
    private let lock = NSLock()
    private var observed = false
    private var invalid = false
    func record() { lock.withLock {
        observed = true
        invalid = invalid || Thread.isMainThread || pthread_get_stacksize_np(pthread_self()) < 8 * 1024 * 1024
    } }
    func valid() -> Bool { lock.withLock { observed && !invalid } }
}

private final class CipherWorkerGate: @unchecked Sendable {
    private let condition = NSCondition()
    private var entered = false, released = false
    func hold() {
        condition.lock(); defer { condition.unlock() }
        entered = true
        let deadline = Date().addingTimeInterval(2)
        while !released { if !condition.wait(until: deadline) { break } }
    }
    func hasEntered() -> Bool { condition.lock(); defer { condition.unlock() }; return entered }
    func release() { condition.lock(); released = true; condition.broadcast(); condition.unlock() }
}

private final class ProofDiagnostics: @unchecked Sendable {
    private let lock = NSLock()
    private let started = ProcessInfo.processInfo.systemUptime
    private var records: [String] = []
    func append(_ record: String) { lock.withLock {
        if records.count < 32 { records.append(record + ":ms=\(Int((ProcessInfo.processInfo.systemUptime - started) * 1000))") }
    } }
    func snapshot() -> [String] { lock.withLock { records } }
}

private actor ProofHTTP: YouTubeHTTPTransport {
    private let actual: PlayerSourceHTTP
    let records: ProofDiagnostics
    let capturePlayer: Bool
    init(records: ProofDiagnostics, capturePlayer: Bool) {
        self.records = records; self.capturePlayer = capturePlayer
        actual = PlayerSourceHTTP(diagnostic: { event in
            switch event {
            case .response(let status) where status != 200 && status != 206:
                records.append("http:rejectedStatus=\(status)")
            case .redirect(let status): records.append("http:refusedRedirect=\(status)")
            default: break
            }
        })
    }
    func diagnostics() -> [String] { records.snapshot() }
    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        let route: String
        switch request.url?.path {
        case "/watch": route = "watch"
        case "/youtubei/v1/player": route = "player"
        default: route = request.url?.path.hasSuffix("/base.js") == true ? "script" : "media"
        }
        do {
            let response = try await actual.request(request, maxBytes: maxBytes)
            records.append("\(route):status=\(response.status):bytes=\(response.body.count)")
            if route == "script" {
                let path = request.url?.path ?? ""
                let variant = path.contains("/player_es6.vflset/") ? "es6" : (path.contains("/player_ias.vflset/") ? "ias" : "other")
                records.append("script:variant=\(variant)")
            }
            if route == "script", capturePlayer, response.status == 200 {
                // Only the generic public player script, never watch/player
                // JSON, locators, visitor context or audio. Fixed local path.
                let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
                let folder = root.appendingPathComponent(".runtime", isDirectory: true)
                let file = folder.appendingPathComponent("apple-native-player-fixture.js")
                guard FileManager.default.fileExists(atPath: root.appendingPathComponent("apps/mobile/native/AureliaYouTubeNative/Package.swift").path),
                      folder.resolvingSymlinksInPath().standardizedFileURL == folder.standardizedFileURL,
                      file.resolvingSymlinksInPath().standardizedFileURL == file.standardizedFileURL,
                      response.body.count <= 8 * 1024 * 1024 else { throw PlaybackFailure.invalidRequest }
                try response.body.write(to: file, options: .atomic)
                records.append("script:sha256=\(SHA256.hash(data: response.body).map { String(format: "%02x", $0) }.joined())")
            }
            if route == "watch" {
                let headers = response.headers.reduce(into: [String: String]()) { $0[$1.key.lowercased()] = $1.value }
                let length = headers["content-length"].flatMap(Int.init)
                let matches = length == nil ? "absent" : (length == response.body.count ? "match" : "mismatch")
                let html = headers["content-type"]?.lowercased().hasPrefix("text/html") == true
                records.append("watch:length=\(matches):html=\(html ? 1 : 0):utf8=\(String(data: response.body, encoding: .utf8) != nil ? 1 : 0)")
            }
            if route == "media", request.value(forHTTPHeaderField: "Range") == "bytes=0-1023" {
                let bytes = [UInt8](response.body)
                var offset = 0, hasMovie = false, hasMedia = false
                for _ in 0..<8 {
                    guard offset + 8 <= bytes.count else { break }
                    let size = bytes[offset..<(offset + 4)].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
                    let type = bytes[(offset + 4)..<(offset + 8)]
                    if type.elementsEqual([109, 111, 111, 118]) { hasMovie = true }
                    if type.elementsEqual([109, 100, 97, 116]) { hasMedia = true }
                    guard size >= 8, size <= UInt64(bytes.count - offset) else { break }
                    offset += Int(size)
                }
                records.append("mp4:movieInPrefix=\(hasMovie ? 1 : 0):mediaInPrefix=\(hasMedia ? 1 : 0)")
            }
            return response
        } catch {
            records.append("\(route):error=\((error as? PlaybackFailure)?.rawValue ?? "network")")
            throw error
        }
    }
}

private final class WholeHTTPDiagnostics: @unchecked Sendable {
    private let lock = NSLock()
    private var responses = 0, redirects = 0, rejected = 0
    func accept(_ event: YouTubeHTTPDiagnostic) { lock.withLock {
        switch event {
        case .response(let status):
            responses += 1
            if status != 200 && status != 206 { rejected = status }
        case .redirect(let status): redirects += 1; rejected = status
        }
    } }
    func snapshot() -> String { lock.withLock { "wholeHTTP:responses=\(responses):redirects=\(redirects):rejectedStatus=\(rejected)" } }
}

private struct ProofReport: Encodable {
    let status: String
    let phase: String
    let reason: String?
    let bytes: Int?
    let wholeAndRanges: Bool
    let nativeProgress: Bool
    let nativeSeek: Bool
    let diagnostics: [String]
}

@MainActor private final class MediaProofDiagnostics {
    private var requests = 0, delivered = 0, cancelled = 0
    private var details: [String] = []
    func accept(_ event: NativeMediaDiagnostic) {
        let detail: String?
        switch event {
        case let .loading(offset, length, toEnd, information):
            requests += 1
            detail = requests <= 4 ? "loader:offset=\(offset):length=\(length):toEnd=\(toEnd ? 1 : 0):info=\(information ? 1 : 0)" : nil
        case .delivered(let count): delivered += count; detail = nil
        case .cancelled: cancelled += 1; detail = nil
        case .failure(let failure): detail = "loader:error=\(failure.rawValue)"
        case .status(let status): detail = "av:status=\(status):delivered=\(delivered)"
        case let .error(domain, code): detail = "av:error=\(domain.rawValue):code=\(code)"
        case let .contentTypes(m4a, mp4, audio, unrestricted):
            detail = "av:allowedM4A=\(m4a ? 1 : 0):allowedMP4=\(mp4 ? 1 : 0):allowedAudio=\(audio ? 1 : 0):unrestricted=\(unrestricted ? 1 : 0)"
        }
        if let detail, details.count < 24 { details.append(detail) }
    }
    func snapshot() -> [String] {
        details + ["loader:requests=\(requests):delivered=\(delivered):cancelled=\(cancelled)"]
    }
    func markProgress() { if details.count < 24 { details.append("loader:deliveredAtProgress=\(delivered)") } }
}

@main private struct NativeSourceProbe {
    @MainActor static func main() async {
        let mode = CommandLine.arguments.dropFirst()
        if mode == ["--offline-live"] {
            if !(await runManagedOfflineLiveProof()) { exit(1) }
            return
        }
        if mode == ["--cipher-checks"] {
            do { try await checkCipher(); print("PASS serialized native cipher adapter") }
            catch { print("FAIL native cipher adapter"); exit(1) }
            return
        }
        guard mode == ["--resolve-only"] || mode == ["--live"] || mode == ["--capture-player"] || mode == ["--player-only"] else {
            print("Choose --cipher-checks, --resolve-only, --player-only, --capture-player or --live.")
            exit(2)
        }
        let records = ProofDiagnostics()
        let http = ProofHTTP(records: records, capturePlayer: mode == ["--capture-player"])
        let mediaProof = MediaProofDiagnostics()
        let wholeHTTP = WholeHTTPDiagnostics()
        var phase = "resolve"
        var length: Int?
        var wholeVerified = false
        var progress = false
        var seek = false
        var controller: NativePlaybackController?
        defer { controller?.dispose() }
        do {
            // The official Blender Big Buck Bunny fixture is CC BY 3.0.
            let track = try PlaybackTrack(videoID: "aqz-KE-bpKQ", title: "Public CC source proof", artist: "Blender Foundation")
            let resolver = PortableYouTubeResolver(transport: http, cipherSolver: NativeYouTubeCipherSolver(diagnostic: { records.append("cipher:\($0.rawValue)") }), deadline: 25,
                diagnostic: { records.append("step:\($0.rawValue)") })
            let source = try await resolver.resolve(track)
            guard let lease = source.youtubeLease, lease.contentLength <= 32 * 1024 * 1024 else {
                throw PlaybackFailure.invalidResponse
            }
            length = lease.contentLength
            if mode == ["--live"] {
                phase = "whole"
                let bytes = GuardedYouTubeByteSource(lease: lease,
                    transport: BoundedYouTubeHTTP(diagnostic: { wholeHTTP.accept($0) }))
                let starts = [0, lease.contentLength / 2 - 512, lease.contentLength - 1024]
                var expected: [Data] = []
                for start in starts { expected.append(try await bytes.read(start...(start + 1023))) }
                var observed = Array(repeating: Data(), count: 3)
                var offset = 0
                let deadline = ProcessInfo.processInfo.systemUptime + 90
                while offset < lease.contentLength {
                    guard ProcessInfo.processInfo.systemUptime < deadline else { throw PlaybackFailure.network }
                    let end = min(lease.contentLength - 1, offset + GuardedYouTubeByteSource.maximumChunkBytes - 1)
                    let data = try await bytes.read(offset...end)
                    for index in starts.indices {
                        let start = max(offset, starts[index]), stop = min(end + 1, starts[index] + 1024)
                        if stop > start { observed[index].append(data.subdata(in: (start - offset)..<(stop - offset))) }
                    }
                    offset = end + 1
                }
                guard zip(expected, observed).allSatisfy({ SHA256.hash(data: $0.0) == SHA256.hash(data: $0.1) }) else {
                    throw PlaybackFailure.invalidResponse
                }
                await bytes.invalidate(); wholeVerified = true
            }
            if mode == ["--live"] || mode == ["--player-only"] {
                phase = "avplayer"
                struct Fixed: PlaybackResolving {
                    let source: ResolvedAudio
                    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio { source }
                }
                let player = NativePlaybackController(resolver: Fixed(source: source), driver: AVPlayerDriver(volume: 0,
                    diagnostic: { mediaProof.accept($0) }))
                controller = player
                try player.setQueue([track], playing: true)
                try await waitForProgress(player, after: 1)
                progress = true
                mediaProof.markProgress()
                records.append("proof:progress")
                let target = max(2, min(30, player.snapshot.duration / 2))
                player.seek(to: target)
                try await waitForProgress(player, after: target + 0.5)
                seek = true; player.pause()
                records.append("proof:seek")
            }
            emit(ProofReport(status: "passed", phase: phase, reason: nil, bytes: length,
                             wholeAndRanges: wholeVerified, nativeProgress: progress, nativeSeek: seek,
                             diagnostics: await http.diagnostics() + [wholeHTTP.snapshot()] + mediaProof.snapshot()))
        } catch {
            controller?.dispose()
            emit(ProofReport(status: "failed", phase: phase,
                             reason: (error as? PlaybackFailure)?.rawValue ?? "network", bytes: length,
                             wholeAndRanges: wholeVerified, nativeProgress: progress, nativeSeek: seek,
                             diagnostics: await http.diagnostics() + [wholeHTTP.snapshot()] + mediaProof.snapshot()))
            exit(1)
        }
    }

    @MainActor private static func waitForProgress(_ controller: NativePlaybackController, after position: Double) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 25
        while ProcessInfo.processInfo.systemUptime < deadline {
            if controller.snapshot.status == .failed { throw controller.snapshot.failure ?? .decoder }
            if controller.snapshot.position > position { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw PlaybackFailure.decoder
    }

    private static func emit(_ report: ProofReport) {
        if let data = try? JSONEncoder().encode(report) { print(String(decoding: data, as: UTF8.self)) }
    }

    private static func checkCipher() async throws {
        let fixture = Data("""
        var g={};var table='V;prototype;get;set'.split(';');
        var sig=function(x){return x.split('').reverse().join('');};
        g.C=function(raw,enabled){this.raw=raw;this.enabled=enabled;this[table[0]]={};};
        g.C[table[1]][table[3]]=function(k,v){this.V[k]=v;};
        g.C[table[1]][table[2]]=function(k){applyN(7,19,this);return this.V[k];};
        var applyN=function(a,b,o){var key=a^b;if(key==20){o.set('n',o.V.n.split('').reverse().join(''));}};
        var decode=function(a,b,x){return x;};
        var landmark=function(M,k,X){M=new g.C(M,!0);M.set("alr","yes");X&&(X=sig2(11,3932,decode(3,673,X)));};
        var sig2=function(a,b,x){return sig(x);};var settings={signatureTimestamp:20724};
        """.utf8)
        let worker = CipherWorkerObservation()
        let solver = NativeYouTubeCipherSolver(diagnostic: { _ in worker.record() })
        guard try await solver.signatureTimestamp(playerJavaScript: fixture) == 20724 else { throw PlaybackFailure.invalidResponse }
        for _ in 0..<3 {
            let result = try await solver.solve(playerJavaScript: fixture, signature: "abcdef", n: "123xyz", videoID: "00000000001")
            guard result.signature == "fedcba", result.n == "zyx321" else { throw PlaybackFailure.invalidResponse }
        }
        let cancelled = Task { () throws -> Int? in
            try Task.checkCancellation()
            return try await solver.signatureTimestamp(playerJavaScript: fixture)
        }
        cancelled.cancel()
        do { _ = try await cancelled.value; throw PlaybackFailure.invalidResponse }
        catch is CancellationError {}
        let valid = try await solver.solve(playerJavaScript: fixture, signature: nil, n: "abc", videoID: "00000000001")
        guard valid.n == "cba", valid.signature == nil else { throw PlaybackFailure.invalidResponse }
        guard worker.valid() else { throw PlaybackFailure.invalidResponse }
        print("PASS native worker stack and cancellation")

        let gate = CipherWorkerGate()
        defer { gate.release() }
        let gatedSolver = NativeYouTubeCipherSolver(diagnostic: { step in if step == .compiled { gate.hold() } })
        let running = Task { try await gatedSolver.signatureTimestamp(playerJavaScript: fixture) }
        for _ in 0..<100 {
            if gate.hasEntered() { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        guard gate.hasEntered() else { running.cancel(); throw PlaybackFailure.invalidResponse }
        running.cancel()
        do {
            _ = try await gatedSolver.signatureTimestamp(playerJavaScript: fixture)
            throw PlaybackFailure.invalidResponse
        } catch PlaybackFailure.busy {}
        gate.release()
        do { _ = try await running.value; throw PlaybackFailure.invalidResponse }
        catch is CancellationError {}
        guard try await gatedSolver.signatureTimestamp(playerJavaScript: fixture) == 20724 else { throw PlaybackFailure.invalidResponse }
        print("PASS cancelled native worker retains physical admission")
    }
}
