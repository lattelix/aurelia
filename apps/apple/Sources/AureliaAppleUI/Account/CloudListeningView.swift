import SwiftUI
import AureliaCloud

struct CloudListeningView: View {
    @Environment(\.aureliaPalette) private var theme
    @Environment(\.dynamicTypeSize) private var typeSize
    enum Kind { case history, recommendations }
    @ObservedObject var model: AureliaModel
    @ObservedObject var cloud: CloudAccountStore
    let accountID: String
    let kind: Kind
    @ViewState private var hidden = Set<String>()
    @ViewState private var hiding = Set<String>()
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if cloud.account?.id == accountID {
                    SectionHeading(title: kind == .history ? "Recently Played" : "Made for You",
                        subtitle: kind == .history ? "Songs from your latest 100 cloud plays · most recent first" : "Based on your likes and listening")
                    Button("Refresh") { Task { await refresh() } }
                        .disabled(cloud.isRefreshing || cloud.recommendationsLoading)
                    if cloud.isRefreshing || cloud.recommendationsLoading { ProgressView("Updating music…") }
                    if kind == .history {
                        let tracks = CloudCollectionView.recentTracks(cloud.library?.history ?? [])
                        if tracks.isEmpty { EmptyCollection(symbol: "clock", title: "Your listening starts here", detail: "Play a song while connected to your Aurelia account to build your history.") }
                        CloudTrackRows(model: model, cloud: cloud, tracks: tracks, accountID: accountID)
                    } else {
                        let entries = cloud.recommendations.filter { !hidden.contains($0.id) }
                        if let error = cloud.recommendationsError { Text(error).foregroundStyle(.secondary) }
                        if entries.isEmpty && !cloud.recommendationsLoading {
                            EmptyCollection(symbol: "sparkles", title: "Find your next favourite", detail: "Save and listen to songs, then refresh your recommendations.")
                        }
                        ForEach(entries) { entry in
                            VStack(alignment: .leading, spacing: 8) {
                                recommendationRow(entry.track, in: entries)
                                HStack {
                                    Text(entry.reason).font(.caption).foregroundStyle(.secondary)
                                    Spacer()
                                    Button("Hide", systemImage: "eye.slash") {
                                        hiding.insert(entry.id)
                                        Task {
                                            let saved = await cloud.recordSignal(.hide, trackID: entry.id, expectedAccountID: accountID)
                                            hiding.remove(entry.id)
                                            if saved && cloud.account?.id == accountID { hidden.insert(entry.id) }
                                        }
                                    }.disabled(hiding.contains(entry.id)).font(.caption)
                                }
                            }
                        }
                    }
                    if let message = cloud.message { Text(message).font(.footnote).foregroundStyle(.secondary) }
                } else {
                    EmptyCollection(symbol: "person.crop.circle", title: "Account changed", detail: "Return to Library to see music for your current account.")
                }
            }.padding(24).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }
        .background(theme.background).navigationTitle(kind == .history ? "History" : "Made for You")
        .task { await refresh() }.refreshable { await refresh() }
        .onChange(of: cloud.account?.id) { _, _ in hidden = []; hiding = [] }
    }

    private func recommendationRow(_ track: TrackDTO, in entries: [RecommendationDTO]) -> some View {
        Group {
            if typeSize.isAccessibilitySize {
                stackedRecommendation(track, in: entries)
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) {
                        selection(track, in: entries).frame(minWidth: 180, maxWidth: .infinity, alignment: .leading)
                        actions(track, in: entries)
                    }
                    stackedRecommendation(track, in: entries)
                }
            }
        }
    }

    private func stackedRecommendation(_ track: TrackDTO, in entries: [RecommendationDTO]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            selection(track, in: entries)
            actions(track, in: entries).frame(maxWidth: .infinity, alignment: .trailing)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func selection(_ track: TrackDTO, in entries: [RecommendationDTO]) -> some View {
        Button { play(track, in: entries) } label: {
            HStack(spacing: 12) {
                CloudArtwork(track: track, radius: 8).frame(width: 52, height: 52)
                VStack(alignment: .leading, spacing: 4) {
                    Text(track.title).font(.headline).foregroundStyle(.primary)
                    Text(track.artist).font(.caption).foregroundStyle(.secondary)
                }
                .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            }.contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(!model.canPlayCloudTrack(track))
            .accessibilityLabel("Play \(track.title), \(track.artist)")
    }

    private func actions(_ track: TrackDTO, in entries: [RecommendationDTO]) -> some View {
        CloudTrackActions(model: model, cloud: cloud, track: track, accountID: accountID,
            play: { play(track, in: entries) })
    }

    private func refresh() async {
        guard cloud.account?.id == accountID else { return }
        if kind == .history { await cloud.refresh() }
        else { await cloud.loadRecommendations(expectedAccountID: accountID) }
    }
    private func play(_ track: TrackDTO, in entries: [RecommendationDTO]) {
        let tracks = entries.map(\.track)
        guard let index = tracks.firstIndex(where: { $0.id == track.id }) else { return }
        if tracks.allSatisfy(model.canPlayCloudTrack) { model.playCloudTracks(tracks, at: index, expectedAccountID: accountID) }
        else { model.playCloudTracks([track], expectedAccountID: accountID) }
    }
}
