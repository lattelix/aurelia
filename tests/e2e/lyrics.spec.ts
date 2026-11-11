import { appHref } from "../../apps/web/src/lib/app-navigation";
import { test, expect } from "@playwright/test";
test.use({ serviceWorkers: "block" });
test("lyrics require choosing the recording, then highlight synchronized lines", async ({
  page,
}) => {
  await page.route("**/api/lyrics?**", (route) =>
    route.fulfill({
      json: [
        {
          id: 1,
          trackName: "Fixture song",
          artistName: "Fixture artist",
          albumName: "Fixture album",
          duration: 72,
          instrumental: false,
          plainLyrics: "First fixture line\nSecond fixture line",
          syncedLyrics:
            "[00:00.00]First fixture line\n[00:01.00]Second fixture line",
        },
      ],
    }),
  );
  await page.route("**/api/stream?**", (route) =>
    route.fulfill({
      json: {
        kind: "audio",
        url: "/audio/1.mp3",
        capabilities: { background: true, seek: true, mediaSession: true },
      },
    }),
  );
  await page.addInitScript(() => {
    localStorage.setItem(
      "aurelia.player.guest",
      JSON.stringify({
        queue: [
          {
            id: "youtube:aqz-KE-bpKQ",
            externalId: "aqz-KE-bpKQ",
            provider: "youtube",
            title: "Fixture song",
            artist: "Fixture artist",
            artistId: "fixture",
            album: "",
            albumId: "",
            duration: 72,
            artwork: "/art/afterglow.svg",
            genre: "",
            year: 0,
          },
        ],
        index: 0,
        position: 0,
        duration: 72,
        playing: false,
        shuffle: false,
        repeat: "off",
        volume: 0.75,
        autoplay: false,
      }),
    );
  });
  await page.goto(appHref("/"));
  await page
    .getByRole("button", { name: "Expand player", exact: true })
    .click();
  await page.getByRole("button", { name: "Show lyrics", exact: true }).click();
  const lyrics = page.getByRole("region", { name: "Lyrics", exact: true });
  await expect(
    lyrics.getByText("Choose the recording that matches this song."),
  ).toBeVisible();
  await lyrics
    .getByRole("button", { name: /Fixture song Fixture artist/ })
    .click();
  await expect(
    lyrics.getByText("First fixture line", { exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Play", exact: true })
    .click();
  await expect(
    lyrics.getByText("Second fixture line", { exact: true }),
  ).toHaveAttribute("aria-current", "true");
});
