import SwiftUI

struct TrackList: View {
    @Environment(\.aureliaPalette) private var theme
    @Environment(\.dynamicTypeSize) private var typeSize
    @ObservedObject var model: AureliaModel
    let tracks: [StudioTrack]
    var playlistID: UUID?
    var body: some View {
        LazyVStack(spacing: 0) {
            ForEach(Array(tracks.enumerated()), id: \.element.id) { index, track in
                Group {
                    if typeSize.isAccessibilitySize {
                        stackedRow(track, at: index)
                    } else {
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 12) {
                                selection(track, at: index).frame(minWidth: 180, maxWidth: .infinity, alignment: .leading)
                                actions(track)
                            }
                            stackedRow(track, at: index)
                        }
                    }
                }.padding(.vertical, 8)
                if index < tracks.count - 1 { Divider().padding(.leading, 60) }
            }
        }
    }

    private func stackedRow(_ track: StudioTrack, at index: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            selection(track, at: index)
            actions(track).frame(maxWidth: .infinity, alignment: .trailing)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func selection(_ track: StudioTrack, at index: Int) -> some View {
        Button { model.play(tracks, at: index) } label: {
            HStack(spacing: 12) {
                Artwork(id: track.albumID, radius: 7).frame(width: 48, height: 48)
                VStack(alignment: .leading, spacing: 4) {
                    Text(track.title).font(.subheadline.weight(.semibold))
                        .foregroundStyle(model.current?.id == track.id ? theme.accent : .primary)
                    Text("\(track.artist) · \(track.album)").font(.caption).foregroundStyle(.secondary)
                }
                .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
            }.contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel("Play \(track.title), \(track.artist)")
    }

    private func actions(_ track: StudioTrack) -> some View {
        HStack(spacing: 12) {
            Text("1:12").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            SymbolButton(symbol: model.profile.likes.contains(track.id) ? "heart.fill" : "heart",
                         label: model.profile.likes.contains(track.id) ? "Unlike \(track.title)" : "Like \(track.title)",
                         active: model.profile.likes.contains(track.id), size: 17) { model.toggleLike(track) }
            Menu {
                Button("Play next", systemImage: "text.line.first.and.arrowtriangle.forward") { model.playNext(track) }
                Button("Add to queue", systemImage: "text.badge.plus") { model.addToQueue(track) }
                if model.profile.playlists.isEmpty { Text("Create a playlist in Library to add songs") }
                ForEach(model.profile.playlists) { playlist in
                    Button("Add to \(playlist.name)") { model.add(track, to: playlist.id) }
                }
                if let playlistID { Button("Remove from playlist", role: .destructive) { model.remove(track, from: playlistID) } }
            } label: { Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44).contentShape(Rectangle()) }
            .fixedSize().accessibilityLabel("More for \(track.title)")
        }.fixedSize(horizontal: true, vertical: false)
    }
}

struct CollectionView: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    let title: String
    let subtitle: String
    let tracks: [StudioTrack]
    let art: String
    var playlistID: UUID?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .bottom, spacing: 24) { cover; heading }
                    VStack(alignment: .leading, spacing: 20) { cover; heading }
                }
                if tracks.isEmpty {
                    EmptyCollection(symbol: "music.note.list", title: "Make it yours", detail: "Use the song menu to add Studio recordings to this playlist.")
                } else { TrackList(model: model, tracks: tracks, playlistID: playlistID) }
            }.padding(24).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }.background(theme.background).navigationTitle(title)
    }
    private var cover: some View { Artwork(id: art, radius: 18).frame(width: 220, height: 220) }
    private var heading: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.largeTitle.bold())
            Text(subtitle).foregroundStyle(.secondary)
            Text("\(tracks.count) songs · on this device").font(.caption).foregroundStyle(.secondary)
            Button { model.play(tracks) } label: { Label("Play", systemImage: "play.fill").padding(.horizontal, 20).padding(.vertical, 5) }
                .buttonStyle(.borderedProminent).disabled(tracks.isEmpty)
        }
    }
}

