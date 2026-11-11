import { appHref } from "../../apps/web/src/lib/app-navigation";
import { expect, test, type Page } from "@playwright/test";
import type { Track } from "@aurelia/core";

// Browser geometry regressions only: these synthetic insets/visual viewports
// are not evidence of a physical keyboard, native renderer or device playback.
test.use({ serviceWorkers: "block" });

const track: Track = {
  id: "studio:afterglow-1",
  externalId: "1",
  provider: "studio",
  title: "A recording title long enough to exercise a narrow mini player",
  artist: "Aurelia Studio",
  artistId: "aurelia-studio",
  album: "Afterglow",
  albumId: "afterglow",
  artwork: "/art/afterglow.svg",
  duration: 72,
  genre: "Ambient",
  year: 2026,
};

async function fixtures(page: Page, guest = false) {
  const mixes = ["night-swim", "golden-hour", "deep-focus", "slow-sundays"].map(
    (id, index) => ({
      id,
      name: `Listening mix ${index + 1}`,
      description: "Synthetic mix for scrolling and dock geometry",
      artwork: track.artwork,
      tracks: [track],
    }),
  );
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: {
        user: guest
          ? null
          : {
              id: "dock-layout-fixture",
              name: "Dock QA",
              email: "dock@example.test",
              identities: [],
            },
        library: {
          likes: [track],
          playlists: [],
          history: [{ track, playedAt: "2026-10-20T12:00:00.000Z" }],
          followedArtists: [],
          searches: [],
          queue: {
            queue: [track],
            index: 0,
            position: 0,
            duration: 72,
            playing: false,
            shuffle: false,
            repeat: "off",
            volume: 0.75,
            autoplay: false,
            mode: "audio",
            quality: "balanced",
          },
        },
        catalogue: [track],
        albums: [],
        artists: [],
        editorialPlaylists: mixes,
        capabilities: { youtube: true, youtubeAudio: true },
        recommendations: [],
      },
    }),
  );
  await page.route("**/api/library/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/stream?**", (route) =>
    route.fulfill({
      json: {
        kind: "audio",
        url: "/audio/1.mp3",
        duration: 72,
        capabilities: { background: true, seek: true, mediaSession: true },
      },
    }),
  );
}

async function assertDock(page: Page, visibleBottom?: number) {
  const navigation = page.getByRole("navigation", {
    name: "Mobile navigation",
  });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("link")).toHaveCount(3);
  for (const name of ["Home", "Search", "Library"]) {
    const link = navigation.getByRole("link", { name, exact: true });
    await expect(link).toBeVisible();
    expect(
      await link.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return {
          width: rect.width,
          height: rect.height,
          reachable: !!hit && element.contains(hit),
        };
      }),
    ).toMatchObject({ reachable: true });
    const bounds = await link.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
  }
  const geometry = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    return {
      main: bounds("#main-content"),
      player: bounds(".player-bar"),
      nav: bounds(".mobile-nav"),
      dock: bounds(".playback-dock"),
      dockPosition: getComputedStyle(document.querySelector(".player-bar")!)
        .position,
      bodyWidth: document.body.scrollWidth,
      width: innerWidth,
      height: innerHeight,
    };
  });
  expect(geometry.player.height).toBeCloseTo(64, 0);
  expect(geometry.nav.height).toBeCloseTo(72, 0);
  expect(geometry.player.bottom).toBeLessThanOrEqual(geometry.nav.top);
  expect(geometry.main.bottom).toBeLessThanOrEqual(geometry.dock.top + 1);
  expect(geometry.dock.bottom).toBeLessThanOrEqual(
    (visibleBottom ?? geometry.height) + 1,
  );
  expect(geometry.dockPosition).not.toBe("fixed");
  expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.width + 1);
  return geometry;
}

