import SwiftUI
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

public enum ThemePalette: String, Codable, CaseIterable, Sendable {
    case base, rainbow, midnight
    public var title: String { rawValue.capitalized }
}

/// Base uses native semantic surfaces and an Apple Music-inspired red, adjusted
/// for readable text in each appearance. These are not private Music app tokens.
struct ApplePalette: Equatable {
    let palette: ThemePalette
    let dark: Bool
    var increasedContrast = false
    var accentRGB: (Double, Double, Double) {
        switch (palette, dark) {
        case (.base, false): (214.0 / 255, 0, 23.0 / 255)
        case (.base, true): (250.0 / 255, 88.0 / 255, 106.0 / 255)
        case (.rainbow, false): (0.48, 0.17, 0.72)
        case (.rainbow, true): (0.82, 0.63, 1.0)
        case (.midnight, false): (0.10, 0.30, 0.70)
        case (.midnight, true): (0.48, 0.72, 1.0)
        }
    }
    @MainActor var backgroundRGB: (Double, Double, Double) {
        switch (palette, dark) {
        case (.base, _): nativeSurfaceRGB(card: false)
        case (.rainbow, false): (0.97, 0.95, 0.99)
        case (.rainbow, true): (0.075, 0.045, 0.105)
        case (.midnight, false): (0.94, 0.96, 0.99)
        case (.midnight, true): (0.025, 0.05, 0.095)
        }
    }
    @MainActor var cardRGB: (Double, Double, Double) {
        switch (palette, dark) {
        case (.base, _): nativeSurfaceRGB(card: true)
        case (.rainbow, false): (1, 0.99, 1)
        case (.rainbow, true): (0.13, 0.08, 0.17)
        case (.midnight, false): (1, 1, 1)
        case (.midnight, true): (0.06, 0.10, 0.17)
        }
    }
    var accent: Color { color(accentRGB) }
    @MainActor var background: Color { color(backgroundRGB) }
    @MainActor var card: Color { color(cardRGB) }
    private func color(_ rgb: (Double, Double, Double)) -> Color { Color(red: rgb.0, green: rgb.1, blue: rgb.2) }
    @MainActor private func nativeSurfaceRGB(card: Bool) -> (Double, Double, Double) {
        // Resolve the chosen in-app appearance explicitly, including increased
        // contrast, rather than borrowing another window's current appearance.
        #if os(iOS)
        let traits = UITraitCollection { traits in
            traits.userInterfaceStyle = dark ? .dark : .light
            traits.accessibilityContrast = increasedContrast ? .high : .normal
        }
        let native = card ? UIColor.secondarySystemBackground : UIColor.systemBackground
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        if native.resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha) {
            return (Double(red), Double(green), Double(blue))
        }
        #elseif os(macOS)
        let name: NSAppearance.Name = dark
            ? (increasedContrast ? .accessibilityHighContrastDarkAqua : .darkAqua)
            : (increasedContrast ? .accessibilityHighContrastAqua : .aqua)
        // Music lists use a content surface. Window chrome can be substantially
        // lighter in dark Aqua and is reserved for the native window itself.
        let native = card ? NSColor.controlBackgroundColor : NSColor.textBackgroundColor
        var rgb: (Double, Double, Double)?
        NSAppearance(named: name)?.performAsCurrentDrawingAppearance {
            if let resolved = native.usingColorSpace(.sRGB) {
                rgb = (Double(resolved.redComponent), Double(resolved.greenComponent), Double(resolved.blueComponent))
            }
        }
        if let rgb { return rgb }
        #endif
        return dark ? (0, 0, 0) : (1, 1, 1)
    }
    static func contrast(_ a: (Double, Double, Double), _ b: (Double, Double, Double)) -> Double {
        func luminance(_ rgb: (Double, Double, Double)) -> Double {
            func linear(_ value: Double) -> Double { value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4) }
            return 0.2126 * linear(rgb.0) + 0.7152 * linear(rgb.1) + 0.0722 * linear(rgb.2)
        }
        let left = luminance(a), right = luminance(b)
        return (max(left, right) + 0.05) / (min(left, right) + 0.05)
    }
}

private struct ApplePaletteKey: EnvironmentKey {
    static let defaultValue = ApplePalette(palette: .base, dark: false)
}
extension EnvironmentValues {
    var aureliaPalette: ApplePalette {
        get { self[ApplePaletteKey.self] }
        set { self[ApplePaletteKey.self] = newValue }
    }
}
