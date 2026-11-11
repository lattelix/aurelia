import SwiftUI
import AureliaCloud
import AureliaPlaybackCore

struct OfflineLibraryView: View {
    @ObservedObject var model: AureliaModel
    @ObservedObject var offline: AppleOfflineStore
    var body: some View {
        Form {
            if let snapshot = offline.snapshot {
                Section("Storage on this device") {
                    LabeledContent("Saved and partial files", value: bytes(snapshot.usedBytes))
                    LabeledContent("Free device storage", value: bytes(snapshot.freeBytes))
                    Picker("Storage limit", selection: Binding(get: { snapshot.policy.budgetBytes }, set: { value in Task { await offline.setBudget(value) } })) {
                        ForEach([512, 1024, 2048, 4096, 8192, 16384, 32768], id: \.self) { mib in
                            Text(bytes(Int64(mib) * 1024 * 1024)).tag(Int64(mib) * 1024 * 1024)
                        }
                    }
                    Text("The limit includes copies from other profiles. At least 128 MB remains free. Nothing is deleted automatically.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Download preferences") {
                    Toggle("Use Wi-Fi only", isOn: Binding(get: { snapshot.settings.wifiOnly }, set: { value in update { $0.wifiOnly = value } }))
                    LabeledContent("Network", value: offline.onWiFi ? "Wi-Fi / Ethernet" : "Mobile data or unavailable")
                    Text("YouTube AAC audio is saved in its original available quality. No transcoding. Keep Aurelia open while downloading; interrupted transfers can resume.")
                        .font(.caption).foregroundStyle(.secondary)
                    Toggle("Keep a collection offline", isOn: Binding(get: { snapshot.settings.enabled }, set: { value in update { $0.enabled = value } }))
                        .disabled(model.cloud?.library == nil)
                    if snapshot.settings.enabled {
                        Picker("Collection", selection: Binding(get: { snapshot.settings.scope }, set: { value in update { $0.scope = value } })) {
                            Text("Favourites").tag(OfflineSyncScope.likes)
                            Text("Personal library").tag(OfflineSyncScope.library)
                            Text("Selected playlists").tag(OfflineSyncScope.playlists)
                        }
                        if snapshot.settings.scope == .playlists {
                            ForEach(model.cloud?.library?.playlists ?? []) { playlist in
                                Toggle(playlist.name, isOn: Binding(get: { snapshot.settings.playlistIDs.contains(playlist.id) }, set: { selected in
                                    update { value in
                                        value.playlistIDs.removeAll { $0 == playlist.id }
                                        if selected { value.playlistIDs.append(playlist.id) }
                                    }
                                }))
                            }
                        }
                        Text("Personal library means your favourites plus songs in your Aurelia playlists. New songs are queued when the library refreshes. Turning this off keeps completed copies.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section {
                    HStack {
                        Button("Resume all", systemImage: "play.fill") { Task { await offline.resumeAll() } }
                        Spacer()
                        Button("Pause downloads", systemImage: "pause.fill") { Task { await offline.pauseAll() } }
                    }
                }
                Section("Saved music · \(snapshot.items.filter { $0.state == .ready }.count) ready") {
                    if snapshot.items.isEmpty { Text("Use a song’s menu → Save offline, or select a collection above.").foregroundStyle(.secondary) }
                    ForEach(snapshot.items) { item in itemRow(item) }
                }
            } else {
                Section {
                    EmptyCollection(symbol: "arrow.down.circle", title: "Offline library", detail: offline.canManage ? "Opening saved music…" : "Connect your account to access its saved music. Guest downloads stay separate from account downloads.")
                }
            }
            if let message = offline.message { Section("Status") { Text(message).foregroundStyle(.secondary) } }
        }
        .formStyle(.grouped).navigationTitle("Downloads")
        .disabled(offline.busy)
        .task { await offline.refresh() }
        .refreshable { await offline.refresh() }
    }
    private func update(_ change: (inout OfflineSyncSettings) -> Void) {
        guard var settings = offline.snapshot?.settings else { return }
        change(&settings)
        Task { await offline.setSync(settings) }
    }
    private func itemRow(_ item: OfflineItemSnapshot) -> some View {
        let revision = offline.ownerRevision
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                ManagedTrackArtwork(offline: offline, trackID: item.track.trackID, fallbackURL: nil)
                    .frame(width: 52, height: 52).clipShape(RoundedRectangle(cornerRadius: 9)).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.track.title).font(.headline).lineLimit(2)
                    Text(item.track.artist).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    if !item.album.isEmpty { Text(item.album).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
                }
                Spacer()
                if item.state == .ready {
                    Button { play(item, expectedOwnerRevision: revision) } label: { Image(systemName: "play.fill").frame(minWidth: 44, minHeight: 44) }
                        .accessibilityLabel("Play saved \(item.track.title)")
                }
                Menu {
                    if item.state != .ready {
                        if [.queued, .resolving, .downloading, .verifying].contains(item.state) {
                            Button("Pause") { Task { await offline.pause(item.id) } }
                        } else {
                            Button("Resume") { Task { await offline.resume(item.id) } }
                            if item.failure == .corrupt || item.failure == .identityChanged {
                                Button("Restart download") { Task { await offline.restart(item.id) } }
                            }
                        }
                    }
                    Button("Remove saved copy", role: .destructive) { Task { await offline.remove(item.id) } }
                } label: { Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44) }
                .accessibilityLabel("Download actions for \(item.track.title)")
            }
            if let total = item.totalBytes, item.state == .downloading {
                ProgressView(value: Double(item.receivedBytes), total: Double(total))
            }
            Text(status(item)).font(.caption).foregroundStyle(.secondary)
        }.padding(.vertical, 4)
    }
    private func play(_ selected: OfflineItemSnapshot, expectedOwnerRevision: UUID?) {
        guard let revision = expectedOwnerRevision, offline.ownerRevision == revision else { return }
        let ready = (offline.snapshot?.items ?? []).filter { $0.state == .ready }
        let tracks = ready.compactMap { item in
            try? TrackDTO(id: item.track.trackID, title: item.track.title, artist: item.track.artist, album: item.album, provider: "youtube", externalId: item.track.videoID, duration: item.duration, artwork: "")
        }
        guard let index = tracks.firstIndex(where: { $0.id == selected.track.trackID }) else { return }
        guard offline.ownerRevision == revision else { return }
        model.playCloudTracks(tracks, at: index, expectedAccountID: model.cloud?.authorizedOwnerID)
    }
    private func bytes(_ count: Int64) -> String { ByteCountFormatter.string(fromByteCount: count, countStyle: .binary) }
    private func status(_ item: OfflineItemSnapshot) -> String {
        let size = item.totalBytes.map { " · " + bytes(Int64($0)) } ?? ""
        switch item.state {
        case .ready: return "Available offline" + size
        case .resolving: return "Preparing audio…"
        case .downloading: return bytes(Int64(item.receivedBytes)) + " / " + bytes(Int64(item.totalBytes ?? 0))
        case .verifying: return "Checking complete file…"
        case .queued: return offline.onWiFi || offline.snapshot?.settings.wifiOnly == false ? "Queued" : "Waiting for Wi-Fi"
        case .paused: return item.failure == .waitingForWiFi ? "Paused · waiting for Wi-Fi" : "Paused · tap Resume"
        case .failed:
            switch item.failure {
            case .storageLimit: return "Storage limit reached"
            case .insufficientSpace: return "Device storage is full"
            case .identityChanged, .corrupt: return "Restart required · the partial file could not be verified"
            case .sourceDenied, .unavailable: return "This recording is unavailable from the source"
            default: return "Download interrupted · tap Resume to retry"
            }
        }
    }
}

struct OfflineTrackMenu: View {
    @ObservedObject var offline: AppleOfflineStore
    let track: TrackDTO
    var body: some View {
        let ownerRevision = offline.ownerRevision
        if track.provider == "youtube" {
            if let item = offline.item(for: track) {
                if item.state == .ready { Label("Available offline", systemImage: "checkmark.circle.fill") }
                else if item.state == .paused || item.state == .failed {
                    Button("Resume download", systemImage: "arrow.down.circle") { Task { await offline.resume(item.id) } }
                } else { Label("Downloading / queued", systemImage: "arrow.down.circle") }
            } else {
                Button("Save offline", systemImage: "arrow.down.circle") {
                    guard let ownerRevision else { return }
                    Task { await offline.download(track, expectedOwnerRevision: ownerRevision) }
                }
                    .disabled(!offline.canManage)
            }
        }
    }
}
