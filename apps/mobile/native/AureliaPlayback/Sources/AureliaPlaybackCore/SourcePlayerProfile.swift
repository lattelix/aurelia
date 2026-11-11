import Foundation

/// Closed anonymous player profiles. Visitor context stays in these in-memory
/// native requests and is never serialized into snapshots or diagnostics.
enum SourcePlayerProfile {
    case web(version: String)
    // Maintained yt-dlp tv_samsung profile, checked 09 Nov 2026.
    case televisionSamsung

    func request(videoID: String, visitorData: String?, signatureTimestamp: Int?) throws -> URLRequest {
        let identifier: String
        let version: String
        let userAgent: String?
        var client: [String: Any]
        var contentContext: [String: Any] = [:]
        switch self {
        case .web(let validatedVersion):
            identifier = "1"; version = validatedVersion; userAgent = nil
            client = ["clientName": "WEB", "clientVersion": version, "hl": "en", "gl": "US"]
        case .televisionSamsung:
            identifier = "7"; version = "5.20260707"
            let televisionUserAgent = "Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1"
            userAgent = televisionUserAgent
            client = ["clientName": "TVHTML5", "clientVersion": version,
                      "deviceMake": "Samsung", "deviceModel": "UKS9800", "osName": "Tizen", "osVersion": "2.4.0",
                      "userAgent": televisionUserAgent, "hl": "en", "gl": "US"]
            contentContext["html5Preference"] = "HTML5_PREF_WANTS"
        }
        if let visitorData { client["visitorData"] = visitorData }
        if let signatureTimestamp { contentContext["signatureTimestamp"] = signatureTimestamp }
        var body: [String: Any] = [
            "videoId": videoID, "contentCheckOk": true, "racyCheckOk": true,
            "context": ["client": client]
        ]
        if !contentContext.isEmpty { body["playbackContext"] = ["contentPlaybackContext": contentContext] }
        var request = URLRequest(url: URL(string: "https://www.youtube.com/youtubei/v1/player?prettyPrint=false")!)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(identifier, forHTTPHeaderField: "X-Youtube-Client-Name")
        request.setValue(version, forHTTPHeaderField: "X-Youtube-Client-Version")
        request.setValue("https://www.youtube.com", forHTTPHeaderField: "Origin")
        if let userAgent { request.setValue(userAgent, forHTTPHeaderField: "User-Agent") }
        if let visitorData { request.setValue(visitorData, forHTTPHeaderField: "X-Goog-Visitor-Id") }
        return request
    }
}
