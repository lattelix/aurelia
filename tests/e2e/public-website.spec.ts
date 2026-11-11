import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

async function isolatedPlayer(page: Page) {
  await page.route("**/api/**", (route) => {
    if (new URL(route.request().url()).pathname === "/api/bootstrap")
      return route.fulfill({
        json: {
          user: null,
          library: null,
          catalogue: [],
          albums: [],
          artists: [],
          editorialPlaylists: [],
          recommendations: [],
          capabilities: {
            localAccounts: true,
            demoCatalogue: false,
            youtube: false,
          },
        },
      });
    return route.fulfill({
      status: 503,
      json: { error: "Isolated website test" },
    });
  });
}

test("public pages do not bootstrap a music session or mount media", async ({
  page,
}) => {
  const unexpected: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.pathname.startsWith("/api/") &&
        !["/api/auth/me", "/api/product/votes"].includes(url.pathname)) ||
      /youtube|googlevideo/.test(url.hostname)
    )
      unexpected.push(url.pathname);
  });
  for (const path of [
    "/",
    "/docs",
    "/features",
    "/platforms",
    "/versions",
    "/roadmap",
    "/privacy",
  ]) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("audio,video,iframe")).toHaveCount(0);
    await expect(page.locator(".app-shell")).toHaveCount(0);
  }
  expect(unexpected).toEqual([]);
});

test("landing opens the player and internal navigation stays under /app", async ({
  page,
}) => {
  await isolatedPlayer(page);
  await page.goto("/");
  await page
    .getByRole("link", { name: "Открыть плеер", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.locator(".app-shell")).toBeVisible();
  const search = page.locator('a[href="/app/search"]:visible').first();
  await search.click();
  await expect(page).toHaveURL(/\/app\/search$/);
  await page.locator('a[href="/app/library"]:visible').first().click();
  await expect(page).toHaveURL(/\/app\/library$/);
  expect(
    await page
      .locator("audio")
      .evaluateAll((els) => els.every((el) => (el as HTMLAudioElement).paused)),
  ).toBe(true);
});

test("legacy navigation preserves account approval and search parameters", async ({
  request,
}) => {
  for (const path of [
    "/search?q=focus",
    "/account?connect=ABCD-EF23",
    "/import?status=done",
    "/playlist/synthetic-id?view=tracks",
  ]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(response.headers().location).toBe(`/app${path}`);
  }
  for (const path of ["/app", "/docs", "/privacy"]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
  }
});

test("feature details use registry IDs and unknown pages remain 404", async ({
  page,
  request,
}) => {
  await page.goto("/features");
  await page.locator('a[href^="/features/"]').first().click();
  await expect(page).toHaveURL(/\/features\/[a-z0-9-]+$/);
  await expect(page.locator("h1")).toBeVisible();
  for (const path of [
    "/features/not-a-feature",
    "/app/not-a-screen",
    "/not-a-page",
  ])
    expect((await request.get(path)).status()).toBe(404);
});

test("existing installed PWA opens the player from the old root", async ({
  page,
}) => {
  await isolatedPlayer(page);
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "standalone", { value: true }),
  );
  await page.goto("/");
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.locator(".app-shell")).toBeVisible();
});

test("manifest keeps app identity and moves launch and shortcuts", async ({
  request,
}) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ id: "/", scope: "/", start_url: "/app" });
  expect(
    manifest.shortcuts.map((shortcut: { url: string }) => shortcut.url),
  ).toEqual(["/app/search", "/app/library"]);
});

test("public layout fits narrow phones and wide screens", async ({ page }) => {
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 850 });
    for (const path of [
      "/",
      "/docs",
      "/features",
      "/platforms",
      "/versions",
      "/roadmap",
    ]) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      if ([360, 1440].includes(width) && path === "/")
        await page.screenshot({
          path: `.runtime/aurelia-landing-${width}-20261110.png`,
          fullPage: false,
        });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `${path} at ${width}px`,
      ).toBe(true);
    }
  }
});
