import { appHref } from "../../apps/web/src/lib/app-navigation";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { outageProxy } from "./outage-proxy";
import { registerWithEmail } from "./auth-helpers";
import { catalogue } from "@aurelia/music";
const origin = process.env.E2E_BASE_URL ?? "http://localhost:3000";
async function navigate(page: Page, path: string) {
  const href = appHref(path);
  await page.locator(`a[href="${href}"]:visible`).first().click();
  await expect(page).toHaveURL(new URL(href, origin).href);
}
async function register(page: Page) {
  await page.goto(appHref("/"));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await registerWithEmail(page, {
    name: "QA Listener",
    email: `qa-${randomUUID()}@example.test`,
    password: "aurelia secure test password",
  });
  await expect(
    page.getByRole("link", { name: "Your account", exact: true }),
  ).toBeVisible();
}
test("complete music journey: account, playlist, search, actual audio, like, queue, persistence, import and logout", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await register(page);
  await navigate(page, "/library");
  await page.getByRole("button", { name: "New playlist" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("QA Mix");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create playlist", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "QA Mix", exact: true }),
  ).toBeVisible();
  await navigate(page, "/search");
  await page
    .getByRole("button", { name: "Studio catalogue", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Search music" }).fill("Golden Hour");
  await expect(
    page.getByRole("heading", { name: "Golden Hour", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Play Golden Hour", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }).first(),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        Number(
          await page
            .getByRole("slider", { name: "Seek", exact: true })
            .inputValue(),
        ),
      { timeout: 15000 },
    )
    .toBeGreaterThan(1);
  await page
    .getByRole("button", { name: "Like Golden Hour", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Unlike Golden Hour", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", { name: "More options for Golden Hour", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add to playlist", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /QA Mix/ })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "More options for Golden Hour", exact: true })
    .click();
  await page.getByRole("button", { name: "Add to queue", exact: true }).click();
  await page.getByRole("link", { name: "Open queue", exact: true }).click();
  await expect(page.locator(".queue-row")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Next track", exact: true })
    .first()
    .click();
  await expect(page.locator(".queue-row.current")).toHaveCount(1);
  await page.getByRole("slider", { name: "Seek", exact: true }).fill("20");
  await expect
    .poll(async () =>
      Number(
        await page
          .getByRole("slider", { name: "Seek", exact: true })
          .inputValue(),
      ),
    )
    .toBeGreaterThanOrEqual(20);
  await page
    .getByRole("button", { name: "Pause", exact: true })
    .first()
    .click();
  await page.waitForTimeout(5500);
  await page.reload();
  await expect(page.locator(".queue-row")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Play", exact: true }).first(),
  ).toBeVisible();
  await navigate(page, "/liked");
  await expect(
    page.getByRole("button", { name: "Unlike Golden Hour", exact: true }),
  ).toBeVisible();
  await navigate(page, "/library");
  await page
    .getByRole("link", { name: /QA Mix/ })
    .last()
    .click();
  await expect(page.locator(".track-row")).toHaveCount(1);
  await page
    .getByRole("button", { name: "More options for Golden Hour", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove from playlist", exact: true })
    .click();
  await expect(page.locator(".track-row")).toHaveCount(0);
  await navigate(page, "/history");
  await expect(page.locator(".track-row").first()).toBeVisible();
  await navigate(page, "/import");
  await page
    .getByRole("button", { name: "Try a sample import", exact: true })
    .click();
  await expect(page.getByText("Sample import · complete")).toBeVisible();
  await expect(page.locator(".import-counters")).toContainText("2");
  await expect(page.locator(".match-review")).toHaveCount(1);
  await page
    .getByRole("combobox", { name: "Choose match for A Song That Is Not Here" })
    .selectOption("studio:parallel-1");
  await expect(page.locator(".match-review")).toHaveCount(0);
  await navigate(page, "/account");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create account or sign in" }),
  ).toBeVisible();
  await navigate(page, "/liked");
  await expect(page.locator(".track-row")).toHaveCount(0);
  await navigate(page, "/queue");
  await expect(page.locator(".queue-row")).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("API authorization, CSRF and idempotent import are enforced", async ({
  request,
}) => {
  const credentials = {
    name: "API Listener",
    email: `api-${randomUUID()}@example.test`,
    password: "correct API test password",
  };
  const untrusted = await request.post("/api/auth/register", {
    data: credentials,
    headers: { Origin: "https://untrusted.example" },
  });
  expect(untrusted.status()).toBe(403);
  const registered = await request.post("/api/auth/register", {
    data: credentials,
    headers: { Origin: origin },
  });
  expect(registered.status()).toBe(200);
  const accountId = (await registered.json()).user.id as string;
  const ownerHeaders = { Origin: origin, "X-Aurelia-Account": accountId };
  const playId = randomUUID();
  for (const completion of [0, 0, 0.7, 0]) {
    expect(
      (
        await request.post("/api/library/history", {
          data: { trackId: "studio:afterglow-1", playId, completion },
          headers: ownerHeaders,
        })
      ).status(),
    ).toBe(200);
  }
  const history = (
    await (await request.get("/api/library", { headers: ownerHeaders })).json()
  ).history;
  expect(history).toHaveLength(1);
  expect(history[0].completion).toBeCloseTo(0.7);
  const created = await request.post("/api/library/playlists", {
    data: { name: "API Mix" },
    headers: ownerHeaders,
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  const added = await request.post(`/api/library/playlists/${id}/tracks`, {
    data: { trackId: "studio:afterglow-1" },
    headers: ownerHeaders,
  });
  expect(added.status()).toBe(200);
  const first = await request.post("/api/import/fixture", {
    headers: ownerHeaders,
  });
  expect(first.status()).toBe(200);
  const firstData = await first.json();
  const second = await request.post("/api/import/fixture", {
    headers: ownerHeaders,
  });
  const secondData = await second.json();
  expect(secondData.id).toBe(firstData.id);
  expect(secondData.jobs).toHaveLength(1);
  expect(secondData.jobs[0]).toMatchObject({
    status: "complete",
    matched: 2,
    unmatched: 1,
  });
  expect(
    (
      await request.delete("/api/auth/account", { headers: ownerHeaders })
    ).status(),
  ).toBe(200);
  expect(
    (await request.get("/api/library", { headers: ownerHeaders })).status(),
  ).toBe(401);
});
test("responsive phone and tablet have no horizontal overflow and mobile now playing works", async ({
  page,
}) => {
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(appHref("/"));
    await expect(
      page.getByRole("heading", { name: "For you", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/aurelia-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(appHref("/"));
  await page
    .locator(".listening-mixes")
    .getByRole("button", { name: "Play golden hour", exact: true })
    .click();
  await expect
    .poll(async () => page.locator(".playing-text strong").textContent())
    .toBe("Golden Hour");
  await page.getByRole("button", { name: "Open now playing" }).click();
  await expect(page.getByRole("dialog", { name: "Now playing" })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(
    page.getByRole("navigation", { name: "Mobile navigation" }),
  ).toBeVisible();
});
test("installable PWA has an offline fallback and never caches account APIs", async ({
  page,
  context,
  browserName,
}) => {
  // WebKit's offline emulation bypasses service workers (Playwright #42775).
  // A real local origin outage verifies the fallback without hiding that defect.
  const proxy = browserName === "webkit" ? await outageProxy(origin) : null;
  await page.goto(proxy ? new URL(appHref("/"), proxy.origin).href : appHref("/"));
  await page.evaluate(() => navigator.serviceWorker.ready);
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  expect((await manifest.json()).display).toBe("standalone");
  await page.reload();
  if (proxy) await proxy.stop();
  else await context.setOffline(true);
  await page.goto(proxy ? new URL(appHref("/library"), proxy.origin).href : appHref("/library"));
  await expect(
    page.getByRole("heading", { name: "A quiet moment." }),
  ).toBeVisible();
  await context.setOffline(false);
  const cached = await page.evaluate(async () => {
    const cache = await caches.open("aurelia-shell-v1");
    return (await cache.keys()).map((r) => new URL(r.url).pathname);
  });
  expect(cached.some((p) => p.startsWith("/api/"))).toBe(false);
  expect(cached.some((p) => p.startsWith("/audio/"))).toBe(false);
});
test("seek requested while the stream is loading survives metadata arrival", async ({
  page,
}) => {
  await page.route("**/api/stream?*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  await page.goto(appHref("/"));
  await page
    .locator(".listening-mixes")
    .getByRole("button", { name: "Play golden hour", exact: true })
    .click();
  const seek = page.getByRole("slider", { name: "Seek", exact: true });
  await seek.fill("40");
  await expect
    .poll(async () => Number(await seek.inputValue()))
    .toBeGreaterThan(40);
});
test("natural completion repeats one, respects pause during related loading, and advances autoplay", async ({
  page,
}) => {
  const proxy = await outageProxy(origin);
  const bootstrap = page.waitForResponse("**/api/bootstrap");
  await page.goto(new URL(appHref("/search"), proxy.origin).href);
  await page
    .getByRole("button", { name: "Studio catalogue", exact: true })
    .click();
  await bootstrap;
  await page.getByRole("textbox", { name: "Search music" }).fill("Golden Hour");
  await expect(
    page.getByRole("heading", { name: "Golden Hour", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Play Golden Hour", exact: true })
    .first()
    .click();
  const seek = page.getByRole("slider", { name: "Seek", exact: true });
  await expect
    .poll(async () => Number(await seek.inputValue()))
    .toBeGreaterThan(1);
  await page.getByRole("button", { name: "Repeat: off", exact: true }).click();
  await page.getByRole("button", { name: "Repeat: all", exact: true }).click();
  await seek.fill("70");
  await expect
    .poll(async () => Number(await seek.inputValue()))
    .toBeLessThan(10);
  await expect(page.locator(".playing-text strong")).toHaveText("Golden Hour");
  await page.getByRole("button", { name: "Repeat: one", exact: true }).click();
  proxy.delay("/api/related", 2000);
  const related = page.waitForRequest("**/api/related?*");
  await seek.fill("71");
  await related;
  await page
    .getByRole("button", { name: "Pause", exact: true })
    .first()
    .click();
  await page.waitForTimeout(2300);
  await expect(
    page.getByRole("button", { name: "Play", exact: true }).first(),
  ).toBeVisible();
  await expect(page.locator(".playing-text strong")).toHaveText("Golden Hour");
  proxy.delay("/api/related", 0);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expect
    .poll(async () => Number(await seek.inputValue()))
    .toBeGreaterThan(0);
  await seek.fill("71");
  await expect(page.locator(".playing-text strong")).not.toHaveText(
    "Golden Hour",
  );
  await expect
    .poll(async () => Number(await seek.inputValue()))
    .toBeGreaterThan(0);
  await proxy.stop();
});
test.describe("synthetic early discovery playback", () => {
  test.use({ serviceWorkers: "block" });
  test("an early Play action survives delayed account bootstrap", async ({
    page,
  }) => {
    const proxy = await outageProxy(origin);
    proxy.delay("/api/bootstrap", 4000);
    const started = page.waitForRequest("**/api/bootstrap");
    const loaded = page.waitForResponse("**/api/bootstrap");
    // The normal first paint is now YouTube-first. Keep early-Play coverage using
    // synthetic discovery metadata and our original local audio, without YouTube I/O.
    const videoId = "abcdefghijk";
    await page.route("**/api/discovery", (route) =>
      route.fulfill({
        json: {
          source: "youtube-music",
          fetchedAt: "2026-11-08T00:00:00.000Z",
          sections: [
            {
              id: "early-play",
              title: "Synthetic discoveries",
              tracks: [
                {
                  ...catalogue[0],
                  id: `youtube:${videoId}`,
                  externalId: videoId,
                  provider: "youtube",
                  artwork: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                  sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
                },
              ],
            },
          ],
        },
      }),
    );
    await page.route("**/api/stream?**", (route) =>
      route.fulfill({
        json: {
          kind: "audio",
          url: `/audio/${catalogue[0].externalId}.mp3`,
          capabilities: { background: true, seek: true, mediaSession: true },
        },
      }),
    );
    await page.goto(new URL(appHref("/"), proxy.origin).href);
    await started;
    await page
      .getByRole("button", { name: "Play Golden Hour", exact: true })
      .first()
      .click();
    const seek = page.getByRole("slider", { name: "Seek", exact: true });
    await expect
      .poll(async () => Number(await seek.inputValue()))
      .toBeGreaterThan(1);
    await loaded;
    await expect(
      page.getByRole("button", { name: "Pause", exact: true }).first(),
    ).toBeVisible();
    await expect(page.locator(".playing-text strong")).toHaveText(
      "Golden Hour",
    );
    await expect
      .poll(async () => Number(await seek.inputValue()))
      .toBeGreaterThan(3);
    await proxy.stop();
  });
});