struct LibraryView: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    @ViewState private var showCreate = false
    @ViewState private var playlistName = ""
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                SectionHeading(title: "Your music, your space", subtitle: "Local profile · saved only on this device")
                if let cloud = model.cloud { CloudLibraryEntry(model: model, cloud: cloud) }
                NavigationLink {
                    CollectionView(model: model, title: "Liked Songs", subtitle: "Your favourites, close at hand", tracks: model.likedTracks, art: model.likedTracks.first?.albumID ?? "afterglow")
                } label: {
                    HStack(spacing: 16) {
                        Image(systemName: "heart.fill").font(.largeTitle).foregroundStyle(theme.accent).frame(width: 60, height: 60)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Liked Songs").font(.headline)
                            Text("\(model.likedTracks.count) songs").font(.subheadline).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                    }.padding(16).background(theme.card, in: RoundedRectangle(cornerRadius: 16))
                }.buttonStyle(.plain)
                HStack {
                    SectionHeading(title: "Playlists")
                    Button { playlistName = ""; showCreate = true } label: { Label("New", systemImage: "plus") }.buttonStyle(.bordered)
                }
                if model.profile.playlists.isEmpty {
                    EmptyCollection(symbol: "music.note.list", title: "A collection for every mood", detail: "Create a playlist, then add songs from their menu.")
                }
                ForEach(model.profile.playlists) { playlist in
                    HStack(spacing: 16) {
                        NavigationLink {
                            PlaylistDetail(model: model, id: playlist.id)
                        } label: {
                            HStack(spacing: 16) {
                                Artwork(id: playlist.trackIDs.first.flatMap { StudioCatalogue.track($0)?.albumID } ?? "blue-hours").frame(width: 68, height: 68)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(playlist.name).font(.headline).foregroundStyle(.primary)
                                    Text("\(playlist.trackIDs.count) songs").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                            }.contentShape(Rectangle())
                        }.buttonStyle(.plain)
                        Menu { Button("Delete playlist", role: .destructive) { model.deletePlaylist(playlist.id) } }
                            label: { Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44) }
                            .accessibilityLabel("Actions for \(playlist.name)")
                    }
                }
                SectionHeading(title: "Albums")
                ForEach(StudioCatalogue.releases) { release in
                    NavigationLink {
                        CollectionView(model: model, title: release.title, subtitle: "Aurelia Studio · 2026", tracks: release.tracks, art: release.id)
                    } label: {
                        HStack(spacing: 14) {
                            Artwork(id: release.id).frame(width: 60, height: 60)
                            VStack(alignment: .leading, spacing: 5) {
                                Text(release.title).font(.headline).foregroundStyle(.primary)
                                Text("Aurelia Studio · \(release.genre)").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                        }
                    }.buttonStyle(.plain)
                }
            }.padding(24).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }
        .background(theme.background).navigationTitle("Local Studio library")
        .alert("New playlist", isPresented: $showCreate) {
            TextField("Playlist name", text: $playlistName)
            Button("Create") { _ = model.createPlaylist(playlistName) }.disabled(playlistName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) {}
        } message: { Text("Saved in your local Aurelia profile.") }
    }
}

private struct PlaylistDetail: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    let id: UUID
    var body: some View {
        if let playlist = model.profile.playlists.first(where: { $0.id == id }) {
            let tracks = playlist.trackIDs.compactMap { StudioCatalogue.track($0) }
            CollectionView(model: model, title: playlist.name, subtitle: "Your local playlist", tracks: tracks,
                           art: tracks.first?.albumID ?? "blue-hours", playlistID: id)
        } else { EmptyCollection(symbol: "music.note.list", title: "Playlist removed", detail: "Return to Library to choose another collection.") }
    }
}
