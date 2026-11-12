#if DEBUG
import SwiftUI
import Foundation
import AureliaCloud
import AureliaPlaybackCore

/// Visual layout inspection only. No live factory, system player or personal store
/// is reachable from this scene. Artwork still reads the app's bundled PNGs.
public struct DebugLayoutQAScene: View {
    @StateObject private var fixture = LayoutQAFixture()
    @ViewState private var typeSize: DynamicTypeSize = .large
    @ViewState private var width: LayoutQAWidth = .device
    @ViewState private var dark = false
    @ViewState private var area: LayoutQAArea = .discovery
    @ViewState private var carouselIndex = 0
    @ViewState private var carouselTrailingEdge = false

    public init() {}

    public var body: some View {
        VStack(spacing: 10) {
            controls.padding(.horizontal, 12)
            GeometryReader { geometry in
                let canvasWidth = min(max(1, geometry.size.width), width.points ?? geometry.size.width)
                ScrollView {
                    if let issue = fixture.issue {
                        Text(issue).foregroundStyle(.secondary).padding()
                    } else if fixture.ready {
                        content
                            .frame(width: canvasWidth, height: area.canvasHeight(typeSize, viewport: geometry.size.height))
                            .environment(\.aureliaPalette, ApplePalette(palette: .base, dark: dark, increasedContrast: false))
                            .environment(\.managedOfflineArtwork, nil)
                            .environment(\.colorScheme, dark ? .dark : .light)
                            .dynamicTypeSize(typeSize)
                            .preferredColorScheme(dark ? .dark : .light)
                            // Visual enabled states remain production states. The host
                            // scrolls the canvas; fixture controls cannot perform actions.
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                            .clipped()
                    } else {
                        ProgressView("Preparing synthetic layout…").padding()
                    }
                }
                .frame(maxWidth: .infinity)
                .id(area)
                .overlay(alignment: .topTrailing) {
                    Text("\(Int(canvasWidth)) pt").font(.caption2.monospacedDigit())
                        .padding(5).background(.regularMaterial, in: Capsule()).padding(4)
                        .allowsHitTesting(false)
                }
            }
        }
        .padding(.top, 8)
        .background(Color.aureliaBackground)
        .task { await fixture.prepare() }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Native layout QA · forced silent").font(.headline)
            Text("Synthetic labels · bundled artwork · inert production content. Scroll the canvas to inspect it.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Picker("Type size", selection: $typeSize) {
                    ForEach(DynamicTypeSize.allCases, id: \.self) { size in Text(size.qaTitle).tag(size) }
                }
                Picker("Width", selection: $width) {
                    ForEach(LayoutQAWidth.allCases, id: \.self) { item in Text(item.rawValue).tag(item) }
                }
                Picker("Appearance", selection: $dark) {
                    Text("Light").tag(false)
                    Text("Dark").tag(true)
                }
            }.pickerStyle(.menu)
            Picker("Layout", selection: $area) {
                ForEach(LayoutQAArea.allCases, id: \.self) { item in Text(item.rawValue).tag(item) }
            }.pickerStyle(.menu)
            if area == .discovery {
                HStack {
                    Picker("Card", selection: $carouselIndex) {
                        ForEach(fixture.tracks.indices, id: \.self) { index in Text("\(index + 1)").tag(index) }
                    }
                    Picker("Card edge", selection: $carouselTrailingEdge) {
                        Text("Leading").tag(false)
                        Text("Trailing").tag(true)
                    }
                }.pickerStyle(.menu)
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch area {
        case .discovery:
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    SectionHeading(title: "Explore selections", subtitle: "Synthetic Studio metadata · production carousel")
                    ScrollViewReader { proxy in
                        MusicDiscoveryCarousel(model: fixture.model, cloud: fixture.cloud, tracks: fixture.tracks)
                            .onAppear { scrollCarousel(proxy) }
                            .onChange(of: carouselIndex) { _, _ in scrollCarousel(proxy) }
                            .onChange(of: carouselTrailingEdge) { _, _ in scrollCarousel(proxy) }
                            .onChange(of: typeSize) { _, _ in scrollCarousel(proxy) }
                            .onChange(of: width) { _, _ in scrollCarousel(proxy) }
                    }
                    MusicMoodSearches(model: fixture.model, cloud: fixture.cloud, music: fixture.cloud.music)
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }
        case .studio:
            NavigationStack { StudioView(model: fixture.model) }
        case .studioRows:
            ScrollView { TrackList(model: fixture.model, tracks: fixture.studioTracks).padding(24) }
        case .cloudRows:
            ScrollView {
                CloudTrackRows(model: fixture.model, cloud: fixture.cloud, tracks: fixture.tracks,
                               accountID: LayoutQAFixture.accountID).padding(24)
            }
        case .recommendations:
            NavigationStack {
                CloudListeningView(model: fixture.model, cloud: fixture.cloud,
                                   accountID: LayoutQAFixture.accountID, kind: .recommendations)
            }
        case .shell:
            AureliaRootView(layoutQAModel: fixture.model)
        case .nowPlaying:
            NowPlayingView(model: fixture.model)
        case .settings:
            NavigationStack { SettingsView(model: fixture.model) }
        }
    }

    private func scrollCarousel(_ proxy: ScrollViewProxy) {
        guard fixture.tracks.indices.contains(carouselIndex) else { return }
        proxy.scrollTo(fixture.tracks[carouselIndex].id, anchor: carouselTrailingEdge ? .trailing : .leading)
    }
}

