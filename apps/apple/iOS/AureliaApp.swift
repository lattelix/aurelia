import SwiftUI
import AureliaAppleUI
import AureliaYouTubeNative

/// The explicit source check must not restore or mutate the real profile.
/// Normal scenes keep one shared model, including on multi-window iPad.
@MainActor private final class AureliaLaunchState: ObservableObject {
    let model: AureliaModel?
    let offlineProofRequested: Bool
    init() {
        let arguments = ProcessInfo.processInfo.arguments
        #if DEBUG
        // Malformed offline-proof arguments stay isolated too. The proof rejects
        // them before creating storage, a resolver or a player.
        offlineProofRequested = arguments.contains {
            $0.hasPrefix("--native-offline-proof") || $0.hasPrefix("--native-background-seconds")
        }
        if offlineProofRequested || (arguments.contains("--native-source-proof") && arguments.contains("--force-muted")) {
            model = nil
            return
        }
        #else
        offlineProofRequested = false
        #endif
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
                VStack(spacing: 16) {
                    Image(systemName: "waveform").font(.largeTitle)
                    Text(launch.offlineProofRequested ? "Native offline check" : "Native source check").font(.headline)
                    Text("Muted development check. Your library is unchanged.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .padding()
                .task {
                    #if DEBUG
                    if launch.offlineProofRequested {
                        _ = await runManagedOfflineLiveProof(directory: FileManager.default.temporaryDirectory.resolvingSymlinksInPath().standardizedFileURL,
                                                            reserveBytes: 128 * 1024 * 1024)
                    } else { await NativeDevicePlaybackCheck.run() }
                    #endif
                }
            }
        }
    }
}
