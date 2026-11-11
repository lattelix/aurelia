import Foundation
import CryptoKit
import AureliaPlaybackCore

private struct ProofReport: Encodable {
    let status: String
    let reason: String?
    let bytes: Int?
    let bitrate: Int?
    let wholeAndRanges: Bool
    let nativeProgress: Bool
    let nativeSeek: Bool
    let phase: String
    let diagnostics: [String]
}

actor DiagnosticHTTP: YouTubeHTTPTransport {
    private let upstream: any YouTubeHTTPTransport
    private var entries: [String] = []
    init(upstream: any YouTubeHTTPTransport = BoundedYouTubeHTTP()) {
        self.upstream = upstream
    }
    func records() -> [String] { entries }
    private func record(_ entry: String) {
        guard entries.count < 10, entry.count <= 160 else { return }
        entries.append(entry)
    }
    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        let player = request.url?.host == "www.youtube.com"
        do {
            let response = try await upstream.request(request, maxBytes: maxBytes)
            if player, let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any] {
                let rawStatus = (object["playabilityStatus"] as? [String: Any])?["status"] as? String ?? "MISSING"
                let status = ["OK", "ERROR", "LOGIN_REQUIRED", "UNPLAYABLE", "MISSING"].contains(rawStatus) ? rawStatus : "OTHER"
                let formats = (object["streamingData"] as? [String: Any])?["adaptiveFormats"] as? [[String: Any]] ?? []
                let audio = formats.filter { ($0["mimeType"] as? String)?.hasPrefix("audio/mp4") == true }
                let direct = audio.filter { $0["url"] is String }
                let withN = direct.filter { item in
                    guard let raw = item["url"] as? String, let parts = URLComponents(string: raw) else { return false }
                    return parts.queryItems?.contains { $0.name == "n" } == true
                }
                record("player:\(status):formats=\(formats.count):audio=\(audio.count):direct=\(direct.count):n=\(withN.count)")
            } else if let requested = PartialMediaSample.requestedRange(
                request.value(forHTTPHeaderField: "Range")
            ) {
                record(PartialMediaSample.safeDiagnostic(response, requested: requested))
            } else {
                record("media:stage=whole:status=\(response.status):bytes=\(response.body.count)")
            }
            return response
        } catch {
            record("\(player ? "player" : "media"):error=\((error as? PlaybackFailure)?.rawValue ?? "network")")
            throw error
        }
    }
}

@MainActor
func httpOnlyLiveCheck() async -> Bool {
    let driver = AVPlayerDriver(volume: 0)
    var playback: NativePlaybackController?
    let diagnostics = DiagnosticHTTP()
    var phase = "resolve"
    defer { playback?.dispose() }
    do {
        // Verified official Blender upload; Sintel is CC BY 3.0. No arbitrary video argument.
        let track = try PlaybackTrack(videoID: "eRsGyueVLvQ", title: "Sintel public CC test", artist: "Blender Foundation")
        let source = try await DirectResolver(transport: diagnostics).resolve(track)
        guard let length = source.contentLength, length <= 32 * 1024 * 1024 else { throw PlaybackFailure.invalidResponse }
        let http = diagnostics
        var expected: [Data] = []
        let starts = [0, length / 2 - 512, length - 1024]
        phase = "ranges"
        for start in starts {
            var request = URLRequest(url: source.url)
            request.setValue("bytes=\(start)-\(start + 1023)", forHTTPHeaderField: "Range")
            let response = try await http.request(request, maxBytes: 1024)
            try PartialMediaSample.validate(
                response,
                expectedStart: start,
                expectedEnd: start + 1023,
                expectedTotal: length
            )
            expected.append(response.body)
        }
        phase = "whole"
        let whole = try await http.request(URLRequest(url: source.url), maxBytes: length)
        guard whole.body.count == length else { throw PlaybackFailure.invalidResponse }
        for (index, start) in starts.enumerated() {
            guard SHA256.hash(data: whole.body.subdata(in: start..<(start + 1024)))
                == SHA256.hash(data: expected[index]) else { throw PlaybackFailure.invalidResponse }
        }
        struct FixedResolver: PlaybackResolving {
            let source: ResolvedAudio
            func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio { source }
        }
        let controller = NativePlaybackController(resolver: FixedResolver(source: source), driver: driver)
        phase = "avplayer"
        playback = controller
        try controller.setQueue([track], playing: true)
        let deadline = Date().addingTimeInterval(25)
        while controller.snapshot.position < 1 && Date() < deadline {
            if controller.snapshot.status == .failed { throw PlaybackFailure.decoder }
            try await Task.sleep(for: .milliseconds(100))
        }
        guard controller.snapshot.position >= 1 else { throw PlaybackFailure.decoder }
        controller.seek(to: 30)
        let seekDeadline = Date().addingTimeInterval(15)
        while (controller.snapshot.position <= 30.5 || controller.snapshot.position > 45) && Date() < seekDeadline {
            if controller.snapshot.status == .failed { throw PlaybackFailure.decoder }
            try await Task.sleep(for: .milliseconds(100))
        }
        guard controller.snapshot.position > 30.5 && controller.snapshot.position < 45 else { throw PlaybackFailure.decoder }
        controller.stop()
        emitProof(ProofReport(status: "passed", reason: nil, bytes: length, bitrate: source.bitrate,
                              wholeAndRanges: true, nativeProgress: true, nativeSeek: true,
                              phase: phase, diagnostics: await diagnostics.records()))
        return true
    } catch {
        emitProof(ProofReport(status: "failed", reason: (error as? PlaybackFailure)?.rawValue ?? "network",
                              bytes: nil, bitrate: nil, wholeAndRanges: false, nativeProgress: false, nativeSeek: false,
                              phase: phase, diagnostics: await diagnostics.records()))
        return false
    }
}

private func emitProof(_ report: ProofReport) {
    if let data = try? JSONEncoder().encode(report), let line = String(data: data, encoding: .utf8) { print(line) }
}
