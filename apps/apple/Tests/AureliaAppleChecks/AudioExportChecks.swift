import Foundation
@preconcurrency import AVFoundation
import CoreMedia
import ImageIO
import CryptoKit
@testable import AureliaAppleUI
import AureliaPlaybackCore
import AureliaCloud

private enum ExportCheckFailure: Error { case assertion(String) }
private func exportRequire(_ value: @autoclosure () throws -> Bool, _ label: String) throws {
    guard try value() else { throw ExportCheckFailure.assertion(label) }
}
private struct ExportCoverFixture: AudioExportCoverProviding {
    let data: Data?
    func jpeg(forVideoID videoID: String) async throws -> Data? {
        guard videoID == "00000000001" else { throw ExportCheckFailure.assertion("cover receives canonical video identity") }
        return data
    }
}
private actor ExportHeldCover: AudioExportCoverProviding {
    private(set) var entered = false
    private var pending: CheckedContinuation<Data?, Never>?
    func jpeg(forVideoID videoID: String) async throws -> Data? {
        entered = true
        return await withCheckedContinuation { pending = $0 }
    }
    func release() { pending?.resume(returning: nil); pending = nil }
}
private struct ExportMediaFixture: PlaybackResolving, YouTubeHTTPTransport {
    let data: Data
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        let url = URL(string: "https://r1.googlevideo.com/videoplayback?id=export-test&itag=140&clen=\(data.count)&expire=4000000000&lmt=1000&mime=audio%2Fmp4&source=youtube")!
        return try .youtube(lease: VerifiedYouTubeStreamLease(requestedVideoID: track.videoID, playerVideoID: track.videoID,
            itag: 140, mimeType: "audio/mp4; codecs=\"mp4a.40.2\"", contentLength: data.count, url: url,
            expiresAt: Date(timeIntervalSince1970: 4_000_000_000)))
    }
    func request(_ request: URLRequest, maxBytes: Int) async throws -> BoundedHTTPResponse {
        guard let range = PartialMediaSample.requestedRange(request.value(forHTTPHeaderField: "Range")),
              range.upperBound < data.count, range.count == maxBytes else { throw PlaybackFailure.invalidRequest }
        return BoundedHTTPResponse(status: 206, headers: ["content-length": String(range.count), "content-type": "audio/mp4",
            "content-range": "bytes \(range.lowerBound)-\(range.upperBound)/\(data.count)"], body: Data(data[range]))
    }
}
private struct ExportFixture {
    let folder: URL
    let engine: ManagedOfflineEngine
    let owner: OfflineOwnerScope
    let copy: OfflineLocalCopy
    let sourceBytes: Data
    let track: TrackDTO
    var outputRoot: URL { folder.appendingPathComponent("exports", isDirectory: true) }
}
@MainActor private func makeExportFixture() async throws -> ExportFixture {
    let manager = FileManager.default
    let folder = manager.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("AureliaExportChecks-" + UUID().uuidString, isDirectory: true)
    try manager.createDirectory(at: folder, withIntermediateDirectories: true)
    do {
        let studio = try await StudioResolver().resolve(StudioCatalogue.tracks[0].queueEntry())
        let original = try Data(contentsOf: studio.url)
        let encoded = folder.appendingPathComponent("initial-aac-fixture.m4a")
        guard let session = AVAssetExportSession(asset: AVURLAsset(url: studio.url), presetName: AVAssetExportPresetAppleM4A) else {
            throw ExportCheckFailure.assertion("AAC fixture encoder")
        }
        session.outputURL = encoded; session.outputFileType = .m4a
        session.timeRange = CMTimeRange(start: .zero, duration: CMTime(seconds: 2, preferredTimescale: 600))
        do { try await AudioExportOperation(session).run() }
        catch {
            print("Audio export fixture encode: status=\(session.status.rawValue) code=\((session.error as NSError?)?.code ?? 0)")
            throw error
        }
        let data = try Data(contentsOf: encoded)
        try exportRequire(try Data(contentsOf: studio.url) == original, "initial test encoding preserves bundled original")
        let source = ExportMediaFixture(data: data)
        let engine = try ManagedOfflineEngine(rootDirectory: folder.appendingPathComponent("managed", isDirectory: true),
            resolver: source, policy: OfflineStoragePolicy(budgetBytes: 8 * 1024 * 1024, reserveBytes: 0),
            transport: source, availableSpace: { _ in 100 * 1024 * 1024 })
        let owner = try OfflineOwnerScope(ownerID: "audio-export-fixture")
        try await engine.activateOwner(owner); try await engine.setEnvironment(foreground: true, onWiFi: true)
        let track = try TrackDTO(id: "youtube:00000000001", title: "Тест / 春 🎵", artist: "Исполнитель", album: "Альбом", provider: "youtube", externalId: "00000000001", duration: 2,
                                 artwork: "https://arbitrary.invalid/must-never-be-used")
        let playback = try PlaybackTrack(videoID: track.externalId, title: track.title, artist: track.artist)
        _ = try await engine.enqueue(playback, owner: owner)
        for _ in 0..<300 {
            let item = try await engine.snapshot(owner: owner).items.first
            if item?.state == .failed { throw item?.failure ?? OfflineFailure.corrupt }
            if item?.state == .ready {
                return ExportFixture(folder: folder, engine: engine, owner: owner,
                    copy: try await engine.openReady(playback, owner: owner), sourceBytes: data, track: track)
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw ExportCheckFailure.assertion("generated AAC reaches managed ready")
    } catch { try? manager.removeItem(at: folder); throw error }
}
private func exportLyrics(plain: String?, synced: String?) throws -> LyricsDTO {
    let data = try JSONSerialization.data(withJSONObject: ["id": 1, "trackName": "Fixture", "artistName": "Fixture", "albumName": "Fixture",
        "duration": 2, "instrumental": false, "plainLyrics": plain as Any? ?? NSNull(), "syncedLyrics": synced as Any? ?? NSNull()])
    return try JSONDecoder().decode(LyricsDTO.self, from: data)
}
private func exportJPEG() throws -> Data {
    let raw = NSMutableData()
    guard let context = CGContext(data: nil, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 64,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
        throw ExportCheckFailure.assertion("JPEG context")
    }
    context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.7, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
    guard let image = context.makeImage(), let destination = CGImageDestinationCreateWithData(raw, "public.jpeg" as CFString, 1, nil) else {
        throw ExportCheckFailure.assertion("JPEG encoder")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw ExportCheckFailure.assertion("JPEG finalize") }
    return raw as Data
}
private func exportMediaPayload(_ data: Data) throws -> Data {
    var offset = 0, audio = Data()
    func number(_ at: Int, _ count: Int) -> UInt64 { data[at..<(at + count)].reduce(0) { ($0 << 8) | UInt64($1) } }
    while offset < data.count {
        guard data.count - offset >= 8 else { throw ExportCheckFailure.assertion("MP4 box header") }
        let raw = number(offset, 4), header = raw == 1 ? 16 : 8
        guard data.count - offset >= header else { throw ExportCheckFailure.assertion("MP4 extended header") }
        let size = raw == 1 ? number(offset + 8, 8) : (raw == 0 ? UInt64(data.count - offset) : raw)
        guard size >= header, size <= data.count - offset else { throw ExportCheckFailure.assertion("MP4 box length") }
        if String(decoding: data[(offset + 4)..<(offset + 8)], as: UTF8.self) == "mdat" {
            audio.append(data[(offset + header)..<(offset + Int(size))])
        }
        offset += Int(size)
    }
    guard !audio.isEmpty else { throw ExportCheckFailure.assertion("M4A media payload") }; return audio
}
@MainActor private func exportPacketHash(_ url: URL) async throws -> Data {
    let asset = AVURLAsset(url: url), tracks = try await asset.loadTracks(withMediaType: .audio)
    guard tracks.count == 1 else { throw ExportCheckFailure.assertion("one AAC track") }
    let reader = try AVAssetReader(asset: asset), output = AVAssetReaderTrackOutput(track: tracks[0], outputSettings: nil)
    reader.add(output)
    guard reader.startReading() else { throw ExportCheckFailure.assertion("compressed AAC reader") }
    var hash = SHA256(), count = 0
    while let sample = output.copyNextSampleBuffer() {
        // CoreMedia explicitly returns no-data marker buffers for empty edits.
        // They contain no AAC packet and must not be treated as media bytes.
        let samples = CMSampleBufferGetNumSamples(sample), sampleBytes = CMSampleBufferGetTotalSampleSize(sample)
        let emptyEdit = CMGetAttachment(sample, key: kCMSampleBufferAttachmentKey_EmptyMedia, attachmentModeOut: nil) as? Bool == true
        if sampleBytes == 0 && (samples == 0 || emptyEdit) { continue }
        guard let block = CMSampleBufferGetDataBuffer(sample) else {
            throw ExportCheckFailure.assertion("AAC sample buffer samples=\(samples) bytes=\(sampleBytes) emptyEdit=\(emptyEdit)")
        }
        let length = CMBlockBufferGetDataLength(block)
        guard length > 0, length < 1024 * 1024 else { throw ExportCheckFailure.assertion("bounded AAC packet") }
        var data = Data(count: length)
        let result = data.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
        guard result == kCMBlockBufferNoErr else { throw ExportCheckFailure.assertion("AAC packet read") }
        hash.update(data: data); count += length
    }
    guard reader.status == .completed, count > 0 else { throw ExportCheckFailure.assertion("complete AAC packet read") }
    return Data(hash.finalize())
}

enum AudioExportChecks {
    static var cases: [(String, @MainActor () async throws -> Void)] {
        [("audio_export_native_tags_lyrics_cover_aac_roundtrip", roundtrip),
         ("audio_export_synced_fallback_and_cleanup", boundaries)]
    }
    @MainActor private static func roundtrip() async throws {
        let fixture = try await makeExportFixture(); defer { try? FileManager.default.removeItem(at: fixture.folder) }
        let plain = "Первая строка\nSecond line 🎵", synced = "[00:00.00]Первая строка\n[00:01.00]Second line 🎵"
        let lyrics = try exportLyrics(plain: plain, synced: synced), jpeg = try exportJPEG()
        let files = try await AudioFileExport.prepare(copy: fixture.copy, track: fixture.track, lyrics: lyrics,
            coverProvider: ExportCoverFixture(data: jpeg), rootDirectory: fixture.outputRoot)
        try exportRequire(Set(files.map(\.pathExtension)) == ["m4a", "txt", "lrc", "jpg"], "all requested export sidecars")
        let audio = files.first { $0.pathExtension == "m4a" }!, bytes = try Data(contentsOf: audio)
        let metadata = try await AVURLAsset(url: audio).load(.metadata)
        for (identifier, value) in [(AVMetadataIdentifier.iTunesMetadataSongName, fixture.track.title), (.iTunesMetadataArtist, fixture.track.artist),
                                    (.iTunesMetadataAlbum, fixture.track.album), (.iTunesMetadataLyrics, plain)] {
            let item = AVMetadataItem.metadataItems(from: metadata, filteredByIdentifier: identifier).first
            let actual = try await item?.load(.stringValue)
            try exportRequire(actual == value, "actual native M4A tag roundtrip: " + identifier.rawValue)
        }
        let art = AVMetadataItem.metadataItems(from: metadata, filteredByIdentifier: .iTunesMetadataCoverArt).first
        let actualArt = try await art?.load(.dataValue)
        try exportRequire(actualArt == jpeg, "actual native artwork tag roundtrip")
        try exportRequire(try String(contentsOf: files.first { $0.pathExtension == "txt" }!, encoding: .utf8) == plain, "UTF8 plain sidecar")
        try exportRequire(try String(contentsOf: files.first { $0.pathExtension == "lrc" }!, encoding: .utf8) == synced, "LRC sidecar unchanged")
        try exportRequire(try Data(contentsOf: files.first { $0.pathExtension == "jpg" }!) == jpeg, "JPEG sidecar exact bytes")
        try exportRequire(try exportMediaPayload(bytes) == exportMediaPayload(fixture.sourceBytes), "AAC mdat bytes pass through exactly")
        let sourcePackets = try await exportPacketHash(fixture.copy.url), outputPackets = try await exportPacketHash(audio)
        try exportRequire(sourcePackets == outputPackets, "compressed AAC packet bitstream preserved")
        try exportRequire(try Data(contentsOf: fixture.copy.url) == fixture.sourceBytes && fixture.copy.isValid, "managed original remains byte-identical")
        try await fixture.engine.activateOwner(nil)
    }
    @MainActor private static func boundaries() async throws {
        let fixture = try await makeExportFixture(); defer { try? FileManager.default.removeItem(at: fixture.folder) }
        let synced = "[00:00.00]First line\n[00:01.00]Вторая строка"
        let lyrics = try exportLyrics(plain: nil, synced: synced)
        let files = try await AudioFileExport.prepare(copy: fixture.copy, track: fixture.track, lyrics: lyrics,
            coverProvider: ExportCoverFixture(data: Data([1, 2, 3])), rootDirectory: fixture.outputRoot)
        try exportRequire(Set(files.map(\.pathExtension)) == ["m4a", "txt", "lrc"], "malformed optional cover omitted")
        let plain = try String(contentsOf: files.first { $0.pathExtension == "txt" }!, encoding: .utf8)
        try exportRequire(plain == "First line\nВторая строка", "synced-only choice also exports static lyrics")
        let name = AudioFileExport.safeName(String(repeating: "🎵", count: 100) + "/../:\u{0}")
        try exportRequire(name.utf8.count <= 180 && !name.contains("/") && !name.contains(":"), "Unicode filename bounded in UTF8")
        try exportRequire(YouTubeExportCover.canonicalURL(videoID: "00000000001")?.absoluteString == "https://i.ytimg.com/vi/00000000001/hqdefault.jpg"
            && YouTubeExportCover.canonicalURL(videoID: "../bad") == nil, "cover URL constructed from video identity only")
        let before = Set(try FileManager.default.contentsOfDirectory(atPath: fixture.outputRoot.path))
        do {
            _ = try await AudioFileExport.prepare(copy: fixture.copy, track: fixture.track, lyrics: nil,
                coverProvider: ExportCoverFixture(data: nil), rootDirectory: fixture.outputRoot, sessionFactory: { _ in nil })
            throw ExportCheckFailure.assertion("missing export session accepted")
        } catch PlaybackFailure.unavailable {}
        let afterFailure = Set(try FileManager.default.contentsOfDirectory(atPath: fixture.outputRoot.path))
        try exportRequire(afterFailure == before, "failed export removes only its new temporary directory")
        let cancellation = ExportCancellation()
        cancellation.task = Task { @MainActor in
            try await AudioFileExport.prepare(copy: fixture.copy, track: fixture.track, lyrics: nil,
                coverProvider: ExportCoverFixture(data: nil), rootDirectory: fixture.outputRoot, sessionFactory: { asset in
                    cancellation.task?.cancel()
                    return AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough)
                })
        }
        do { _ = try await cancellation.task!.value; throw ExportCheckFailure.assertion("cancelled export returned files") }
        catch is CancellationError {}
        let afterCancel = Set(try FileManager.default.contentsOfDirectory(atPath: fixture.outputRoot.path))
        try exportRequire(afterCancel == before && fixture.copy.isValid, "cancelled export removes partial and preserves managed copy")
        let held = ExportHeldCover()
        let first = Task { @MainActor in
            try await AudioFileExport.prepare(copy: fixture.copy, track: fixture.track, lyrics: nil,
                coverProvider: held, rootDirectory: fixture.outputRoot)
        }
        for _ in 0..<300 {
            if await held.entered { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let entered = await held.entered
        guard entered else { first.cancel(); await held.release(); throw ExportCheckFailure.assertion("held cover admission deadline") }
        do {
            _ = try await AudioFileExport.prepare(copy: fixture.copy, track: fixture.track, lyrics: nil,
                coverProvider: ExportCoverFixture(data: nil), rootDirectory: fixture.outputRoot)
            first.cancel(); await held.release(); throw ExportCheckFailure.assertion("concurrent export admitted against same budget")
        } catch PlaybackFailure.busy {}
        first.cancel(); await held.release()
        do { _ = try await first.value; throw ExportCheckFailure.assertion("held cancelled export completed") }
        catch is CancellationError {}
        let afterConcurrent = Set(try FileManager.default.contentsOfDirectory(atPath: fixture.outputRoot.path))
        try exportRequire(afterConcurrent == before, "concurrent busy rejection and cancelled admission leave no files")
        try await fixture.engine.activateOwner(nil)
    }
}
@MainActor private final class ExportCancellation { var task: Task<[URL], Error>? }
