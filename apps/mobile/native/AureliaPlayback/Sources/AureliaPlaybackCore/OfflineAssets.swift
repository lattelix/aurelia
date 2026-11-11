import Foundation
import ImageIO

/// Public music metadata only. No URL, request headers, account IDs or stream
/// capabilities can be represented by this persistent asset contract.
public struct OfflineAssetsPayload: Codable, Sendable, Equatable {
    public let album: String
    public let duration: Double
    public let coverJPEG: Data?
    public let plainLyrics: String?
    public let syncedLyrics: String?
    /// Missing in older files. An attempted optional enrichment is recorded
    /// even when a cover/lyrics source had no result, avoiding cold-start loops.
    public let enrichmentComplete: Bool?
    public var isEnriched: Bool { enrichmentComplete == true }
    public init(album: String, duration: Double, coverJPEG: Data? = nil,
                plainLyrics: String? = nil, syncedLyrics: String? = nil, enrichmentComplete: Bool? = false) throws {
        self.album = album; self.duration = duration; self.coverJPEG = coverJPEG
        self.plainLyrics = plainLyrics; self.syncedLyrics = syncedLyrics
        self.enrichmentComplete = enrichmentComplete
        try OfflineAssetsCodec.validate(self)
    }
}
public struct OfflineStoredAssets: Sendable {
    public let payload: OfflineAssetsPayload
    public let revision: UUID
}
enum OfflineAssetsCodec {
    static let maximumBytes = 1024 * 1024
    static let maximumCoverBytes = 512 * 1024
    private struct Envelope: Codable { let version: Int; let payload: OfflineAssetsPayload }
    static func validate(_ payload: OfflineAssetsPayload) throws {
        guard payload.album.utf16.count <= 500, !payload.album.contains("://"),
              !payload.album.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
              payload.duration.isFinite, (0...86400).contains(payload.duration),
              [payload.plainLyrics, payload.syncedLyrics].allSatisfy({ value in
                  value.map { $0.utf16.count <= 100_000 && !$0.contains("://") && !$0.unicodeScalars.contains(where: { $0.value == 0 }) } ?? true
              }) else { throw OfflineFailure.invalidRequest }
        if let bytes = payload.coverJPEG {
            guard !bytes.isEmpty, bytes.count <= maximumCoverBytes,
                  let source = CGImageSourceCreateWithData(bytes as CFData, nil), CGImageSourceGetCount(source) == 1,
                  let type = CGImageSourceGetType(source), type as String == "public.jpeg",
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
                  let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
                  (1...2048).contains(width.intValue), (1...2048).contains(height.intValue),
                  CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary) != nil else {
                throw OfflineFailure.invalidRequest
            }
        }
    }
    static func encode(_ payload: OfflineAssetsPayload) throws -> Data {
        try validate(payload)
        let bytes = try JSONEncoder().encode(Envelope(version: 1, payload: payload))
        guard bytes.count <= maximumBytes else { throw OfflineFailure.storageLimit }; return bytes
    }
    static func decode(_ bytes: Data) throws -> OfflineAssetsPayload {
        guard bytes.count <= maximumBytes else { throw OfflineFailure.corrupt }
        let envelope: Envelope
        do { envelope = try JSONDecoder().decode(Envelope.self, from: bytes) } catch { throw OfflineFailure.corrupt }
        guard envelope.version == 1 else { throw OfflineFailure.corrupt }
        do { try validate(envelope.payload) } catch { throw OfflineFailure.corrupt }
        return envelope.payload
    }
}
