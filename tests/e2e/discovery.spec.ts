import { appHref } from "../../apps/web/src/lib/app-navigation";
import { expect, test, type Page } from "@playwright/test";
import type { DiscoveryPage, Track } from "@aurelia/core";

// Public metadata fixtures only. All API/media/image requests below are local
// mocks; these tests neither resolve a stream nor mutate a real account.
test.use({ serviceWorkers: "block" });

function youtube(
  id: string,
  title: string,
): DiscoveryPage["sections"][number]["tracks"][number] {
  return {
    id: `youtube:${id}`,
    externalId: id,
    provider: "youtube",
    title,
    artist: "Public discovery fixture",
    artistId: "fixture-channel",
    album: "",
    albumId: "",
    duration: 72,
    genre: "",
    year: 0,
    artwork: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    sourceUrl: `https://www.youtube.com/watch?v=${id}`,
  };
}
const bootstrapTrack = youtube("aqz-KE-bpKQ", "Bootstrap recording fixture");
const initialTrack = youtube("YE7VzlLtp-4", "Initial recommendation fixture");
const freshFirst = youtube("jNQXAC9IVRw", "Fresh first recommendation fixture");
const freshSelected = youtube(
  "eRsGyueVLvQ",
  "Fresh selected recommendation fixture",
);
const studio: Track = {
  ...bootstrapTrack,
  provider: "studio",
  id: "studio:discovery-sentinel",
  externalId: "1",
  title: "Studio sentinel must stay hidden",
  artwork: "/art/afterglow.svg",
};
const discovery: DiscoveryPage = {
  source: "youtube-music",
  fetchedAt: "2026-11-08T08:30:00.000Z",
  sections: [
    {
      id: "public-discoveries",
      title: "Public discovery section fixture",
      tracks: [initialTrack],
    },
  ],
};

async function fixtures(
  page: Page,
  options: { signedIn?: boolean; failDiscoveryOnce?: boolean } = {},
) {
  const requests = {
    discovery: 0,
    recommendations: 0,
    search: [] as string[],
    stream: [] as string[],
  };
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = () =>
      Promise.reject(new Error("Audio disabled in discovery fixture"));
  });
  await page.route("https://**/*", (route) => route.abort());
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/bootstrap")
      return route.fulfill({
        json: {
          user: options.signedIn
            ? {
                id: "11111111-1111-4111-8111-111111111111",
                name: "Discovery QA",
                email: null,
                identities: [],
              }
            : null,
          library: {
            likes: [],
            playlists: [],
            history: [
              {
                id: "studio-history",
                track: studio,
                playedAt: "2026-11-08T07:00:00.000Z",
                completion: 0.5,
              },
            ],
            followedArtists: [],
            searches: [],
            queue: null,
          },
          // Deliberately retain Studio in the payload to exercise UI filtering.
          catalogue: [studio],
          albums: [],
          artists: [],
          editorialPlaylists: [
            {
              id: "golden-hour",
              name: "Studio mix sentinel",
              description: "Demo only",
              artwork: studio.artwork,
              tracks: [studio],
            },
          ],
          recommendations: [
            { track: bootstrapTrack, reason: "Bootstrap fixture", score: 1 },
            { track: studio, reason: "Demo only", score: 0 },
          ],
          capabilities: {
            demoCatalogue: false,
            youtube: true,
            localAccounts: false,
          },
        },
      });
    if (url.pathname === "/api/discovery") {
      requests.discovery++;
      return requests.discovery === 1 && options.failDiscoveryOnce
        ? route.fulfill({
            status: 503,
            json: { error: "Discovery fixture unavailable" },
          })
        : route.fulfill({ json: discovery });
    }
    if (url.pathname === "/api/recommendations") {
      requests.recommendations++;
      const tracks =
        requests.recommendations === 1
          ? [initialTrack]
          : [freshFirst, freshSelected];
      return route.fulfill({
        json: tracks.map((track) => ({
          track,
          reason: "Fetched recommendation fixture",
          score: 2,
        })),
      });
    }
    if (url.pathname === "/api/search") {
      requests.search.push(url.href);
      return route.fulfill({
        json: {
          source: "youtube",
          tracks: [initialTrack],
          albums: [],
          artists: [],
          playlists: [],
        },
      });
    }
    if (url.pathname === "/api/stream") {
      requests.stream.push(url.href);
      return route.fulfill({
        status: 503,
        json: { error: "Stream resolution disabled in fixture" },
      });
    }
    // Listening signals/queue writes, if any, are intercepted rather than sent
    // to the owned server's database. No credentials or owner data are used.
    return route.fulfill({ json: {} });
  });
  return requests;
}

