import SwiftUI
import AureliaCloud

struct MusicDiscoveryView: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    @ObservedObject var cloud: CloudAccountStore
    @ObservedObject var music: CloudMusicStore
    @ScaledMetric(relativeTo: .body) private var cardWidth = 172.0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("A WORLD OF MUSIC").font(.caption.weight(.bold)).tracking(2).foregroundStyle(theme.accent)
                    Text("Find your next feeling.").font(.largeTitle.bold())
                    Text("Explore YouTube music. Keep your favourites in your own Aurelia library.")
                        .font(.body).foregroundStyle(.secondary)
                    NavigationLink { MusicSearchView(model: model, cloud: cloud, music: music) } label: {
                        Label("Search songs, albums and artists", systemImage: "magnifyingglass")
                            .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                    }
                    .buttonStyle(.plain)
                    .background(theme.card, in: RoundedRectangle(cornerRadius: 16))
                    AppleSourceNotice(youtubePlaybackAvailable: model.youtubePlaybackAvailable)
                    NavigationLink { MusicChartsView(model: model, cloud: cloud, catalogue: music.makeCatalogueSession()) } label: {
                        Label("Charts by region", systemImage: "chart.bar.fill")
                            .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                    }.buttonStyle(.plain).background(theme.card, in: RoundedRectangle(cornerRadius: 16))
                }
                moodSearches
                HStack(alignment: .firstTextBaseline) {
                    SectionHeading(title: "Explore selections", subtitle: "Public metadata from YouTube Music")
                    Button { Task { await music.loadDiscovery() } } label: {
                        Image(systemName: "arrow.clockwise").frame(minWidth: 44, minHeight: 44)
                    }.disabled(music.discoveryLoading).accessibilityLabel("Refresh discovery")
                }
                if music.discoveryLoading { ProgressView("Refreshing music…").frame(maxWidth: .infinity).padding(.vertical) }
                if let error = music.discoveryError {
                    MusicErrorView(title: "Discovery is unavailable", message: error) { Task { await music.loadDiscovery() } }
                }
                if let discovery = music.discovery {
                    ForEach(discovery.sections) { section in
                        VStack(alignment: .leading, spacing: 14) {
                            Text(section.title).font(.title3.bold()).accessibilityAddTraits(.isHeader)
                            if section.tracks.isEmpty {
                                Text("No songs in this selection yet.").font(.subheadline).foregroundStyle(.secondary)
                            } else {
                                ScrollView(.horizontal) {
                                    LazyHStack(alignment: .top, spacing: 16) {
                                        ForEach(section.tracks) { track in discoveryCard(track) }
                                    }.padding(.bottom, 6)
                                }.scrollIndicators(.hidden)
                            }
                        }
                    }
                    if discovery.sections.isEmpty && !music.discoveryLoading {
                        EmptyCollection(symbol: "sparkles", title: "A new selection is on its way", detail: "Try searching for an artist or song while Explore is empty.")
                    }
                    if let date = discoveryDate(discovery.fetchedAt) {
                        Text("Selection updated \(date.formatted(date: .abbreviated, time: .shortened))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } else if !music.discoveryLoading && music.discoveryError == nil {
                    EmptyCollection(symbol: "sparkles", title: "Ready to explore", detail: "Refresh to load public music selections, or search for a favourite artist.")
                }
                if let message = cloud.message { Text(message).font(.footnote).foregroundStyle(.secondary) }
                NavigationLink { StudioView(model: model) } label: {
                    HStack(spacing: 14) {
                        Image(systemName: "waveform").font(.title2).foregroundStyle(theme.accent)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Try the local Studio").font(.headline).foregroundStyle(.primary)
                            Text("12 original instrumentals · available offline").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").foregroundStyle(.secondary)
                    }.padding(16).background(theme.card, in: RoundedRectangle(cornerRadius: 16))
                }.buttonStyle(.plain)
            }.padding(24).frame(maxWidth: 1100).frame(maxWidth: .infinity)
        }
        .background(theme.background).navigationTitle("Discover")
        .task(id: MusicIdentity(accountID: cloud.account?.id, phase: cloud.phase)) { await music.loadDiscovery() }
        .refreshable { await music.loadDiscovery() }
    }

    private func discoveryCard(_ track: TrackDTO) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            CloudArtwork(track: track, radius: 14).frame(width: cardWidth, height: cardWidth)
            Text(track.title).font(.subheadline.weight(.semibold)).lineLimit(2, reservesSpace: true)
            Text(track.artist).font(.caption).foregroundStyle(.secondary).lineLimit(2, reservesSpace: true)
            CloudTrackActions(model: model, cloud: cloud, track: track, accountID: cloud.account?.id)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }.frame(width: cardWidth, alignment: .leading)
    }

    private var moodSearches: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Set the mood").font(.headline)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 125), spacing: 10)], spacing: 10) {
                ForEach(["Focus", "Slow mornings", "Late night", "Feel good", "Ambient", "A little energy"], id: \.self) { mood in
                    NavigationLink { MusicSearchView(model: model, cloud: cloud, music: music, initialQuery: mood) } label: {
                        Text(mood).font(.subheadline.weight(.medium)).frame(maxWidth: .infinity, minHeight: 44)
                            .padding(.horizontal, 8).background(theme.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
                    }.buttonStyle(.plain)
                }
            }
        }
    }

    private func discoveryDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

