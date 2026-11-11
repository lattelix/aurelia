import { appHref } from "../../apps/web/src/lib/app-navigation";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { registerWithEmail, signInWithEmail } from "./auth-helpers";

const origin = process.env.E2E_BASE_URL ?? "http://localhost:3000";

test("a second mobile session can sign in, open the same library and play it", async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const email = `sync-${randomUUID()}@example.test`;
  const password = randomUUID();
  const second = await browser.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
  });
  let registered = false;
  let accountId = "";
  try {
    const bootstrap = page.waitForResponse("**/api/bootstrap");
    await page.goto(appHref("/"));
    await bootstrap;
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await registerWithEmail(page, {
      name: "Cross-device QA",
      email,
      password,
    });
    registered = true;
    accountId = (await (await page.request.get("/api/bootstrap")).json()).user
      .id;

    await page.goto(appHref("/search"));
    await page
      .getByRole("button", { name: "Studio catalogue", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Search music" })
      .fill("Golden Hour");
    await page
      .getByRole("button", { name: "Like Golden Hour", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Unlike Golden Hour", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.goto(appHref("/library"));
    await page
      .getByRole("button", { name: "New playlist", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("Name", { exact: true })
      .fill("Across devices");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create playlist", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Across devices", exact: true }),
    ).toBeVisible();
    await page.goto(appHref("/liked"));
    await page
      .getByRole("button", {
        name: "More options for Golden Hour",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Add to playlist", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /Across devices/ })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const mobile = await second.newPage();
    const mobileBootstrap = mobile.waitForResponse("**/api/bootstrap");
    await mobile.goto(appHref("/library"));
    await mobileBootstrap;
    expect((await second.request.get("/api/library")).status()).toBe(401);
    await mobile.getByRole("button", { name: "Sign in", exact: true }).click();
    await signInWithEmail(mobile, { email, password });
    await mobile
      .getByRole("link", { name: /Across devices/ })
      .last()
      .click();
    await expect(mobile.locator(".track-row")).toHaveCount(1);
    await expect(
      mobile.getByRole("button", { name: "Unlike Golden Hour", exact: true }),
    ).toBeVisible();
    await mobile
      .getByRole("button", { name: "Play Golden Hour", exact: true })
      .first()
      .click();
    const currentUser = (
      await (await second.request.get("/api/bootstrap")).json()
    ).user;
    await expect
      .poll(
        async () =>
          mobile.evaluate((id) => {
            const snapshot = JSON.parse(
              localStorage.getItem(`aurelia.player.${id}`) ?? "{}",
            );
            return snapshot.position ?? 0;
          }, currentUser.id),
        { timeout: 25000 },
      )
      .toBeGreaterThan(1);
    expect(
      await mobile.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await mobile.reload();
    await expect(mobile.locator(".track-row")).toHaveCount(1);
    await expect(
      mobile.getByRole("button", { name: "Unlike Golden Hour", exact: true }),
    ).toBeVisible();
    const library = await (
      await second.request.get("/api/library", {
        headers: { "X-Aurelia-Account": accountId },
      })
    ).json();
    expect(library.likes.map((track: { id: string }) => track.id)).toContain(
      "studio:afterglow-1",
    );
    expect(
      library.playlists.find(
        (playlist: { name: string }) => playlist.name === "Across devices",
      ).tracks,
    ).toHaveLength(1);
    const session = (await second.cookies()).find(
      (cookie) => cookie.name === "aurelia_session",
    );
    expect(session?.httpOnly).toBe(true);
    if (origin.startsWith("https:")) expect(session?.secure).toBe(true);
  } finally {
    await second.close();
    if (registered) {
      const removed = await page.request.delete("/api/auth/account", {
        headers: { Origin: origin, "X-Aurelia-Account": accountId },
      });
      expect(removed.status()).toBe(200);
    }
  }
});
