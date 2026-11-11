import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  applyThemeSnapshot,
  DEFAULT_ACCESSIBILITY,
  DEFAULT_PREFERENCES,
  nativeMaterialAvailability,
  parseNativeAppearance,
  PREFERENCE_QUERIES,
  readThemePreferences,
  resolveThemeSnapshot,
  SKIN_COLORS,
  SKIN_STORAGE_KEY,
  THEME_SKINS,
  THEME_STORAGE_KEY,
  themeInitScript,
  type AccessibilityPreferences,
  type ResolvedTheme,
  type ThemeSkin,
} from "../apps/web/src/components/theme-contract";

function fakeDocument() {
  const root = {
    dataset: {} as Record<string, string>,
    style: { colorScheme: "" },
  };
  const meta = {
    content: "",
    setAttribute: (_: string, value: string) => {
      meta.content = value;
    },
  };
  return {
    document: {
      documentElement: root,
      querySelector: () => meta,
    } as unknown as Document,
    root,
    meta,
  };
}

function runFirstPaint({
  stored = {},
  system = DEFAULT_ACCESSIBILITY,
  storageBlocked = false,
  mediaMissing = false,
}: {
  stored?: Record<string, string>;
  system?: AccessibilityPreferences;
  storageBlocked?: boolean;
  mediaMissing?: boolean;
} = {}) {
  const dom = fakeDocument();
  const matches: Record<string, boolean> = {
    [PREFERENCE_QUERIES.light]: system.colorScheme === "light",
    [PREFERENCE_QUERIES.motion]: system.reduceMotion,
    [PREFERENCE_QUERIES.contrast]: system.increaseContrast,
    [PREFERENCE_QUERIES.transparency]: system.reduceTransparency,
  };
  const sandbox = {
    document: dom.document,
    window: mediaMissing
      ? {}
      : {
          matchMedia: (query: string) => ({ matches: matches[query] ?? false }),
        },
    get localStorage() {
      if (storageBlocked) throw new Error("Storage is blocked");
      return { getItem: (key: string) => stored[key] ?? null };
    },
  };
  runInNewContext(themeInitScript, sandbox, { timeout: 100 });
  return dom;
}

const nativeSnapshot = {
  platform: "ios",
  colorScheme: "light",
  contrast: "standard",
  reduceMotion: false,
  reduceTransparency: false,
  capabilities: {
    osSupportsLiquidGlass: true,
    nativeGlassRendererAvailable: false,
    nativeGlassReason: "native-renderer-not-implemented",
  },
  safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 },
};

