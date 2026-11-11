import SwiftUI

struct SettingsView: View {
    @Environment(\.aureliaPalette) private var theme
    @ObservedObject var model: AureliaModel
    var body: some View {
        Form {
            Section("Appearance") {
                Picker("Palette", selection: Binding(get: { model.profile.palette }, set: { model.setPalette($0) })) {
                    ForEach(ThemePalette.allCases, id: \.self) { Text($0.title).tag($0) }
                }.tint(theme.accent)
                    .id("palette-picker:\(pickerAppearanceKey)")
                Picker("Appearance", selection: Binding(get: { model.profile.appearance }, set: { model.setAppearance($0) })) {
                    ForEach(AppearanceMode.allCases, id: \.self) { Text($0.title).tag($0) }
                }.tint(theme.accent)
                    .id("appearance-picker:\(pickerAppearanceKey)")
                LabeledContent("Player surface", value: model.glassRendered ? "Native Liquid Glass" : "System material / opaque fallback")
                Text("Glass is used for the floating player when the system supports it. Reduce Transparency uses a solid surface.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Local Studio") {
                LabeledContent("Studio library", value: "On this device")
                LabeledContent("Likes", value: String(model.profile.likes.count))
                LabeledContent("Playlists", value: String(model.profile.playlists.count))
                Text("These counts refer to bundled Studio recordings. Your Aurelia account’s favourites and playlists are in Cloud Library. Appearance is a device preference; playback queues restore paused for each account on this device.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Connections") {
                if let localFiles = model.localFiles {
                    NavigationLink { LocalFilesView(store: localFiles, onPlay: model.playLocalFiles, onDisable: model.stopLocalPlayback,
                                                   onPlayNext: model.playLocalNext, onAddToQueue: model.addLocalToQueue) } label: { Label("Files on this device", systemImage: "folder") }
                }
                if let offline = model.offline {
                    NavigationLink { OfflineLibraryView(model: model, offline: offline) } label: { Label("Downloads", systemImage: "arrow.down.circle") }
                }
                if let cloud = model.cloud {
                    NavigationLink { AccountView(cloud: cloud) } label: { Label("Your Aurelia account", systemImage: "person.crop.circle") }
                    NavigationLink { CloudLibraryView(model: model, cloud: cloud) } label: { Label("Cloud library", systemImage: "icloud") }
                    NavigationLink { LibraryTransferView(cloud: cloud) } label: { Label("Import & Export", systemImage: "arrow.up.arrow.down") }
                }
                Label("YouTube discovery and search", systemImage: "magnifyingglass")
                AppleSourceNotice(youtubePlaybackAvailable: model.youtubePlaybackAvailable)
            }
            Section("Playback") {
                LabeledContent("Audio", value: model.forceMuted ? "Forced silent QA" : "Starts paused")
                Toggle("Show volume control", isOn: Binding(get: { model.profile.showVolumeControl }, set: { model.setShowVolumeControl($0) }))
                #if os(iOS)
                if model.profile.showVolumeControl {
                    Toggle("Match system volume", isOn: Binding(get: { model.profile.matchSystemVolume }, set: { model.setMatchSystemVolume($0) }))
                    Text(model.profile.matchSystemVolume ? "The Now Playing slider controls this device’s media volume." : "The Now Playing slider controls Aurelia’s player volume separately.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                #endif
                Text("Music starts only when you choose a song or press Play. Volume controls are device preferences.")
                    .font(.caption).foregroundStyle(.secondary)
                LabeledContent("Sources", value: model.youtubePlaybackAvailable ? "Native YouTube audio + bundled Studio" : "Bundled Studio · YouTube opens externally")
            }
            Section("Aurelia") {
                LabeledContent("Native preview", value: "0.1.0")
                Text("A quiet place for your music.").foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .tint(theme.accent)
        .navigationTitle("Settings")
    }

    // On iPhone, native pickers retain the previous resolved UIColor after an
    // in-session appearance switch. Refresh only these controls, not the Form.
    private var pickerAppearanceKey: String {
        "\(theme.palette.rawValue):\(theme.dark):\(theme.increasedContrast)"
    }
}
