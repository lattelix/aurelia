import { appHref } from "../../apps/web/src/lib/app-navigation";
import { expect, test, type Page } from "@playwright/test";
// Synthetic stream routing must remain in the test context, including WebKit.
test.use({ serviceWorkers: "block" });

async function prepareMockedFallback(page: Page) {
  await page.route("**/api/stream?**", (route) => route.fulfill({
    json: {
      kind: "youtube", videoId: "jfKfPfyJRdk", notice: "Synthetic video fallback",
      capabilities: { background: false, seek: true, mediaSession: false },
    },
  }));
  await page.addInitScript(() => {
    const track = {
      id: "youtube:jfKfPfyJRdk", title: "Responsive video fixture", artist: "Fixture",
      artistId: "fixture", album: "YouTube", albumId: "youtube", duration: 72,
      artwork: "/art/afterglow.svg", provider: "youtube", externalId: "jfKfPfyJRdk",
      genre: "Music", year: 2026,
    };
    localStorage.setItem("aurelia.player.guest", JSON.stringify({
      queue: [track], index: 0, position: 0, duration: 72, playing: false,
      shuffle: false, repeat: "off", volume: 0, autoplay: false,
    }));
    HTMLMediaElement.prototype.play = function () {
      document.body.dataset.realMediaAttempts = String(Number(document.body.dataset.realMediaAttempts ?? 0) + 1);
      return Promise.reject(new Error("Real media is disabled in the video layout fixture"));
    };
    type Events = {
      onReady: (event: { target: FakePlayer }) => void;
      onStateChange: (event: { data: number }) => void;
    };
    class FakePlayer {
      position = 0;
      frame: HTMLIFrameElement;
      constructor(node: HTMLElement, readonly options: { events: Events }) {
        this.frame = document.createElement("iframe");
        this.frame.title = "Simulated YouTube viewport";
        this.frame.srcdoc = '<body style="margin:0;background:#101318;color:white;display:grid;place-content:center;height:100vh;font:14px sans-serif">YouTube video fixture</body>';
        node.replaceWith(this.frame);
        queueMicrotask(() => options.events.onReady({ target: this }));
      }
      playVideo() {
        document.body.dataset.youtubePlaying = "true";
        this.options.events.onStateChange({ data: 1 });
      }
      pauseVideo() {
        document.body.dataset.youtubePlaying = "false";
        this.options.events.onStateChange({ data: 2 });
      }
      seekTo(position: number) { this.position = position; }
      setVolume() {}
      getCurrentTime() { return this.position; }
      getDuration() { return 72; }
      destroy() { this.frame.remove(); document.body.dataset.youtubePlaying = "false"; }
    }
    window.YT = { Player: FakePlayer };
  });
}

for (const viewport of [
  { label: "desktop", width: 1440, height: 900 },
  { label: "phone portrait", width: 390, height: 844 },
  { label: "small phone", width: 320, height: 568 },
  { label: "phone landscape", width: 844, height: 390 },
]) {
  test(`video fallback is a bounded card without an extra dock row on ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await prepareMockedFallback(page);
    await page.goto(appHref("/"));
    const dock = page.locator(".playback-dock");
    await expect(page.getByRole("button", { name: "Play", exact: true }).first()).toBeVisible();
    const before = await dock.boundingBox();
    await page.getByRole("button", { name: "Play", exact: true }).first().click();
    const card = page.getByRole("complementary", { name: "YouTube video player" });
    const frame = page.getByTitle("Simulated YouTube viewport", { exact: true });
    await expect(card).toBeVisible();
    await expect(frame).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute("data-youtube-playing", "true");
    const [cardBox, frameBox, after] = await Promise.all([
      card.boundingBox(), frame.boundingBox(), dock.boundingBox(),
    ]);
    expect(before).not.toBeNull(); expect(after).not.toBeNull();
    expect(cardBox).not.toBeNull(); expect(frameBox).not.toBeNull();
    if (!before || !after || !cardBox || !frameBox) throw new Error("Missing video layout bounds");
    expect(Math.abs(after.height - before.height)).toBeLessThan(2);
    expect(cardBox.width).toBeLessThanOrEqual(376);
    expect(cardBox.width).toBeLessThanOrEqual(viewport.width - 24);
    expect(cardBox.x).toBeGreaterThanOrEqual(0);
    expect(cardBox.y).toBeGreaterThanOrEqual(0);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(viewport.width);
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(viewport.height);
    expect(frameBox.width).toBeGreaterThanOrEqual(200);
    expect(frameBox.height).toBeGreaterThanOrEqual(200);
    expect(frameBox.height).toBeLessThanOrEqual(205);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    expect(await page.locator("body").getAttribute("data-real-media-attempts")).toBeNull();
    await page.screenshot({ path: `test-results/youtube-card-${viewport.label.replaceAll(" ", "-")}-${test.info().project.name}.png` });
    const close = card.getByRole("button", { name: "Close video", exact: true });
    await close.focus();
    await expect(close).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(card).toHaveCount(0);
    await expect(page.locator("body")).toHaveAttribute("data-youtube-playing", "false");
  });
}
