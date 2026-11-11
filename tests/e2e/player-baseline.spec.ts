import { appHref } from "../../apps/web/src/lib/app-navigation";
import { expect, test, type Page } from "@playwright/test";
import type { Track } from "@aurelia/core";

test.use({ serviceWorkers: "block" });
const owner = "11111111-1111-4111-8111-111111111111";
const playlistId = "22222222-2222-4222-8222-222222222222";
const tracks: Track[] = ["Current", "Next", "Last"].map((name, index) => ({
  id: `youtube:abcdefghij${index}`,
  externalId: `abcdefghij${index}`,
  provider: "youtube",
  title: `${name} baseline fixture`,
  artist: "Fixture artist",
  artistId: "fixture",
  album: "Fixture album",
  albumId: "fixture",
  genre: "",
  duration: 72,
  year: 2026,
  artwork: "/art/afterglow.svg",
  sourceUrl: `https://www.youtube.com/watch?v=abcdefghij${index}`,
}));

async function fixture(page: Page) {
  const requests = { audio: 0, additions: 0 };
  let failAddition = true;
  let activeOwner = owner;
  await page.addInitScript(
    ({ owner, tracks }) => {
      localStorage.setItem(
        `aurelia.player.${owner}`,
        JSON.stringify({
          queue: [tracks[0], tracks[2]],
          index: 0,
          position: 23,
          duration: 72,
          playing: false,
          shuffle: false,
          repeat: "off",
          volume: 0,
          autoplay: false,
          mode: "audio",
          quality: "balanced",
        }),
      );
      localStorage.setItem(
        "aurelia.player.33333333-3333-4333-8333-333333333333",
        JSON.stringify({
          queue: [tracks[2]],
          index: 0,
          position: 11,
          duration: 72,
          playing: false,
          shuffle: false,
          repeat: "off",
          volume: 0,
          autoplay: false,
          mode: "audio",
          quality: "balanced",
        }),
      );
      HTMLMediaElement.prototype.play = () =>
        Promise.reject(new Error("No real audio in baseline fixture"));
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: () =>
            Promise.reject(new Error("Clipboard unavailable fixture")),
        },
      });
    },
    { owner, tracks },
  );
  await page.route("https://**/*", (route) => route.abort());
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/bootstrap")
      return route.fulfill({
        json: {
          user: {
            id: activeOwner,
            name: "Baseline fixture",
            email: null,
            identities: [],
          },
          library: {
            likes: tracks,
            playlists: [
              {
                id: playlistId,
                name: "Target playlist",
                description: "",
                tracks: [],
                createdAt: "2026-11-08T00:00:00.000Z",
              },
            ],
            history: [],
            followedArtists: [],
            searches: [],
            queue: null,
          },
          catalogue: [],
          albums: [],
          artists: [],
          editorialPlaylists: [],
          recommendations: [],
          capabilities: {
            localAccounts: true,
            youtube: true,
            demoCatalogue: false,
          },
        },
      });
    if (path === `/api/library/playlists/${playlistId}/tracks`) {
      requests.additions++;
      return failAddition
        ? route.fulfill({
            status: 503,
            json: { error: "Addition unavailable fixture" },
          })
        : route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/lyrics")
      return route.fulfill({
        json: [
          {
            id: 1,
            trackName: tracks[0].title,
            artistName: tracks[0].artist,
            albumName: "Fixture",
            duration: 72,
            instrumental: false,
            plainLyrics: "First line\nSecond line",
            syncedLyrics: "[00:10.00]First line\n[00:35.00]Second line",
          },
        ],
      });
    if (path === "/api/stream") {
      requests.audio++;
      return route.fulfill({
        status: 503,
        json: { error: "No source should be requested" },
      });
    }
    if (path === "/api/discovery")
      return route.fulfill({
        json: {
          source: "youtube-music",
          fetchedAt: "2026-11-08T00:00:00.000Z",
          sections: [],
        },
      });
    if (path === "/api/recommendations") return route.fulfill({ json: [] });
    return route.fulfill({ json: { ok: true } });
  });
  return {
    requests,
    allowAddition: () => {
      failAddition = false;
    },
    switchAccount: () => {
      activeOwner = "33333333-3333-4333-8333-333333333333";
    },
  };
}

