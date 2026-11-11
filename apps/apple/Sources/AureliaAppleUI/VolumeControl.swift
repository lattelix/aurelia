import SwiftUI
#if os(iOS)
import MediaPlayer
import UIKit
#endif

enum VolumeControlPolicy {
    static var systemVolumeSupported: Bool {
        #if os(iOS)
        true
        #else
        false
        #endif
    }

    /// Linked iOS playback leaves attenuation to the system's media output.
    /// The app's independent level remains session-only for a later unlink.
    static func playerGain(_ volume: Double, matchSystemVolume: Bool, forceMuted: Bool,
                           systemVolumeSupported: Bool = Self.systemVolumeSupported) -> Float {
        if forceMuted { return 0 }
        if systemVolumeSupported && matchSystemVolume { return 1 }
        return volume.isFinite ? Float(min(1, max(0, volume))) : 0
    }
}

struct NowPlayingVolumeControl: View {
    @ObservedObject var model: AureliaModel
    @Environment(\.aureliaPalette) private var theme

    var body: some View {
        VStack(spacing: 8) {
            #if os(iOS)
            if model.usesSystemVolume && !model.forceMuted {
                SystemVolumeControl(tint: theme.accent).frame(maxWidth: .infinity, minHeight: 44)
            } else {
                playerSlider
            }
            #else
            playerSlider
            #endif
            Text(caption).font(.caption).foregroundStyle(.secondary)
        }
    }

    private var playerSlider: some View {
        HStack(spacing: 12) {
            Image(systemName: "speaker.fill").foregroundStyle(.secondary)
            Slider(value: Binding(get: { model.volume }, set: { model.setVolume($0) }), in: 0...1)
                .disabled(model.forceMuted).accessibilityLabel("Player volume")
            Image(systemName: "speaker.wave.3.fill").foregroundStyle(.secondary)
        }
    }

    private var caption: String {
        if model.forceMuted { return "Silent QA · volume locked at 0" }
        if model.usesSystemVolume { return "System volume · also controlled by this device’s volume buttons." }
        return model.volume == 0 ? "Muted · raise volume to listen." : "Player volume · independent of system volume."
    }
}

#if os(iOS)
/// MPVolumeView owns its live value and writes only in response to a user gesture.
/// Mounts and preference changes never assign a system output level.
private struct SystemVolumeControl: UIViewRepresentable {
    var tint: Color

    func makeUIView(context: Context) -> MPVolumeView {
        let view = MPVolumeView(frame: .zero)
        view.showsRouteButton = false
        view.tintColor = UIColor(tint)
        view.accessibilityLabel = "System volume"
        return view
    }

    func updateUIView(_ view: MPVolumeView, context: Context) {
        view.tintColor = UIColor(tint)
    }
}
#endif
