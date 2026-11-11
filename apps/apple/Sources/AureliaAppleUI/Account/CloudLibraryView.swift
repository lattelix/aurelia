import SwiftUI
import AureliaCloud

struct CloudLibraryEntry: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    @ObservedObject var cloud: CloudAccountStore
    var body: some View {
        NavigationLink { CloudLibraryView(model: model, cloud: cloud) } label: {
            HStack(spacing: 14) {
                Image(systemName: "icloud.fill").font(.title).foregroundStyle(theme.accent)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Cloud Library").font(.headline).foregroundStyle(.primary)
                    Text(cloud.account?.name ?? "Connect your Aurelia account").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right").foregroundStyle(.secondary)
            }.padding(16).background(theme.card, in: RoundedRectangle(cornerRadius: 16))
        }.buttonStyle(.plain)
    }
}

struct CloudLibraryView: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    @ObservedObject var cloud: CloudAccountStore
    @ViewState private var editor: PlaylistEditorRequest?
    @ViewState private var query = ""
    @ViewState private var playlistSort: CloudPlaylistSort = .saved
    @ViewState private var trackSort: CloudTrackSort = .saved
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if let localFiles = model.localFiles {
                    NavigationLink { LocalFilesView(store: localFiles, onPlay: model.playLocalFiles, onDisable: model.stopLocalPlayback,
                                                   onPlayNext: model.playLocalNext, onAddToQueue: model.addLocalToQueue) } label: { Label("Files on this device", systemImage: "folder") }
                        .buttonStyle(.bordered)
                }
                if let offline = model.offline {
                    NavigationLink { OfflineLibraryView(model: model, offline: offline) } label: { Label("Downloads", systemImage: "arrow.down.circle") }
                        .buttonStyle(.bordered)
                }
                if let account = cloud.account {
                    SectionHeading(title: account.name + "’s library", subtitle: "Your saved music · synced with your Aurelia account")
                    HStack {
                        Button("Refresh") { Task { await cloud.refresh() } }.disabled(cloud.isRefreshing)
                        if cloud.isRefreshing || cloud.isMutating { ProgressView().controlSize(.small) }
                        Spacer()
                        NavigationLink("Account") { AccountView(cloud: cloud) }
                    }
                    if let library = cloud.library {
                        TextField("Filter saved songs and playlists", text: $query).textFieldStyle(.roundedBorder)
                            .accessibilityLabel("Filter your cloud library")
                        HStack {
                            NavigationLink("History") { CloudListeningView(model: model, cloud: cloud, accountID: account.id, kind: .history) }
                            NavigationLink("Made for You") { CloudListeningView(model: model, cloud: cloud, accountID: account.id, kind: .recommendations) }
                        }.buttonStyle(.bordered)
                        NavigationLink { MusicSearchView(model: model, cloud: cloud, music: cloud.music) } label: {
                            Label("Find music to save", systemImage: "magnifyingglass")
                        }.buttonStyle(.bordered)
                        SectionHeading(title: "Liked Songs", subtitle: "\(library.likes.count) saved songs")
                        Picker("Sort songs", selection: $trackSort) {
                            ForEach(CloudTrackSort.allCases) { Text($0.rawValue).tag($0) }
                        }.pickerStyle(.menu)
                        if library.likes.isEmpty {
                            Text("Save a song with its heart in Discover or Search. Your favourites will appear here.").foregroundStyle(.secondary)
                        }
                        let likes = CloudCollectionView.tracks(library.likes, query: query, sort: trackSort)
                        if !library.likes.isEmpty && likes.isEmpty { Text("No saved songs match this filter.").foregroundStyle(.secondary) }
                        CloudTrackRows(model: model, cloud: cloud, tracks: likes, accountID: account.id)
                        HStack {
                            SectionHeading(title: "Playlists")
                            Button {
                                editor = PlaylistEditorRequest(accountID: account.id)
                            } label: { Label("New", systemImage: "plus") }.disabled(cloud.isMutating || cloud.libraryNeedsRefresh)
                        }
                        if library.playlists.isEmpty {
                            Text("Create a playlist, then add songs using their menu.").foregroundStyle(.secondary)
                        }
                        Picker("Sort playlists", selection: $playlistSort) {
                            ForEach(CloudPlaylistSort.allCases) { Text($0.rawValue).tag($0) }
                        }.pickerStyle(.menu)
                        let playlists = CloudCollectionView.playlists(library.playlists, query: query, sort: playlistSort)
                        if !library.playlists.isEmpty && playlists.isEmpty { Text("No playlists match this filter.").foregroundStyle(.secondary) }
                        ForEach(playlists) { playlist in
                            NavigationLink { CloudPlaylistView(model: model, cloud: cloud, id: playlist.id, accountID: account.id) } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "music.note.list").foregroundStyle(theme.accent).frame(width: 48, height: 48)
                                        .background(theme.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(playlist.name).font(.headline).foregroundStyle(.primary)
                                        Text("\(playlist.tracks.count) songs").font(.caption).foregroundStyle(.secondary)
                                        if !playlist.description.isEmpty {
                                            Text(playlist.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                        }
                                    }
                                    Spacer(minLength: 4)
                                    Image(systemName: "chevron.right").foregroundStyle(.secondary)
                                }.padding(.vertical, 6).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        }
                    } else if cloud.isRefreshing {
                        ProgressView("Loading your library…").frame(maxWidth: .infinity).padding(.vertical)
                    } else {
                        EmptyCollection(symbol: "icloud", title: "Your library has not loaded", detail: "Refresh to load saved songs and playlists. Check your connection if the problem continues.")
                    }
                    AppleSourceNotice(youtubePlaybackAvailable: model.youtubePlaybackAvailable)
                } else if cloud.phase == .restoring {
                    ProgressView("Restoring your account…").frame(maxWidth: .infinity).padding(.vertical, 30)
                } else {
                    EmptyCollection(symbol: "icloud", title: "Your library travels with you", detail: "Connect the same Aurelia account you use on the web to save YouTube music, likes and playlists.")
                    NavigationLink("Connect your account") { AccountView(cloud: cloud) }.buttonStyle(.borderedProminent)
                    Text("You can discover and search music before signing in.").font(.subheadline).foregroundStyle(.secondary)
                }
                if let message = cloud.message { Text(message).font(.footnote).foregroundStyle(.secondary) }
                Divider()
                NavigationLink { LibraryView(model: model) } label: { Label("Local Studio library", systemImage: "internaldrive") }
                Text("Bundled Studio recordings have their own local likes and playlists on this device.").font(.caption).foregroundStyle(.secondary)
            }.padding(24).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }
        .background(theme.background).navigationTitle("Library")
        .task { await cloud.foreground() }
        .refreshable { await cloud.refresh() }
        .sheet(item: $editor) { PlaylistEditor(cloud: cloud, request: $0) }
        .onChange(of: cloud.account?.id) { _, _ in editor = nil; query = "" }
    }
}

