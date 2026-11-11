import Foundation
import CryptoKit
@preconcurrency import AVFoundation

public enum LocalAudioFailure: Error, Sendable {
    case disabled, unsupported, invalidFile, storageLimit, corrupt, busy, notFound
    public var message: String {
        switch self {
        case .disabled: "Enable music files on this device before importing or playing them."
        case .unsupported: "This file cannot be played as MP3, M4A or FLAC audio on this device."
        case .invalidFile: "Choose a regular audio file up to 128 MiB."
        case .storageLimit: "The music-file storage budget or available disk space is too small."
        case .corrupt: "This private audio copy is missing or damaged. Remove it and import the original again."
        case .busy: "Finish the current import or stop this recording before changing its copy."
        case .notFound: "This recording is no longer in the device library."
        }
    }
}

/// Public metadata contains neither the original path nor a private file locator.
public struct LocalAudioRecord: Codable, Sendable, Equatable, Identifiable {
    public let id: UUID
    public let title: String
    public let artist: String
    public let album: String
    public let duration: Double
    public let fileExtension: String
    public let byteCount: Int
    public let checksum: String
    public let importedAt: Date
    public func playbackTrack(id entryID: UUID = UUID()) throws -> PlaybackTrack {
        try PlaybackTrack(id: entryID, deviceID: id, title: title, artist: artist)
    }
    fileprivate func validate() throws {
        guard Self.validText(title, required: true), Self.validText(artist, required: true), Self.validText(album),
              duration.isFinite, duration > 0, duration <= 86400,
              LocalAudioLibrary.supportedExtensions.contains(fileExtension), (1...LocalAudioLibrary.maximumFileBytes).contains(byteCount),
              OfflineFiles.validHash(checksum), importedAt.timeIntervalSince1970.isFinite else { throw LocalAudioFailure.corrupt }
    }
    fileprivate static func validText(_ text: String, required: Bool = false) -> Bool {
        (!required || !text.isEmpty) && text.utf16.count <= 500 && !text.contains("://")
            && !text.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }
}

public struct LocalAudioSnapshot: Sendable {
    public let enabled: Bool
    public let records: [LocalAudioRecord]
    public let usedBytes: Int
    public let storageBudgetBytes: Int
}

/// The library alone issues this immutable private-copy capability. It cannot
/// authorize an arbitrary source URL or a different provider's recording.
public final class LocalAudioCopy: @unchecked Sendable {
    public let deviceID: UUID
    public let contentLength: Int
    let url: URL
    private let root: URL
    private let checksum: String
    private let admission: OfflineReadAdmission
    fileprivate init(record: LocalAudioRecord, url: URL, root: URL, admission: OfflineReadAdmission) {
        deviceID = record.id; contentLength = record.byteCount; self.url = url
        self.root = root; checksum = record.checksum; self.admission = admission
    }
    public var isValid: Bool {
        guard admission.isValid,
              (try? OfflineFiles.prefixHasher(url, root: root, length: contentLength, checksum: checksum)) != nil else { return false }
        return admission.isValid
    }
}
private final class WeakLocalAudioCopy: @unchecked Sendable {
    weak var value: LocalAudioCopy?
    init(_ value: LocalAudioCopy) { self.value = value }
}

