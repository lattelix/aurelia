import Foundation
import CryptoKit
import Darwin

/// A native-only local capability. Its creation is confined to the managed
/// store; generic URL initializers cannot turn arbitrary files into audio.
public final class OfflineLocalCopy: @unchecked Sendable {
    public let videoID: String
    public let contentLength: Int
    public let url: URL
    let root: URL
    let checksum: String
    private let admission: OfflineReadAdmission
    init(videoID: String, contentLength: Int, url: URL, root: URL, checksum: String,
         admission: OfflineReadAdmission) {
        self.videoID = videoID; self.contentLength = contentLength; self.url = url
        self.root = root; self.checksum = checksum; self.admission = admission
    }
    public var isValid: Bool {
        guard admission.isValid, (try? OfflineFiles.validateReady(url, root: root,
                    length: contentLength, checksum: checksum)) != nil else { return false }
        return admission.isValid
    }
}

final class OfflineReadAdmission: @unchecked Sendable {
    private let lock = NSLock()
    private var valid = true
    var isValid: Bool { lock.lock(); defer { lock.unlock() }; return valid }
    func invalidate() { lock.lock(); valid = false; lock.unlock() }
}
final class OfflineWeakCopy: @unchecked Sendable {
    weak var value: OfflineLocalCopy?
    init(_ value: OfflineLocalCopy) { self.value = value }
}