struct MusicSearchView: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    @ObservedObject var cloud: CloudAccountStore
    // A search belongs to this screen, including separate Mac windows or tabs.
    @StateObject private var catalogue: CloudCatalogueStore
    @ViewState private var query: String
    @ViewState private var kind: MusicSearchKind = .songs
    @ViewState private var completedRequest: SearchRequest?
    @ViewState private var retry = 0

    init(model: AureliaModel, cloud: CloudAccountStore, music: CloudMusicStore, initialQuery: String = "") {
        self.model = model; self.cloud = cloud
        _catalogue = StateObject(wrappedValue: music.makeCatalogueSession())
        _query = ViewState(initialValue: initialQuery)
    }
    private var normalizedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var request: SearchRequest { SearchRequest(query: normalizedQuery, kind: kind, identity: MusicIdentity(accountID: cloud.account?.id, phase: cloud.phase), retry: retry) }
    private var invalidQuery: Bool {
        normalizedQuery.utf16.count > 200 || normalizedQuery.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                SectionHeading(title: normalizedQuery.isEmpty ? "Find your sound" : "Music results", subtitle: "Songs, albums, artists and public playlists")
                Picker("Search category", selection: $kind) {
                    ForEach(MusicSearchKind.allCases, id: \.self) { Text($0.title).tag($0) }
                }.pickerStyle(.menu)
                AppleSourceNotice(youtubePlaybackAvailable: model.youtubePlaybackAvailable)
                if normalizedQuery.isEmpty {
                    EmptyCollection(symbol: "magnifyingglass", title: "What would you like to find?", detail: "Search for an artist, song or mood. You can explore without connecting an account.")
                } else if invalidQuery {
                    EmptyCollection(symbol: "text.magnifyingglass", title: "Try a shorter search", detail: "Use up to 200 characters without line breaks or control characters.")
                } else if catalogue.loading || completedRequest != request {
                    ProgressView("Searching music…").frame(maxWidth: .infinity).padding(.vertical, 30)
                } else if let error = catalogue.error {
                    MusicErrorView(title: "Search is unavailable", message: error) { retry &+= 1 }
                } else if let result = catalogue.result {
                    if catalogue.usesLegacySongs { Text("Showing song search results.").font(.caption).foregroundStyle(.secondary) }
                    MusicCatalogueContent(model: model, cloud: cloud, catalogue: catalogue, result: result)
                }
                if cloud.account == nil {
                    NavigationLink { AccountView(cloud: cloud) } label: { Label("Connect your account to save music", systemImage: "icloud") }
                }
                if let message = cloud.message { Text(message).font(.footnote).foregroundStyle(.secondary) }
            }.padding(24).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }
        #if os(macOS)
        .searchable(text: $query, prompt: "Songs, albums, artists, playlists")
        #else
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Songs, albums, artists, playlists")
        #endif
        .background(theme.background).navigationTitle("Search")
        .task(id: request) {
            let captured = request
            completedRequest = nil; catalogue.clear()
            guard !captured.query.isEmpty, !invalidQuery else { return }
            do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
            guard !Task.isCancelled else { return }
            await catalogue.search(captured.query, kind: captured.kind)
            guard !Task.isCancelled, captured == request else { return }
            completedRequest = captured
        }
    }
}

private struct SearchRequest: Equatable {
    let query: String
    let kind: MusicSearchKind
    let identity: MusicIdentity
    let retry: Int
}

private struct MusicIdentity: Equatable {
    let accountID: String?
    let phase: CloudAuthPhase
}

struct MusicErrorView: View {
    @Environment(\.aureliaPalette) private var theme
    let title: String
    let message: String
    let retry: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: "wifi.exclamationmark").font(.headline)
            Text(message).font(.subheadline).foregroundStyle(.secondary)
            Button("Try again", action: retry).buttonStyle(.bordered)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(18)
            .background(theme.card, in: RoundedRectangle(cornerRadius: 16))
    }
}
