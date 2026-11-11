export const THEME_CHOICES = ["system", "light", "dark"] as const;
export const THEME_SKINS = ["base", "rainbow", "midnight"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];
export type ThemeSkin = (typeof THEME_SKINS)[number];
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "aurelia.theme";
export const SKIN_STORAGE_KEY = "aurelia.skin";
export const SKIN_COLORS: Record<ThemeSkin, Record<ResolvedTheme, string>> = {
  base: { light: "#ffffff", dark: "#1f1f1f" },
  rainbow: { light: "#f7f7ff", dark: "#101116" },
  midnight: { light: "#f7f4ee", dark: "#111118" },
};
export const THEME_COLORS = SKIN_COLORS.base;
export interface ThemePreferences {
  theme: ThemeChoice;
  skin: ThemeSkin;
}
export interface AccessibilityPreferences {
  colorScheme: ResolvedTheme;
  reduceMotion: boolean;
  increaseContrast: boolean;
  reduceTransparency: boolean;
}
export interface NativeAppearance {
  platform: "ios";
  colorScheme: ResolvedTheme;
  contrast: "standard" | "increased";
  reduceMotion: boolean;
  reduceTransparency: boolean;
  capabilities: {
    osSupportsLiquidGlass: boolean;
    nativeGlassRendererAvailable: boolean;
  };
}
export interface ThemeSnapshot extends ThemePreferences {
  resolvedTheme: ResolvedTheme;
  reduceMotion: boolean;
  increaseContrast: boolean;
  reduceTransparency: boolean;
  nativeAppearance: NativeAppearance | null;
}
export const DEFAULT_PREFERENCES: ThemePreferences = {
  theme: "system",
  skin: "base",
};
export const DEFAULT_ACCESSIBILITY: AccessibilityPreferences = {
  colorScheme: "dark",
  reduceMotion: false,
  increaseContrast: false,
  reduceTransparency: false,
};
export const PREFERENCE_QUERIES = {
  light: "(prefers-color-scheme: light)",
  motion: "(prefers-reduced-motion: reduce)",
  contrast: "(prefers-contrast: more)",
  transparency: "(prefers-reduced-transparency: reduce)",
} as const;

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return THEME_CHOICES.some((choice) => choice === value);
}
export function isThemeSkin(value: unknown): value is ThemeSkin {
  return THEME_SKINS.some((skin) => skin === value);
}
export function readThemePreferences(
  storage: Pick<Storage, "getItem"> | null,
): ThemePreferences {
  const read = (key: string) => {
    try {
      return storage?.getItem(key);
    } catch {
      return null;
    }
  };
  const theme = read(THEME_STORAGE_KEY),
    skin = read(SKIN_STORAGE_KEY);
  return {
    theme: isThemeChoice(theme) ? theme : "system",
    skin: isThemeSkin(skin) ? skin : "base",
  };
}
export function parseNativeAppearance(value: unknown): NativeAppearance | null {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Record<string, unknown>;
  if (!snapshot.capabilities || typeof snapshot.capabilities !== "object")
    return null;
  const flags = snapshot.capabilities as Record<string, unknown>;
  if (
    snapshot.platform !== "ios" ||
    (snapshot.colorScheme !== "light" && snapshot.colorScheme !== "dark") ||
    (snapshot.contrast !== "standard" && snapshot.contrast !== "increased") ||
    typeof snapshot.reduceMotion !== "boolean" ||
    typeof snapshot.reduceTransparency !== "boolean" ||
    typeof flags.osSupportsLiquidGlass !== "boolean" ||
    typeof flags.nativeGlassRendererAvailable !== "boolean"
  )
    return null;
  return {
    platform: "ios",
    colorScheme: snapshot.colorScheme,
    contrast: snapshot.contrast,
    reduceMotion: snapshot.reduceMotion,
    reduceTransparency: snapshot.reduceTransparency,
    capabilities: {
      osSupportsLiquidGlass: flags.osSupportsLiquidGlass,
      nativeGlassRendererAvailable: flags.nativeGlassRendererAvailable,
    },
  };
}
export function resolveThemeSnapshot(
  preferences: ThemePreferences,
  browser: AccessibilityPreferences,
  nativeAppearance: NativeAppearance | null = null,
): ThemeSnapshot {
  return {
    ...preferences,
    resolvedTheme:
      preferences.theme === "system"
        ? (nativeAppearance?.colorScheme ?? browser.colorScheme)
        : preferences.theme,
    reduceMotion:
      browser.reduceMotion || Boolean(nativeAppearance?.reduceMotion),
    increaseContrast:
      browser.increaseContrast || nativeAppearance?.contrast === "increased",
    reduceTransparency:
      browser.reduceTransparency ||
      Boolean(nativeAppearance?.reduceTransparency),
    nativeAppearance,
  };
}
export interface NativeMaterialAvailability {
  id: "liquid-glass" | "material" | "fluent";
  label: string;
  available: boolean;
  reason: string;
}
/** OS support alone, a user agent, and a WebView are not native renderers. */
export function nativeMaterialAvailability(
  appearance: NativeAppearance | null,
): NativeMaterialAvailability[] {
  const glass = Boolean(
    appearance?.capabilities.osSupportsLiquidGlass &&
    appearance.capabilities.nativeGlassRendererAvailable,
  );
  return [
    {
      id: "liquid-glass",
      label: "Liquid Glass",
      available: glass,
      reason: glass
        ? "Supported by the native renderer."
        : "Not available in this app's current renderer.",
    },
    {
      id: "material",
      label: "Native Material",
      available: false,
      reason: "An Android native renderer is not connected.",
    },
    {
      id: "fluent",
      label: "Native Fluent",
      available: false,
      reason: "A Windows native renderer is not connected.",
    },
  ];
}
export function applyThemeSnapshot(
  document: Document,
  snapshot: ThemeSnapshot,
) {
  const root = document.documentElement;
  root.dataset.appearance = snapshot.theme;
  root.dataset.theme = snapshot.resolvedTheme;
  root.dataset.skin = snapshot.skin;
  root.dataset.motion = snapshot.reduceMotion ? "reduced" : "full";
  root.dataset.contrast = snapshot.increaseContrast ? "more" : "standard";
  root.dataset.transparency = snapshot.reduceTransparency ? "reduced" : "full";
  root.style.colorScheme = snapshot.resolvedTheme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute(
      "content",
      SKIN_COLORS[snapshot.skin][snapshot.resolvedTheme],
    );
}
/** Standalone JS avoids production function-name transforms. Storage failure must not prevent system preference application. */
export const themeInitScript = `(function(){
var read=function(key){try{return localStorage.getItem(key);}catch(e){return null;}};
var matches=function(query){try{return window.matchMedia(query).matches;}catch(e){return false;}};
var choice=read(${JSON.stringify(THEME_STORAGE_KEY)});
if(${JSON.stringify(THEME_CHOICES)}.indexOf(choice)===-1)choice="system";
var skin=read(${JSON.stringify(SKIN_STORAGE_KEY)});
if(${JSON.stringify(THEME_SKINS)}.indexOf(skin)===-1)skin="base";
var resolved=choice==="system"?(matches(${JSON.stringify(PREFERENCE_QUERIES.light)})?"light":"dark"):choice;
var root=document.documentElement;
root.dataset.appearance=choice;root.dataset.theme=resolved;root.dataset.skin=skin;
root.dataset.motion=matches(${JSON.stringify(PREFERENCE_QUERIES.motion)})?"reduced":"full";
root.dataset.contrast=matches(${JSON.stringify(PREFERENCE_QUERIES.contrast)})?"more":"standard";
root.dataset.transparency=matches(${JSON.stringify(PREFERENCE_QUERIES.transparency)})?"reduced":"full";
root.style.colorScheme=resolved;
var colors=${JSON.stringify(SKIN_COLORS)};
var meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.setAttribute("content",colors[skin][resolved]);
})();`;
