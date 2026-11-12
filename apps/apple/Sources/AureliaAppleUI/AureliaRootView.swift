import SwiftUI

private enum Destination: String, CaseIterable, Identifiable {
    case listen, search, library, settings
    var id: Self { self }
    var title: String {
        switch self { case .listen: "Discover"; case .search: "Search"; case .library: "Library"; case .settings: "Settings" }
    }
    var symbol: String {
        switch self { case .listen: "sparkles"; case .search: "magnifyingglass"; case .library: "square.stack.fill"; case .settings: "gearshape" }
    }
}

public struct AureliaRootView: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject private var model: AureliaModel
    @ViewState private var selected: Destination? = .listen
    @ViewState private var phoneTab: Destination = .listen
    @ViewState private var showPlayer = false
    @StateObject private var activity: PlaybackActivityRecorder
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    public init(model: AureliaModel) {
        self.model = model
        _activity = StateObject(wrappedValue: PlaybackActivityRecorder())
    }
    #if DEBUG
    init(layoutQAModel model: AureliaModel) {
        self.model = model
        _activity = StateObject(wrappedValue: PlaybackActivityRecorder(defaults: nil))
    }
    #endif

    public var body: some View {
        shell
            .tint(palette.accent)
            .preferredColorScheme(model.profile.appearance == .system ? nil : model.profile.appearance == .dark ? .dark : .light)
            .sheet(isPresented: $showPlayer) { NowPlayingView(model: model) }
            .environment(\.aureliaPalette, palette)
            .environment(\.managedOfflineArtwork, model.offline)
            .task { await model.cloud?.restore() }
            .onReceive(model.$playback) { activity.accept($0, cloud: model.cloud) }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active || phase == .background { Task { await model.offline?.setForeground(phase == .active) } }
                if phase == .active { Task { await model.cloud?.foreground(); activity.foreground(cloud: model.cloud) } }
            }
            .alert("Aurelia", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
                Button("OK") { model.notice = nil }
            } message: { Text(model.notice ?? "") }
    }
    private var palette: ApplePalette {
        ApplePalette(palette: model.profile.palette,
                     dark: model.profile.appearance == .dark || (model.profile.appearance == .system && colorScheme == .dark),
                     increasedContrast: colorSchemeContrast == .increased)
    }

    @ViewBuilder private var shell: some View {
        #if os(macOS)
        NavigationSplitView {
            List(selection: $selected) {
                Section {
                    ForEach(Destination.allCases) { destination in
                        Label(destination.title, systemImage: destination.symbol).tag(destination)
                    }
                } header: {
                    HStack(spacing: 8) {
                        Image(systemName: "waveform").foregroundStyle(theme.accent)
                        Text("Aurelia").font(.title2.bold()).foregroundStyle(.primary)
                    }.padding(.vertical, 20)
                }
                Section("Your space") {
                    Label("Personal cloud library", systemImage: "icloud").foregroundStyle(.secondary)
                    Text("Discover on YouTube\nKeep your favourites in Aurelia")
                        .font(.caption).foregroundStyle(.secondary).padding(.vertical, 4)
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 260)
        } detail: {
            NavigationStack { destination(selected ?? .listen) }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { miniPlayer.padding(.horizontal, 18).padding(.bottom, 12) }
        .frame(minWidth: 800, minHeight: 640)
        #else
        if #available(iOS 26.0, *) {
            phoneTabs(legacyPlayerInset: false)
                .tabViewBottomAccessory { miniPlayer.padding(.horizontal, 12).padding(.bottom, 8) }
        } else {
            phoneTabs(legacyPlayerInset: true)
        }
        #endif
    }

    #if os(iOS)
    private func phoneTabs(legacyPlayerInset: Bool) -> some View {
        TabView(selection: $phoneTab) {
            ForEach(Destination.allCases) { tab in
                phoneDestination(tab, legacyPlayerInset: legacyPlayerInset)
                    .tabItem { Label(tab.title, systemImage: tab.symbol) }.tag(tab)
            }
        }
    }

    @ViewBuilder private func phoneDestination(_ tab: Destination, legacyPlayerInset: Bool) -> some View {
        if legacyPlayerInset {
            NavigationStack { destination(tab) }
                .safeAreaInset(edge: .bottom, spacing: 0) { miniPlayer.padding(.horizontal, 12).padding(.bottom, 8) }
        } else {
            NavigationStack { destination(tab) }
        }
    }
    #endif

    @ViewBuilder private func destination(_ destination: Destination) -> some View {
        switch destination {
        case .listen:
            if let cloud = model.cloud { MusicDiscoveryView(model: model, cloud: cloud, music: cloud.music) }
            else { StudioView(model: model) }
        case .search:
            if let cloud = model.cloud { MusicSearchView(model: model, cloud: cloud, music: cloud.music) }
            else { StudioSearchView(model: model) }
        case .library:
            if let cloud = model.cloud { CloudLibraryView(model: model, cloud: cloud) }
            else { LibraryView(model: model) }
        case .settings: SettingsView(model: model)
        }
    }

    private var miniPlayer: some View {
        HStack(spacing: 12) {
            Button { showPlayer = true } label: {
                HStack(spacing: 12) {
                    PlaybackArtwork(track: model.currentPlaybackTrack, radius: 9).frame(width: 46, height: 46)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(model.currentPlaybackTrack?.title ?? "Nothing playing").font(.subheadline.weight(.semibold)).lineLimit(1)
                        Text(model.currentPlaybackTrack == nil ? "Choose a recording to begin" : model.statusText)
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("Open Now Playing")
            if model.playback.status == .loading { ProgressView().controlSize(.small) }
            SymbolButton(symbol: model.isPlaying ? "pause.fill" : "play.fill", label: model.isPlaying ? "Pause" : "Play") { model.togglePlayback() }
                .disabled(model.currentPlaybackTrack == nil)
            SymbolButton(symbol: "forward.fill", label: "Next recording", size: 18) { model.next() }
                .disabled(model.currentPlaybackTrack == nil)
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .modifier(PlayerGlass(model: model))
    }
}

struct StudioView: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("LOCAL STUDIO").font(.caption.weight(.bold)).tracking(2).foregroundStyle(theme.accent)
                    Text("A quiet space to try the player.").font(.largeTitle.bold())
                    Text("12 bundled original instrumentals. Studio likes and playlists stay on this device.").foregroundStyle(.secondary)
                }
                hero
                SectionHeading(title: "Made for the moment", subtitle: "Four worlds from Aurelia Studio")
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 145, maximum: 290), spacing: 20)], spacing: 24) {
                    ForEach(StudioCatalogue.releases) { release in
                        NavigationLink {
                            CollectionView(model: model, title: release.title, subtitle: "Aurelia Studio · \(release.genre) · 2026", tracks: release.tracks, art: release.id)
                        } label: {
                            VStack(alignment: .leading, spacing: 8) {
                                Artwork(id: release.id).aspectRatio(1, contentMode: .fit)
                                Text(release.title).font(.headline).foregroundStyle(.primary)
                                Text(release.genre).font(.caption).foregroundStyle(.secondary)
                            }
                        }.buttonStyle(.plain)
                    }
                }
                SectionHeading(title: "A little more you", subtitle: "Start with these original instrumentals")
                TrackList(model: model, tracks: Array(StudioCatalogue.tracks.prefix(6)))
                AppleSourceNotice(youtubePlaybackAvailable: model.youtubePlaybackAvailable)
            }.padding(24).frame(maxWidth: 1100).frame(maxWidth: .infinity)
        }
        .background(theme.background).navigationTitle("Studio")
    }
    private var hero: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("AURELIA STUDIO").font(.caption.weight(.bold)).tracking(2)
            Text("Stay in the golden hour.").font(.title.bold())
            Text("Warm textures. Wide open skies.").font(.subheadline)
            Button { model.play(StudioCatalogue.releases[0].tracks) } label: {
                Label("Play Afterglow", systemImage: "play.fill").font(.subheadline.bold()).padding(.vertical, 6)
            }.buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.black)
        }
        .foregroundStyle(.white).padding(24)
        .frame(maxWidth: .infinity, minHeight: 310, alignment: .bottomLeading)
        .background {
            Artwork(id: "afterglow", radius: 22)
                .overlay(LinearGradient(colors: [.clear, .black.opacity(0.8)], startPoint: .center, endPoint: .bottom))
        }
        .clipShape(RoundedRectangle(cornerRadius: 22))
    }
}

private struct StudioSearchView: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                SectionHeading(title: model.searchText.isEmpty ? "Find your sound" : "Studio results", subtitle: "Search the 12 original recordings available on this device.")
                if model.results.isEmpty {
                    EmptyCollection(symbol: "magnifyingglass", title: "No recordings found", detail: "Try a title, album or genre such as Ambient.")
                } else { TrackList(model: model, tracks: model.results) }
                Label("YouTube search isn't connected to this native client yet.", systemImage: "network.slash")
                    .font(.footnote).foregroundStyle(.secondary)
            }.padding(24).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }
        .searchable(text: $model.searchText, prompt: "Songs, albums, moods")
        .background(theme.background).navigationTitle("Search")
    }
}
