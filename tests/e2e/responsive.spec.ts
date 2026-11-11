import { appHref } from "../../apps/web/src/lib/app-navigation";
import { test, expect, type Locator, type Page } from "@playwright/test";
import type { Track } from "@aurelia/core";

test.use({ serviceWorkers: "block" });

const track: Track = {
  id: "youtube:aqz-KE-bpKQ",
  externalId: "aqz-KE-bpKQ",
  provider: "youtube",
  title:
    "A long recording title with several words and an extended live version",
  artist: "AnArtistNameWithoutSpacesToExerciseNarrowScreens",
  artistId: "responsive-fixture",
  album: "A long album name with more words than a narrow player can fit",
  albumId: "responsive-album",
  artwork: "/art/afterglow.svg",
  duration: 72,
  genre: "Music",
  year: 2026,
  sourceUrl: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
};
const playlistName = "LateNightSessionsWithoutSpacesForResponsiveRegression";
const viewports = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
];

async function fixtures(page: Page) {
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: {
        user: {
          id: "responsive-fixture",
          name: "Responsive QA",
          email: "responsive@example.test",
          identities: [],
        },
        library: {
          likes: [track],
          playlists: [
            {
              id: "responsive-playlist",
              name: playlistName,
              description: "Synthetic layout fixture",
              tracks: [track],
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          history: [],
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
        editorialPlaylists: [],
        capabilities: { youtube: true, youtubeAudio: true },
        recommendations: [],
      },
    }),
  );
  // No account mutations or external media services are used in geometry QA.
  await page.route("**/api/library/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/search?**", (route) =>
    route.fulfill({
      json: {
        tracks: [track],
        albums: [],
        artists: [],
        playlists: [],
        source: "youtube",
      },
    }),
  );
  await page.route("**/api/stream?**", (route) =>
    route.fulfill({
      json: {
        kind: "audio",
        url: "/audio/1.mp3",
        bitrate: 128000,
        capabilities: { background: true, seek: true, mediaSession: true },
      },
    }),
  );
  await page.route("**/api/lyrics?**", (route) =>
    route.fulfill({
      json: [
        {
          id: 1,
          trackName: track.title,
          artistName: track.artist,
          albumName: track.album,
          duration: 72,
          instrumental: false,
          plainLyrics: Array.from(
            { length: 40 },
            (_, i) => `Layout lyric line ${i + 1}`,
          ).join("\n"),
          syncedLyrics: Array.from(
            { length: 40 },
            (_, i) =>
              `[00:${String(i).padStart(2, "0")}.00]Layout lyric line ${i + 1}`,
          ).join("\n"),
        },
      ],
    }),
  );
}

async function open(page: Page, path: string) {
  await page.goto(appHref(path));
  await expect(
    page.getByRole("link", { name: "Your account", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open now playing", exact: true }),
  ).toBeVisible();
}

async function noPageOverflow(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            Math.max(
              document.documentElement.scrollWidth,
              document.body.scrollWidth,
            ) - document.documentElement.clientWidth,
        ),
      { message: "The page must fit without horizontal scrolling" },
    )
    .toBeLessThanOrEqual(1);
}

