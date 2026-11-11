import SwiftUI
import AureliaPlaybackCore
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// Name the existing property-wrapper type explicitly. New SDKs also export a
// State macro whose plugin is shipped with full Xcode, not Command Line Tools.
typealias ViewState<Value> = SwiftUI.State<Value>

private struct ManagedOfflineArtworkKey: EnvironmentKey {
    static let defaultValue: AppleOfflineStore? = nil
}
extension EnvironmentValues {
    var managedOfflineArtwork: AppleOfflineStore? {
        get { self[ManagedOfflineArtworkKey.self] }
        set { self[ManagedOfflineArtworkKey.self] = newValue }
    }
}

/// Managed bytes are read through the owner/SHA gate. A downloaded recording
/// without saved artwork shows a placeholder instead of making a web request.
struct ManagedTrackArtwork: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var offline: AppleOfflineStore
    let trackID: String
    let fallbackURL: URL?
    @ViewState private var image: Image?
    @ViewState private var loadedRequest: ManagedArtworkRequest?
    private var request: ManagedArtworkRequest {
        .init(trackID: trackID, owner: offline.ownerRevision, assets: offline.item(forTrackID: trackID)?.assetsRevision)
    }
    var body: some View {
        Group {
            if loadedRequest == request, let image { image.resizable().scaledToFill() }
            else if offline.item(forTrackID: trackID)?.state == .ready { placeholder }
            else { AsyncImage(url: fallbackURL) { image in image.resizable().scaledToFill() } placeholder: { placeholder } }
        }
        .task(id: request) {
            image = nil; loadedRequest = nil
            let captured = request
            guard let owner = captured.owner,
                  let stored = await offline.savedAssets(for: trackID, expectedRevision: owner),
                  let bytes = stored.payload.coverJPEG, !Task.isCancelled, offline.ownerRevision == owner, request == captured else { return }
            #if os(macOS)
            if let native = NSImage(data: bytes) { image = Image(nsImage: native); loadedRequest = captured }
            #else
            if let native = UIImage(data: bytes) { image = Image(uiImage: native); loadedRequest = captured }
            #endif
        }
        .onDisappear { image = nil; loadedRequest = nil }
    }
    private var placeholder: some View {
        Rectangle().fill(theme.accent.opacity(0.10)).overlay(Image(systemName: "music.note").foregroundStyle(.secondary))
    }
}
private struct ManagedArtworkRequest: Equatable {
    let trackID: String
    let owner: UUID?
    let assets: UUID?
}

extension Color {
    static let aureliaAccent = Color(red: 0.93, green: 0.25, blue: 0.34)
    static var aureliaBackground: Color {
        #if os(macOS)
        Color(nsColor: .windowBackgroundColor)
        #else
        Color(uiColor: .systemGroupedBackground)
        #endif
    }
    static var aureliaCard: Color {
        #if os(macOS)
        Color(nsColor: .controlBackgroundColor)
        #else
        Color(uiColor: .secondarySystemGroupedBackground)
        #endif
    }
}

/// The parent chooses the artwork bounds. Aspect-fill image dimensions stay in
/// the overlay, so a wide thumbnail cannot widen a row or draw across card gaps.
struct ArtworkViewport<Content: View>: View {
    let radius: CGFloat
    private let content: Content

    init(radius: CGFloat, @ViewBuilder content: () -> Content) {
        self.radius = radius
        self.content = content()
    }

    var body: some View {
        Rectangle().fill(.clear)
            .overlay { content }
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .accessibilityHidden(true)
    }
}

struct Artwork: View {
    @Environment(\.aureliaPalette) private var theme
    let id: String
    var radius: CGFloat = 12
    var body: some View {
        ArtworkViewport(radius: radius) {
            if let url = StudioCatalogue.artworkURL(id) {
                #if os(macOS)
                if let image = NSImage(contentsOf: url) {
                    Image(nsImage: image).resizable().scaledToFill()
                }
                #else
                if let image = UIImage(contentsOfFile: url.path) {
                    Image(uiImage: image).resizable().scaledToFill()
                }
                #endif
            } else {
                Rectangle().fill(.quaternary).overlay(Image(systemName: "music.note"))
            }
        }
    }
}

struct PlaybackArtwork: View {
    @Environment(\.aureliaPalette) private var theme
    @Environment(\.managedOfflineArtwork) private var offline
    let track: PlaybackTrack?
    var radius: CGFloat = 12
    private var youtubeArtwork: URL? {
        guard let track, track.provider == .youtube, track.trackID == "youtube:\(track.videoID)",
              track.videoID.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil else { return nil }
        return URL(string: "https://i.ytimg.com/vi/\(track.videoID)/hqdefault.jpg")
    }
    var body: some View {
        ArtworkViewport(radius: radius) {
            if let track, track.provider == .studio, let local = StudioCatalogue.track(track.trackID) {
                Artwork(id: local.albumID, radius: radius)
            } else if let url = youtubeArtwork {
                if let offline, let track {
                    ManagedTrackArtwork(offline: offline, trackID: track.trackID, fallbackURL: url)
                } else { AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { placeholder } }
            } else { placeholder }
        }
    }
    private var placeholder: some View {
        Rectangle().fill(theme.accent.opacity(0.10))
            .overlay(Image(systemName: "music.note").font(.title).foregroundStyle(.secondary))
    }
}

struct SymbolButton: View {
    @Environment(\.aureliaPalette) private var theme
    let symbol: String
    let label: String
    var active = false
    var size: CGFloat = 20
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: size, weight: .semibold))
                .foregroundStyle(active ? theme.accent : .primary)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel(label).help(label)
    }
}

struct SectionHeading: View {
    @Environment(\.aureliaPalette) private var theme
    let title: String
    var subtitle: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.title2.bold())
            if let subtitle { Text(subtitle).font(.subheadline).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct EmptyCollection: View {
    @Environment(\.aureliaPalette) private var theme
    let symbol: String
    let title: String
    let detail: String
    var body: some View {
        ContentUnavailableView(title, systemImage: symbol, description: Text(detail))
            .padding(.vertical, 30)
    }
}

/// Capabilities reflect this mounted surface, not merely OS version detection.
struct PlayerGlass: ViewModifier {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    @ViewState private var surfaceID = UUID()
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *), !reduceTransparency {
            content
                .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .onAppear { model.setGlassRendered(true, surface: surfaceID) }
                .onDisappear { model.setGlassRendered(false, surface: surfaceID) }
        } else if reduceTransparency {
            content.background(theme.card, in: RoundedRectangle(cornerRadius: 22))
                .onAppear { model.setGlassRendered(false, surface: surfaceID) }
        } else {
            content.background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22))
                .onAppear { model.setGlassRendered(false, surface: surfaceID) }
        }
    }
}

func clockText(_ seconds: Double) -> String {
    let safe = seconds.isFinite ? max(0, min(86400, seconds)) : 0
    return String(format: "%d:%02d", Int(safe) / 60, Int(safe) % 60)
}
