import SwiftUI
@preconcurrency import AVFoundation
import ImageIO
import CoreMedia
import AureliaCloud
import AureliaPlaybackCore
#if os(iOS)
import UIKit
#endif

/// Owns asynchronous export/cancellation without exposing framework errors that
/// can retain private file URLs. No player or audio session is created.
final class AudioExportOperation: @unchecked Sendable {
    let session: AVAssetExportSession
    init(_ session: AVAssetExportSession) { self.session = session }
    func run() async throws {
        try Task.checkCancellation()
        let timeout = Task { [self] in
            try? await Task.sleep(for: .seconds(60))
            if !Task.isCancelled { session.cancelExport() }
        }
        defer { timeout.cancel() }
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                session.exportAsynchronously { continuation.resume() }
            }
        } onCancel: { self.session.cancelExport() }
        try Task.checkCancellation()
        guard session.status == .completed else { throw PlaybackFailure.unavailable }
    }
}

protocol AudioExportCoverProviding: Sendable {
    func jpeg(forVideoID videoID: String) async throws -> Data?
}
private final class ExportCoverRedirectRefusal: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
struct YouTubeExportCover: AudioExportCoverProviding {
    static let maximumBytes = 1024 * 1024
    static func canonicalURL(videoID: String) -> URL? {
        guard videoID.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil else { return nil }
        return URL(string: "https://i.ytimg.com/vi/\(videoID)/hqdefault.jpg")
    }
    func jpeg(forVideoID videoID: String) async throws -> Data? {
        guard let url = Self.canonicalURL(videoID: videoID) else { throw PlaybackFailure.invalidTrack }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 8; configuration.timeoutIntervalForResource = 8
        configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil; configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: ExportCoverRedirectRefusal(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        request.httpShouldHandleCookies = false
        request.setValue("image/jpeg", forHTTPHeaderField: "Accept")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        do {
            let (stream, raw) = try await session.bytes(for: request)
            defer { stream.task.cancel() }
            guard let response = raw as? HTTPURLResponse, response.statusCode == 200, response.url == url,
                  response.value(forHTTPHeaderField: "Content-Type")?.lowercased().split(separator: ";").first == "image/jpeg",
                  response.value(forHTTPHeaderField: "Content-Encoding").map({ $0.lowercased() == "identity" }) ?? true,
                  response.expectedContentLength < 0 || response.expectedContentLength <= Self.maximumBytes else { return nil }
            var body = Data(), block = [UInt8](); block.reserveCapacity(16 * 1024)
            for try await byte in stream {
                if block.isEmpty { try Task.checkCancellation() }
                guard body.count + block.count < Self.maximumBytes else { return nil }
                block.append(byte)
                if block.count == 16 * 1024 { body.append(contentsOf: block); block.removeAll(keepingCapacity: true) }
            }
            try Task.checkCancellation(); body.append(contentsOf: block)
            return AudioFileExport.validJPEG(body) ? body : nil
        } catch is CancellationError { throw CancellationError() }
        catch { return nil } // Artwork is optional; no underlying network error escapes.
    }
}

/// Export creates a separate remuxed M4A. Every production entry requires the
/// managed store's current owner-scoped capability; arbitrary URLs are refused.
@MainActor enum AudioFileExport {
    private static var preparationInFlight = false
    static let maximumTextBytes = 400_000
    static let extraStorageHeadroom: Int64 = 4 * 1024 * 1024
    static func safeName(_ value: String) -> String {
        let forbidden = CharacterSet(charactersIn: "/\\:\u{0}").union(.controlCharacters)
        let name = value.unicodeScalars.map { forbidden.contains($0) ? "_" : String($0) }.joined()
            .trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
        var bounded = ""
        for character in name {
            guard bounded.utf8.count + String(character).utf8.count <= 180 else { break }
            bounded.append(character)
        }
        return bounded.isEmpty ? "Aurelia song" : bounded
    }
    nonisolated static func validJPEG(_ bytes: Data) -> Bool {
        guard !bytes.isEmpty, bytes.count <= YouTubeExportCover.maximumBytes,
              let source = CGImageSourceCreateWithData(bytes as CFData, nil), CGImageSourceGetCount(source) == 1,
              let type = CGImageSourceGetType(source), type as String == "public.jpeg",
              let raw = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = raw[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = raw[kCGImagePropertyPixelHeight] as? NSNumber,
              (1...2048).contains(width.intValue), (1...2048).contains(height.intValue),
              CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary) != nil else { return false }
        return true
    }
    static func plainText(_ lyrics: LyricsDTO?) throws -> String? {
        guard let lyrics else { return nil }
        guard lyrics.plainLyrics.map({ $0.utf8.count <= maximumTextBytes }) ?? true,
              lyrics.syncedLyrics.map({ $0.utf8.count <= maximumTextBytes }) ?? true else { throw PlaybackFailure.invalidResponse }
        if let plain = lyrics.plainLyrics, !plain.isEmpty { return plain }
        let derived = lyrics.lines.map(\.text).joined(separator: "\n")
        return derived.isEmpty ? nil : derived
    }
    static func prepare(copy: OfflineLocalCopy, track: TrackDTO, lyrics: LyricsDTO?,
                        coverProvider: any AudioExportCoverProviding = YouTubeExportCover(), rootDirectory: URL? = nil,
                        sessionFactory: (AVAsset) -> AVAssetExportSession? = { AVAssetExportSession(asset: $0, presetName: AVAssetExportPresetPassthrough) }) async throws -> [URL] {
        try Task.checkCancellation()
        // MainActor functions can reenter across awaits. Admit one complete
        // preparation so concurrent windows cannot reserve the same free space.
        guard !preparationInFlight else { throw PlaybackFailure.busy }
        preparationInFlight = true
        defer { preparationInFlight = false }
        guard copy.isValid, track.provider == "youtube", track.id == "youtube:" + copy.videoID,
              copy.videoID == track.externalId else { throw PlaybackFailure.invalidSource }
        defer { withExtendedLifetime(copy) {} }
        let plain = try plainText(lyrics)
        var cover: Data?
        do { cover = try await coverProvider.jpeg(forVideoID: copy.videoID) }
        catch is CancellationError { throw CancellationError() }
        catch { cover = nil }
        if let bytes = cover, !validJPEG(bytes) { cover = nil }
        try Task.checkCancellation()
        guard copy.isValid else { throw PlaybackFailure.invalidSource }
        let manager = FileManager.default
        let temporary = manager.temporaryDirectory.resolvingSymlinksInPath().standardizedFileURL
        let root = rootDirectory ?? temporary.appendingPathComponent("AureliaExports-v1", isDirectory: true)
        guard root.standardizedFileURL.path == root.resolvingSymlinksInPath().standardizedFileURL.path,
              root.standardizedFileURL.path.hasPrefix(temporary.path + "/") else { throw OfflineFailure.storage }
        try manager.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let old = try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        guard old.count <= 100 else { throw OfflineFailure.storageLimit }
        for item in old {
            let attributes = try manager.attributesOfItem(atPath: item.path)
            guard UUID(uuidString: item.lastPathComponent) != nil,
                  item.standardizedFileURL.path == item.resolvingSymlinksInPath().standardizedFileURL.path,
                  attributes[.type] as? FileAttributeType == .typeDirectory else { throw OfflineFailure.storage }
            if let date = attributes[.creationDate] as? Date, Date().timeIntervalSince(date) > 86400 { try manager.removeItem(at: item) }
        }
        let retained = try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        guard retained.count < 100 else { throw OfflineFailure.storageLimit }
        var retainedBytes: Int64 = 0
        for item in retained {
            let children = try manager.contentsOfDirectory(at: item, includingPropertiesForKeys: nil)
            guard children.count <= 5 else { throw OfflineFailure.storage }
            for child in children {
                guard child.standardizedFileURL.path == child.resolvingSymlinksInPath().standardizedFileURL.path else { throw OfflineFailure.storage }
                let values = try manager.attributesOfItem(atPath: child.path)
                guard values[.type] as? FileAttributeType == .typeRegular else { throw OfflineFailure.storage }
                retainedBytes += (values[.size] as? NSNumber)?.int64Value ?? 0
            }
        }
        guard retainedBytes + Int64(copy.contentLength) + extraStorageHeadroom <= 512 * 1024 * 1024 else { throw OfflineFailure.storageLimit }
        let volume = try manager.attributesOfFileSystem(forPath: root.path)
        guard (volume[.systemFreeSize] as? NSNumber)?.int64Value ?? 0 > Int64(copy.contentLength) + extraStorageHeadroom + 128 * 1024 * 1024 else { throw OfflineFailure.insufficientSpace }
        let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let name = safeName(track.artist + " - " + track.title)
        let output = directory.appendingPathComponent(name).appendingPathExtension("m4a")
        do {
            try Task.checkCancellation()
            let asset = AVURLAsset(url: copy.url)
            guard let session = sessionFactory(asset), session.supportedFileTypes.contains(.m4a) else { throw PlaybackFailure.unavailable }
            session.outputURL = output; session.outputFileType = .m4a
            func tag(_ identifier: AVMetadataIdentifier, _ value: String) -> AVMetadataItem {
                let item = AVMutableMetadataItem(); item.identifier = identifier; item.value = value as NSString
                item.dataType = kCMMetadataBaseDataType_UTF8 as String; item.extendedLanguageTag = "und"; return item
            }
            var metadata = [tag(.iTunesMetadataSongName, track.title), tag(.iTunesMetadataArtist, track.artist)]
            if !track.album.isEmpty { metadata.append(tag(.iTunesMetadataAlbum, track.album)) }
            if let plain { metadata.append(tag(.iTunesMetadataLyrics, plain)) }
            if let cover {
                let item = AVMutableMetadataItem(); item.identifier = .iTunesMetadataCoverArt
                item.value = cover as NSData; item.dataType = kCMMetadataBaseDataType_JPEG as String; metadata.append(item)
            }
            session.metadata = metadata
            try await AudioExportOperation(session).run()
            guard copy.isValid, (try manager.attributesOfItem(atPath: output.path)[.size] as? NSNumber)?.intValue ?? 0 > 0 else { throw PlaybackFailure.invalidSource }
            let exported = AVURLAsset(url: output), exportedMetadata = try await exported.load(.metadata)
            let expected: [(AVMetadataIdentifier, String)] = [(.iTunesMetadataSongName, track.title), (.iTunesMetadataArtist, track.artist)]
                + (track.album.isEmpty ? [] : [(.iTunesMetadataAlbum, track.album)])
                + (plain.map { [(.iTunesMetadataLyrics, $0)] } ?? [])
            for (identifier, value) in expected {
                guard let item = AVMetadataItem.metadataItems(from: exportedMetadata, filteredByIdentifier: identifier).first,
                      try await item.load(.stringValue) == value else { throw PlaybackFailure.invalidResponse }
            }
            if let cover {
                guard let item = AVMetadataItem.metadataItems(from: exportedMetadata, filteredByIdentifier: .iTunesMetadataCoverArt).first,
                      try await item.load(.dataValue) == cover else { throw PlaybackFailure.invalidResponse }
            }
            var files = [output]
            func sidecar(_ data: Data, extension suffix: String) throws {
                let file = directory.appendingPathComponent(name).appendingPathExtension(suffix)
                try data.write(to: file, options: .atomic); files.append(file)
            }
            if let plain { try sidecar(Data(plain.utf8), extension: "txt") }
            if let synced = lyrics?.syncedLyrics, !synced.isEmpty { try sidecar(Data(synced.utf8), extension: "lrc") }
            if let cover { try sidecar(cover, extension: "jpg") }
            try Task.checkCancellation()
            guard copy.isValid else { throw PlaybackFailure.invalidSource }
            return files
        } catch { try? manager.removeItem(at: directory); throw error }
    }
}

private struct SavedExportCover: AudioExportCoverProviding {
    let videoID: String
    let bytes: Data?
    func jpeg(forVideoID requested: String) async throws -> Data? {
        try Task.checkCancellation()
        guard requested == videoID else { throw PlaybackFailure.invalidTrack }
        return bytes
    }
}

struct OfflineExportView: View {
    @ObservedObject var offline: AppleOfflineStore
    let track: TrackDTO
    let music: CloudMusicStore
    let ownerRevision: UUID
    @ViewState private var files: [URL] = []
    @ViewState private var loading = false
    @ViewState private var message: String?
    @ViewState private var preparation: Task<Void, Never>?
    @ViewState private var preparationID = UUID()
    #if os(iOS)
    @ViewState private var filesDestination: FilesExportRequest?
    @StateObject private var filesLifetime = FilesExportLifetime()
    #endif
    var body: some View {
        Form {
            Section {
                Text(track.title).font(.headline)
                Text(track.artist).foregroundStyle(.secondary)
                Text("Create a separate M4A with title, artist, album and saved lyrics. AAC audio passes through without re-encoding. TXT and LRC accompany the file when available. Your saved cover is embedded and included as JPEG when available.")
                Text("Choose and check the correct lyrics version in Now Playing before exporting. Unavailable lyrics and album metadata are omitted.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Prepare audio files", systemImage: "doc.badge.arrow.up") {
                    preparation?.cancel()
                    let ticket = UUID(); preparationID = ticket
                    loading = true; message = nil
                    preparation = Task { @MainActor in
                        defer {
                            if preparationID == ticket { loading = false; preparation = nil }
                        }
                        do {
                            let copy = try await offline.copyForExport(track, expectedRevision: ownerRevision)
                            let assets = await offline.savedAssets(for: track.id, expectedRevision: ownerRevision)
                            let item = offline.item(for: track)
                            let album = track.album.isEmpty ? assets?.payload.album ?? item?.album ?? "" : track.album
                            let duration = track.duration > 0 ? track.duration : assets?.payload.duration ?? item?.duration ?? 0
                            let metadata = try TrackDTO(id: track.id, title: track.title, artist: track.artist, album: album,
                                provider: track.provider, externalId: track.externalId, duration: duration, artwork: "")
                            var lyrics = LyricsDTO.managed(trackName: track.title, artistName: track.artist, albumName: album,
                                duration: duration, plainLyrics: assets?.payload.plainLyrics, syncedLyrics: assets?.payload.syncedLyrics)
                            if lyrics == nil { lyrics = await music.makeLyricsSession().restoreSelection(for: track.id) }
                            try Task.checkCancellation()
                            try offline.requireCurrentOwner(expectedRevision: ownerRevision)
                            let prepared = try await AudioFileExport.prepare(copy: copy, track: metadata, lyrics: lyrics,
                                coverProvider: SavedExportCover(videoID: track.externalId, bytes: assets?.payload.coverJPEG))
                            try Task.checkCancellation()
                            try offline.requireCurrentOwner(expectedRevision: ownerRevision)
                            guard preparationID == ticket else { return }
                            files = prepared
                        } catch is CancellationError { }
                        catch {
                            guard preparationID == ticket else { return }
                            message = "Could not prepare the export. Check that the song is fully downloaded and that there is enough free space."
                        }
                    }
                }.disabled(loading || !files.isEmpty)
                if loading { ProgressView("Preparing tagged copy…") }
                if !files.isEmpty {
                    #if os(iOS)
                    Button("Save to Files", systemImage: "folder") { saveToFiles() }
                        .disabled(filesDestination != nil || offline.ownerRevision != ownerRevision)
                    ShareLink(items: files) { Label("Share…", systemImage: "square.and.arrow.up") }
                        .disabled(offline.ownerRevision != ownerRevision)
                    Text("\(files.count) files ready. Save to Files opens a file destination. Share opens the system share sheet. The managed offline copy stays in Aurelia.")
                        .font(.caption).foregroundStyle(.secondary)
                    #else
                    ShareLink(items: files) { Label("Save to Files or share", systemImage: "square.and.arrow.up") }
                    Text("\(files.count) files ready. Use the system share sheet to choose a destination. The managed offline copy stays in Aurelia.")
                        .font(.caption).foregroundStyle(.secondary)
                    #endif
                }
                if let message { Text(message).foregroundStyle(.secondary) }
            }
        }.formStyle(.grouped).navigationTitle("Export audio")
        .onChange(of: offline.ownerRevision) { _, _ in
            cancelPreparation(); files = []; message = "Account changed. Reopen export from the current library."
        }
        .onDisappear {
            #if os(iOS)
            if filesLifetime.hasActiveOperation { preparation?.cancel(); return }
            #endif
            cancelPreparation()
        } // Completed share files retain their normal expiry.
        #if os(iOS)
        .background(FilesExportLifetimeAnchor(lifetime: filesLifetime).frame(width: 0, height: 0))
        .sheet(item: $filesDestination) { request in
            FilesExportPicker(files: request.files, requestID: request.id, lifetime: filesLifetime, isCurrent: { current(request) }) { saved in
                guard current(request) else { return }
                do { try offline.requireCurrentOwner(expectedRevision: ownerRevision) }
                catch { filesDestination = nil; return }
                filesDestination = nil
                message = saved ? "Files copied to the selected destination." : "Save to Files cancelled."
            }
        }
        #endif
    }
    private func cancelPreparation() {
        preparationID = UUID(); preparation?.cancel(); preparation = nil; loading = false
        #if os(iOS)
        filesLifetime.invalidate()
        filesDestination = nil
        #endif
    }
    #if os(iOS)
    private func saveToFiles() {
        guard !loading, !files.isEmpty, filesDestination == nil else { return }
        do {
            try offline.requireCurrentOwner(expectedRevision: ownerRevision)
            let request = FilesExportRequest(files: files, ownerRevision: ownerRevision, preparationID: preparationID)
            filesLifetime.begin(request.id)
            message = nil
            filesDestination = request
        } catch { message = "This export is no longer available. Reopen export from the current library." }
    }
    private func current(_ request: FilesExportRequest) -> Bool {
        filesLifetime.isActive(request.id) && request.ownerRevision == ownerRevision &&
            request.preparationID == preparationID && offline.ownerRevision == ownerRevision
    }
    #endif
}

#if os(iOS)
private struct FilesExportRequest: Identifiable {
    let id = UUID()
    let files: [URL]
    let ownerRevision: UUID
    let preparationID: UUID
}

@MainActor private final class FilesExportLifetime: ObservableObject {
    private var activeRequestID: UUID?
    private var delegate: FilesExportPicker.Coordinator?
    var hasActiveOperation: Bool { activeRequestID != nil }
    func isActive(_ id: UUID) -> Bool { activeRequestID == id }
    func begin(_ id: UUID) { invalidate(); activeRequestID = id }
    func retain(_ coordinator: FilesExportPicker.Coordinator, for id: UUID) {
        guard isActive(id) else { coordinator.invalidate(); return }
        delegate?.invalidate(); delegate = coordinator
    }
    func finish(_ id: UUID) { if isActive(id) { invalidate() } }
    func invalidate() { activeRequestID = nil; delegate?.invalidate(); delegate = nil }
}

// Removal of the export view cancels the operation; modal coverage does not.
private struct FilesExportLifetimeAnchor: UIViewRepresentable {
    let lifetime: FilesExportLifetime
    func makeCoordinator() -> FilesExportLifetime { lifetime }
    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero); view.isUserInteractionEnabled = false; return view
    }
    func updateUIView(_ view: UIView, context: Context) { }
    static func dismantleUIView(_ view: UIView, coordinator: FilesExportLifetime) { coordinator.invalidate() }
}