async function usable(
  control: Locator,
  { scroll = false, touch = false } = {},
) {
  if (scroll) {
    await control.scrollIntoViewIfNeeded();
    // A fixed player can cover an element that is already inside the viewport.
    // Center it to exercise reachability by scrolling rather than demand that
    // every page control be unobstructed at its initial scroll position.
    await control.evaluate((element) =>
      element.scrollIntoView({ block: "center", inline: "nearest" }),
    );
  }
  await expect(control).toBeVisible();
  await expect
    .poll(
      () =>
        control.evaluate(
          (element, minimum) => {
            const rect = element.getBoundingClientRect();
            const modal = element.closest("dialog:modal");
            const failures: string[] = [];
            if (rect.width < minimum || rect.height < minimum)
              failures.push("target too small");
            if (
              rect.left < -1 ||
              rect.right > innerWidth + 1 ||
              rect.top < -1 ||
              rect.bottom > innerHeight + 1
            )
              failures.push("outside viewport");
            for (
              let parent = element.parentElement;
              parent;
              parent = parent.parentElement
            ) {
              const style = getComputedStyle(parent);
              const bounds = parent.getBoundingClientRect();
              const left = bounds.left + parent.clientLeft;
              const top = bounds.top + parent.clientTop;
              if (
                /(auto|scroll|hidden|clip)/.test(style.overflowX) &&
                (rect.left < left - 1 ||
                  rect.right > left + parent.clientWidth + 1)
              )
                failures.push("horizontally clipped");
              if (
                /(auto|scroll|hidden|clip)/.test(style.overflowY) &&
                (rect.top < top - 1 ||
                  rect.bottom > top + parent.clientHeight + 1)
              )
                failures.push("vertically clipped");
              // A modal lives in the top layer: its own scroller can clip, but
              // ancestors outside that modal cannot. Keep viewport/hit tests.
              // https://drafts.csswg.org/css-position-4/#top-layer
              if (parent === modal) break;
            }
            const hit = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            );
            if (!hit || !element.contains(hit))
              failures.push("covered by another element");
            return failures;
          },
          touch ? 44 : 1,
        ),
      { message: `Control must be reachable: ${control}` },
    )
    .toEqual([]);
}

