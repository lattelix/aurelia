import { appHref } from "../../apps/web/src/lib/app-navigation";
import { test, expect } from "@playwright/test";

test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ context }) => {
  await context.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: {
        user: null,
        library: {
          likes: [],
          playlists: [],
          history: [],
          followedArtists: [],
          searches: [],
        },
        catalogue: [],
        albums: [],
        artists: [],
        editorialPlaylists: [],
        capabilities: {},
        recommendations: [],
      },
    }),
  );
});

test("theme follows the system and persists an explicit choice", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(appHref("/settings"));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(
    page.getByRole("radio", { name: "System", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("radio", { name: "Light", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(
    page.getByRole("radio", { name: "Light", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("radio", { name: "System", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("style and appearance persist as independent choices", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(appHref("/settings"));
  await page.getByRole("radio", { name: "Midnight", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-skin", "midnight");
  await expect(page.locator("html")).toHaveAttribute(
    "data-appearance",
    "system",
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("radio", { name: "Light", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-skin", "midnight");
  await page.getByRole("radio", { name: "Base", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(
    await page.evaluate(() => ({
      theme: localStorage.getItem("aurelia.theme"),
      skin: localStorage.getItem("aurelia.skin"),
    })),
  ).toEqual({ theme: "light", skin: null });
});

test("first paint applies persisted palette before any React chunk runs", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    localStorage.setItem("aurelia.theme", "light");
    localStorage.setItem("aurelia.skin", "rainbow");
  });
  await page.route("**/_next/static/**", (route) =>
    route.request().resourceType() === "script"
      ? route.abort()
      : route.continue(),
  );
  await page.goto(appHref("/settings"), { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-skin", "rainbow");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#f7f7ff",
  );
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--bg")
        .trim(),
    ),
  ).toBe("#f7f7ff");
});

test("a second tab synchronizes choices and clearing storage restores system/base", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(appHref("/settings"));
  await expect(
    page.getByRole("radio", { name: "System", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  const other = await context.newPage();
  await other.goto(appHref("/settings"));
  await other.getByRole("radio", { name: "Dark", exact: true }).click();
  await other.getByRole("radio", { name: "Rainbow", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-skin", "rainbow");
  await other.evaluate(() => localStorage.clear());
  await expect(page.locator("html")).toHaveAttribute(
    "data-appearance",
    "system",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-skin", "base");
  await other.close();
});

test("theme choices support radio keyboard navigation at phone width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(appHref("/settings"));
  const modes = page.getByRole("radiogroup", {
    name: "Appearance",
    exact: true,
  });
  await modes.getByRole("radio", { name: "System", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    modes.getByRole("radio", { name: "Light", exact: true }),
  ).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("End");
  await expect(
    modes.getByRole("radio", { name: "Dark", exact: true }),
  ).toBeFocused();
  const styles = page.getByRole("radiogroup", { name: "Style", exact: true });
  for (const [name, description] of [
    ["Base", "Clean neutrals. A red and pink accent."],
    ["Rainbow", "Color accents and soft gradients."],
    ["Midnight", "Warm neutrals. An amber accent."],
  ]) {
    const radio = styles.getByRole("radio", { name, exact: true });
    await expect(radio).toHaveAccessibleName(name);
    await expect(radio).toHaveAccessibleDescription(description);
  }
  await styles.getByRole("radio", { name: "Base", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(
    styles.getByRole("radio", { name: "Midnight", exact: true }),
  ).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-skin", "midnight");
  await page.keyboard.press("Home");
  await expect(
    styles.getByRole("radio", { name: "Base", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  for (const radio of await modes.getByRole("radio").all())
    // Allow subpixel bounding-box precision around the CSS 44px minimum.
    expect((await radio.boundingBox())?.height).toBeGreaterThanOrEqual(44 - 0.01);
});

test("device accessibility preferences apply live without changing selected skin", async ({
  page,
}) => {
  await page.goto(appHref("/settings"));
  await page.getByRole("radio", { name: "Rainbow", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce", contrast: "more" });
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  await expect(page.locator("html")).toHaveAttribute("data-contrast", "more");
  await expect(page.locator(".appearance-accessibility")).toContainText(
    "Reduced motion is on",
  );
  expect(
    await page
      .getByRole("radio", { name: "Rainbow", exact: true })
      .evaluate((element) => getComputedStyle(element).transitionDuration),
  ).toBe("0s");
  await page.emulateMedia({
    reducedMotion: "no-preference",
    contrast: "no-preference",
  });
  await expect(page.locator("html")).toHaveAttribute("data-motion", "full");
  await expect(page.locator("html")).toHaveAttribute(
    "data-contrast",
    "standard",
  );
  await expect(page.locator("html")).toHaveAttribute("data-skin", "rainbow");
  await expect(
    page
      .getByRole("list", { name: "Native material availability" })
      .locator('[data-available="false"]'),
  ).toHaveCount(3);
});

test("confirmed native events win over stale initial response without enabling an absent renderer", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    const listeners = new Set<(snapshot: unknown) => void>();
    const pending: ((snapshot: unknown) => void)[] = [];
    Reflect.set(window, "appearanceFixture", {
      emit: (snapshot: unknown) =>
        listeners.forEach((listener) => listener(snapshot)),
      initial: (snapshot: unknown) =>
        pending.splice(0).forEach((resolve) => resolve(snapshot)),
    });
    Reflect.set(window, "CapacitorCustomPlatform", { name: "ios" });
    Reflect.set(window, "Capacitor", {
      PluginHeaders: [
        {
          name: "AureliaAppearance",
          methods: [
            { name: "getAppearance", rtype: "promise" },
            { name: "addListener", rtype: "callback" },
            { name: "removeListener", rtype: "promise" },
          ],
        },
      ],
      nativeCallback(
        _plugin: string,
        method: string,
        _options: unknown,
        callback: (snapshot: unknown) => void,
      ) {
        if (method === "addListener") listeners.add(callback);
        document.documentElement.dataset.appearanceListener = "ready";
        return Promise.resolve("appearance-listener");
      },
      nativePromise(_plugin: string, method: string) {
        if (method === "getAppearance")
          return new Promise((resolve) => pending.push(resolve));
        return Promise.resolve();
      },
    });
  });
  await page.goto(appHref("/settings"));
  await expect(page.locator("html")).toHaveAttribute(
    "data-appearance-listener",
    "ready",
  );
  const snapshot = {
    platform: "ios",
    colorScheme: "light",
    contrast: "increased",
    reduceMotion: true,
    reduceTransparency: true,
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    safeAreaUnits: "points",
    capabilities: {
      osSupportsLiquidGlass: true,
      nativeGlassRendererAvailable: false,
      safeAreaInsets: false,
      accessibilityPreferences: true,
    },
  };
  await page.evaluate(
    (snapshot) => Reflect.get(window, "appearanceFixture").emit(snapshot),
    snapshot,
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  await expect(page.locator("html")).toHaveAttribute(
    "data-transparency",
    "reduced",
  );
  await page.evaluate(
    (snapshot) => Reflect.get(window, "appearanceFixture").initial(snapshot),
    {
      ...snapshot,
      colorScheme: "dark",
      reduceMotion: false,
      contrast: "standard",
    },
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(
    page
      .getByRole("list", { name: "Native material availability" })
      .locator('[data-available="false"]'),
  ).toHaveCount(3);
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
});