test("play next and queue edits keep paused position, clear asks before stopping", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const { requests } = await fixture(page);
  await page.goto(appHref("/liked"));
  await page
    .getByRole("button", {
      name: `More options for ${tracks[1].title}`,
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Play next", exact: true }).click();
  await page
    .getByRole("button", { name: "Open now playing", exact: true })
    .click();
  await page.getByRole("link", { name: /Up next ·/ }).click();
  await expect(page.locator(".queue-row strong")).toHaveText(
    tracks.map((track) => track.title),
  );
  await page
    .getByRole("button", { name: `Move ${tracks[0].title} down`, exact: true })
    .click();
  await expect(page.locator(".queue-row strong")).toHaveText([
    tracks[1].title,
    tracks[0].title,
    tracks[2].title,
  ]);
  await page
    .getByRole("button", {
      name: `Remove ${tracks[1].title} from queue`,
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Clear upcoming", exact: true })
    .click();
  await expect(page.locator(".queue-row strong")).toHaveText([tracks[0].title]);
  const player = page.getByRole("contentinfo", { name: "Music player" });
  await expect(
    player.getByRole("button", { name: "Play", exact: true }).first(),
  ).toBeVisible();
  await player
    .getByRole("button", { name: "Open now playing", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByRole("slider", { name: "Seek", exact: true }),
  ).toHaveValue("23");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  expect(requests.audio).toBe(0);
  await page.getByRole("button", { name: "Clear queue", exact: true }).click();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page.locator(".queue-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear queue", exact: true }).click();
  await page
    .getByRole("button", { name: "Stop & clear queue", exact: true })
    .click();
  await expect(page.locator(".queue-row")).toHaveCount(0);
  await expect(page.getByText("Your next favorite awaits")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
});

test("failed add keeps dialog open; retry closes only after success and typing keeps focus", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(appHref("/liked"));
  await page
    .getByRole("button", {
      name: `More options for ${tracks[0].title}`,
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Add to playlist", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Add to a playlist",
    exact: true,
  });
  const name = dialog.getByLabel("Or create a new playlist");
  await name.pressSequentially("Focus stays here");
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Focus stays here");
  await dialog.getByRole("button", { name: /Target playlist/ }).click();
  await expect(dialog.getByRole("alert")).toContainText("Could not confirm");
  await expect(name).toHaveValue("Focus stays here");
  state.allowAddition();
  await dialog.getByRole("button", { name: /Target playlist/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: `More options for ${tracks[0].title}`,
      exact: true,
    }),
  ).toBeFocused();
  expect(state.requests.additions).toBe(2);
});

test("track menus stay bound to a song and queue confirmation expires on account switch", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(appHref("/liked"));
  await page
    .getByRole("button", {
      name: `More options for ${tracks[0].title}`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Play next", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Filter songs", exact: true })
    .fill(tracks[1].title);
  await expect(
    page.getByRole("button", { name: "Play next", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Open now playing", exact: true })
    .click();
  await page.getByRole("link", { name: /Up next ·/ }).click();
  await page.getByRole("button", { name: "Clear queue", exact: true }).click();
  state.switchAccount();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("dialog", { name: "Clear your queue?", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".queue-row strong")).toHaveText([tracks[2].title]);
});

test("share fallback exposes only canonical song link; timed lyrics seek stays paused", async ({
  page,
}) => {
  const { requests } = await fixture(page);
  await page.goto(appHref("/liked"));
  await page
    .getByRole("button", {
      name: `More options for ${tracks[0].title}`,
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Copy song link", exact: true })
    .click();
  const share = page.getByRole("dialog", { name: "Share song", exact: true });
  await expect(share.getByLabel("Song link")).toHaveValue(tracks[0].sourceUrl!);
  await share.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("button", { name: "Open now playing", exact: true })
    .click();
  await page.getByRole("button", { name: "Show lyrics", exact: true }).click();
  await page.locator(".lyrics-candidate").click();
  await page
    .getByRole("button", { name: "Seek to 0:35 — Second line", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByRole("slider", { name: "Seek", exact: true }),
  ).toHaveValue("35");
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Play", exact: true }),
  ).toBeVisible();
  expect(requests.audio).toBe(0);
});
