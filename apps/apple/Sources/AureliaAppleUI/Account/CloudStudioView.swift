import SwiftUI
import AureliaCloud

struct CloudStudioView: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    @ObservedObject var cloud: CloudAccountStore
    let accountID: String
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if cloud.account?.id == accountID {
                    SectionHeading(title: "Studio, saved to your account", subtitle: "These hearts and playlists belong to your cloud library.")
                    ForEach(StudioCatalogue.tracks) { track in
                        if typeSize.isAccessibilitySize {
                            stackedRow(track)
                        } else {
                            ViewThatFits(in: .horizontal) {
                                HStack(spacing: 12) {
                                    metadata(track)
                                    Spacer(minLength: 4)
                                    actions(track)
                                }
                                stackedRow(track)
                            }
                        }
                        Divider()
                    }
                } else {
                    EmptyCollection(symbol: "person.crop.circle", title: "Account changed", detail: "Return to Cloud Library before saving music.")
                }
                if let message = cloud.message { Text(message).font(.footnote).foregroundStyle(.secondary) }
            }.padding(24).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }.background(theme.background).navigationTitle("Studio for Cloud")
    }

    private func metadata(_ track: StudioTrack) -> some View {
        HStack(spacing: 12) {
            Artwork(id: track.albumID, radius: 8).frame(width: 48, height: 48)
            VStack(alignment: .leading, spacing: 4) {
                Text(track.title).font(.subheadline.bold())
                Text(track.album).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func stackedRow(_ track: StudioTrack) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            metadata(track)
            actions(track).frame(maxWidth: .infinity, alignment: .trailing)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func actions(_ track: StudioTrack) -> some View {
        let liked = cloud.library?.likes.contains { $0.id == track.id } ?? false
        let canSave = !cloud.isMutating && !cloud.libraryNeedsRefresh && cloud.library != nil && cloud.account?.id == accountID
        return HStack(spacing: 0) {
            SymbolButton(symbol: "play.fill", label: "Play \(track.title) from Studio", size: 16) { model.play([track]) }
            SymbolButton(symbol: liked ? "heart.fill" : "heart", label: liked ? "Unlike \(track.title) in cloud" : "Like \(track.title) in cloud", active: liked, size: 17) {
                Task { await cloud.setLiked(track.id, liked: !liked, expectedAccountID: accountID) }
            }.disabled(!canSave)
            Menu {
                ForEach(cloud.library?.playlists ?? []) { playlist in
                    Button("Add to \(playlist.name)") {
                        Task { await cloud.playlistTrack(track.id, playlistID: playlist.id, adding: true, expectedAccountID: accountID) }
                    }
                }
                if cloud.library?.playlists.isEmpty ?? true { Text("Create a cloud playlist first") }
            } label: { Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44) }
            .disabled(!canSave).accessibilityLabel("Cloud playlists for \(track.title)")
        }.fixedSize(horizontal: true, vertical: false)
    }
}