private struct CloudPlaylistView: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    @ObservedObject var cloud: CloudAccountStore
    let id: String
    let accountID: String
    @ViewState private var editor: PlaylistEditorRequest?
    @ViewState private var query = ""
    @ViewState private var sort: CloudTrackSort = .saved
    @ViewState private var confirmDelete = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if cloud.account?.id == accountID, let playlist = cloud.library?.playlists.first(where: { $0.id == id }) {
                    SectionHeading(title: playlist.name, subtitle: "\(playlist.tracks.count) songs · cloud playlist")
                    if !playlist.description.isEmpty { Text(playlist.description).foregroundStyle(.secondary).textSelection(.enabled) }
                    HStack {
                        Button("Edit details", systemImage: "pencil") {
                            editor = PlaylistEditorRequest(accountID: accountID, playlist: playlist)
                        }.disabled(cloud.isMutating || cloud.libraryNeedsRefresh)
                        Button("Delete", systemImage: "trash", role: .destructive) { confirmDelete = true }
                            .disabled(cloud.isMutating || cloud.libraryNeedsRefresh)
                        Spacer()
                        Button("Refresh") { Task { await cloud.refresh() } }.disabled(cloud.isRefreshing)
                    }
                    if cloud.isRefreshing || cloud.isMutating { ProgressView().controlSize(.small) }
                    if playlist.tracks.isEmpty {
                        EmptyCollection(symbol: "music.note.list", title: "Make it yours", detail: "Find a song, open its menu and add it to this playlist.")
                    } else {
                        TextField("Filter songs", text: $query).textFieldStyle(.roundedBorder).accessibilityLabel("Filter playlist songs")
                        Picker("Sort songs", selection: $sort) {
                            ForEach(CloudTrackSort.allCases) { Text($0.rawValue).tag($0) }
                        }.pickerStyle(.menu)
                        let visible = CloudCollectionView.tracks(playlist.tracks, query: query, sort: sort)
                        if visible.isEmpty { Text("No songs match this filter.").foregroundStyle(.secondary) }
                        CloudTrackRows(model: model, cloud: cloud, tracks: visible, accountID: accountID, playlistID: id,
                            reorder: query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && sort == .saved ? { from, to in
                                let expected = playlist.tracks.map(\.id)
                                guard expected.indices.contains(from), expected.indices.contains(to) else { return }
                                var reordered = expected
                                reordered.swapAt(from, to)
                                Task { await cloud.reorderPlaylist(id, trackIDs: reordered, expectedTrackIDs: expected, expectedAccountID: accountID) }
                            } : nil)
                        Text("Filtering and sorting change this view and the next playback selection. To change the saved playlist order, clear the filter and choose Saved order, then move songs using their menu.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    NavigationLink { MusicSearchView(model: model, cloud: cloud, music: cloud.music) } label: {
                        Label("Find music to add", systemImage: "magnifyingglass")
                    }.buttonStyle(.bordered)
                    AppleSourceNotice(youtubePlaybackAvailable: model.youtubePlaybackAvailable)
                    NavigationLink("Browse bundled Studio recordings") { CloudStudioView(model: model, cloud: cloud, accountID: accountID) }
                } else {
                    EmptyCollection(symbol: "music.note.list", title: "Playlist unavailable", detail: "The account or playlist changed. Return to Library and refresh your saved music.")
                }
                if let message = cloud.message { Text(message).font(.footnote).foregroundStyle(.secondary) }
            }.padding(24).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }
        .background(theme.background).navigationTitle("Playlist")
        .sheet(item: $editor) { PlaylistEditor(cloud: cloud, request: $0) }
        .confirmationDialog("Delete this playlist?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete playlist", role: .destructive) {
                Task { if await cloud.deletePlaylist(id, expectedAccountID: accountID) { dismiss() } }
            }
        } message: { Text("This removes the playlist from your Aurelia account. Your liked songs remain saved.") }
        .onChange(of: cloud.account?.id) { _, _ in editor = nil; confirmDelete = false }
    }
}

