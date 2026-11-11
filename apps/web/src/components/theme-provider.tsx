"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";
import {
  applyThemeSnapshot,
  DEFAULT_ACCESSIBILITY,
  DEFAULT_PREFERENCES,
  isThemeChoice,
  isThemeSkin,
  parseNativeAppearance,
  PREFERENCE_QUERIES,
  readThemePreferences,
  resolveThemeSnapshot,
  SKIN_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type AccessibilityPreferences,
  type NativeAppearance,
  type ThemeChoice,
  type ThemeSkin,
  type ThemeSnapshot,
} from "./theme-contract";
export {
  SKIN_STORAGE_KEY,
  THEME_COLORS,
  THEME_STORAGE_KEY,
  themeInitScript,
  type ResolvedTheme,
  type ThemeChoice,
  type ThemeSkin,
} from "./theme-contract";

interface AppearanceBridge {
  getAppearance(): Promise<unknown>;
  addListener(
    event: "appearanceChange",
    listener: (snapshot: unknown) => void,
  ): Promise<PluginListenerHandle>;
}
const nativeBridge = registerPlugin<AppearanceBridge>("AureliaAppearance");
interface SystemBarsBridge {
  setColorScheme(options: { colorScheme: "light" | "dark" }): Promise<void>;
}
const systemBarsBridge = registerPlugin<SystemBarsBridge>("AureliaSystemBars");
const initialSnapshot = resolveThemeSnapshot(
  DEFAULT_PREFERENCES,
  DEFAULT_ACCESSIBILITY,
);
interface ThemeContextValue extends ThemeSnapshot {
  setTheme: (theme: ThemeChoice) => void;
  setSkin: (skin: ThemeSkin) => void;
}
const ThemeContext = createContext<ThemeContextValue | null>(null);

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
function media(query: string) {
  try {
    return window.matchMedia(query);
  } catch {
    return null;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // SSR stays deterministic. The blocking script applies persisted CSS before
  // paint; these refs own later storage, OS and confirmed native events.
  const preferences = useRef({ ...DEFAULT_PREFERENCES });
  const accessibility = useRef<AccessibilityPreferences>({
    ...DEFAULT_ACCESSIBILITY,
  });
  const nativeAppearance = useRef<NativeAppearance | null>(null);
  const [snapshot, setSnapshot] = useState<ThemeSnapshot>(initialSnapshot);
  const commit = useCallback(() => {
    const next = resolveThemeSnapshot(
      preferences.current,
      accessibility.current,
      nativeAppearance.current,
    );
    applyThemeSnapshot(document, next);
    setSnapshot(next);
    if (Capacitor.isPluginAvailable("AureliaSystemBars")) {
      try {
        void systemBarsBridge
          .setColorScheme({ colorScheme: next.resolvedTheme })
          .catch(() => {});
      } catch {
        /* Keep the selected app theme if this optional window bridge is unavailable. */
      }
    }
  }, []);

  useEffect(() => {
    const queries = {
      light: media(PREFERENCE_QUERIES.light),
      motion: media(PREFERENCE_QUERIES.motion),
      contrast: media(PREFERENCE_QUERIES.contrast),
      transparency: media(PREFERENCE_QUERIES.transparency),
    };
    const changed = () => {
      accessibility.current = {
        colorScheme: queries.light?.matches ? "light" : "dark",
        reduceMotion: queries.motion?.matches ?? false,
        increaseContrast: queries.contrast?.matches ?? false,
        reduceTransparency: queries.transparency?.matches ?? false,
      };
      commit();
    };
    preferences.current = readThemePreferences(storage());
    changed();
    const synchronizeStorage = (event: StorageEvent) => {
      if (
        event.key !== null &&
        event.key !== THEME_STORAGE_KEY &&
        event.key !== SKIN_STORAGE_KEY
      )
        return;
      const local = storage();
      if (event.storageArea && event.storageArea !== local) return;
      preferences.current = readThemePreferences(local);
      commit();
    };
    for (const query of Object.values(queries))
      query?.addEventListener("change", changed);
    window.addEventListener("storage", synchronizeStorage);
    return () => {
      for (const query of Object.values(queries))
        query?.removeEventListener("change", changed);
      window.removeEventListener("storage", synchronizeStorage);
    };
  }, [commit]);

  useEffect(() => {
    if (!Capacitor.isPluginAvailable("AureliaAppearance")) return;
    let active = true;
    let revision = 0;
    const initialRevision = revision;
    let listener: PluginListenerHandle | undefined;
    const accept = (value: unknown) => {
      if (!active) return;
      nativeAppearance.current = parseNativeAppearance(value);
      commit();
    };
    void nativeBridge
      .addListener("appearanceChange", (value) => {
        revision++;
        accept(value);
      })
      .then((handle) => {
        if (active) listener = handle;
        else void handle.remove().catch(() => {});
      })
      .catch(() => {});
    void nativeBridge
      .getAppearance()
      .then((value) => {
        if (revision === initialRevision) accept(value);
      })
      .catch(() => {});
    return () => {
      active = false;
      void listener?.remove().catch(() => {});
    };
  }, [commit]);

  const setTheme = useCallback(
    (value: ThemeChoice) => {
      const next = isThemeChoice(value) ? value : "system";
      preferences.current = { ...preferences.current, theme: next };
      try {
        if (next === "system") storage()?.removeItem(THEME_STORAGE_KEY);
        else storage()?.setItem(THEME_STORAGE_KEY, next);
      } catch {
        /* This tab still works when persistence is unavailable. */
      }
      commit();
    },
    [commit],
  );
  const setSkin = useCallback(
    (value: ThemeSkin) => {
      const next = isThemeSkin(value) ? value : "base";
      preferences.current = { ...preferences.current, skin: next };
      try {
        if (next === "base") storage()?.removeItem(SKIN_STORAGE_KEY);
        else storage()?.setItem(SKIN_STORAGE_KEY, next);
      } catch {
        /* This tab still works when persistence is unavailable. */
      }
      commit();
    },
    [commit],
  );
  const value = useMemo(
    () => ({ ...snapshot, setTheme, setSkin }),
    [snapshot, setTheme, setSkin],
  );
  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}
export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("ThemeProvider missing");
  return value;
}
