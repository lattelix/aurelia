import SwiftUI
import AureliaCloud

struct NowPlayingView: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    @Environment(\.dismiss) private var dismiss
    @ViewState private var showLyrics = false
    @ViewState private var seeking = false
    @ViewState private var seekPosition: Double = 0
    @ViewState private var seekEntryID: UUID?
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    PlaybackArtwork(track: model.currentPlaybackTrack, radius: 24)
                        .aspectRatio(1, contentMode: .fit).frame(maxWidth: 340)
                        .shadow(color: .black.opacity(0.13), radius: 20, y: 10)
                    HStack(alignment: .center) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(model.currentPlaybackTrack?.title ?? "Nothing playing").font(.title2.bold())
                            Text(model.currentPlaybackTrack?.artist ?? "Choose a recording to begin").foregroundStyle(.secondary)
                        }
                        Spacer()
                        if let track = model.current {
                            SymbolButton(symbol: model.profile.likes.contains(track.id) ? "heart.fill" : "heart", label: "Toggle like", active: model.profile.likes.contains(track.id)) { model.toggleLike(track) }
                        } else if let track = model.cloudCurrentTrack, let cloud = model.cloud {
                            CloudTrackActions(model: model, cloud: cloud, track: track, accountID: cloud.account?.id, showPlay: false)
                        }
                    }
                    VStack(spacing: 4) {
                        Slider(value: Binding(get: { displayedPosition }, set: { seekPosition = $0 }),
                               in: 0...max(1, model.currentDuration),
                               onEditingChanged: { editing in
                                   if editing { seekPosition = displayedPosition; seekEntryID = model.currentPlaybackTrack?.id }
                                   seeking = editing
                                   if !editing {
                                       if let id = seekEntryID, id == model.currentPlaybackTrack?.id { model.seek(seekPosition) }
                                       seekEntryID = nil
                                   }
                               })
                            .disabled(model.currentPlaybackTrack == nil || model.currentDuration <= 0).accessibilityLabel("Playback position")
                        HStack {
                            Text(clockText(displayedPosition))
                            Spacer()
                            Text(model.currentDuration > 0 ? "−" + clockText(max(0, model.currentDuration - displayedPosition)) : "–:–")
                        }.font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    HStack(spacing: 0) {
                        SymbolButton(symbol: "shuffle", label: model.playback.shuffle ? "Turn shuffle off" : "Turn shuffle on", active: model.playback.shuffle, size: 18) { model.toggleShuffle() }
                        Spacer(minLength: 0)
                        SymbolButton(symbol: "backward.fill", label: "Previous recording", size: 25) { model.previous() }
                            .disabled(model.currentPlaybackTrack == nil)
                        SymbolButton(symbol: model.isPlaying ? "pause.fill" : "play.fill", label: model.isPlaying ? "Pause" : "Play", size: 38) { model.togglePlayback() }
                            .disabled(model.currentPlaybackTrack == nil)
                        SymbolButton(symbol: "forward.fill", label: "Next recording", size: 25) { model.next() }
                            .disabled(model.currentPlaybackTrack == nil)
                        Spacer(minLength: 0)
                        SymbolButton(symbol: model.playback.repeatMode == .one ? "repeat.1" : "repeat", label: "Repeat: \(model.playback.repeatMode.rawValue)", active: model.playback.repeatMode != .off, size: 18) { model.cycleRepeat() }
                    }
                    if model.profile.showVolumeControl {
                        NowPlayingVolumeControl(model: model)
                    }
                    Text(model.statusText).font(.caption).foregroundStyle(.secondary)
                        .accessibilityLabel("Playback status: \(model.statusText)")
                    Menu {
                        ForEach([15, 30, 45, 60, 90], id: \.self) { minutes in
                            Button("In \(minutes) minutes") { model.setSleepTimer(minutes: minutes) }
                        }
                        Button("At end of this song") { model.setSleepTimerAtTrackEnd() }.disabled(model.currentPlaybackTrack == nil)
                        if model.sleepTimer != nil { Button("Cancel timer", role: .destructive) { model.cancelSleepTimer() } }
                    } label: {
                        Label(model.sleepTimerText ?? "Sleep timer", systemImage: "moon.zzz")
                            .font(.subheadline).frame(minHeight: 44)
                    }
                    Button("Lyrics", systemImage: "quote.bubble") { showLyrics = true }
                        .buttonStyle(.bordered).frame(minHeight: 44)
                        .disabled(model.currentPlaybackTrack == nil)
                    queue
                }.padding(24).frame(maxWidth: 520).frame(maxWidth: .infinity)
            }
            .background(theme.background)
            .navigationTitle("Now Playing")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .onChange(of: model.currentPlaybackTrack?.id) { _, _ in seeking = false; seekPosition = 0; seekEntryID = nil }
            .onDisappear { seeking = false; seekEntryID = nil }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $showLyrics) { NowPlayingLyricsSheet(model: model) }
        }
        #if os(macOS)
        .frame(minWidth: 440, idealWidth: 510, minHeight: 680, idealHeight: 820)
        #endif
    }
    private var displayedPosition: Double {
        min(max(0, seeking ? seekPosition : model.playback.position), max(1, model.currentDuration))
    }
    private var queue: some View {
        let revision = model.playback.queueRevision
        return VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Queue").font(.headline)
                Spacer()
                Text("\(model.playback.queue.count) songs").font(.caption).foregroundStyle(.secondary)
                if !model.playback.queue.isEmpty {
                    Button("Clear", role: .destructive) { model.clearQueue(expectedRevision: revision) }
                        .accessibilityLabel("Clear playback queue")
                }
            }
            if let detail = model.queuePersistenceText {
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            if model.playback.shuffle {
                Text("Shuffle is on. This list shows the original collection order.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if model.playback.queue.isEmpty {
                Text("Your queue begins when you choose a recording.").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(Array(model.playback.queue.enumerated()), id: \.element.id) { index, entry in
                HStack(spacing: 8) {
                    Button { model.selectQueueEntry(entry.id, expectedRevision: revision) } label: {
                        HStack(spacing: 12) {
                            PlaybackArtwork(track: entry, radius: 6).frame(width: 42, height: 42)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(entry.title).font(.subheadline.weight(.semibold))
                                Text(entry.artist).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                            if index == model.playback.index { Image(systemName: model.isPlaying ? "waveform" : "pause.fill").foregroundStyle(theme.accent) }
                        }.foregroundStyle(.primary).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel("Select \(entry.title) in queue")
                    Menu {
                        Button("Move up", systemImage: "arrow.up") { model.moveQueueEntry(entry.id, by: -1, expectedRevision: revision) }.disabled(index == 0)
                        Button("Move down", systemImage: "arrow.down") { model.moveQueueEntry(entry.id, by: 1, expectedRevision: revision) }.disabled(index == model.playback.queue.count - 1)
                        Button("Remove from queue", role: .destructive) { model.removeQueueEntry(entry.id, expectedRevision: revision) }
                    } label: { Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44) }
                        .accessibilityLabel("Queue actions for \(entry.title)")
                }
            }
        }
    }
}

