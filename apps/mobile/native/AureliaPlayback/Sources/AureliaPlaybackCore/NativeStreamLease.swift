import Foundation

/// A memory-only capability for one AAC recording. The opaque CDN `id` is not
/// the YouTube video ID; both identities are checked at their own boundary.
/// Deliberately not Codable, CustomStringConvertible, or included in snapshots.
public struct VerifiedYouTubeStreamLease: Sendable {
    public let requestedVideoID: String
    public let playerVideoID: String
    public let itag: Int
    public let mimeType: String
    public let contentLength: Int
    public let expiresAt: Date
    public let bitrate: Int?
    let url: URL
    private let identity: Identity

    private struct Identity: Sendable, Equatable {
        let id: String
        let itag: Int
        let contentLength: Int
        let lastModified: String?
        let mime: String?
        let source: String?
    }

    public init(
        requestedVideoID: String,
        playerVideoID: String,
        itag: Int,
        mimeType: String,
        contentLength: Int,
        url: URL,
        expiresAt: Date,
        bitrate: Int? = nil,
        now: Date = Date()
    ) throws {
        guard requestedVideoID.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil,
              requestedVideoID == playerVideoID,
              [139, 140, 141].contains(itag), Self.isAAC(mimeType),
              contentLength > 0, contentLength <= 128 * 1024 * 1024,
              bitrate.map({ $0 > 0 && $0 <= 10_000_000 }) ?? true,
              now.timeIntervalSince1970.isFinite,
              expiresAt.timeIntervalSince1970.isFinite else { throw PlaybackFailure.invalidSource }
        let parsed = try Self.parse(url)
        guard parsed.identity.itag == itag, parsed.identity.contentLength == contentLength,
              expiresAt.timeIntervalSince1970 <= parsed.expiry,
              parsed.expiry - expiresAt.timeIntervalSince1970 < 1 else { throw PlaybackFailure.invalidSource }
        guard expiresAt > now else { throw PlaybackFailure.expired }
        self.requestedVideoID = requestedVideoID; self.playerVideoID = playerVideoID
        self.itag = itag; self.mimeType = mimeType; self.contentLength = contentLength
        self.url = url; self.expiresAt = expiresAt; self.bitrate = bitrate
        self.identity = parsed.identity
    }

    /// Renewal may change the signing material and CDN host, never the recording.
    public func validatingRenewal(
        _ replacement: VerifiedYouTubeStreamLease, now: Date = Date()
    ) throws {
        guard replacement.requestedVideoID == requestedVideoID,
              replacement.playerVideoID == playerVideoID,
              replacement.itag == itag, replacement.contentLength == contentLength,
              replacement.expiresAt >= expiresAt,
              Self.normalizedMIME(replacement.mimeType) == Self.normalizedMIME(mimeType),
              replacement.identity == identity else { throw PlaybackFailure.invalidSource }
        guard now.timeIntervalSince1970.isFinite, replacement.expiresAt > now else {
            throw PlaybackFailure.expired
        }
    }

    /// A redirect-capable transport must call this for *every* hop before I/O.
    /// The shipping bounded transport currently refuses all redirects instead.
    public func validatingRedirect(to candidate: URL, now: Date = Date()) throws {
        let parsed = try Self.parse(candidate)
        guard parsed.identity == identity,
              now.timeIntervalSince1970.isFinite,
              parsed.expiry >= expiresAt.timeIntervalSince1970 else { throw PlaybackFailure.invalidSource }
        guard expiresAt > now else { throw PlaybackFailure.expired }
    }

    static func normalizedMIME(_ value: String) -> String {
        value.lowercased().filter { !$0.isWhitespace }
    }

    static func isAAC(_ value: String) -> Bool {
        let value = normalizedMIME(value)
        return value == "audio/mp4;codecs=\"mp4a.40.2\""
            || value == "audio/mp4;codecs=\"mp4a.40.5\""
    }

    static func decimal(_ value: String) -> Int? {
        guard !value.isEmpty else { return nil }
        var number = 0
        for digit in value.utf8 {
            guard digit >= 48, digit <= 57, number <= (Int.max - Int(digit - 48)) / 10 else { return nil }
            number = number * 10 + Int(digit - 48)
        }
        return number
    }

    private static func parse(_ url: URL) throws -> (identity: Identity, expiry: Double) {
        guard url.absoluteString.utf8.count <= 16 * 1024,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", let host = parts.host?.lowercased(),
              host.hasSuffix(".googlevideo.com"), host.count > ".googlevideo.com".count,
              host.range(of: "^[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.googlevideo\\.com$", options: .regularExpression) != nil,
              parts.percentEncodedPath == "/videoplayback",
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
              let items = parts.queryItems, items.count <= 100 else { throw PlaybackFailure.invalidSource }
        var fields: [String: String] = [:]
        for item in items {
            let name = item.name.lowercased()
            guard !name.isEmpty, name.count <= 100, fields[name] == nil,
                  let value = item.value, value.count <= 8192,
                  !["range", "begin", "sq", "authorization", "cookie"].contains(name) else {
                throw PlaybackFailure.invalidSource
            }
            fields[name] = value
        }
        guard let id = fields["id"], !id.isEmpty, id.count <= 256,
              id.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }),
              let rawItag = fields["itag"], let itag = decimal(rawItag),
              let rawLength = fields["clen"], let length = decimal(rawLength), length > 0,
              let rawExpiry = fields["expire"], let expiry = decimal(rawExpiry), expiry > 0,
              fields["lmt"].map({ decimal($0) != nil }) ?? true,
              fields["mime"].map({ $0.lowercased() == "audio/mp4" }) ?? true,
              fields["source"].map({ !$0.isEmpty && $0.count <= 100 }) ?? true else {
            throw PlaybackFailure.invalidSource
        }
        return (Identity(id: id, itag: itag, contentLength: length,
                         lastModified: fields["lmt"], mime: fields["mime"], source: fields["source"]), Double(expiry))
    }
}