private struct PlaylistEditorRequest: Identifiable {
    let id = UUID()
    let accountID: String
    let playlistID: String?
    let name: String
    let description: String
    init(accountID: String, playlist: PlaylistDTO? = nil) {
        self.accountID = accountID; playlistID = playlist?.id
        name = playlist?.name ?? ""; description = playlist?.description ?? ""
    }
}

private struct PlaylistEditor: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var cloud: CloudAccountStore
    let request: PlaylistEditorRequest
    @ViewState private var name: String
    @ViewState private var description: String
    @Environment(\.dismiss) private var dismiss
    init(cloud: CloudAccountStore, request: PlaylistEditorRequest) {
        self.cloud = cloud; self.request = request
        _name = ViewState(initialValue: request.name); _description = ViewState(initialValue: request.description)
    }
    private var canSave: Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.utf16.count <= 120 && description.utf16.count <= 1000 &&
            !cloud.isMutating && !cloud.libraryNeedsRefresh && cloud.account?.id == request.accountID
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Playlist details") {
                    TextField("Name", text: $name).accessibilityLabel("Playlist name")
                    TextField("Description", text: $description, axis: .vertical).lineLimit(3...6)
                        .accessibilityLabel("Playlist description")
                    Text("Name: up to 120 characters. Description: up to 1,000 characters.").font(.caption).foregroundStyle(.secondary)
                }
                if cloud.isMutating { ProgressView("Saving playlist…") }
                if let message = cloud.message { Text(message).font(.footnote).foregroundStyle(.secondary) }
                Text("Saved to your signed-in Aurelia account.").font(.caption).foregroundStyle(.secondary)
            }
            .formStyle(.grouped).navigationTitle(request.playlistID == nil ? "New playlist" : "Edit playlist")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(cloud.isMutating) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let capturedName = name, capturedDescription = description
                        Task {
                            let saved: Bool
                            if let playlistID = request.playlistID {
                                saved = await cloud.updatePlaylist(playlistID, name: capturedName, description: capturedDescription, expectedAccountID: request.accountID)
                            } else {
                                saved = await cloud.createPlaylist(capturedName, description: capturedDescription, expectedAccountID: request.accountID)
                            }
                            if saved { dismiss() }
                        }
                    }.disabled(!canSave)
                }
            }
        }
        .interactiveDismissDisabled(cloud.isMutating)
        #if os(macOS)
        .frame(minWidth: 400, idealWidth: 480, minHeight: 350)
        #endif
    }
}
