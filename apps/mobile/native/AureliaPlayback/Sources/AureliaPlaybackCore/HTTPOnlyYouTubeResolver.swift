import Foundation

/// Deliberately limited: direct AAC URLs only; no JS, cipher, n-transform,
/// cookie/login, remote resolver, attestation script, gateway or video fallback.
public struct HTTPOnlyYouTubeResolver: PlaybackResolving {
    private static let shared = BoundedPlaybackResolver(underlying: DirectResolver())
    public init() {}
    public func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        guard track.provider == .youtube else { throw PlaybackFailure.invalidTrack }
        return try await Self.shared.resolve(track)
    }
}

/// Exposed for deterministic transport contract tests, not arbitrary URL input.
public struct DirectResolver: PlaybackResolving {
    private let transport: any YouTubeHTTPTransport
    public init(transport: any YouTubeHTTPTransport = BoundedYouTubeHTTP()) { self.transport = transport }

    public func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        guard track.provider == .youtube else { throw PlaybackFailure.invalidTrack }
        var lastFailure: PlaybackFailure = .unavailable
        var firstDecodedFailure: PlaybackFailure?
        for profile in [ClientProfile.ios, .androidVR, .visionOS] {
            try Task.checkCancellation()
            var decodedSource = false
            do {
                var context: [String: Any] = profile.context
                if profile.identifier == "28" { context["androidSdkVersion"] = 32 }
                let data = try JSONSerialization.data(withJSONObject: [
                    "videoId": track.videoID, "contentCheckOk": true, "racyCheckOk": true,
                    "context": ["client": context],
                    "playbackContext": ["contentPlaybackContext": ["html5Preference": "HTML5_PREF_WANTS"]]
                ])
                var request = URLRequest(url: URL(string: "https://www.youtube.com/youtubei/v1/player?prettyPrint=false")!)
                request.httpMethod = "POST"; request.httpBody = data
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
                request.setValue(profile.userAgent, forHTTPHeaderField: "User-Agent")
                request.setValue(profile.identifier, forHTTPHeaderField: "X-Youtube-Client-Name")
                request.setValue(profile.version, forHTTPHeaderField: "X-Youtube-Client-Version")
                let response = try await transport.request(request, maxBytes: 1024 * 1024)
                let source = try Self.decode(response.body, expectedVideoID: track.videoID)
                decodedSource = true
                guard let length = source.contentLength, length >= 3072 else { throw PlaybackFailure.invalidResponse }
                for start in [0, length / 2 - 512, length - 1024] {
                    var rangedRequest = URLRequest(url: source.url)
                    rangedRequest.setValue("bytes=\(start)-\(start + 1023)", forHTTPHeaderField: "Range")
                    let sample = try await transport.request(rangedRequest, maxBytes: 1024)
                    try PartialMediaSample.validate(
                        sample,
                        expectedStart: start,
                        expectedEnd: start + 1023,
                        expectedTotal: length
                    )
                }
                return source
            } catch is CancellationError { throw CancellationError() }
            catch let failure as PlaybackFailure {
                if decodedSource && firstDecodedFailure == nil { firstDecodedFailure = failure }
                lastFailure = failure
            } catch {
                if decodedSource && firstDecodedFailure == nil { firstDecodedFailure = .invalidResponse }
                lastFailure = .invalidResponse
            }
        }
        throw firstDecodedFailure ?? lastFailure
    }

    private static func decode(_ data: Data, expectedVideoID: String) throws -> ResolvedAudio {
        guard data.count <= 1024 * 1024,
              let payload = try? JSONDecoder().decode(PlayerResponse.self, from: data) else { throw PlaybackFailure.invalidResponse }
        guard payload.playabilityStatus?.status == "OK" else { throw PlaybackFailure.sourceDenied }
        guard payload.videoDetails?.videoId == expectedVideoID else { throw PlaybackFailure.invalidResponse }
        guard payload.videoDetails?.isLiveContent != true else { throw PlaybackFailure.unavailable }
        let formats = (payload.streamingData?.adaptiveFormats ?? []).filter {
            $0.mimeType.hasPrefix("audio/mp4") && $0.mimeType.contains("mp4a") && ($0.drmFamilies?.isEmpty ?? true)
        }.sorted { ($0.bitrate ?? 0) > ($1.bitrate ?? 0) }
        var requiresScript = false
        var rejectedRange = false
        for format in formats {
            guard format.signatureCipher == nil, format.cipher == nil else { requiresScript = true; continue }
            guard let rawURL = format.url, let url = URL(string: rawURL), ResolvedAudio.isAllowed(url),
                  let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { continue }
            if components.queryItems?.contains(where: { $0.name == "n" }) == true { requiresScript = true; continue }
            if components.queryItems?.contains(where: { $0.name.caseInsensitiveCompare("range") == .orderedSame }) == true {
                rejectedRange = true
                continue
            }
            guard let rawExpiry = components.queryItems?.first(where: { $0.name == "expire" })?.value,
                  let expiry = TimeInterval(rawExpiry), expiry.isFinite,
                  let rawLength = format.contentLength, let length = Int(rawLength) else { continue }
            return try ResolvedAudio(
                url: url, expiresAt: Date(timeIntervalSince1970: expiry),
                bitrate: format.bitrate, contentLength: length
            )
        }
        if requiresScript { throw PlaybackFailure.scriptRequired }
        if rejectedRange { throw PlaybackFailure.invalidSource }
        throw PlaybackFailure.unavailable
    }
}

private struct ClientProfile: Sendable {
    let identifier: String
    let version: String
    let userAgent: String
    let context: [String: String]
    static let ios = ClientProfile(
        identifier: "5", version: "20.11.6",
        userAgent: "com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)",
        context: ["clientName": "iOS", "clientVersion": "20.11.6", "deviceMake": "Apple",
                  "deviceModel": "iPhone10,4", "osName": "iOS", "osVersion": "16.7.7.20H330", "hl": "en", "gl": "US"]
    )
    static let androidVR = ClientProfile(
        identifier: "28", version: "1.65.10",
        userAgent: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
        context: ["clientName": "ANDROID_VR", "clientVersion": "1.65.10", "deviceMake": "Oculus",
                  "deviceModel": "Quest 3", "osName": "Android", "osVersion": "12L", "hl": "en", "gl": "US"]
    )
    static let visionOS = ClientProfile(
        identifier: "101", version: "1.02",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
        context: ["clientName": "VISIONOS", "clientVersion": "1.02", "deviceMake": "Apple",
                  "deviceModel": "RealityDevice17,1", "osName": "visionOS", "osVersion": "26.5.23O471", "hl": "en", "gl": "US"]
    )
}

private struct PlayerResponse: Decodable {
    struct Details: Decodable { let videoId: String; let isLiveContent: Bool? }
    struct Status: Decodable { let status: String }
    struct Streaming: Decodable { let adaptiveFormats: [Format]? }
    struct Format: Decodable {
        let mimeType: String
        let url: String?
        let signatureCipher: String?
        let cipher: String?
        let contentLength: String?
        let bitrate: Int?
        let drmFamilies: [String]?
    }
    let videoDetails: Details?
    let playabilityStatus: Status?
    let streamingData: Streaming?
}