/// Explicit picker imports only. Originals are read without modification; the
/// app owns UUID-named copies and a bounded metadata index in its private root.
public actor LocalAudioLibrary {
    public static let maximumRecords = 1000
    public static let maximumFileBytes = 128 * 1024 * 1024
    public static let supportedExtensions: Set<String> = ["mp3", "m4a", "flac"]
    public static let storageBudgets = [256, 512, 1024, 2048].map { $0 * 1024 * 1024 }
    private static let maximumIndexBytes = 4 * 1024 * 1024
    private struct Index: Codable {
        var version = 1
        var enabled = false
        var storageBudgetBytes = 512 * 1024 * 1024
        var records: [LocalAudioRecord] = []
    }
    private let root: URL
    private var index: Index
    private var admission = OfflineReadAdmission()
    private var reads: [UUID: [WeakLocalAudioCopy]] = [:]
    private var importing = false
    private var revision: UInt64 = 0

    public init(rootDirectory: URL) throws {
        do { try OfflineFiles.prepareDirectory(rootDirectory) } catch { throw LocalAudioFailure.invalidFile }
        root = rootDirectory.standardizedFileURL
        let url = root.appendingPathComponent("index.json")
        if FileManager.default.fileExists(atPath: url.path) {
            guard let size = try? OfflineFiles.size(url, root: root), size <= Self.maximumIndexBytes,
                  let data = try? Self.readBounded(url, maximum: Self.maximumIndexBytes),
                  let value = try? JSONDecoder().decode(Index.self, from: data), value.version == 1,
                  value.records.count <= Self.maximumRecords, Set(value.records.map(\.id)).count == value.records.count,
                  Self.storageBudgets.contains(value.storageBudgetBytes) else { throw LocalAudioFailure.corrupt }
            try value.records.forEach { try $0.validate() }
            guard value.records.reduce(0, { $0 + $1.byteCount }) <= value.storageBudgetBytes else { throw LocalAudioFailure.corrupt }
            index = value
        } else { index = Index() }
    }
    public func snapshot() -> LocalAudioSnapshot {
        LocalAudioSnapshot(enabled: index.enabled, records: index.records,
            usedBytes: (try? usedBytesOnDisk()) ?? index.records.reduce(0, { $0 + $1.byteCount }), storageBudgetBytes: index.storageBudgetBytes)
    }
    public func setEnabled(_ enabled: Bool) throws {
        guard index.enabled != enabled else { return }
        let previous = index.enabled
        index.enabled = enabled
        do { try persist() } catch { index.enabled = previous; throw error }
        revision &+= 1
        admission.invalidate(); admission = OfflineReadAdmission(); reads.removeAll()
    }
    public func setStorageBudget(_ bytes: Int) throws {
        guard Self.storageBudgets.contains(bytes), try usedBytesOnDisk() <= bytes else { throw LocalAudioFailure.storageLimit }
        let previous = index.storageBudgetBytes
        index.storageBudgetBytes = bytes
        do { try persist() } catch { index.storageBudgetBytes = previous; throw error }
    }
    public func importFile(_ source: URL) async throws -> LocalAudioRecord {
        guard index.enabled else { throw LocalAudioFailure.disabled }
        guard !importing else { throw LocalAudioFailure.busy }
        guard index.records.count < Self.maximumRecords else { throw LocalAudioFailure.storageLimit }
        let ext = source.pathExtension.lowercased()
        guard source.isFileURL, source.query == nil, source.fragment == nil,
              Self.supportedExtensions.contains(ext),
              let values = try? source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size > 0, size <= Self.maximumFileBytes else { throw LocalAudioFailure.invalidFile }
        guard try usedBytesOnDisk() + size <= index.storageBudgetBytes,
              OfflineFiles.freeBytes(root) >= Int64(size + 8 * 1024 * 1024) else { throw LocalAudioFailure.storageLimit }
        importing = true; let ticket = revision
        defer { importing = false }
        let id = UUID(), temporary = root.appendingPathComponent(id.uuidString.lowercased() + ".part")
        let final = root.appendingPathComponent(id.uuidString.lowercased() + "." + ext)
        var committed = false
        defer {
            try? FileManager.default.removeItem(at: temporary)
            if !committed { try? FileManager.default.removeItem(at: final) }
        }
        let checksum = try copy(source, to: temporary, expectedBytes: size)
        try Task.checkCancellation()
        try FileManager.default.moveItem(at: temporary, to: final)
        try Self.validateContainer(final, extension: ext)
        let asset = AVURLAsset(url: final, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        guard try await asset.load(.isPlayable), !(try await asset.loadTracks(withMediaType: .audio)).isEmpty else { throw LocalAudioFailure.unsupported }
        let duration = try await asset.load(.duration).seconds
        guard duration.isFinite, duration > 0, duration <= 86400 else { throw LocalAudioFailure.unsupported }
        let metadata = try await asset.load(.commonMetadata)
        let title = await tag(.commonKeyTitle, from: metadata)
        let artist = await tag(.commonKeyArtist, from: metadata)
        let album = await tag(.commonKeyAlbumName, from: metadata)
        try Task.checkCancellation()
        guard index.enabled, revision == ticket else { throw LocalAudioFailure.disabled }
        let fallback = Self.clean(source.deletingPathExtension().lastPathComponent)
        let record = LocalAudioRecord(id: id, title: title.isEmpty ? (fallback.isEmpty ? "Imported recording" : fallback) : title,
            artist: artist.isEmpty ? "Unknown artist" : artist, album: album, duration: duration,
            fileExtension: ext, byteCount: size, checksum: checksum, importedAt: Date())
        try record.validate()
        // The source may change during copying; verify exactly what AVFoundation inspected.
        _ = try OfflineFiles.prefixHasher(final, root: root, length: size, checksum: checksum)
        guard try usedBytesOnDisk() <= index.storageBudgetBytes else { throw LocalAudioFailure.storageLimit }
        index.records.insert(record, at: 0)
        do { try persist() } catch { index.records.removeAll { $0.id == id }; throw error }
        committed = true
        return record
    }
    public func open(_ id: UUID) throws -> LocalAudioCopy {
        guard index.enabled else { throw LocalAudioFailure.disabled }
        guard let record = index.records.first(where: { $0.id == id }) else { throw LocalAudioFailure.notFound }
        let url = file(record)
        do { _ = try OfflineFiles.prefixHasher(url, root: root, length: record.byteCount, checksum: record.checksum) }
        catch { throw LocalAudioFailure.corrupt }
        let copy = LocalAudioCopy(record: record, url: url, root: root, admission: admission)
        reads[id, default: []].removeAll { $0.value == nil }
        reads[id, default: []].append(WeakLocalAudioCopy(copy))
        return copy
    }
    /// Deletes only the UUID-owned private copy. The picker source was never retained.
    public func remove(_ id: UUID) throws {
        guard !importing else { throw LocalAudioFailure.busy }
        guard let position = index.records.firstIndex(where: { $0.id == id }) else { throw LocalAudioFailure.notFound }
        reads[id, default: []].removeAll { $0.value == nil }
        guard reads[id, default: []].isEmpty else { throw LocalAudioFailure.busy }
        let record = index.records[position], url = file(record)
        try OfflineFiles.checkedFile(url, root: root, allowMissing: true)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        index.records.remove(at: position)
        do { try persist() } catch { index.records.insert(record, at: position); throw error }
        reads[id] = nil
    }
    private func file(_ record: LocalAudioRecord) -> URL {
        root.appendingPathComponent(record.id.uuidString.lowercased() + "." + record.fileExtension)
    }
    /// A crash between copy and index commit cannot hide owned bytes from the
    /// budget. Inspect only this flat private directory, never the user's tree.
    private func usedBytesOnDisk() throws -> Int {
        let files = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles, .skipsSubdirectoryDescendants])
        guard files.count <= Self.maximumRecords * 2 + 2 else { throw LocalAudioFailure.storageLimit }
        var total = 0
        for url in files where url.lastPathComponent != "index.json" {
            let size = try OfflineFiles.size(url, root: root)
            guard size <= Self.maximumFileBytes, total <= 2 * 1024 * 1024 * 1024 - size else { throw LocalAudioFailure.storageLimit }
            total += size
        }
        return total
    }
    private func persist() throws {
        let data = try JSONEncoder().encode(index)
        guard data.count <= Self.maximumIndexBytes else { throw LocalAudioFailure.storageLimit }
        let target = root.appendingPathComponent("index.json")
        try OfflineFiles.checkedFile(target, root: root, allowMissing: true)
        try data.write(to: target, options: .atomic)
    }
    private func copy(_ source: URL, to target: URL, expectedBytes: Int) throws -> String {
        try OfflineFiles.checkedFile(target, root: root, allowMissing: true)
        guard !FileManager.default.fileExists(atPath: target.path),
              FileManager.default.createFile(atPath: target.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw LocalAudioFailure.invalidFile }
        let reader = try FileHandle(forReadingFrom: source), writer = try FileHandle(forWritingTo: target)
        defer { try? reader.close(); try? writer.close() }
        var hasher = SHA256(), total = 0
        while let block = try reader.read(upToCount: 256 * 1024), !block.isEmpty {
            try Task.checkCancellation()
            total += block.count
            guard total <= expectedBytes, total <= Self.maximumFileBytes else { throw LocalAudioFailure.invalidFile }
            hasher.update(data: block); try writer.write(contentsOf: block)
        }
        guard total == expectedBytes else { throw LocalAudioFailure.invalidFile }
        try writer.synchronize()
        return OfflineFiles.hex(hasher.finalize())
    }
    private func tag(_ key: AVMetadataKey, from metadata: [AVMetadataItem]) async -> String {
        guard let item = metadata.first(where: { $0.commonKey == key }), let text = try? await item.load(.stringValue) else { return "" }
        return Self.clean(text)
    }
    private static func clean(_ value: String) -> String {
        var units = 0, bounded = String.UnicodeScalarView()
        for scalar in value.unicodeScalars {
            if CharacterSet.controlCharacters.contains(scalar) { continue }
            let count = scalar.value > 0xffff ? 2 : 1
            if units + count > 500 { break }
            units += count; bounded.append(scalar)
        }
        let text = String(bounded).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.contains("://") else { return "" }
        return text
    }
    private static func readBounded(_ url: URL, maximum: Int) throws -> Data {
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        let data = try handle.read(upToCount: maximum + 1) ?? Data()
        guard data.count <= maximum else { throw LocalAudioFailure.corrupt }
        return data
    }
    private static func validateContainer(_ url: URL, extension ext: String) throws {
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        let bytes = Array(try handle.read(upToCount: 16) ?? Data())
        let valid: Bool
        switch ext {
        case "mp3":
            let id3 = bytes.count >= 3 && Array(bytes.prefix(3)) == [0x49, 0x44, 0x33]
            let frame = bytes.count >= 4 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0
                && bytes[1] & 0x06 != 0 && bytes[1] & 0x18 != 0x08
            valid = id3 || frame
        case "m4a": valid = bytes.count >= 12 && Array(bytes[4..<8]) == Array("ftyp".utf8)
        case "flac": valid = bytes.count >= 4 && Array(bytes.prefix(4)) == Array("fLaC".utf8)
        default: valid = false
        }
        guard valid else { throw LocalAudioFailure.unsupported }
    }
}
