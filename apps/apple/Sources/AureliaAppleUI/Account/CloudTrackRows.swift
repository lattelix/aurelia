import SwiftUI
import AureliaCloud
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Only a canonical ID can become an external link; response URL fields never do.
func youtubeWatchURL(_ track: TrackDTO) -> URL? {
    guard track.provider == "youtube", track.id == "youtube:\(track.externalId)",
          track.externalId.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil else { return nil }
    return URL(string: "https://www.youtube.com/watch?v=\(track.externalId)")
}

struct CloudArtwork: View {
    @Environment(\.aureliaPalette) private var theme
    @Environment(\.managedOfflineArtwork) private var offline
    let track: TrackDTO
    var radius: CGFloat = 10
    var body: some View {
        ArtworkViewport(radius: radius) {
            if track.provider == "studio", let local = StudioCatalogue.track(track.id) {
                Artwork(id: local.albumID, radius: radius)
            } else if let offline, track.provider == "youtube" {
                ManagedTrackArtwork(offline: offline, trackID: track.id, fallbackURL: track.safeArtworkURL)
            } else {
                AsyncImage(url: track.safeArtworkURL) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Rectangle().fill(theme.accent.opacity(0.12))
                        .overlay(Image(systemName: "music.note").foregroundStyle(.secondary))
                }
            }
        }
    }
}

struct CloudTrackActions: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    @ObservedObject var cloud: CloudAccountStore
    @ViewState private var exportRequest: AudioExportRequest?
    let track: TrackDTO
    let accountID: String?
    var playlistID: String?
    var showPlay = true
    var play: (() -> Void)?
    var moveUp: (() -> Void)?
    var moveDown: (() -> Void)?

    private var canSave: Bool { accountID != nil && cloud.account?.id == accountID && cloud.library != nil && !cloud.isMutating && !cloud.libraryNeedsRefresh }
    private var liked: Bool { cloud.library?.likes.contains { $0.id == track.id } ?? false }
    var body: some View {
        HStack(spacing: 0) {
            if showPlay && model.canPlayCloudTrack(track) {
                SymbolButton(symbol: "play.fill", label: "Play \(track.title)", size: 16) {
                    if let play { play() }
                    else { model.playCloudTracks([track], expectedAccountID: accountID) }
                }
            }
            if let accountID {
                SymbolButton(symbol: liked ? "heart.fill" : "heart", label: liked ? "Unlike \(track.title) in cloud" : "Save \(track.title) to cloud likes", active: liked, size: 17) {
                    Task { await cloud.setLiked(track.id, liked: !liked, expectedAccountID: accountID) }
                }.disabled(!canSave)
            }
            Menu {
                if model.canPlayCloudTrack(track) {
                    Button("Play next", systemImage: "text.line.first.and.arrowtriangle.forward") { model.playCloudNext(track, expectedAccountID: accountID) }
                    Button("Add to queue", systemImage: "text.badge.plus") { model.addCloudToQueue(track, expectedAccountID: accountID) }
                }
                if let offline = model.offline { OfflineTrackMenu(offline: offline, track: track) }
                if let offline = model.offline, offline.item(for: track)?.state == .ready {
                    Button("Export audio file", systemImage: "doc.badge.arrow.up") {
                        if let revision = offline.ownerRevision { exportRequest = AudioExportRequest(track: track, revision: revision) }
                    }
                }
                if let url = youtubeWatchURL(track) {
                    ShareLink(item: url) { Label("Share song", systemImage: "square.and.arrow.up") }
                    Button("Copy song link", systemImage: "link") {
                        copySongLink(url)
                        model.notice = "Song link copied."
                    }
                    Link(destination: url) { Label("Open in YouTube", systemImage: "arrow.up.right") }
                }
                if let accountID {
                    ForEach(cloud.library?.playlists ?? []) { playlist in
                        let added = playlist.tracks.contains { $0.id == track.id }
                        Button(added ? "In \(playlist.name)" : "Add to \(playlist.name)") {
                            Task { await cloud.playlistTrack(track.id, playlistID: playlist.id, adding: true, expectedAccountID: accountID) }
                        }.disabled(!canSave || added)
                    }
                    if cloud.library?.playlists.isEmpty ?? true { Text("Create a playlist in Library to save songs") }
                    if let playlistID {
                        Divider()
                        if let moveUp { Button("Move up", systemImage: "arrow.up", action: moveUp).disabled(!canSave) }
                        if let moveDown { Button("Move down", systemImage: "arrow.down", action: moveDown).disabled(!canSave) }
                        Button("Remove from playlist", role: .destructive) {
                            Task { await cloud.playlistTrack(track.id, playlistID: playlistID, adding: false, expectedAccountID: accountID) }
                        }.disabled(!canSave)
                    }
                } else {
                    Text("Connect your account in Library to save this song")
                }
            } label: {
                Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            }
            .accessibilityLabel("Actions for \(track.title)")
            .help("Song actions")
        }
        .fixedSize(horizontal: true, vertical: false)
        .sheet(item: $exportRequest) { request in
            if let offline = model.offline {
                NavigationStack {
                    OfflineExportView(offline: offline, track: request.track, music: cloud.music, ownerRevision: request.revision)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { exportRequest = nil } } }
                }
                #if os(macOS)
                .frame(minWidth: 480, minHeight: 440)
                #endif
            }
        }
    }
}

