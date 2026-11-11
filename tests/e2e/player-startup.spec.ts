import { appHref } from "../../apps/web/src/lib/app-navigation";
import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });
const track = {
  id: "youtube:abcdefghijk", title: "Saved playback fixture", artist: "Fixture",
  artistId: "fixture", album: "YouTube", albumId: "youtube", duration: 72,
  artwork: "/art/afterglow.svg", provider: "youtube", externalId: "abcdefghijk",
  genre: "Music", year: 2026,
};
async function bootstrap(page: Page) {
  await page.route("**/api/bootstrap", (route) => route.fulfill({ json: {
    user: null, library: null, catalogue: [track], albums: [], artists: [],
    editorialPlaylists: [], recommendations: [], capabilities: { localAccounts: true },
  } }));
}

test("new listener has an empty player without automatically requesting a recording", async ({ page }) => {
  await bootstrap(page);
  const streamRequests: string[] = [];
  await page.route("**/api/stream?**", (route) => {
    streamRequests.push(route.request().url());
    return route.fulfill({ status: 503, json: { error: "No source should be requested" } });
  });
  await page.goto(appHref("/"));
  const player = page.getByRole("contentinfo", { name: "Music player" });
  await expect(player.getByText("Your next favorite awaits")).toBeVisible();
  await expect(player.getByRole("button", { name: "Play", exact: true }).first()).toBeDisabled();
  expect(streamRequests).toHaveLength(0);
});

test("saved playing queue remains paused and a late YouTube ready/playing event cannot start it", async ({ page }) => {
  await bootstrap(page);
  let streamRequests = 0;
  await page.route("**/api/stream?**", (route) => {
    streamRequests++;
    return route.fulfill({ json: {
      kind: "youtube", videoId: track.externalId,
      capabilities: { background: false, seek: true, mediaSession: false },
    } });
  });
  await page.addInitScript((savedTrack) => {
    localStorage.setItem("aurelia.player.guest", JSON.stringify({
      queue: [savedTrack], index: 0, position: 23, duration: 72, playing: true,
      shuffle: false, repeat: "all", volume: 0, autoplay: true,
    }));
    HTMLMediaElement.prototype.play = () => Promise.reject(new Error("Real audio disabled in startup fixture"));
    type Events = {
      onReady: (event: { target: FakePlayer }) => void;
      onStateChange: (event: { data: number }) => void;
    };
    class FakePlayer {
      position = 0;
      ready = () => this.options.events.onReady({ target: this });
      late = () => this.options.events.onStateChange({ data: 1 });
      constructor(node: HTMLElement, readonly options: { events: Events; playerVars?: Record<string, string | number> }) {
        node.textContent = "Deferred YouTube ready fixture";
        document.body.dataset.youtubeAutoplay = String(options.playerVars?.autoplay);
        document.addEventListener("fixture-youtube-ready", this.ready);
        document.addEventListener("fixture-youtube-late-playing", this.late);
      }
      cueVideoById({ startSeconds }: { videoId: string; startSeconds: number }) {
        this.position = startSeconds;
        document.body.dataset.youtubeCued = "true";
      }
      seekTo(position: number) { this.position = position; }
      setVolume() {}
      getCurrentTime() { return this.position; }
      getDuration() { return 72; }
      playVideo() {
        document.body.dataset.youtubePlayCalls = String(Number(document.body.dataset.youtubePlayCalls ?? 0) + 1);
        this.options.events.onStateChange({ data: 1 });
      }
      pauseVideo() { this.options.events.onStateChange({ data: 2 }); }
      destroy() {
        document.removeEventListener("fixture-youtube-ready", this.ready);
        document.removeEventListener("fixture-youtube-late-playing", this.late);
      }
    }
    window.YT = { Player: FakePlayer };
  }, track);
  await page.goto(appHref("/"));
  const player = page.getByRole("contentinfo", { name: "Music player" });
  await expect(player.getByText(track.title)).toBeVisible();
  await expect(player.getByRole("button", { name: "Play", exact: true }).first()).toBeVisible();
  await expect(player.getByRole("slider", { name: "Seek", exact: true })).toHaveValue("23");
  await expect(page.getByLabel("YouTube video player", { exact: true })).toHaveCount(0);
  expect(streamRequests).toBe(0);
  await player.getByRole("button", { name: "Play", exact: true }).first().click();
  await expect(page.getByText("Deferred YouTube ready fixture")).toBeVisible();
  await player.getByRole("button", { name: "Pause", exact: true }).first().click();
  await page.evaluate(() => {
    document.dispatchEvent(new Event("fixture-youtube-ready"));
    document.dispatchEvent(new Event("fixture-youtube-late-playing"));
  });
  await expect(player.getByRole("button", { name: "Play", exact: true }).first()).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-youtube-autoplay", "0");
  await expect(page.locator("body")).toHaveAttribute("data-youtube-cued", "true");
  expect(await page.locator("body").getAttribute("data-youtube-play-calls")).toBeNull();
  expect(streamRequests).toBe(1);
});
