import Foundation
import CryptoKit
@testable import AureliaPlaybackCore

private enum LocalFileCheckFailure: Error { case assertion(String) }
private func localFileExpect(_ value: @autoclosure () -> Bool, _ label: String) throws {
    if !value() { throw LocalFileCheckFailure.assertion(label) }
}

/// Copies the existing test recording; never creates a player or audio session.
private func makeLocalFileFixture(_ url: URL) throws {
    var repository = URL(fileURLWithPath: #filePath)
    for _ in 0..<7 { repository.deleteLastPathComponent() }
    let fixture = repository.appendingPathComponent("apps/apple/Sources/AureliaAppleUI/Resources/Audio/1.mp3")
    guard FileManager.default.fileExists(atPath: fixture.path) else { throw LocalFileCheckFailure.assertion("bundled source fixture missing") }
    try FileManager.default.copyItem(at: fixture, to: url)
}

func runLocalAudioLibraryChecks() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("AureliaLocalFilesChecks-" + UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let source = folder.appendingPathComponent("Selected song.mp3")
    try makeLocalFileFixture(source)
    let original = try Data(contentsOf: source), originalHash = Data(SHA256.hash(data: original))
    let root = folder.appendingPathComponent("private", isDirectory: true)
    let library = try LocalAudioLibrary(rootDirectory: root)
    let initial = await library.snapshot()
    try localFileExpect(!initial.enabled && initial.records.isEmpty && initial.storageBudgetBytes == 512 * 1024 * 1024, "local audio opt-in defaults off with explicit storage budget")
    do { _ = try await library.importFile(source); throw LocalFileCheckFailure.assertion("disabled import accepted") }
    catch LocalAudioFailure.disabled {}
    try await library.setEnabled(true)
    let unsupported = folder.appendingPathComponent("playlist.m3u")
    try Data("https://example.invalid/audio".utf8).write(to: unsupported)
    do { _ = try await library.importFile(unsupported); throw LocalFileCheckFailure.assertion("remote playlist accepted") }
    catch LocalAudioFailure.invalidFile {}
    let disguised = folder.appendingPathComponent("playlist.mp3")
    try Data("#EXTM3U\nhttps://example.invalid/audio".utf8).write(to: disguised)
    do { _ = try await library.importFile(disguised); throw LocalFileCheckFailure.assertion("disguised playlist accepted") }
    catch LocalAudioFailure.unsupported {}
    let symlink = folder.appendingPathComponent("symlink.mp3")
    try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: source)
    do { _ = try await library.importFile(symlink); throw LocalFileCheckFailure.assertion("symlink source accepted") }
    catch LocalAudioFailure.invalidFile {}
    let large = folder.appendingPathComponent("too-large.m4a")
    _ = FileManager.default.createFile(atPath: large.path, contents: nil)
    let sparse = try FileHandle(forWritingTo: large)
    try sparse.truncate(atOffset: UInt64(LocalAudioLibrary.maximumFileBytes + 1)); try sparse.close()
    do { _ = try await library.importFile(large); throw LocalFileCheckFailure.assertion("oversized source accepted") }
    catch LocalAudioFailure.invalidFile {}
    let record = try await library.importFile(source)
    let snapshot = await library.snapshot()
    try localFileExpect(snapshot.records.count == 1 && !record.title.isEmpty && !record.artist.isEmpty && record.duration > 0, "AVFoundation audio validation and bounded tags or fallback")
    try localFileExpect(record.byteCount == original.count && snapshot.usedBytes == original.count, "copy bytes tracked against budget")
    var interruptedCopies: [URL] = []
    for _ in 0..<4 {
        let url = root.appendingPathComponent(UUID().uuidString.lowercased() + ".part")
        _ = FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: UInt64(LocalAudioLibrary.maximumFileBytes)); try handle.close()
        interruptedCopies.append(url)
    }
    do { _ = try await library.importFile(source); throw LocalFileCheckFailure.assertion("unindexed interrupted copies escaped storage budget") }
    catch LocalAudioFailure.storageLimit {}
    for url in interruptedCopies { try FileManager.default.removeItem(at: url) }
    let playback = try record.playbackTrack(), encoded = try JSONEncoder().encode(playback)
    try localFileExpect(playback.provider == .device && playback.videoID.isEmpty && playback.deviceID == record.id, "local files have a distinct native provider and UUID identity")
    let decoded = try JSONDecoder().decode(PlaybackTrack.self, from: encoded)
    try localFileExpect(decoded == playback, "device playback metadata roundtrip")
    let text = String(decoding: encoded, as: UTF8.self)
    try localFileExpect(!text.contains("file:") && !text.contains(source.path) && !text.contains("mp3"), "queue metadata never exposes file locators")
    do { _ = try ResolvedAudio(url: source, expiresAt: .distantFuture); throw LocalFileCheckFailure.assertion("generic URL initializer admitted local file") }
    catch PlaybackFailure.invalidSource {}
    let copy = try await library.open(record.id)
    let audio = try ResolvedAudio.device(copy)
    try localFileExpect(audio.isDeviceFile && !audio.isOffline && audio.deviceID == record.id && audio.isPlayable, "checked local capability enters device audio path only")
    do { try await library.remove(record.id); throw LocalFileCheckFailure.assertion("live copy was deleted") }
    catch LocalAudioFailure.busy {}
    let privateURL = root.appendingPathComponent(record.id.uuidString.lowercased() + "." + record.fileExtension)
    let privateBytes = try Data(contentsOf: privateURL)
    try localFileExpect(privateBytes == original, "private copy preserves source bytes exactly")
    let after = try Data(contentsOf: source)
    try localFileExpect(Data(SHA256.hash(data: after)) == originalHash, "import never modifies original")
    try await library.setEnabled(false)
    try localFileExpect(!audio.isPlayable, "disabling device audio revokes existing read capability")
    let cold = try LocalAudioLibrary(rootDirectory: root)
    let restored = await cold.snapshot()
    try localFileExpect(!restored.enabled && restored.records == [record], "cold metadata retains copies and disabled opt-in")
    do { _ = try await cold.open(record.id); throw LocalFileCheckFailure.assertion("disabled cold file opened") }
    catch LocalAudioFailure.disabled {}
    try await library.remove(record.id)
    try localFileExpect(!FileManager.default.fileExists(atPath: privateURL.path) && FileManager.default.fileExists(atPath: source.path), "remove deletes app copy only")
    try await library.setEnabled(true)
    let tampered = try await library.importFile(source), ready = try await library.open(tampered.id)
    let tamperedURL = root.appendingPathComponent(tampered.id.uuidString.lowercased() + "." + tampered.fileExtension)
    let writer = try FileHandle(forWritingTo: tamperedURL)
    try writer.seekToEnd(); try writer.write(contentsOf: Data([0])); try writer.close()
    try localFileExpect(!ready.isValid, "private-copy checksum/length tamper invalidates admission")
    do { _ = try await library.open(tampered.id); throw LocalFileCheckFailure.assertion("tampered copy reopened") }
    catch LocalAudioFailure.corrupt {}
    let finalOriginal = try Data(contentsOf: source)
    try localFileExpect(finalOriginal == original, "all operations preserve selected original")
}
