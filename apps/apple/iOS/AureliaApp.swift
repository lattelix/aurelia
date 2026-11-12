import SwiftUI
import AureliaAppleUI
import AureliaYouTubeNative

/// Admit only complete development intents before constructing any live dependency.
/// Unrelated OS/application arguments retain their normal launch behavior.
enum NativeDebugLaunchIntent: Equatable {
    case normal, layout, source, offline, rejected

    static func admit(_ arguments: [String], developmentModesEnabled: Bool) -> Self {
        let layout = arguments.filter { $0.hasPrefix("--native-layout-qa") }
        let source = arguments.filter { $0.hasPrefix("--native-source-proof") }
        let offline = arguments.filter { $0.hasPrefix("--native-offline-proof") }
        let background = arguments.filter { $0.hasPrefix("--native-background-seconds") }
        guard !layout.isEmpty || !source.isEmpty || !offline.isEmpty || !background.isEmpty else { return .normal }
        // Release recognizes QA intent only to reject it without opening a profile.
        guard developmentModesEnabled else { return .rejected }
        let mute = arguments.filter { $0.hasPrefix("--force-muted") }
        guard mute == ["--force-muted"], [layout, source, offline].filter({ !$0.isEmpty }).count == 1 else { return .rejected }
        if !layout.isEmpty { return layout == ["--native-layout-qa"] && background.isEmpty ? .layout : .rejected }
        if !source.isEmpty { return source == ["--native-source-proof"] && background.isEmpty ? .source : .rejected }
        guard offline == ["--native-offline-proof"], background.count <= 1 else { return .rejected }
        guard let option = background.first else { return .offline }
        let prefix = "--native-background-seconds="
        guard option.hasPrefix(prefix) else { return .rejected }
        let value = option.dropFirst(prefix.count)
        guard (2...3).contains(value.utf8.count), value.utf8.allSatisfy({ (48...57).contains($0) }),
              let seconds = Int(value), (16...180).contains(seconds) else { return .rejected }
        return .offline
    }
}

/// The explicit source check must not restore or mutate the real profile.
/// Normal scenes keep one shared model, including on multi-window iPad.
@MainActor private final class AureliaLaunchState: ObservableObject {
    let model: AureliaModel?
    let intent: NativeDebugLaunchIntent
    init() {
        let arguments = ProcessInfo.processInfo.arguments
        #if DEBUG
        intent = NativeDebugLaunchIntent.admit(arguments, developmentModesEnabled: true)
        #else
        intent = NativeDebugLaunchIntent.admit(arguments, developmentModesEnabled: false)
        #endif
        guard intent == .normal else { model = nil; return }
        let forced = arguments.contains("--force-muted")
            || ProcessInfo.processInfo.environment["AURELIA_FORCE_MUTED"] == "1"
        model = AureliaModel.live(forceMuted: forced,
            youtubeResolver: NativeYouTubeSourceFactory.makeResolver())
    }
}

@main struct AureliaPhone: App {
    @StateObject private var launch = AureliaLaunchState()
    var body: some Scene {
        WindowGroup {
            if let model = launch.model {
                AureliaRootView(model: model)
            } else {
                if launch.intent == .rejected {
                    VStack(spacing: 16) {
                        Image(systemName: "exclamationmark.shield").font(.largeTitle)
                        Text("Development check rejected").font(.headline)
                        Text("Checks require a development build and one complete muted mode. No library or playback was opened.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }.padding()
                } else {
                    #if DEBUG
                    if launch.intent == .layout {
                        DebugLayoutQAScene()
                    } else {
                        VStack(spacing: 16) {
                            Image(systemName: "waveform").font(.largeTitle)
                            Text(launch.intent == .offline ? "Native offline check" : "Native source check").font(.headline)
                            Text("Muted development check. Your library is unchanged.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        .padding()
                        .task {
                            if launch.intent == .offline {
                                _ = await runManagedOfflineLiveProof(directory: FileManager.default.temporaryDirectory.resolvingSymlinksInPath().standardizedFileURL,
                                                                    reserveBytes: 128 * 1024 * 1024)
                            } else { await NativeDevicePlaybackCheck.run() }
                        }
                    }
                    #endif
                }
            }
        }
    }
}