/// A full presentation gets a bounded scroll viewport. It also observes the
/// player directly, so live lines follow progress while the parent sheet rests.
private struct NowPlayingLyricsSheet: View {
    @ObservedObject var model: AureliaModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        if let track = model.currentPlaybackTrack, track.provider != .studio, let music = model.cloud?.music {
            let offline = model.offline, revision = offline?.ownerRevision
            let metadata = model.cloudCurrentTrack
            LyricsView(trackID: track.trackID, title: track.title, artist: track.artist, music: music,
                       position: model.playback.position, duration: model.currentDuration,
                       canSeek: model.currentDuration > 0,
                       loadManaged: managedLoader(metadata, offline: offline, revision: revision),
                       saveManaged: managedSaver(metadata, offline: offline, revision: revision), onSeek: { position in
                           guard model.currentPlaybackTrack?.id == track.id else { return }
                           model.seek(position)
                       }).id(track.id.uuidString + ":" + (revision?.uuidString ?? "no-managed-owner"))
        } else {
            NavigationStack {
                EmptyCollection(symbol: "quote.bubble", title: "No lyrics", detail: "Studio recordings are instrumental. Choose a song to look for its lyrics.")
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            }
        }
    }
    private func managedLoader(_ track: TrackDTO?, offline: AppleOfflineStore?, revision: UUID?) -> (@MainActor () async -> LyricsDTO?)? {
        guard let track, track.provider == "youtube", let offline else { return nil }
        return { await offline.savedLyrics(for: track, expectedRevision: revision) }
    }
    private func managedSaver(_ track: TrackDTO?, offline: AppleOfflineStore?, revision: UUID?) -> (@MainActor (LyricsDTO) async -> Bool)? {
        guard let track, track.provider == "youtube", let offline, offline.item(for: track) != nil else { return nil }
        return { record in await offline.saveLyrics(record, for: track, expectedRevision: revision) }
    }
}