test("normal Home renders upstream sections and fetched time without Studio or autoplay", async ({
  page,
}) => {
  const requests = await fixtures(page);
  await page.goto(appHref("/"));
  await expect(
    page.getByRole("heading", { name: "Explore YouTube Music", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: discovery.sections[0].title,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("button", { name: `Play ${initialTrack.title}`, exact: true })
      .first(),
  ).toBeVisible();
  const fetchedAt = await page.evaluate(
    (value) => new Date(value).toLocaleString(),
    discovery.fetchedAt,
  );
  await expect(
    page.getByText("From YouTube Music", { exact: false }),
  ).toContainText(fetchedAt);
  await expect(page.getByText(studio.title, { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Studio mix sentinel", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Your mixes", exact: true }),
  ).toHaveCount(0);
  const player = page.getByRole("contentinfo", { name: "Music player" });
  await expect(player.getByText("Your next favorite awaits")).toBeVisible();
  await expect(
    player.getByRole("button", { name: "Play", exact: true }).first(),
  ).toBeDisabled();
  expect(requests.stream).toHaveLength(0);
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("discovery failure offers a working retry without falling back to Studio", async ({
  page,
}) => {
  const requests = await fixtures(page, { failDiscoveryOnce: true });
  await page.goto(appHref("/"));
  await expect(
    page.getByRole("heading", {
      name: "Discoveries are unavailable",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(studio.title, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: discovery.sections[0].title,
      exact: true,
    }),
  ).toBeVisible();
  expect(requests.discovery).toBe(2);
  expect(requests.stream).toHaveLength(0);
});

test("Focus opens an honest YouTube mood search and retains the query through the skip link", async ({
  page,
}) => {
  const requests = await fixtures(page);
  await page.goto(appHref("/"));
  await page.locator(".mood-grid button").filter({ hasText: "Focus" }).click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === appHref("/search") &&
      url.searchParams.get("q") === "instrumental focus music" &&
      url.searchParams.get("provider") === "youtube",
  );
  await expect(
    page.getByRole("textbox", { name: "Search music", exact: true }),
  ).toHaveValue("instrumental focus music");
  await expect.poll(() => requests.search.length).toBeGreaterThan(0);
  const request = new URL(requests.search.at(-1)!);
  expect(request.searchParams.get("q")).toBe("instrumental focus music");
  expect(request.searchParams.get("provider")).toBe("youtube");
  const skip = page.getByRole("link", { name: "Skip to content", exact: true });
  await skip.focus();
  await skip.press("Enter");
  await expect(page).toHaveURL(
    (url) =>
      url.hash === "#main-content" &&
      url.searchParams.get("q") === "instrumental focus music" &&
      url.searchParams.get("provider") === "youtube",
  );
  await expect(
    page.getByRole("textbox", { name: "Search music", exact: true }),
  ).toHaveValue("instrumental focus music");
  await expect(
    page.getByRole("button", { name: "Studio catalogue", exact: true }),
  ).toHaveCount(0);
});

test("URL searches accept 200 characters, reject 201 and always use YouTube in normal mode", async ({
  page,
}) => {
  const requests = await fixtures(page);
  const query = "a".repeat(200);
  await page.goto(
    appHref(`/search?${new URLSearchParams({ q: query, provider: "studio" })}`),
  );
  await expect(
    page.getByRole("textbox", { name: "Search music", exact: true }),
  ).toHaveValue(query);
  await expect.poll(() => requests.search.length).toBe(1);
  expect(new URL(requests.search[0]).searchParams.get("q")).toBe(query);
  expect(new URL(requests.search[0]).searchParams.get("provider")).toBe(
    "youtube",
  );
  await page.goto(
    appHref(`/search?${new URLSearchParams({ q: `${query}a`, provider: "youtube" })}`),
  );
  await expect(
    page.getByRole("textbox", { name: "Search music", exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: "Search by mood", exact: true }),
  ).toBeVisible();
  expect(
    requests.search.every(
      (value) => (new URL(value).searchParams.get("q")?.length ?? 0) <= 200,
    ),
  ).toBe(true);
});

test("320px Light mood cards use a bounded grid with white titles and arrows", async ({
  page,
}) => {
  await fixtures(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(appHref("/"));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const grid = page.locator(".mood-grid");
  await expect(grid.getByRole("button")).toHaveCount(3);
  expect(
    await grid.evaluate((element) => getComputedStyle(element).display),
  ).toBe("grid");
  const cards = await grid.getByRole("button").evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        titleColor: getComputedStyle(element.querySelector("strong")!).color,
        arrowColor: getComputedStyle(element.querySelector("svg")!).color,
      };
    }),
  );
  for (const card of cards) {
    expect(card.left).toBeGreaterThanOrEqual(0);
    expect(card.right).toBeLessThanOrEqual(321);
    expect(card.width).toBeGreaterThan(44);
    expect(card.titleColor).toBe("rgb(255, 255, 255)");
    expect(card.arrowColor).toBe("rgb(255, 255, 255)");
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("refreshed recommendation card plays its fetched collection rather than bootstrap tracks", async ({
  page,
}) => {
  const requests = await fixtures(page, { signedIn: true });
  await page.goto(appHref("/recommendations"));
  await expect(
    page.getByRole("button", {
      name: `Play ${initialTrack.title}`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh recommendations", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: `Play ${freshSelected.title}`,
      exact: true,
    }),
  ).toBeVisible();
  expect(requests.recommendations).toBe(2);
  await page
    .getByRole("button", { name: `Play ${freshSelected.title}`, exact: true })
    .click();
  const player = page.getByRole("contentinfo", { name: "Music player" });
  await expect(
    player.getByText(freshSelected.title, { exact: true }),
  ).toBeVisible();
  await player.getByRole("link", { name: "Open queue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Up next", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".queue-row strong")).toHaveText([
    freshFirst.title,
    freshSelected.title,
  ]);
  await expect(page.locator(".queue-row.current strong")).toHaveText(
    freshSelected.title,
  );
  await expect(
    page.getByText(bootstrapTrack.title, { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(studio.title, { exact: true })).toHaveCount(0);
});