private struct AudioExportRequest: Identifiable {
    let id = UUID()
    let track: TrackDTO
    let revision: UUID
}

struct CloudTrackRows: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    @ObservedObject var cloud: CloudAccountStore
    let tracks: [TrackDTO]
    let accountID: String?
    var playlistID: String?
    var reorder: ((Int, Int) -> Void)?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        LazyVStack(spacing: 0) {
            ForEach(Array(tracks.enumerated()), id: \.element.id) { index, track in
                VStack(alignment: .leading, spacing: 0) {
                    if typeSize.isAccessibilitySize {
                        VStack(alignment: .leading, spacing: 4) {
                            selection(track, at: index)
                            actions(track, at: index).frame(maxWidth: .infinity, alignment: .trailing)
                        }
                    } else {
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 8) {
                                selection(track, at: index).frame(minWidth: 180, maxWidth: .infinity, alignment: .leading)
                                actions(track, at: index)
                            }
                            VStack(alignment: .leading, spacing: 4) {
                                selection(track, at: index)
                                actions(track, at: index).frame(maxWidth: .infinity, alignment: .trailing)
                            }
                        }
                    }
                }.padding(.vertical, 10)
                if index < tracks.count - 1 { Divider() }
            }
        }
    }

    private func metadata(_ track: TrackDTO) -> some View {
        HStack(spacing: 12) {
            CloudArtwork(track: track, radius: 8).frame(width: 52, height: 52)
            VStack(alignment: .leading, spacing: 4) {
                Text(track.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                Text(track.artist).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                Text(track.provider == "youtube" ? (model.youtubePlaybackAvailable ? "YouTube · native audio" : "YouTube · opens externally") : "Studio · on this device")
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func actions(_ track: TrackDTO, at index: Int) -> some View {
        CloudTrackActions(model: model, cloud: cloud, track: track, accountID: accountID, playlistID: playlistID,
                          play: { playCollection(at: index) },
                          moveUp: reorder != nil && index > 0 ? { reorder?(index, index - 1) } : nil,
                          moveDown: reorder != nil && index < tracks.count - 1 ? { reorder?(index, index + 1) } : nil)
    }

    @ViewBuilder private func selection(_ track: TrackDTO, at index: Int) -> some View {
        if model.canPlayCloudTrack(track) {
            Button { playCollection(at: index) } label: { metadata(track).foregroundStyle(.primary).contentShape(Rectangle()) }
                .buttonStyle(.plain).accessibilityLabel("Play \(track.title), \(track.artist)")
        } else { metadata(track) }
    }
    private func playCollection(at index: Int) {
        guard tracks.indices.contains(index) else { return }
        let start = tracks.count > 500 ? index : 0
        let window = tracks[start..<min(tracks.count, start + 500)]
        if window.allSatisfy(model.canPlayCloudTrack) {
            model.playCloudTracks(tracks, at: index, expectedAccountID: accountID)
        } else { model.playCloudTracks([tracks[index]], expectedAccountID: accountID) }
    }
}

struct AppleSourceNotice: View {
    @Environment(\.aureliaPalette) private var theme
    let youtubePlaybackAvailable: Bool
    var body: some View {
        Label(youtubePlaybackAvailable
              ? "Native YouTube audio is enabled. Queues restore paused on this device, separately for each account. Some recordings may be unavailable."
              : "Discover and save YouTube music here. Listening opens in YouTube while native playback is unavailable in this build.", systemImage: "info.circle")
            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
}

func copySongLink(_ url: URL) {
    #if os(macOS)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(url.absoluteString, forType: .string)
    #else
    UIPasteboard.general.string = url.absoluteString
    #endif
}