private enum LayoutQAWidth: String, CaseIterable {
    case compact = "320", standard = "390", device = "Full width"
    var points: CGFloat? { switch self { case .compact: 320; case .standard: 390; case .device: nil } }
}

private enum LayoutQAArea: String, CaseIterable {
    case discovery = "Discovery carousel + moods", studio = "Studio hero + library"
    case studioRows = "Studio long rows", cloudRows = "Cloud long rows", recommendations = "Recommendations"
    case shell = "Application shell", nowPlaying = "Now Playing", settings = "Settings"

    func canvasHeight(_ size: DynamicTypeSize, viewport: CGFloat) -> CGFloat {
        if self == .shell { return max(1, viewport) }
        // These tall inspection canvases expose inert production ScrollView/Form
        // content to the host scroll. They do not simulate a device's height.
        return max(viewport, size.isAccessibilitySize ? 8_000 : 2_600)
    }
}

private extension DynamicTypeSize {
    var qaTitle: String {
        switch self {
        case .xSmall: "XS"; case .small: "S"; case .medium: "M"; case .large: "L"
        case .xLarge: "XL"; case .xxLarge: "XXL"; case .xxxLarge: "XXXL"
        case .accessibility1: "AX1"; case .accessibility2: "AX2"; case .accessibility3: "AX3"
        case .accessibility4: "AX4"; case .accessibility5: "AX5"
        @unknown default: "Other"
        }
    }
}

@MainActor private final class LayoutQAFixture: ObservableObject {
    nonisolated static let accountID = "layout-qa-synthetic-owner"
    nonisolated static let date = Date(timeIntervalSince1970: 1_794_355_200)
    @Published private(set) var ready = false
    @Published private(set) var issue: String?
    let model: AureliaModel
    let cloud: CloudAccountStore
    let tracks: [TrackDTO]
    let studioTracks: [StudioTrack]
    private let driver: LayoutQADriver
    private let transport: LayoutQATransport
    private var started = false

    init() {
        let recordings = Array(StudioCatalogue.tracks.prefix(4))
        let studios = recordings.enumerated().map { index, track in
            StudioTrack(id: track.id,
                        title: "Synthetic \(index + 1) · A very long recording title for the quiet hours between the last train and the first light of morning",
                        albumID: track.albumID, album: track.album, genre: track.genre, audioNumber: track.audioNumber)
        }
        // Canonical IDs select bundled artwork in CloudArtwork/PlaybackArtwork.
        // No YouTube DTO, remote AsyncImage or validation exception is involved.
        let metadata = studios.map { track in
            try! TrackDTO(id: track.id, title: track.title,
                          artist: "Synthetic ensemble with an intentionally long artist credit and many invited musicians",
                          album: "Synthetic collection for narrow layouts and the largest accessibility text sizes",
                          provider: "studio", externalId: String(track.audioNumber), duration: track.duration)
        }
        let transport = LayoutQATransport(tracks: metadata)
        let cloud = CloudAccountStore(client: CloudAPIClient(transport: transport),
                                      credentials: LayoutQACredentials(), now: { Self.date })
        let driver = LayoutQADriver()
        self.tracks = metadata; self.studioTracks = studios
        self.transport = transport; self.cloud = cloud; self.driver = driver
        self.model = AureliaModel(driver: driver, resolver: LayoutQAResolver(),
                                  store: LocalProfileStore(defaults: nil), forceMuted: true, cloud: cloud,
                                  youtubePlaybackAvailable: false, offline: nil, localFiles: nil,
                                  timerNow: { Self.date })
    }

