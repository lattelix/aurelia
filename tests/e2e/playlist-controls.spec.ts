import { appHref } from "../../apps/web/src/lib/app-navigation";
import { expect, test, type Page } from "@playwright/test";
import type { Track, UserPlaylist } from "@aurelia/core";

test.use({ serviceWorkers: "block" });
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const createdId = "33333333-3333-4333-8333-333333333333";
const songs: Track[] = [
  ["aqz-KE-bpKQ", "Zulu song", "Artist A"],
  ["YE7VzlLtp-4", "Alpha song", "Artist B"],
  ["jNQXAC9IVRw", "Beta song", "Artist B"],
].map(([externalId, title, artist]) => ({
  id: `youtube:${externalId}`,
  externalId,
  title,
  artist,
  artistId: artist,
  provider: "youtube",
  album: "Fixture album",
  albumId: "fixture-album",
  duration: 72,
  genre: "",
  year: 0,
  artwork: `https://i.ytimg.com/vi/${externalId}/hqdefault.jpg`,
  sourceUrl: `https://www.youtube.com/watch?v=${externalId}`,
}));
function libraryState() {
  return {
    accountId: "44444444-4444-4444-8444-444444444444",
    playlists: [
      {
        id: firstId,
        name: "Zulu library",
        description: "Quiet favorites",
        tracks: [...songs],
        createdAt: "2026-11-01T00:00:00Z",
      },
      {
        id: secondId,
        name: "Alpha library",
        description: "Morning songs",
        tracks: [],
        createdAt: "2026-11-08T00:00:00Z",
      },
    ] as UserPlaylist[],
    createRequests: 0,
    failMetadata: false,
    failOrder: false,
    orders: [] as { trackIds: string[]; expectedTrackIds: string[] }[],
  };
}
async function mockLibrary(
  page: Page,
  state: ReturnType<typeof libraryState>,
  createGate?: Promise<void>,
  metadataGate?: Promise<void>,
) {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = () =>
      Promise.reject(new Error("Audio disabled in playlist fixture"));
  });
  await page.route("https://**/*", (route) => route.abort());
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/bootstrap")
      return route.fulfill({
        json: {
          user: {
            id: state.accountId,
            name: "Playlist QA",
            email: null,
            identities: [],
          },
          library: {
            likes: [],
            playlists: state.playlists,
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
          capabilities: { youtube: true, demoCatalogue: false },
        },
      });
    if (path === "/api/library/playlists" && method === "POST") {
      state.createRequests++;
      await createGate;
      const input = route.request().postDataJSON();
      state.playlists.push({
        id: createdId,
        name: input.name,
        description: input.description,
        tracks: [],
        createdAt: "2026-11-08T12:00:00Z",
      });
      return route.fulfill({ status: 201, json: { id: createdId } });
    }
    const match = /^\/api\/library\/playlists\/([^/]+)(\/order)?$/.exec(path);
    if (match) {
      const playlist = state.playlists.find((entry) => entry.id === match[1]);
      if (!playlist)
        return route.fulfill({
          status: 404,
          json: { error: "Playlist not found" },
        });
      if (method === "PATCH") {
        await metadataGate;
        if (state.failMetadata) {
          state.failMetadata = false;
          return route.fulfill({
            status: 503,
            json: { error: "Fixture metadata failure" },
          });
        }
        const input = route.request().postDataJSON();
        playlist.name = input.name ?? playlist.name;
        playlist.description = input.description ?? playlist.description;
        return route.fulfill({ json: { ok: true } });
      }
      if (method === "PUT" && match[2]) {
        const input: { trackIds: string[]; expectedTrackIds: string[] } = route
          .request()
          .postDataJSON();
        state.orders.push(input);
        if (state.failOrder) {
          state.failOrder = false;
          playlist.tracks = [...playlist.tracks].reverse();
          return route.fulfill({
            status: 409,
            json: {
              error: "The playlist order changed. Reload and try again.",
            },
          });
        }
        playlist.tracks = input.trackIds.map((id) =>
          playlist.tracks.find((track) => track.id === id)!,
        );
        return route.fulfill({ json: { ok: true } });
      }
    }
    if (path === "/api/stream")
      return route.fulfill({
        status: 503,
        json: { error: "Playback source disabled in fixture" },
      });
    // Every remaining API call, including queue/signals, stays inside the mock.
    return route.fulfill({ json: {} });
  });
}