describe("theme preferences and first paint", () => {
  it("preserves the old appearance key and defaults a missing skin independently", () => {
    expect(
      readThemePreferences({
        getItem: (key) => (key === THEME_STORAGE_KEY ? "light" : null),
      }),
    ).toEqual({ theme: "light", skin: "base" });
    expect(
      readThemePreferences({
        getItem: (key) => (key === SKIN_STORAGE_KEY ? "midnight" : null),
      }),
    ).toEqual({ theme: "system", skin: "midnight" });
  });

  it("rejects invalid persisted values and isolates failures between storage keys", () => {
    expect(readThemePreferences({ getItem: () => "__proto__" })).toEqual(
      DEFAULT_PREFERENCES,
    );
    expect(readThemePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(
      readThemePreferences({
        getItem: (key) => {
          if (key === THEME_STORAGE_KEY) throw new Error("Blocked key");
          return "rainbow";
        },
      }),
    ).toEqual({ theme: "system", skin: "rainbow" });
  });

  it("applies system light and base before React with no persisted preference", () => {
    const { root, meta } = runFirstPaint({
      system: { ...DEFAULT_ACCESSIBILITY, colorScheme: "light" },
    });
    expect(root.dataset).toMatchObject({
      appearance: "system",
      theme: "light",
      skin: "base",
    });
    expect(root.style.colorScheme).toBe("light");
    expect(meta.content).toBe(SKIN_COLORS.base.light);
  });

  for (const skin of THEME_SKINS) {
    for (const theme of ["light", "dark"] as const) {
      it(`keeps the first paint and hydrated contract coherent for ${skin}/${theme}`, () => {
        const stored = { [THEME_STORAGE_KEY]: theme, [SKIN_STORAGE_KEY]: skin };
        const system = {
          ...DEFAULT_ACCESSIBILITY,
          colorScheme:
            theme === "light" ? ("dark" as const) : ("light" as const),
        };
        const first = runFirstPaint({ stored, system });
        const hydrated = fakeDocument();
        applyThemeSnapshot(
          hydrated.document,
          resolveThemeSnapshot({ theme, skin }, system),
        );
        expect(first.root.dataset).toEqual(hydrated.root.dataset);
        expect(first.root.style).toEqual(hydrated.root.style);
        expect(first.meta.content).toBe(hydrated.meta.content);
      });
    }
  }

  it("keeps accessibility and OS preferences when even reading storage throws", () => {
    const { root } = runFirstPaint({
      storageBlocked: true,
      system: {
        colorScheme: "light",
        reduceMotion: true,
        increaseContrast: true,
        reduceTransparency: true,
      },
    });
    expect(root.dataset).toEqual({
      appearance: "system",
      theme: "light",
      skin: "base",
      motion: "reduced",
      contrast: "more",
      transparency: "reduced",
    });
  });

  it("fails safely when matchMedia is absent and treats stored code as untrusted data", () => {
    const { root } = runFirstPaint({
      mediaMissing: true,
      stored: {
        [THEME_STORAGE_KEY]: 'dark";throw new Error("injected")//',
        [SKIN_STORAGE_KEY]: "constructor",
      },
    });
    expect(root.dataset).toMatchObject({
      appearance: "system",
      theme: "dark",
      skin: "base",
    });
  });
});

describe("native appearance capability boundary", () => {
  it("accepts the registered plugin's schema and excludes unrelated native fields", () => {
    const parsed = parseNativeAppearance(nativeSnapshot);
    expect(parsed?.colorScheme).toBe("light");
    expect(parsed).not.toHaveProperty("safeAreaInsets");
    expect(parsed?.capabilities).not.toHaveProperty("nativeGlassReason");
  });

  it("does not enable Liquid Glass from OS support without a renderer", () => {
    const materials = nativeMaterialAvailability(
      parseNativeAppearance(nativeSnapshot),
    );
    expect(materials.every((material) => material.available === false)).toBe(
      true,
    );
    expect(materials[0].reason).toContain("current renderer");
    expect(
      nativeMaterialAvailability(null).every((material) => !material.available),
    ).toBe(true);
  });

  it("requires both OS support and an actual registered native renderer", () => {
    const available = parseNativeAppearance({
      ...nativeSnapshot,
      capabilities: {
        osSupportsLiquidGlass: true,
        nativeGlassRendererAvailable: true,
      },
    });
    expect(nativeMaterialAvailability(available)[0].available).toBe(true);
    const unsupported = parseNativeAppearance({
      ...nativeSnapshot,
      capabilities: {
        osSupportsLiquidGlass: false,
        nativeGlassRendererAvailable: true,
      },
    });
    expect(nativeMaterialAvailability(unsupported)[0].available).toBe(false);
  });

  it.each([
    null,
    { userAgent: "iPhone iOS 26", platform: "ios" },
    { ...nativeSnapshot, platform: "web" },
    { ...nativeSnapshot, reduceMotion: "false" },
    { ...nativeSnapshot, colorScheme: "system" },
    {
      ...nativeSnapshot,
      capabilities: {
        osSupportsLiquidGlass: true,
        nativeGlassRendererAvailable: "true",
      },
    },
  ])("rejects malformed or inferred capabilities: %j", (snapshot) => {
    expect(parseNativeAppearance(snapshot)).toBeNull();
  });

  it("follows native system color while keeping explicit mode and accessibility independent", () => {
    const native = parseNativeAppearance({
      ...nativeSnapshot,
      contrast: "increased",
      reduceTransparency: true,
    });
    const browser = { ...DEFAULT_ACCESSIBILITY, reduceMotion: true };
    const system = resolveThemeSnapshot(
      { theme: "system", skin: "rainbow" },
      browser,
      native,
    );
    expect(system).toMatchObject({
      resolvedTheme: "light",
      skin: "rainbow",
      reduceMotion: true,
      increaseContrast: true,
      reduceTransparency: true,
    });
    expect(
      resolveThemeSnapshot(
        { theme: "dark", skin: "midnight" },
        browser,
        native,
      ),
    ).toMatchObject({
      resolvedTheme: "dark",
      skin: "midnight",
      reduceMotion: true,
      increaseContrast: true,
    });
  });
});

// Read the shipped CSS, including its cascade, rather than duplicating palette values.
const stylesheet = readFileSync(
  new URL("../apps/web/src/components/theme-presets.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");
function palette(
  skin: ThemeSkin,
  theme: ResolvedTheme,
  increasedContrast = false,
) {
  const selectors = new Set([
    ":root",
    theme === "light" ? ':root[data-theme="light"]' : "",
    `:root[data-skin="${skin}"][data-theme="${theme}"]`,
    `:root[data-skin="${skin}"]`,
    ...(increasedContrast
      ? [
          ':root[data-contrast="more"]',
          `:root[data-contrast="more"][data-theme="${theme}"]`,
        ]
      : []),
  ]);
  const tokens: Record<string, string> = {};
  for (const [, selector, body] of stylesheet.matchAll(
    /([^{}]+)\{([^{}]*)\}/g,
  )) {
    if (!selectors.has(selector.trim())) continue;
    for (const [, token, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
      tokens[token] = value.trim();
  }
  return tokens;
}
function luminance(hex: string) {
  expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
  const rgb = hex
    .slice(1)
    .match(/../g)!
    .map((channel) => {
      const value = parseInt(channel, 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const light = luminance(a),
    dark = luminance(b);
  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
}

describe("shipped semantic palette contrast", () => {
  for (const skin of THEME_SKINS)
    for (const theme of ["light", "dark"] as const) {
      it(`${skin}/${theme} keeps body, secondary, status and accent text readable`, () => {
        const tokens = palette(skin, theme);
        expect(tokens["--bg"]).toBe(SKIN_COLORS[skin][theme]);
        const backgrounds = [
          "--bg",
          "--panel",
          "--field",
          "--surface",
          "--raised",
          "--surface-hover",
        ];
        const texts = [
          "--text",
          "--muted",
          "--muted-strong",
          "--muted-faint",
          "--accent",
          "--accent-strong",
          "--danger-text",
          "--success",
        ];
        for (const text of texts)
          for (const background of backgrounds) {
            expect(
              contrast(tokens[text], tokens[background]),
              `${skin}/${theme} ${text} on ${background}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        for (const [foreground, background] of [
          ["--on-emphasis", "--accent"],
          ["--on-danger", "--danger"],
          ["--toast-text", "--toast-bg"],
          ["--warning-text", "--warning-bg"],
        ]) {
          expect(
            contrast(tokens[foreground], tokens[background]),
            `${skin}/${theme} ${foreground}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
        for (const background of ["--field", "--raised"]) {
          expect(
            contrast(tokens["--control-border"], tokens[background]),
            `${skin}/${theme} control border`,
          ).toBeGreaterThanOrEqual(3);
        }
      });

      it(`${skin}/${theme} increases secondary-text contrast without changing geometry`, () => {
        const normal = palette(skin, theme),
          increased = palette(skin, theme, true);
        for (const token of [
          "--muted",
          "--muted-strong",
          "--muted-faint",
          "--control-border",
        ]) {
          expect(
            contrast(increased[token], increased["--surface-hover"]),
          ).toBeGreaterThan(contrast(normal[token], normal["--surface-hover"]));
        }
        expect(increased["--card-radius"]).toBe(normal["--card-radius"]);
        expect(increased["--density-scale"]).toBe(normal["--density-scale"]);
      });
    }
});