    func prepare() async {
        guard !started else { return }
        started = true
        await cloud.restore()
        guard cloud.phase == .signedIn, cloud.account?.id == Self.accountID,
              cloud.recommendations.count == tracks.count else {
            issue = "Synthetic cloud fixture did not validate."; return
        }
        for track in studioTracks { model.addToQueue(track) }
        // Queue insertion resolves only an inert value; the mock driver owns it.
        for _ in 0..<100 where model.playback.status == .loading {
            try? await Task.sleep(for: .milliseconds(1))
        }
        model.notice = nil
        guard model.playback.status == .paused, model.playback.failure == nil,
              model.playback.queue.count == studioTracks.count, driver.loadCalls > 0,
              model.forceMuted, model.offline == nil, model.localFiles == nil,
              driver.playCalls == 0, !driver.volumes.isEmpty, driver.volumes.allSatisfy({ $0 == 0 }),
              await transport.rejectedRequests == 0 else {
            issue = "Synthetic layout fixture failed its silent isolation checks."; return
        }
        ready = true
    }
}

/// Accepts only the finite read requests needed by production view tasks. It has
/// no URLSession, URLProtocol hook, disk cache or fallback transport.
private actor LayoutQATransport: CloudHTTPTransport {
    private let bootstrap: Data
    private let recommendations: Data
    private let discovery = Data(#"{"source":"youtube-music","fetchedAt":"2026-11-11T00:00:00Z","sections":[]}"#.utf8)
    private(set) var rejectedRequests = 0

    init(tracks: [TrackDTO]) {
        let objects = tracks.map { track -> [String: Any] in
            ["id": track.id, "title": track.title, "artist": track.artist, "album": track.album,
             "provider": track.provider, "externalId": track.externalId, "duration": track.duration, "artwork": track.artwork]
        }
        let entries: [[String: Any]] = objects.map {
            ["track": $0, "score": 1, "reason": "Synthetic recommendation explanation that wraps naturally when text is large and the available width is small."]
        }
        self.recommendations = try! JSONSerialization.data(withJSONObject: entries, options: [.sortedKeys])
        let user: [String: Any] = ["id": LayoutQAFixture.accountID, "name": "Synthetic Layout QA", "identities": []]
        let library: [String: Any] = ["likes": objects, "playlists": [], "history": [], "searches": []]
        let payload: [String: Any] = ["user": user, "library": library,
                                     "capabilities": [String: Bool](), "recommendations": entries]
        self.bootstrap = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    }

    func send(_ request: URLRequest, maxBytes: Int) async throws -> CloudHTTPResponse {
        guard request.httpMethod == "GET", let url = request.url,
              url.scheme == "https", url.host == CloudAPIClient.origin.host, url.port == nil,
              url.query == nil, url.fragment == nil, request.httpBody == nil, request.httpBodyStream == nil else {
            rejectedRequests += 1; throw CloudFailure.denied
        }
        let data: Data
        switch url.path {
        case "/api/bootstrap": data = bootstrap
        case "/api/recommendations": data = recommendations
        case "/api/discovery": data = discovery
        default: rejectedRequests += 1; throw CloudFailure.denied
        }
        guard data.count <= maxBytes else { throw CloudFailure.invalidResponse }
        return CloudHTTPResponse(status: 200, body: data)
    }
}

@MainActor private final class LayoutQACredentials: CredentialStoring {
    private let credential = try! CloudCredential(token: String(repeating: "Q", count: 43),
        accountID: LayoutQAFixture.accountID, expiresAt: Date(timeIntervalSince1970: 4_102_444_800))
    func load() throws -> CloudCredential? { credential }
    func save(_ credential: CloudCredential) throws { throw CloudFailure.denied }
    func delete() throws { throw CloudFailure.denied }
}

private struct LayoutQAResolver: PlaybackResolving {
    // ResolvedAudio keeps its production HTTPS admission rules. This inert
    // marker is never fetched, opened, decoded or passed to AVFoundation.
    static let marker = URL(string: "https://layout-qa.googlevideo.com/layout-only")!
    func resolve(_ track: PlaybackTrack) async throws -> ResolvedAudio {
        guard track.provider == .studio, StudioCatalogue.track(track.trackID) != nil else { throw PlaybackFailure.invalidTrack }
        return try ResolvedAudio(url: Self.marker, expiresAt: .distantFuture)
    }
}

@MainActor private final class LayoutQADriver: PlaybackDriving {
    var onEvent: (@MainActor (UInt64, PlaybackDriverEvent) -> Void)?
    private(set) var playCalls = 0
    private(set) var loadCalls = 0
    private(set) var volumes: [Float] = []
    func load(_ source: ResolvedAudio, track: PlaybackTrack, generation: UInt64) throws {
        guard source.url == LayoutQAResolver.marker, track.provider == .studio else { throw PlaybackFailure.invalidSource }
        loadCalls += 1
    }
    func play() { playCalls += 1 }
    func pause() {}
    func seek(to position: Double) {}
    func stop() {}
    func dispose() {}
    func setVolume(_ value: Float) { volumes.append(value) }
}
#endif