test("navigation resets the main scroller after leaving a long settings page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixtures(page);
  await page.goto(appHref("/"));
  const main = page.getByRole("main");
  await main.evaluate((element) => {
    element.scrollTop = 400;
  });
  await expect
    .poll(() => main.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page.locator(".topbar-settings").click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => main.evaluate((element) => element.scrollTop))
    .toBe(0);
  await main.evaluate((element) => {
    element.scrollTop = 400;
  });
  await page
    .getByRole("navigation", { name: "Mobile navigation" })
    .getByRole("link", { name: "Home", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "For you", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => main.evaluate((element) => element.scrollTop))
    .toBe(0);
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  test.describe(`touch dock ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });
    test.beforeEach(async ({ page }) => fixtures(page));

    test("all three navigation targets remain reachable while main content scrolls", async ({
      page,
    }) => {
      await page.goto(appHref("/"));
      await expect(page.locator(".playing-text strong")).toHaveText(
        track.title,
      );
      const before = await assertDock(page);
      await page.locator("#main-content").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const after = await assertDock(page);
      expect(after.nav.top).toBeCloseTo(before.nav.top, 0);
      expect(after.dock.bottom).toBeCloseTo(before.dock.bottom, 0);
      await page
        .getByRole("navigation", { name: "Mobile navigation" })
        .getByRole("link", { name: "Library", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Your library", exact: true }),
      ).toBeVisible();
      await assertDock(page);
    });
  });
}

test.describe("native inset and IME geometry inputs", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  test.beforeEach(async ({ page }) => fixtures(page));

  test("Capacitor safe-area variables are consumed once for every skin", async ({
    page,
  }) => {
    await page.goto(appHref("/"));
    await expect(page.locator(".playing-text strong")).toHaveText(track.title);
    for (const [skin, mode] of [
      ["base", "dark"],
      ["rainbow", "light"],
      ["midnight", "dark"],
    ]) {
      await page.evaluate(
        ({ skin, mode }) => {
          const root = document.documentElement;
          root.dataset.skin = skin;
          root.dataset.theme = mode;
          root.style.setProperty("--safe-area-inset-left", "18px");
          root.style.setProperty("--safe-area-inset-right", "26px");
          root.style.setProperty("--safe-area-inset-bottom", "34px");
          root.style.setProperty("--safe-area-inset-top", "24px");
        },
        { skin, mode },
      );
      const geometry = await assertDock(page);
      expect(geometry.dock.bottom - geometry.nav.bottom).toBeCloseTo(34, 0);
      expect(
        await page.locator(".playback-dock").evaluate((element) => {
          const style = getComputedStyle(element);
          return [style.paddingLeft, style.paddingRight, style.paddingBottom];
        }),
      ).toEqual(["18px", "26px", "34px"]);
    }
  });

  test("a shortened visual viewport keeps navigation and the dialog close control inside its bounds", async ({
    page,
  }) => {
    await page.goto(appHref("/"));
    await expect(page.locator(".playing-text strong")).toHaveText(track.title);
    await page.evaluate(() => {
      const viewport = window.visualViewport!;
      Object.defineProperties(viewport, {
        height: { configurable: true, value: 360 },
        offsetTop: { configurable: true, value: 40 },
      });
      viewport.dispatchEvent(new Event("resize"));
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--app-height"),
        ),
      )
      .toBe("360px");
    await assertDock(page, 400);
    await page
      .getByRole("button", { name: "Open now playing", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Now playing",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(39);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(401);
    const close = dialog.getByRole("button", {
      name: "Close dialog",
      exact: true,
    });
    const closeBounds = await close.boundingBox();
    expect(closeBounds!.y).toBeGreaterThanOrEqual(40);
    expect(closeBounds!.y + closeBounds!.height).toBeLessThanOrEqual(400);
    await close.click();
    await expect(dialog).toHaveCount(0);
  });

  test("a 150px visual viewport keeps compact playback and navigation inside its safe area", async ({
    page,
  }) => {
    await page.goto(appHref("/"));
    await expect(page.locator(".playing-text strong")).toHaveText(track.title);
    for (const height of [150, 100]) {
      await page.evaluate((height) => {
        const root = document.documentElement;
        root.style.setProperty("--safe-area-inset-left", "18px");
        root.style.setProperty("--safe-area-inset-right", "26px");
        root.style.setProperty("--safe-area-inset-bottom", "34px");
        const viewport = window.visualViewport!;
        Object.defineProperties(viewport, {
          height: { configurable: true, value: height },
          offsetTop: { configurable: true, value: 40 },
        });
        viewport.dispatchEvent(new Event("resize"));
      }, height);
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.documentElement.style.getPropertyValue("--app-height"),
          ),
        )
        .toBe(`${height}px`);
      const bounds = await page.locator(".playback-dock").boundingBox();
      expect(bounds!.y).toBeGreaterThanOrEqual(40);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height + 40);
      const navigation = page.getByRole("navigation", {
        name: "Mobile navigation",
      });
      for (const name of ["Home", "Search", "Library"]) {
        const target = navigation.getByRole("link", { name, exact: true });
        await expect(target).toBeVisible();
        const targetBounds = await target.boundingBox();
        expect(targetBounds!.width).toBeGreaterThanOrEqual(44);
        expect(targetBounds!.height).toBeGreaterThanOrEqual(44);
        expect(targetBounds!.y + targetBounds!.height).toBeLessThanOrEqual(
          height + 40 - 34,
        );
        expect(
          await target.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            );
            return !!hit && element.contains(hit);
          }),
        ).toBe(true);
      }
      const play = page.locator(".mobile-play-button");
      await expect(play).toBeVisible();
      const playBounds = await play.boundingBox();
      expect(playBounds!.width).toBeGreaterThanOrEqual(44);
      expect(playBounds!.height).toBeGreaterThanOrEqual(44);
      expect(playBounds!.y + playBounds!.height).toBeLessThanOrEqual(
        height + 40 - 34,
      );
      expect(
        await page.locator(".player-bar").evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return rect.height;
        }),
      ).toBe(52);
    }
  });

  test("the provider-level sign-in dialog also fits a shortened visual viewport", async ({
    page,
  }) => {
    await page.unroute("**/api/bootstrap");
    await fixtures(page, true);
    await page.goto(appHref("/"));
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.evaluate(() => {
      const viewport = window.visualViewport!;
      Object.defineProperties(viewport, {
        height: { configurable: true, value: 320 },
        offsetTop: { configurable: true, value: 40 },
      });
      viewport.dispatchEvent(new Event("resize"));
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--app-height"),
        ),
      )
      .toBe("320px");
    const bounds = await dialog.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(40);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(360);
    await dialog
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
  });
});
