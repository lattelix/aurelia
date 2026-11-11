import { appHref } from "../../apps/web/src/lib/app-navigation";
import { test, expect } from "@playwright/test";
test("audio continues behind dialogs and switches to video at the current position", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const track = {
      id: "youtube:jfKfPfyJRdk",
      title: "Audio fixture",
      artist: "Fixture channel",
      artistId: "fixture",
      album: "YouTube",
      albumId: "youtube",
      duration: 72,
      artwork: "/art/afterglow.svg",
      provider: "youtube",
      externalId: "jfKfPfyJRdk",
      genre: "Music",
      year: 2026,
    };
    localStorage.setItem(
      "aurelia.player.guest",
      JSON.stringify({
        queue: [
          {
            ...track,
            id: "studio:afterglow-1",
            title: "Golden Hour",
            artist: "Aurelia Studio",
            artistId: "aurelia-studio",
            album: "Afterglow",
            albumId: "afterglow",
            duration: 72,
            provider: "studio",
            externalId: "1",
            genre: "Downtempo",
          },
          track,
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
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        location.origin,
      );
      if (
        url.pathname === "/api/stream" &&
        url.searchParams.get("id") === track.id
      )
        return Promise.resolve(
          new Response(
            JSON.stringify({
              kind: "audio",
              url: "/audio/1.mp3",
              bitrate: 128000,
              capabilities: {
                background: true,
                seek: true,
                mediaSession: true,
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
        );
      return original(input, init);
    };
    type VideoApi = {
      playVideo(): void;
      pauseVideo(): void;
      seekTo(n: number, allow: boolean): void;
      setVolume(n: number): void;
      getCurrentTime(): number;
      getDuration(): number;
      destroy(): void;
    };
    class FakePlayer implements VideoApi {
      position = 0;
      events: {
        onReady: (event: { target: VideoApi }) => void;
        onStateChange: (event: { data: number }) => void;
      };
      constructor(
        node: HTMLElement,
        options: { events: FakePlayer["events"] },
      ) {
        this.events = options.events;
        node.textContent = "Simulated YouTube video fixture";
        queueMicrotask(() => this.events.onReady({ target: this }));
      }
      playVideo() {
        document.body.dataset.youtubePlaying = "true";
        this.events.onStateChange({ data: 1 });
      }
      pauseVideo() {
        document.body.dataset.youtubePlaying = "false";
        this.events.onStateChange({ data: 2 });
      }
      seekTo(n: number) {
        this.position = n;
      }
      setVolume() {}
      getCurrentTime() {
        return this.position;
      }
      getDuration() {
        return 72;
      }
      destroy() {
        document.body.dataset.youtubePlaying = "false";
      }
    }
    window.YT = { Player: FakePlayer };
  });
  await page.goto(appHref("/"));
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expect
    .poll(async () =>
      Number(
        await page
          .getByRole("slider", { name: "Seek", exact: true })
          .inputValue(),
      ),
    )
    .toBeGreaterThan(0);
  if (await page.evaluate(() => "mediaSession" in navigator))
    await expect
      .poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title))
      .toBe("Golden Hour");
  await page.getByRole("button", { name: "Next track", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "YouTube video player" }),
  ).toHaveCount(0);
  if (await page.evaluate(() => "mediaSession" in navigator))
    await expect
      .poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title))
      .toBe("Audio fixture");
  const seek = page.getByRole("slider", { name: "Seek", exact: true });
  await expect
    .poll(async () => Number(await seek.inputValue()))
    .toBeGreaterThan(1);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const before = Number(await seek.inputValue());
  await expect
    .poll(async () => Number(await seek.inputValue()))
    .toBeGreaterThan(before + 0.5);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Watch video", exact: true }).click();
  await expect(page.getByText("Simulated YouTube video fixture")).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute(
    "data-youtube-playing",
    "true",
  );
  expect(Number(await seek.inputValue())).toBeGreaterThan(1);
  await page
    .getByRole("button", { name: "Back to audio", exact: true })
    .click();
  await expect(page.getByText("Simulated YouTube video fixture")).toHaveCount(
    0,
  );
  const resumed = Number(await seek.inputValue());
  await expect
    .poll(async () => Number(await seek.inputValue()))
    .toBeGreaterThan(resumed + 0.5);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hidden = Number(await seek.inputValue());
  await expect
    .poll(async () => Number(await seek.inputValue()))
    .toBeGreaterThan(hidden + 0.5);
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }).first(),
  ).toBeVisible();
});
