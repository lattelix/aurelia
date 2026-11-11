import Foundation
import Combine
import AureliaPlaybackCore

/// Device-local opt-in state and picker work. No account or cloud dependency.
@MainActor public final class AppleLocalFilesStore: ObservableObject {
    @Published public private(set) var snapshot: LocalAudioSnapshot?
    @Published public private(set) var busy = false
    @Published public private(set) var message: String?
    @Published public private(set) var importingPosition = 0
    @Published public private(set) var importingTotal = 0
    public let library: LocalAudioLibrary?
    public init(library: LocalAudioLibrary?) { self.library = library }
    public func refresh() async {
        guard let library else { message = "Device music storage could not be opened."; return }
        snapshot = await library.snapshot()
    }
    public func setEnabled(_ enabled: Bool) async {
        guard let library, !busy else { return }
        busy = true; defer { busy = false }
        do { try await library.setEnabled(enabled); message = nil }
        catch { show(error) }
        await refresh()
    }
    public func setStorageBudget(_ bytes: Int) async {
        guard let library, !busy else { return }
        busy = true; defer { busy = false }
        do { try await library.setStorageBudget(bytes); message = nil }
        catch { show(error) }
        await refresh()
    }
    public func importFiles(_ urls: [URL]) async {
        guard let library, !busy, !urls.isEmpty else { return }
        guard urls.count <= LocalAudioLibrary.maximumRecords else { message = "Choose no more than 1,000 recordings per import."; return }
        busy = true; importingTotal = urls.count; importingPosition = 0; message = nil
        defer { busy = false; importingPosition = 0; importingTotal = 0 }
        var imported = 0, failures = 0
        for url in urls {
            guard !Task.isCancelled else { break }
            let access = url.startAccessingSecurityScopedResource()
            do { _ = try await library.importFile(url); imported += 1 }
            catch { failures += 1; show(error) }
            if access { url.stopAccessingSecurityScopedResource() }
            importingPosition += 1
            await refresh()
        }
        if failures == 0 { message = "Imported \(imported) recording\(imported == 1 ? "" : "s") as private copies. Your originals were left unchanged." }
        else { message = "Imported \(imported); \(failures) could not be imported. " + (message ?? "Check the format and storage budget.") }
    }
    public func remove(_ id: UUID) async {
        guard let library, !busy else { return }
        busy = true; defer { busy = false }
        do { try await library.remove(id); message = "Removed the app’s private copy. Your original file was left unchanged." }
        catch { show(error) }
        await refresh()
    }
    private func show(_ error: Error) { message = (error as? LocalAudioFailure)?.message ?? "The audio-file operation could not finish. Your original files were left unchanged." }
}
