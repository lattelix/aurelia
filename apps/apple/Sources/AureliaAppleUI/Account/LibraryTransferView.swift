import SwiftUI
import UniformTypeIdentifiers
import AureliaCloud

private struct LibraryJSONDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents, data.count <= 2_000_000 else { throw CocoaError(.fileReadTooLarge) }
        self.data = data
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

struct LibraryTransferView: View {
    @ObservedObject var cloud: CloudAccountStore
    @ViewState private var document: LibraryJSONDocument?
    @ViewState private var exporting = false
    @ViewState private var importing = false
    @ViewState private var busy = false
    @ViewState private var message: String?
    @ViewState private var reviewItems: [CloudImportItemDTO] = []
    var body: some View {
        Form {
            Section("Portable library") {
                Text("Keep a JSON backup of your likes, playlists and listening history. This file contains music metadata, not audio or account credentials.")
                Button("Export library", systemImage: "square.and.arrow.up") {
                    guard let owner = cloud.account?.id else { return }
                    busy = true
                    Task {
                        let data = await cloud.exportLibrary(expectedAccountID: owner)
                        busy = false
                        guard owner == cloud.account?.id else { return }
                        if let data { document = LibraryJSONDocument(data: data); exporting = true }
                        else { message = cloud.message ?? "The export could not be prepared." }
                    }
                }.disabled(busy || cloud.account == nil)
                Button("Import JSON file", systemImage: "square.and.arrow.down") { importing = true }
                    .disabled(busy || cloud.account == nil)
                Text("Imports are added to your current account. Uncertain matches remain in review and never replace your existing library. Maximum file size: 2 MB.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if busy { ProgressView("Working with your library…") }
            if let message { Section("Result") { Text(message).textSelection(.enabled) } }
            if !reviewItems.isEmpty, let owner = cloud.account?.id {
                Section { NavigationLink("Review uncertain matches") { ImportReviewView(cloud: cloud, accountID: owner, items: reviewItems) } }
            }
            Section {
                Link("Open import review on the website", destination: CloudAPIClient.origin.appendingPathComponent("import"))
            }
        }
        .formStyle(.grouped).navigationTitle("Import & Export")
        .fileExporter(isPresented: $exporting, document: document, contentType: .json, defaultFilename: "Aurelia-library") { result in
            switch result { case .success: message = "Library backup saved."; case .failure: message = "Export was cancelled or could not be saved." }
            document = nil
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            guard let owner = cloud.account?.id else { return }
            switch result {
            case .failure: message = "No file imported."
            case .success(let url):
                busy = true
                Task {
                    defer { busy = false }
                    let access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    do {
                        let handle = try FileHandle(forReadingFrom: url)
                        defer { try? handle.close() }
                        let data = try handle.read(upToCount: 2_000_001) ?? Data()
                        guard !data.isEmpty, data.count <= 2_000_000 else { message = "Choose a JSON file up to 2 MB."; return }
                        let result = await cloud.importLibrary(data, expectedAccountID: owner)
                        guard owner == cloud.account?.id else { return }
                        reviewItems = result?.items ?? []
                        message = result == nil ? (cloud.message ?? "The file could not be imported.") : "Import processed. Refresh your library to see saved matches. Open import review for any uncertain tracks."
                    } catch { message = "This file could not be read. No data was imported." }
                }
            }
        }
        .onChange(of: cloud.account?.id) { _, _ in document = nil; exporting = false; message = nil; reviewItems = [] }
    }
}