private struct FilesExportPicker: UIViewControllerRepresentable {
    let files: [URL]
    let requestID: UUID
    let lifetime: FilesExportLifetime
    let isCurrent: () -> Bool
    let completion: (Bool) -> Void

    func makeCoordinator() -> Coordinator {
        let coordinator = Coordinator(requestID: requestID, lifetime: lifetime, isCurrent: isCurrent, completion: completion)
        lifetime.retain(coordinator, for: requestID)
        return coordinator
    }
    func makeUIViewController(context: Context) -> UIViewController {
        guard isCurrent(), !files.isEmpty else { return UIViewController() }
        let picker = UIDocumentPickerViewController(forExporting: files, asCopy: true)
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIViewController, context: Context) {
        context.coordinator.isCurrent = isCurrent
        if !isCurrent() { controller.dismiss(animated: true) }
    }
    static func dismantleUIViewController(_ controller: UIViewController, coordinator: Coordinator) {
        if !coordinator.isActive {
            (controller as? UIDocumentPickerViewController)?.delegate = nil
            coordinator.invalidate()
        }
    }
    @MainActor final class Coordinator: NSObject, UIDocumentPickerDelegate {
        var isCurrent: () -> Bool
        private let requestID: UUID
        private weak var lifetime: FilesExportLifetime?
        private var completion: ((Bool) -> Void)?
        var isActive: Bool { lifetime?.isActive(requestID) == true }
        init(requestID: UUID, lifetime: FilesExportLifetime, isCurrent: @escaping () -> Bool, completion: @escaping (Bool) -> Void) {
            self.requestID = requestID; self.lifetime = lifetime; self.isCurrent = isCurrent; self.completion = completion
        }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt _: [URL]) { finish(saved: true) }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish(saved: false) }
        func invalidate() { completion = nil; isCurrent = { false } }
        private func finish(saved: Bool) {
            let callback = completion; completion = nil
            defer { lifetime?.finish(requestID) }
            guard isCurrent() else { return }
            callback?(saved)
        }
    }
}
#endif