for (const viewport of viewports) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });
    test.beforeEach(async ({ page }) => fixtures(page));

    test("search and library stay within the screen with usable navigation and actions", async ({
      page,
      browserName,
    }) => {
      await open(page, "/search");
      const input = page.getByRole("textbox", {
        name: "Search music",
        exact: true,
      });
      await input.fill("recording");
      await expect(
        page.getByRole("heading", { name: track.title, exact: true }),
      ).toBeVisible();
      await noPageOverflow(page);
      await usable(input);
      await usable(page.getByRole("button", { name: "Search", exact: true }));
      await usable(
        page.getByRole("button", { name: "Clear search", exact: true }),
      );
      const play = page.getByRole("button", {
        name: `Play top result ${track.title}`,
        exact: true,
      });
      await usable(play, { scroll: true });
      await page
        .getByRole("button", { name: "Clear search", exact: true })
        .click();
      const library = page.locator(`a[href="${appHref("/library")}"]:visible`).first();
      await usable(library);
      await library.click();
      await expect(
        page.getByRole("heading", { name: "Your library", exact: true }),
      ).toBeVisible();
      await noPageOverflow(page);
      const create = page.getByRole("button", {
        name: "New playlist",
        exact: true,
      });
      await usable(create, { scroll: true });
      await usable(
        page
          .getByRole("main")
          .getByRole("link", { name: new RegExp(playlistName) }),
        { scroll: true },
      );
      await create.click();
      const dialog = page.getByRole("dialog", {
        name: "Create playlist",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await usable(dialog.getByLabel("Name", { exact: true }), {
        scroll: true,
      });
      await usable(
        dialog.getByRole("button", { name: "Create playlist", exact: true }),
        { scroll: true },
      );
      if (process.env.E2E_ARTIFACT_DIR && viewport.width === 320 && viewport.height === 568)
        await page.screenshot({ path: `${process.env.E2E_ARTIFACT_DIR}/create-playlist-320x568-${browserName}.png` });
      await dialog
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
      await page
        .getByRole("link", { name: /Your music lives somewhere else/ })
        .scrollIntoViewIfNeeded();
      await usable(
        page.getByRole("link", { name: /Your music lives somewhere else/ }),
      );
    });

    test("settings are accessible from navigation and every theme option fits", async ({
      page,
    }) => {
      await open(page, "/library");
      const settings = page
        .getByRole("banner")
        .getByRole("link", { name: "Settings", exact: true });
      await usable(settings);
      await settings.click();
      await expect(
        page.getByRole("heading", { name: "Settings", exact: true }),
      ).toBeVisible();
      await noPageOverflow(page);
      const appearance = page.getByRole("radiogroup", {
        name: "Appearance",
        exact: true,
      });
      await usable(appearance, { scroll: true });
      for (const name of ["System", "Light", "Dark"]) {
        const option = appearance.getByRole("radio", { name, exact: true });
        await usable(option);
        await option.click();
        await expect(option).toHaveAttribute("aria-checked", "true");
      }
      await usable(
        page.getByRole("switch", { name: "Autoplay", exact: true }),
        { scroll: true },
      );
      await noPageOverflow(page);
    });

    test("persistent and full players keep transport, seek, quality and close reachable", async ({
      page,
    }) => {
      await open(page, "/library");
      const footer = page.getByRole("contentinfo", {
        name: "Music player",
        exact: true,
      });
      await usable(
        footer.getByRole("button", { name: "Open now playing", exact: true }),
      );
      const miniPlay = footer
        .getByRole("button", { name: "Play", exact: true })
        .filter({ visible: true });
      const miniNext = footer
        .getByRole("button", { name: "Next track", exact: true })
        .filter({ visible: true });
      await usable(miniPlay, { touch: true });
      await usable(miniNext, { touch: true });
      const navigation = page.getByRole("navigation", {
        name: "Mobile navigation",
        exact: true,
      });
      if (await navigation.isVisible()) {
        const playerBounds = await footer.boundingBox();
        const navBounds = await navigation.boundingBox();
        expect(playerBounds!.y + playerBounds!.height).toBeLessThanOrEqual(
          navBounds!.y,
        );
      }
      await footer
        .getByRole("button", { name: "Open now playing", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Now playing",
        exact: true,
      });
      const close = dialog.getByRole("button", {
        name: "Close dialog",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect
        .poll(() =>
          dialog.evaluate(
            (element) => element.scrollWidth - element.clientWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
      await usable(close);
      const seek = dialog.getByRole("slider", { name: "Seek", exact: true });
      const play = dialog.getByRole("button", { name: "Play", exact: true });
      const landscape = viewport.width > viewport.height;
      // A landscape dialog may scroll; a portrait player must expose its primary transport immediately.
      await usable(seek, { scroll: landscape });
      await usable(play, { scroll: landscape, touch: true });
      await play.click();
      const pause = dialog.getByRole("button", { name: "Pause", exact: true });
      await usable(pause, { touch: true });
      await pause.click();
      await seek.fill("24");
      await expect
        .poll(async () => Number(await seek.inputValue()))
        .toBeGreaterThanOrEqual(24);
      for (const name of [
        "Previous track",
        "Next track",
        "Shuffle",
        "Repeat: off",
      ]) {
        await usable(dialog.getByRole("button", { name, exact: true }), {
          scroll: true,
        });
      }
      const quality = dialog.getByRole("combobox", {
        name: "Audio quality",
        exact: true,
      });
      await usable(quality, { scroll: true });
      await quality.selectOption("high");
      await expect(quality).toHaveValue("high");
      await usable(
        dialog.getByRole("button", { name: "Watch video", exact: true }),
        { scroll: true },
      );
      const lyricsButton = dialog.getByRole("button", {
        name: "Show lyrics",
        exact: true,
      });
      await usable(lyricsButton, { scroll: true });
      await lyricsButton.click();
      const lyrics = dialog.getByRole("region", {
        name: "Lyrics",
        exact: true,
      });
      const recording = lyrics.getByRole("button", {
        name: new RegExp(track.title),
      });
      await usable(recording, { scroll: true });
      await recording.click();
      await lyrics
        .getByText("Layout lyric line 40", { exact: true })
        .scrollIntoViewIfNeeded();
      await usable(close);
      await usable(dialog.getByRole("link", { name: /Up next/ }), {
        scroll: true,
      });
      await usable(close);
      await close.click();
      await expect(dialog).toHaveCount(0);
      await usable(
        footer
          .getByRole("button", { name: "Play", exact: true })
          .filter({ visible: true }),
        { touch: true },
      );
      await noPageOverflow(page);
    });
  });
}
