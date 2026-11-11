import SwiftUI
import AureliaCloud

struct LyricsView: View {
    @Environment(\.aureliaPalette) private var theme
    private struct TrackInfo { let id: String; let title: String; let artist: String }
    private let track: TrackInfo
    let position: Double
    let duration: Double
    let canSeek: Bool
    let onSeek: (Double) -> Void
    private let loadManaged: (@MainActor () async -> LyricsDTO?)?
    private let saveManaged: (@MainActor (LyricsDTO) async -> Bool)?
    @StateObject private var lyrics: CloudLyricsStore
    @ViewState private var query: String
    @ViewState private var submitted: String
    @ViewState private var attempt = 0
    @ViewState private var selected: LyricsDTO?
    @ViewState private var selectedLines: [LyricsLine] = []
    @ViewState private var timingOffset: Double = 0
    @ViewState private var cacheMessage: String?
    @ViewState private var selectionTask: Task<Void, Never>?
    @ViewState private var selectionGeneration: UInt64 = 0
    @ViewState private var activeTrackID: String
    @Environment(\.dismiss) private var dismiss

    init(track: TrackDTO, music: CloudMusicStore, position: Double, duration: Double, canSeek: Bool,
         loadManaged: (@MainActor () async -> LyricsDTO?)? = nil,
         saveManaged: (@MainActor (LyricsDTO) async -> Bool)? = nil, onSeek: @escaping (Double) -> Void) {
        self.init(trackID: track.id, title: track.title, artist: track.artist, music: music,
            position: position, duration: duration, canSeek: canSeek, loadManaged: loadManaged, saveManaged: saveManaged, onSeek: onSeek)
    }
    init(trackID: String, title: String, artist: String, music: CloudMusicStore,
         position: Double, duration: Double, canSeek: Bool,
         loadManaged: (@MainActor () async -> LyricsDTO?)? = nil,
         saveManaged: (@MainActor (LyricsDTO) async -> Bool)? = nil, onSeek: @escaping (Double) -> Void) {
        self.track = TrackInfo(id: trackID, title: title, artist: artist)
        self.position = position; self.duration = duration; self.canSeek = canSeek; self.onSeek = onSeek
        self.loadManaged = loadManaged; self.saveManaged = saveManaged
        _activeTrackID = ViewState(initialValue: trackID)
        _lyrics = StateObject(wrappedValue: music.makeLyricsSession())
        let title = title.replacingOccurrences(of: #"\([^)]*\)|\[[^\]]*\]"#, with: "", options: .regularExpression)
        let initial = String((title + " " + artist).trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        _query = ViewState(initialValue: initial); _submitted = ViewState(initialValue: initial)
    }
    private var validQuery: Bool {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return (2...200).contains(query.utf16.count) && !query.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }
    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        Text(track.title).font(.title2.weight(.bold))
                        Text(track.artist).foregroundStyle(.secondary)
                        TextField("Song and artist", text: $query).textFieldStyle(.roundedBorder)
                            .accessibilityLabel("Find lyrics by song and artist").onSubmit(submit)
                        Button("Find lyrics", systemImage: "magnifyingglass", action: submit)
                            .disabled(!validQuery || lyrics.isLoading).buttonStyle(.bordered)
                        if lyrics.isLoading { ProgressView("Finding lyrics…") }
                        else if let error = lyrics.error {
                            Text(error).foregroundStyle(.secondary)
                            Button("Retry", action: submit).disabled(!validQuery)
                        } else if let selected {
                            selectedLyrics(selected)
                        } else {
                            Text("Choose the recording that matches this song. Timing depends on the selected recording.")
                                .font(.subheadline).foregroundStyle(.secondary)
                            if lyrics.records.isEmpty {
                                EmptyCollection(symbol: "text.quote", title: "No lyrics found", detail: "Try a different song name or artist.")
                            }
                            ForEach(lyrics.records) { record in
                                Button { choose(record) } label: {
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(record.trackName).font(.headline).foregroundStyle(.primary)
                                        Text([record.artistName, record.albumName, record.duration.formatted(.number.precision(.fractionLength(0))) + "s"].filter { !$0.isEmpty }.joined(separator: " · "))
                                            .font(.caption).foregroundStyle(.secondary)
                                        Text(record.syncedLyrics?.isEmpty == false ? "Synced lyrics" : record.instrumental ? "Instrumental" : "Plain lyrics")
                                            .font(.caption).foregroundStyle(theme.accent)
                                    }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
                                        .background(theme.card, in: RoundedRectangle(cornerRadius: 12))
                                }.buttonStyle(.plain)
                            }
                        }
                        if selected?.provenance == .managed {
                            Text("Saved lyrics").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            Text("LRCLIB selection saved on this device").font(.caption).foregroundStyle(.secondary)
                        } else {
                            Link("Lyrics from LRCLIB", destination: URL(string: "https://lrclib.net")!)
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(24).frame(maxWidth: 750).frame(maxWidth: .infinity)
                }
                .onChange(of: activeLine) { _, line in
                    guard let line else { return }
                    withAnimation(.easeInOut(duration: 0.25)) { proxy.scrollTo(line, anchor: .center) }
                }
            }
            .background(theme.background).navigationTitle("Lyrics")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task(id: "\(track.id):\(submitted):\(attempt)") {
                if attempt == 0 {
                    let cached = await lyrics.restorePreferredSelection(for: track.id, loadManaged: loadManaged)
                    guard !Task.isCancelled else { return }
                    if let cached {
                        selected = cached; selectedLines = cached.lines
                        cacheMessage = cached.provenance == .managed
                            ? "Lyrics saved with this downloaded recording"
                            : "LRCLIB selection saved on this device"
                        return
                    }
                }
                guard !Task.isCancelled else { return }
                await lyrics.search(submitted)
            }
            .onDisappear { cancelSelection(); selectionTask = nil; lyrics.reset() }
            .onChange(of: track.id) { _, id in
                activeTrackID = id; cancelSelection(); selected = nil; selectedLines = []; cacheMessage = nil
            }
        }
        #if os(macOS)
        .frame(minWidth: 430, idealWidth: 600, minHeight: 500)
        #endif
    }
    private var activeLine: Int? { LyricsLine.activeIndex(in: selectedLines, position: position - timingOffset) }
    private func submit() {
        guard validQuery else { return }
        cancelSelection()
        selected = nil; selectedLines = []; cacheMessage = nil
        submitted = query.trimmingCharacters(in: .whitespacesAndNewlines); attempt += 1
    }
    private func choose(_ record: LyricsDTO) {
        let previous = selectionTask
        cancelSelection(); let ticket = selectionGeneration, trackID = track.id, selectedID = record.selectionID
        selected = record; selectedLines = record.lines; timingOffset = 0
        cacheMessage = "Saving this recording for offline lyrics…"
        selectionTask = Task { @MainActor in
            defer { if selectionGeneration == ticket { selectionTask = nil } }
            // Complete an earlier cancelled local write before starting the
            // replacement selection; its text cannot finish after this one.
            await previous?.value
            guard !Task.isCancelled, selectionGeneration == ticket, activeTrackID == trackID, selected?.selectionID == selectedID else { return }
            let cached = await lyrics.cacheSelection(record, for: trackID)
            guard !Task.isCancelled, selectionGeneration == ticket, activeTrackID == trackID, selected?.selectionID == selectedID else { return }
            let managed = await saveManaged?(record)
            guard !Task.isCancelled, selectionGeneration == ticket, activeTrackID == trackID, selected?.selectionID == selectedID else { return }
            if managed == true { cacheMessage = "Lyrics saved with this downloaded recording" }
            else if cached && managed == nil { cacheMessage = "LRCLIB selection saved on this device" }
            else if cached { cacheMessage = "Saved on this device. To keep lyrics with the download, refresh Downloads and choose this recording again." }
            else { cacheMessage = "Could not save these lyrics for offline use. They remain visible while this sheet is open." }
        }
    }
    private func cancelSelection() {
        selectionGeneration &+= 1; selectionTask?.cancel()
    }
    @ViewBuilder private func selectedLyrics(_ record: LyricsDTO) -> some View {
        Text(record.trackName + " · " + record.artistName).font(.subheadline).foregroundStyle(.secondary)
        if let cacheMessage { Text(cacheMessage).font(.caption).foregroundStyle(.secondary) }
        Button("Choose another recording") {
            cancelSelection()
            selected = nil; selectedLines = []; cacheMessage = nil
            if lyrics.records.isEmpty { submit() }
        }
        if !selectedLines.isEmpty {
            Stepper("Lyrics delay: \(timingOffset.formatted(.number.precision(.fractionLength(1)))) s", value: $timingOffset, in: -30...30, step: 0.5)
                .accessibilityLabel("Lyrics delay in seconds")
            Text("Positive values show lyrics later; negative values show them earlier. This adjustment applies to this recording while this sheet is open.")
                .font(.caption).foregroundStyle(.secondary)
            if timingOffset != 0 { Button("Reset timing") { timingOffset = 0 } }
            let active = activeLine
            ForEach(selectedLines) { line in
                let target = max(0, line.time + timingOffset)
                Button { onSeek(target) } label: {
                    Text(line.text.isEmpty ? "♪" : line.text)
                        .font(.title3.weight(active == line.id ? .bold : .medium))
                        .foregroundStyle(active == line.id ? theme.accent : Color.primary.opacity(0.65))
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
                }
                .buttonStyle(.plain).disabled(!canSeek || duration > 0 && target > duration)
                .accessibilityLabel("Seek to \(Int(target) / 60):\(String(format: "%02d", Int(target) % 60)), \(line.text.isEmpty ? "instrumental" : line.text)")
                .accessibilityAddTraits(active == line.id ? .isSelected : [])
                .id(line.id)
            }
        } else {
            Text(record.instrumental ? "Instrumental recording" : record.plainLyrics ?? "No lyrics available")
                .font(.body).lineSpacing(7).textSelection(.enabled)
        }
    }
}