enum OfflineFiles {
    static let maximumIndexBytes = 2 * 1024 * 1024
    static func hash(_ data: Data) -> String { hex(SHA256.hash(data: data)) }
    static func hex<D: Sequence>(_ bytes: D) -> String where D.Element == UInt8 {
        bytes.map { String(format: "%02x", $0) }.joined()
    }
    static func validHash(_ value: String) -> Bool {
        value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }
    static func ownerHash(_ value: String) -> String { hash(Data(("aurelia-offline-owner-v1:" + value).utf8)) }
    static func sourceFingerprint(_ lease: VerifiedYouTubeStreamLease) throws -> String {
        // The already verified lease owns URL admission. Retain only a digest
        // of its immutable recording fields, never the locator/signing data.
        guard let fields = URLComponents(url: lease.url, resolvingAgainstBaseURL: false)?.queryItems else {
            throw OfflineFailure.unavailable
        }
        let names = ["id", "itag", "clen", "lmt", "mime", "source"]
        let stable = names.map { name in
            fields.first(where: { $0.name.lowercased() == name })?.value
        }
        let encoded = try JSONEncoder().encode(stable)
        return hash(Data((lease.requestedVideoID + "|" + VerifiedYouTubeStreamLease.normalizedMIME(lease.mimeType)).utf8) + encoded)
    }
    static func prepareDirectory(_ url: URL) throws {
        guard url.isFileURL, url.query == nil, url.fragment == nil,
              url.standardizedFileURL.path == url.resolvingSymlinksInPath().standardizedFileURL.path else {
            throw OfflineFailure.storage
        }
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        let values = try FileManager.default.attributesOfItem(atPath: url.path)
        guard values[.type] as? FileAttributeType == .typeDirectory else { throw OfflineFailure.storage }
        var mutableURL = url
        var resourceValues = URLResourceValues(); resourceValues.isExcludedFromBackup = true
        try mutableURL.setResourceValues(resourceValues)
    }
    static func checkedFile(_ url: URL, root: URL, allowMissing: Bool = false) throws {
        guard url.isFileURL, root.isFileURL, url.query == nil, url.fragment == nil,
              url.standardizedFileURL.path.hasPrefix(root.standardizedFileURL.path + "/"),
              root.standardizedFileURL.path == root.resolvingSymlinksInPath().standardizedFileURL.path,
              url.standardizedFileURL.path == url.resolvingSymlinksInPath().standardizedFileURL.path else {
            throw OfflineFailure.storage
        }
        if !FileManager.default.fileExists(atPath: url.path) {
            guard allowMissing else { throw OfflineFailure.corrupt }; return
        }
        let values = try FileManager.default.attributesOfItem(atPath: url.path)
        guard values[.type] as? FileAttributeType == .typeRegular else { throw OfflineFailure.storage }
    }
    static func size(_ url: URL, root: URL) throws -> Int {
        try checkedFile(url, root: root)
        // URL.resourceValues may cache a file size from an earlier chunk.
        // Fresh stat data is required for every mutable partial/ready check.
        guard let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber, size.int64Value >= 0,
              size.int64Value <= Int64(Int.max) else {
            throw OfflineFailure.storage
        }
        return size.intValue
    }
    static func prefixHasher(_ url: URL, root: URL, length: Int, checksum: String?,
                             discardUncommittedTail: Bool = false) throws -> SHA256 {
        let actualSize = try size(url, root: root)
        guard length >= 0, length <= 128 * 1024 * 1024,
              actualSize >= length, actualSize <= 128 * 1024 * 1024,
              actualSize == length || discardUncommittedTail else { throw OfflineFailure.corrupt }
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        var hash = SHA256(), count = 0
        while count < length, let block = try handle.read(upToCount: min(256 * 1024, length - count)), !block.isEmpty {
            count += block.count; guard count <= length else { throw OfflineFailure.corrupt }
            hash.update(data: block)
        }
        let verificationHash = hash
        guard count == length, checksum == nil ? length == 0 : hex(verificationHash.finalize()) == checksum else {
            throw OfflineFailure.corrupt
        }
        if actualSize > length {
            let writer = try FileHandle(forWritingTo: url); defer { try? writer.close() }
            try writer.truncate(atOffset: UInt64(length)); try writer.synchronize()
        }
        return hash
    }
    static func validateReady(_ url: URL, root: URL, length: Int, checksum: String) throws {
        guard url.pathExtension == "m4a", validHash(checksum), length > 0 else { throw OfflineFailure.corrupt }
        _ = try prefixHasher(url, root: root, length: length, checksum: checksum)
        try validateM4A(url, length: length)
    }
    static func validateM4A(_ url: URL, length: Int) throws {
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        var offset = 0, boxes = 0, ftyp = false, moov = false, mdat = false
        while offset < length {
            boxes += 1; guard boxes <= 1_024, length - offset >= 8 else { throw OfflineFailure.corrupt }
            try handle.seek(toOffset: UInt64(offset))
            guard let header = try handle.read(upToCount: 16), header.count >= 8 else { throw OfflineFailure.corrupt }
            let raw = integer(header, at: 0, count: 4)
            let headerSize = raw == 1 ? 16 : 8
            guard header.count >= headerSize else { throw OfflineFailure.corrupt }
            let boxLength = raw == 1 ? integer(header, at: 8, count: 8) : (raw == 0 ? UInt64(length - offset) : raw)
            guard boxLength >= UInt64(headerSize), boxLength <= UInt64(length - offset) else { throw OfflineFailure.corrupt }
            let kind = String(decoding: header[4..<8], as: UTF8.self)
            if kind == "ftyp" {
                guard !ftyp, offset == 0, boxLength >= 16, boxLength <= 4_096 else { throw OfflineFailure.corrupt }
                ftyp = true
            } else if kind == "mdat" { guard boxLength > UInt64(headerSize) else { throw OfflineFailure.corrupt }; mdat = true }
            else if kind == "moov" {
                guard !moov, boxLength <= 8 * 1024 * 1024 else { throw OfflineFailure.corrupt }
                try handle.seek(toOffset: UInt64(offset + headerSize))
                guard let payload = try handle.read(upToCount: Int(boxLength) - headerSize),
                      payload.count == Int(boxLength) - headerSize else { throw OfflineFailure.corrupt }
                var audio = false, selfContained = false, count = 0
                try validateBoxes(payload, depth: 0, count: &count, audio: &audio, selfContained: &selfContained)
                guard audio, selfContained else { throw OfflineFailure.corrupt }; moov = true
            }
            offset += Int(boxLength)
        }
        guard offset == length, ftyp, moov, mdat else { throw OfflineFailure.corrupt }
    }
    private static func integer(_ bytes: Data, at: Int, count: Int) -> UInt64 {
        bytes[at..<(at + count)].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
    }
    private static func validateBoxes(_ bytes: Data, depth: Int, count: inout Int,
                                     audio: inout Bool, selfContained: inout Bool) throws {
        guard depth < 8 else { throw OfflineFailure.corrupt }
        var offset = 0
        while offset < bytes.count {
            count += 1; guard count <= 8_192, bytes.count - offset >= 8 else { throw OfflineFailure.corrupt }
            let length = integer(bytes, at: offset, count: 4)
            guard length >= 8, length <= UInt64(bytes.count - offset) else { throw OfflineFailure.corrupt }
            let kind = String(decoding: bytes[(offset + 4)..<(offset + 8)], as: UTF8.self)
            let payload = Data(bytes[(offset + 8)..<(offset + Int(length))])
            if ["trak", "mdia", "minf", "stbl", "dinf"].contains(kind) {
                try validateBoxes(payload, depth: depth + 1, count: &count, audio: &audio, selfContained: &selfContained)
            } else if kind == "stsd" {
                guard payload.count >= 8, integer(payload, at: 4, count: 4) == 1 else { throw OfflineFailure.corrupt }
                let entries = Data(payload[8...])
                guard entries.count >= 36, integer(entries, at: 0, count: 4) == entries.count,
                      String(decoding: entries[4..<8], as: UTF8.self) == "mp4a",
                      integer(entries, at: 14, count: 2) == 1 else { throw OfflineFailure.corrupt }
                audio = true
            } else if kind == "dref" {
                guard payload.count == 20, integer(payload, at: 4, count: 4) == 1,
                      integer(payload, at: 8, count: 4) == 12,
                      String(decoding: payload[12..<16], as: UTF8.self) == "url ",
                      integer(payload, at: 16, count: 4) == 1 else { throw OfflineFailure.corrupt }
                selfContained = true
            }
            offset += Int(length)
        }
    }
    static func write(_ index: OfflineIndex, directory: URL) throws {
        let data = try JSONEncoder().encode(index)
        guard data.count <= maximumIndexBytes else { throw OfflineFailure.storageLimit }
        let path = directory.appendingPathComponent("index.json")
        try checkedFile(path, root: directory, allowMissing: true)
        let stage = directory.appendingPathComponent(UUID().uuidString.lowercased() + ".index.tmp")
        defer { try? FileManager.default.removeItem(at: stage) }
        guard FileManager.default.createFile(atPath: stage.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw OfflineFailure.storage
        }
        let handle = try FileHandle(forWritingTo: stage)
        do { try handle.synchronize(); try handle.close() } catch { try? handle.close(); throw OfflineFailure.storage }
        // No throwing work follows the atomic commit. Callers can safely
        // restore their in-memory prior record if this operation throws.
        guard rename(stage.path, path.path) == 0 else { throw OfflineFailure.storage }
    }
    static func freeBytes(_ root: URL) -> Int64 {
        guard let attributes = try? FileManager.default.attributesOfFileSystem(forPath: root.path),
              let bytes = attributes[.systemFreeSize] as? NSNumber else { return 0 }
        return max(0, bytes.int64Value)
    }
    static func usedBytes(_ root: URL) throws -> Int64 {
        let owners = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey])
        guard owners.count <= 64 else { throw OfflineFailure.storageLimit }
        var total: Int64 = 0
        for directory in owners {
            guard validHash(directory.lastPathComponent), directory.standardizedFileURL.path == directory.resolvingSymlinksInPath().standardizedFileURL.path,
                  try FileManager.default.attributesOfItem(atPath: directory.path)[.type] as? FileAttributeType == .typeDirectory else { throw OfflineFailure.storage }
            let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])
            guard files.count <= OfflineStoragePolicy.maximumRecords * 2 + 4 else { throw OfflineFailure.storageLimit }
            for file in files {
                let bytes = try size(file, root: directory)
                total += Int64(bytes)
            }
        }
        return total
    }
}
