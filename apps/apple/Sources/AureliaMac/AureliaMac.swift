import SwiftUI
import AureliaAppleUI
import AureliaYouTubeNative

@main
struct AureliaMac: App {
    @StateObject private var model: AureliaModel
    init() {
        let forced = ProcessInfo.processInfo.arguments.contains("--force-muted")
            || ProcessInfo.processInfo.environment["AURELIA_FORCE_MUTED"] == "1"
        _model = StateObject(wrappedValue: AureliaModel.live(forceMuted: forced,
            youtubeResolver: NativeYouTubeSourceFactory.makeResolver()))
    }
    var body: some Scene {
        WindowGroup("Aurelia") { AureliaRootView(model: model) }
            .defaultSize(width: 1120, height: 800)
            .commands {
                CommandMenu("Playback") {
                    Button(model.isPlaying ? "Pause" : "Play") { model.togglePlayback() }.keyboardShortcut(.space, modifiers: [])
                    Button("Next") { model.next() }.keyboardShortcut(.rightArrow, modifiers: [.command])
                    Button("Previous") { model.previous() }.keyboardShortcut(.leftArrow, modifiers: [.command])
                }
            }
    }
}
