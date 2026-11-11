import SwiftUI
import UniformTypeIdentifiers
import AureliaPlaybackCore

struct LocalFilesView: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var store: AppleLocalFilesStore
    let onPlay: ([LocalAudioRecord], Int) -> Void
    let onDisable: () -> Void
    var onPlayNext: ((LocalAudioRecord) -> Void)?
    var onAddToQueue: ((LocalAudioRecord) -> Void)?
    @ViewState private var importing = false
    @ViewState private var deletion: LocalAudioRecord?
    @ViewState private var query = ""
    @ViewState private var alphabetical = false
    @ViewState private var pickerError: String?
    private var visible: [LocalAudioRecord] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let filtered = (store.snapshot?.records ?? []).filter {
            query.isEmpty || ($0.title + " " + $0.artist + " " + $0.album).localizedStandardContains(query)
        }
        return alphabetical ? filtered.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending } : filtered
    }
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                SectionHeading(title: "Music Files", subtitle: "Your own recordings · kept on this device")
                Toggle("Enable music files on this device", isOn: Binding(
                    get: { store.snapshot?.enabled ?? false },
                    set: { enabled in
                        if !enabled { onDisable() }
                        Task { await store.setEnabled(enabled) }
                    }))
                    .disabled(store.busy || store.snapshot == nil)
                Text("Choose individual MP3, M4A or FLAC files using the system picker. Aurelia copies them into its private storage and reads their tags. Originals stay unchanged; no files are uploaded or added to your cloud account.")
                    .font(.subheadline).foregroundStyle(.secondary)
                if let snapshot = store.snapshot {
                    HStack {
                    Text("Storage limit")
                    Spacer()
                    Picker("Storage limit", selection: Binding(
                        get: { snapshot.storageBudgetBytes }, set: { bytes in Task { await store.setStorageBudget(bytes) } })) {
                            ForEach(LocalAudioLibrary.storageBudgets, id: \.self) { bytes in Text(size(bytes)).tag(bytes) }
                        }.pickerStyle(.menu).labelsHidden().disabled(store.busy)
                    }
                    Text("\(size(snapshot.usedBytes)) used of \(size(snapshot.storageBudgetBytes)) · \(snapshot.records.count)/1,000 recordings")
                        .font(.caption).foregroundStyle(.secondary)
                    if snapshot.enabled {
                        Button("Import audio files", systemImage: "plus") { pickerError = nil; importing = true }
                            .buttonStyle(.borderedProminent).disabled(store.busy || snapshot.records.count >= LocalAudioLibrary.maximumRecords)
                        Text("Maximum 128 MiB per file. Your original and the private copy both use storage. Playback depends on this device’s audio-format support.")
                            .font(.caption).foregroundStyle(.secondary)
                        if !snapshot.records.isEmpty {
                            TextField("Filter music files", text: $query).textFieldStyle(.roundedBorder)
                                .accessibilityLabel("Filter device music by title, artist or album")
                            Toggle("Sort by title", isOn: $alphabetical)
                            if visible.isEmpty { Text("No recordings match your filter.").foregroundStyle(.secondary) }
                            ForEach(Array(visible.enumerated()), id: \.element.id) { index, record in
                                row(record, index: index)
                            }
                        } else {
                            EmptyCollection(symbol: "folder", title: "Choose music you own", detail: "Import individual audio files to play them without a network connection.")
                        }
                    } else if !snapshot.records.isEmpty {
                        Text("Your private copies remain stored while this feature is off. Enable it to play or remove them.")
                            .foregroundStyle(.secondary)
                    }
                }
                if store.busy {
                    if store.importingTotal > 0 { ProgressView("Importing \(store.importingPosition) of \(store.importingTotal)…") }
                    else { ProgressView("Updating device music…") }
                }
                if let message = store.message { Text(message).font(.footnote).foregroundStyle(.secondary) }
                if let pickerError { Text(pickerError).font(.footnote).foregroundStyle(.secondary) }
            }.padding(24).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }
        .background(theme.background).navigationTitle("Music Files")
        .task { await store.refresh() }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.mp3, .mpeg4Audio, UTType(filenameExtension: "flac") ?? .audio], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): pickerError = nil; Task { await store.importFiles(urls) }
            case .failure(let error):
                if (error as? CocoaError)?.code != .userCancelled { pickerError = "The system picker could not provide these files. Try selecting them again." }
            }
        }
        .confirmationDialog("Remove the private copy?", isPresented: Binding(get: { deletion != nil }, set: { if !$0 { deletion = nil } }), titleVisibility: .visible) {
            if let deletion {
                Button("Remove private copy", role: .destructive) {
                    self.deletion = nil
                    Task { await store.remove(deletion.id) }
                }
            }
        } message: { Text("Your original file is left unchanged. Stop playback of this recording before removing its copy.") }
    }
    private func row(_ record: LocalAudioRecord, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Button { onPlay(visible, index) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "waveform").foregroundStyle(theme.accent).frame(width: 48, height: 48)
                            .background(theme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                        VStack(alignment: .leading, spacing: 4) {
                            Text(record.title).font(.headline).foregroundStyle(.primary).lineLimit(2)
                            Text([record.artist, record.album].filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            Text(record.fileExtension.uppercased() + " · " + size(record.byteCount)).font(.caption2).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain).disabled(store.busy).accessibilityLabel("Play \(record.title), \(record.artist)")
                Menu {
                    if let onPlayNext { Button("Play next") { onPlayNext(record) } }
                    if let onAddToQueue { Button("Add to queue") { onAddToQueue(record) } }
                    Button("Remove private copy", role: .destructive) { deletion = record }
                } label: { Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44).contentShape(Rectangle()) }
                    .disabled(store.busy).accessibilityLabel("Actions for \(record.title)")
            }
            Divider()
        }
    }
    private func size(_ bytes: Int) -> String { ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .binary) }
}