test("create/edit metadata keeps failed drafts, prevents duplicate create and refreshes a second session", async ({
  page,
  browser,
  baseURL,
}) => {
  const state = libraryState();
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  await mockLibrary(page, state, createGate);
  const second = await browser.newContext({ baseURL });
  try {
    const other = await second.newPage();
    await mockLibrary(other, state);
    await other.goto(appHref("/library"));
    await page.goto(appHref("/library"));
    await page
      .getByRole("button", { name: "New playlist", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Create playlist",
      exact: true,
    });
    await dialog
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Created playlist");
    await dialog
      .getByRole("textbox", { name: "Description", exact: true })
      .fill("Created with a description");
    await dialog
      .getByRole("button", { name: "Create playlist", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Saving…", exact: true }),
    ).toBeDisabled();
    await expect.poll(() => state.createRequests).toBe(1);
    releaseCreate();
    await expect(
      page.getByRole("heading", { name: "Created playlist", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Created with a description", { exact: true }),
    ).toBeVisible();
    state.failMetadata = true;
    await page
      .getByRole("button", { name: "Edit playlist", exact: true })
      .click();
    const edit = page.getByRole("dialog", {
      name: "Edit playlist",
      exact: true,
    });
    await edit
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Renamed playlist");
    await edit
      .getByRole("textbox", { name: "Description", exact: true })
      .fill("Updated description");
    await edit
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(edit.getByRole("alert")).toContainText(
      "Your changes are still here",
    );
    await expect(
      edit.getByRole("textbox", { name: "Name", exact: true }),
    ).toHaveValue("Renamed playlist");
    await edit
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(edit).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Renamed playlist", exact: true }),
    ).toBeVisible();
    await other.reload();
    await other
      .getByRole("main")
      .getByRole("link", { name: /Renamed playlist/ })
      .click();
    await expect(
      other.getByRole("heading", { name: "Renamed playlist", exact: true }),
    ).toBeVisible();
    await expect(
      other.getByText("Updated description", { exact: true }),
    ).toBeVisible();
  } finally {
    releaseCreate();
    await second.close();
  }
});

test("library filters descriptions and sorts playlists without changing saved data", async ({
  page,
}) => {
  const state = libraryState();
  await mockLibrary(page, state);
  await page.goto(appHref("/library"));
  const cards = page.locator('.library-grid > a[href^="/app/playlist/"] h3');
  await page
    .getByRole("searchbox", { name: "Filter playlists", exact: true })
    .fill("quiet");
  await expect(cards).toHaveText(["Zulu library"]);
  await page
    .getByRole("searchbox", { name: "Filter playlists", exact: true })
    .fill("missing");
  await expect(
    page.getByRole("status").filter({ hasText: "No playlists match" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filter", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Sort playlists", exact: true })
    .selectOption("name");
  await expect(cards).toHaveText(["Alpha library", "Zulu library"]);
  expect(state.playlists.map((playlist) => playlist.name)).toEqual([
    "Zulu library",
    "Alpha library",
  ]);
});

test("filtered/sorted playlist Play uses exactly the visible sequence", async ({
  page,
}) => {
  const state = libraryState();
  await mockLibrary(page, state);
  await page.goto(appHref(`/playlist/${firstId}`));
  await page
    .getByRole("combobox", { name: "Sort songs", exact: true })
    .selectOption("title");
  await page
    .getByRole("searchbox", { name: "Filter songs", exact: true })
    .fill("Artist B");
  await expect(page.locator(".track-row .track-title")).toHaveText([
    "Alpha song",
    "Beta song",
  ]);
  await expect(
    page.getByRole("button", { name: "Reorder songs", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", {
      name: "Play results from Zulu library",
      exact: true,
    })
    .click();
  await page
    .getByRole("contentinfo", { name: "Music player" })
    .getByRole("link", { name: "Open queue", exact: true })
    .click();
  await expect(page.locator(".queue-row strong")).toHaveText([
    "Alpha song",
    "Beta song",
  ]);
  expect(state.playlists[0].tracks.map((track) => track.title)).toEqual([
    "Zulu song",
    "Alpha song",
    "Beta song",
  ]);
});

test("320px keyboard reorder preserves failed draft, reloads a conflict and persists the new order", async ({
  page,
}) => {
  const state = libraryState();
  state.failOrder = true;
  await mockLibrary(page, state);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(appHref(`/playlist/${firstId}`));
  await page
    .getByRole("button", { name: "Reorder songs", exact: true })
    .click();
  let dialog = page.getByRole("dialog", { name: "Reorder songs", exact: true });
  const down = dialog.getByRole("button", {
    name: "Move Zulu song down",
    exact: true,
  });
  await down.focus();
  await down.press("Enter");
  await expect(dialog.getByRole("status")).toContainText("position 2");
  await dialog.getByRole("button", { name: "Save order", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "playlist may have changed",
  );
  expect(state.orders[0]).toEqual({
    trackIds: [songs[1].id, songs[0].id, songs[2].id],
    expectedTrackIds: songs.map((track) => track.id),
  });
  await expect(dialog.locator(".playlist-order-track strong")).toHaveText([
    "1. Alpha song",
    "2. Zulu song",
    "3. Beta song",
  ]);
  await dialog
    .getByRole("button", { name: "Reload playlist", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole("button", { name: "Reorder songs", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Reorder songs", exact: true });
  await dialog
    .getByRole("button", { name: "Move Beta song down", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Save order", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".track-row .track-title")).toHaveText([
    "Alpha song",
    "Beta song",
    "Zulu song",
  ]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page
      .getByRole("contentinfo", { name: "Music player" })
      .getByText("Your next favorite awaits"),
  ).toBeVisible();
});

test("changing the active profile invalidates an editor before a late save returns", async ({
  page,
}) => {
  const state = libraryState();
  let releaseSave!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await mockLibrary(page, state, undefined, gate);
  try {
    await page.goto(appHref(`/playlist/${firstId}`));
    await page
      .getByRole("button", { name: "Edit playlist", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Edit playlist",
      exact: true,
    });
    await dialog
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Old profile draft");
    const sent = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" &&
        new URL(request.url()).pathname.endsWith(firstId),
    );
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await sent;
    state.accountId = "55555555-5555-4555-8555-555555555555";
    state.playlists = [];
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("heading", {
        name: "That collection isn’t here",
        exact: true,
      }),
    ).toBeVisible();
    const returned = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname.endsWith(firstId),
    );
    releaseSave();
    await returned;
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByText("Playlist updated", { exact: true }),
    ).toHaveCount(0);
    expect(state.playlists).toEqual([]);
  } finally {
    releaseSave();
  }
});

test("oversized playlist Play gives explicit feedback and a filter can produce a playable queue", async ({
  page,
}) => {
  const state = libraryState();
  state.playlists[0].tracks = Array.from({ length: 501 }, (_, index) => {
    const externalId = `qa${String(index).padStart(9, "0")}`;
    return {
      ...songs[0],
      id: `youtube:${externalId}`,
      externalId,
      title:
        index === 500
          ? "Unique final selection"
          : `Large fixture song ${index}`,
    };
  });
  await mockLibrary(page, state);
  await page.goto(appHref(`/playlist/${firstId}`));
  await page
    .getByRole("button", { name: "Play Zulu library", exact: true })
    .click();
  await expect(
    page.getByText(
      "A queue holds up to 500 songs. Filter this collection to 500 or fewer songs before playing.",
      { exact: true },
    ),
  ).toBeVisible();
  const player = page.getByRole("contentinfo", { name: "Music player" });
  await expect(player.getByText("Your next favorite awaits")).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Filter songs", exact: true })
    .fill("Unique final selection");
  await page
    .getByRole("button", {
      name: "Play results from Zulu library",
      exact: true,
    })
    .click();
  await expect(
    player.getByText("Unique final selection", { exact: true }),
  ).toBeVisible();
  await player.getByRole("link", { name: "Open queue", exact: true }).click();
  await expect(page.locator(".queue-row strong")).toHaveText([
    "Unique final selection",
  ]);
});
