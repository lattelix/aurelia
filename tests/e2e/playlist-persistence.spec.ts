import { appHref } from "../../apps/web/src/lib/app-navigation";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { registerWithEmail, signInWithEmail } from "./auth-helpers";

test("playlist metadata and saved order persist through real API and another session", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const origin = process.env.E2E_BASE_URL ?? "http://localhost:3000";
  const account = {
    name: "Playlist persistence QA",
    email: `playlist-${randomUUID()}@example.test`,
    password: randomUUID(),
  };
  const second = await browser.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
  });
  let owner: string | undefined;
  try {
    await page.goto(appHref("/library"));
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await registerWithEmail(page, account);
    const bootstrap = await (await page.request.get("/api/bootstrap")).json();
    owner = bootstrap.user.id;
    const headers = { Origin: origin, "X-Aurelia-Account": owner! };
    const created = await page.request.post("/api/library/playlists", {
      headers,
      data: { name: "Persistent playlist", description: "Original" },
    });
    expect(created.status()).toBe(201);
    const { id } = await created.json();
    const trackIds = bootstrap.catalogue
      .slice(0, 3)
      .map((track: { id: string }) => track.id);
    expect(trackIds).toHaveLength(3);
    for (const trackId of trackIds)
      expect(
        (
          await page.request.post(`/api/library/playlists/${id}/tracks`, {
            headers,
            data: { trackId },
          })
        ).status(),
      ).toBe(200);
    await page.goto(appHref(`/playlist/${id}`));
    await page
      .getByRole("button", { name: "Edit playlist", exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Edit playlist",
      exact: true,
    });
    await editor
      .getByLabel("Name", { exact: true })
      .fill("Edited persistent playlist");
    await editor
      .getByRole("textbox", { name: "Description", exact: true })
      .fill("Saved through the actual server");
    await editor
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(editor).toHaveCount(0);
    await page
      .getByRole("button", { name: "Reorder songs", exact: true })
      .click();
    const order = page.getByRole("dialog", {
      name: "Reorder songs",
      exact: true,
    });
    await order
      .getByRole("button", { name: /^Move .+ down$/ })
      .first()
      .click();
    await order
      .getByRole("button", { name: "Save order", exact: true })
      .click();
    await expect(order).toHaveCount(0);

    const mobile = await second.newPage();
    await mobile.goto(appHref("/library"));
    await mobile.getByRole("button", { name: "Sign in", exact: true }).click();
    await signInWithEmail(mobile, account);
    await mobile.goto(appHref(`/playlist/${id}`));
    await expect(
      mobile.getByRole("heading", {
        name: "Edited persistent playlist",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      mobile.getByText("Saved through the actual server", { exact: true }),
    ).toBeVisible();
    const libraryResponse = await second.request.get("/api/library", {
      headers: { "X-Aurelia-Account": owner! },
    });
    expect(libraryResponse.status()).toBe(200);
    const library = await libraryResponse.json();
    const playlist = library.playlists.find(
      (item: { id: string }) => item.id === id,
    );
    expect(playlist.tracks.map((track: { id: string }) => track.id)).toEqual([
      trackIds[1],
      trackIds[0],
      trackIds[2],
    ]);
    const stale = await page.request.put(`/api/library/playlists/${id}/order`, {
      headers,
      data: { trackIds, expectedTrackIds: trackIds },
    });
    expect(stale.status()).toBe(409);
    const afterResponse = await second.request.get("/api/library", {
      headers: { "X-Aurelia-Account": owner! },
    });
    expect(afterResponse.status()).toBe(200);
    const after = await afterResponse.json();
    expect(
      after.playlists
        .find((item: { id: string }) => item.id === id)
        .tracks.map((track: { id: string }) => track.id),
    ).toEqual([trackIds[1], trackIds[0], trackIds[2]]);
  } finally {
    if (owner)
      expect(
        (
          await page.request.delete("/api/auth/account", {
            headers: { Origin: origin, "X-Aurelia-Account": owner },
          })
        ).status(),
      ).toBe(200);
    await second.close();
  }
});
