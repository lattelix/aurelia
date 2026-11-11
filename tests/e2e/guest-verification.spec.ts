import { expect, test, type Page } from "@playwright/test";
import type { Account, Track } from "@aurelia/core";
import { appHref } from "../../apps/web/src/lib/app-navigation";

// All APIs/widgets are synthetic; no real provider, account or audio is contacted.
test.use({ serviceWorkers: "block" });
const first: Track = {
  id: "youtube:abcdefghijk",
  title: "Guest access first fixture",
  artist: "Fixture",
  artistId: "fixture",
  album: "YouTube",
  albumId: "youtube",
  duration: 72,
  artwork: "/art/afterglow.svg",
  provider: "youtube",
  externalId: "abcdefghijk",
  genre: "Music",
  year: 2026,
};
const second: Track = {
  ...first,
  id: "youtube:lmnopqrstuv",
  externalId: "lmnopqrstuv",
  title: "Guest access second fixture",
};
const account: Account = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Authenticated fixture",
  email: "fixture@example.test",
  identities: ["local"],
};
type WidgetOptions = {
  callback: (token: string) => Promise<void>;
  "error-callback": () => void;
  "expired-callback": () => void;
  sitekey: string;
  action: string;
};
interface WidgetFixture {
  widgets: Record<string, WidgetOptions>;
  rendered: string[];
  removed: string[];
  resets: string[];
  audioPlayCalls: number;
  installWidget: () => void;
  lateScript?: HTMLScriptElement;
}
type FixtureWindow = Window & { guestVerificationFixture: WidgetFixture };

async function syntheticGuest(
  page: Page,
  baseURL: string | undefined,
  options: {
    authenticated?: boolean;
    holdGet?: boolean;
    holdPost?: boolean;
    scriptFailure?: boolean;
    scriptNoApi?: boolean;
    holdScript?: boolean;
  } = {},
) {
  const origin = new URL(baseURL ?? "http://localhost:3000").origin;
  const requests = {
    gets: 0,
    scripts: 0,
    posts: [] as unknown[],
    streams: [] as string[],
    events: [] as string[],
  };
  let failNextPost = false;
  const held: (() => Promise<void>)[] = [];
  const snapshot = {
    queue: [first, second],
    index: 0,
    position: 23,
    duration: 72,
    playing: true,
    shuffle: false,
    repeat: "off",
    volume: 0,
    autoplay: false,
    mode: "audio",
    quality: "balanced",
  };
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/bootstrap")
      return route.fulfill({
        json: {
          user: options.authenticated ? account : null,
          library: options.authenticated
            ? {
                likes: [],
                playlists: [],
                history: [],
                searches: [],
                followedArtists: [],
                queue: snapshot,
              }
            : null,
          catalogue: [first, second],
          albums: [],
          artists: [],
          editorialPlaylists: [],
          recommendations: [],
          capabilities: { localAccounts: true, guestVerification: true },
        },
      });
    if (path === "/api/guest") {
      const get = route.request().method() === "GET";
      if (get) {
        requests.gets++;
        requests.events.push("guest:get");
      } else {
        requests.posts.push(route.request().postDataJSON());
        requests.events.push("guest:post");
      }
      const response = get
        ? {
            required: true,
            allowed: options.authenticated === true,
            ready: true,
            siteKey: "0xSyntheticPublicSiteKey",
            action: "listen_guest",
          }
        : { ok: true };
      if ((get && options.holdGet) || (!get && options.holdPost)) {
        await new Promise<void>((resolve) =>
          held.push(async () => {
            // Pause can abort the intercepted request before its late response.
            try {
              await route.fulfill({ json: response });
            } catch {
              /* Expected cancelled request. */
            } finally {
              resolve();
            }
          }),
        );
        return;
      }
      const failed = !get && failNextPost;
      if (!get) failNextPost = false;
      return route.fulfill({
        status: failed ? 503 : 200,
        json: failed ? { error: "Synthetic unavailable" } : response,
      });
    }
    if (path === "/api/stream") {
      requests.streams.push(url.searchParams.get("id") ?? "");
      requests.events.push("stream");
      return route.fulfill({
        status: 503,
        json: { error: "Synthetic recording unavailable; no real audio" },
      });
    }
    if (path === "/api/discovery")
      return route.fulfill({
        json: {
          source: "youtube-music",
          fetchedAt: "2026-11-10T12:00:00.000Z",
          sections: [],
        },
      });
    if (path === "/api/recommendations" || path === "/api/related")
      return route.fulfill({ json: [] });
    if (path === "/api/library/queue")
      return route.fulfill({ json: { ok: true } });
    return route.fulfill({
      status: 503,
      json: { error: "Unavailable in guest-check fixture" },
    });
  });
  await page.route(
    "https://challenges.cloudflare.com/turnstile/**",
    async (route) => {
      requests.scripts++;
      if (options.scriptFailure && requests.scripts === 1) return route.abort();
      if (options.holdScript && requests.scripts === 1) {
        await new Promise<void>((resolve) =>
          held.push(async () => {
            try {
              await route.fulfill({
                contentType: "application/javascript",
                body: "/* Delayed synthetic script. */",
              });
            } catch {
              /* Removing a timed-out script may cancel its request. */
            } finally {
              resolve();
            }
          }),
        );
        return;
      }
      const noApi = options.scriptNoApi && requests.scripts === 1;
      return route.fulfill({
        contentType: "application/javascript",
        body:
          !noApi &&
          (options.scriptFailure || options.scriptNoApi || options.holdScript)
            ? "window.guestVerificationFixture.installWidget();"
            : "/* Synthetic script without a provider API. */",
      });
    },
  );
  await page.addInitScript(
    ({ saved, owner, deferWidget }) => {
      localStorage.setItem(`aurelia.player.${owner}`, JSON.stringify(saved));
      const fixture: WidgetFixture = {
        widgets: {},
        rendered: [],
        removed: [],
        resets: [],
        audioPlayCalls: 0,
        installWidget: () => {},
      };
      (window as unknown as FixtureWindow).guestVerificationFixture = fixture;
      HTMLMediaElement.prototype.play = () => {
        fixture.audioPlayCalls++;
        return Promise.reject(
          new Error("Real audio disabled in guest-check fixture"),
        );
      };
      const api = {
        render(element: HTMLElement, callbacks: WidgetOptions) {
          const id = `synthetic-widget-${fixture.rendered.length}`;
          fixture.widgets[id] = callbacks;
          fixture.rendered.push(id);
          element.textContent = "Synthetic guest verification ready";
          return id;
        },
        // Keep callbacks after removal to simulate a late event from the provider.
        remove(id: string) {
          fixture.removed.push(id);
        },
        reset(id: string) {
          fixture.resets.push(id);
        },
      };
      fixture.installWidget = () => {
        Object.assign(window, { turnstile: api });
      };
      if (!deferWidget) fixture.installWidget();
    },
    {
      saved: snapshot,
      owner: options.authenticated ? account.id : "guest",
      deferWidget:
        options.scriptFailure === true ||
        options.scriptNoApi === true ||
        options.holdScript === true,
    },
  );
  return {
    requests,
    failNextPost: () => {
      failNextPost = true;
    },
    release: async () => {
      for (const release of held.splice(0)) await release();
    },
  };
}
const player = (page: Page) =>
  page.getByRole("contentinfo", { name: "Music player" });
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Listen as a guest" });
async function settled(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function restore(page: Page) {
  await page.goto(appHref("/"));
  await expect(
    player(page).getByText(first.title, { exact: true }),
  ).toBeVisible();
  await expect(
    player(page).getByRole("button", { name: "Play", exact: true }).first(),
  ).toBeVisible();
  await expect(
    player(page).getByRole("slider", { name: "Seek", exact: true }),
  ).toHaveValue("23");
  await settled(page);
}
async function play(page: Page) {
  await player(page)
    .getByRole("button", { name: "Play", exact: true })
    .first()
    .click();
}
async function begin(page: Page) {
  await play(page);
  await expect(dialog(page)).toBeVisible();
  await expect(
    dialog(page).getByText("Synthetic guest verification ready"),
  ).toBeVisible();
  return page.evaluate(() =>
    (window as unknown as FixtureWindow).guestVerificationFixture.rendered.at(
      -1,
    )!,
  );
}
async function callback(
  page: Page,
  id: string,
  event: "success" | "error" | "expired" = "success",
) {
  await page.evaluate(
    ({ id, event }) => {
      const widget = (window as unknown as FixtureWindow)
        .guestVerificationFixture.widgets[id];
      if (event === "error") widget["error-callback"]();
      else if (event === "expired") widget["expired-callback"]();
      else void widget.callback(`synthetic-token:${id}`);
    },
    { id, event },
  );
}
async function noAudio(page: Page) {
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).guestVerificationFixture
          .audioPlayCalls,
    ),
  ).toBe(0);
}
// showModal intentionally makes pointer controls inert; dispatch the existing
// transport event to simulate a command arriving from outside the modal.
async function transport(page: Page, name: "Pause" | "Next track") {
  await player(page)
    .getByRole("button", { name, exact: true })
    .first()
    .dispatchEvent("click");
}

test("restored playback stays paused; only explicit Play opens guest verification", async ({
  page,
  baseURL,
}) => {
  const fixture = await syntheticGuest(page, baseURL);
  await restore(page);
  await expect(dialog(page)).toHaveCount(0);
  expect(fixture.requests.gets).toBe(0);
  expect(fixture.requests.streams).toEqual([]);
  const id = await begin(page);
  expect(fixture.requests.gets).toBe(1);
  expect(fixture.requests.posts).toEqual([]);
  expect(fixture.requests.streams).toEqual([]);
  expect(
    await page.evaluate((id) => {
      const widget = (window as unknown as FixtureWindow)
        .guestVerificationFixture.widgets[id];
      return { sitekey: widget.sitekey, action: widget.action };
    }, id),
  ).toEqual({ sitekey: "0xSyntheticPublicSiteKey", action: "listen_guest" });
  await noAudio(page);
});

test("successful verification submits the token before one recording request", async ({
  page,
  baseURL,
}) => {
  const fixture = await syntheticGuest(page, baseURL);
  await restore(page);
  const id = await begin(page);
  await callback(page, id);
  await expect.poll(() => fixture.requests.streams).toEqual([first.id]);
  await expect(dialog(page)).toHaveCount(0);
  expect(fixture.requests.posts).toEqual([{ token: `synthetic-token:${id}` }]);
  expect(fixture.requests.events).toEqual([
    "guest:get",
    "guest:post",
    "stream",
  ]);
  await callback(page, id);
  await settled(page);
  expect(fixture.requests.posts).toHaveLength(1);
  expect(fixture.requests.streams).toHaveLength(1);
  await noAudio(page);
});

test("Cancel removes verification without preloading and rejects a late callback", async ({
  page,
  baseURL,
}) => {
  const fixture = await syntheticGuest(page, baseURL);
  await restore(page);
  const id = await begin(page);
  await dialog(page).getByRole("button", { name: "Close dialog" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(
    player(page).getByRole("button", { name: "Play", exact: true }).first(),
  ).toBeVisible();
  await callback(page, id);
  await settled(page);
  expect(fixture.requests.posts).toEqual([]);
  expect(fixture.requests.streams).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).guestVerificationFixture.removed,
    ),
  ).toContain(id);
  await noAudio(page);
});

test("Pause before the admission GET resolves prevents a late modal or recording", async ({
  page,
  baseURL,
}) => {
  const fixture = await syntheticGuest(page, baseURL, { holdGet: true });
  try {
    await restore(page);
    await play(page);
    await expect.poll(() => fixture.requests.gets).toBe(1);
    await expect(dialog(page)).toHaveCount(0);
    await transport(page, "Pause");
    await fixture.release();
    await settled(page);
    await expect(dialog(page)).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as FixtureWindow).guestVerificationFixture
            .rendered,
      ),
    ).toEqual([]);
    expect(fixture.requests.posts).toEqual([]);
    expect(fixture.requests.streams).toEqual([]);
    await expect(
      player(page).getByRole("button", { name: "Play", exact: true }).first(),
    ).toBeVisible();
    await noAudio(page);
  } finally {
    await fixture.release();
  }
});

test("Pause invalidates an in-flight verification POST before late success", async ({
  page,
  baseURL,
}) => {
  const fixture = await syntheticGuest(page, baseURL, { holdPost: true });
  try {
    await restore(page);
    const id = await begin(page);
    await callback(page, id);
    await expect.poll(() => fixture.requests.posts.length).toBe(1);
    await expect(dialog(page).getByRole("status")).toHaveText("Verifying…");
    await transport(page, "Pause");
    await expect(dialog(page)).toHaveCount(0);
    await fixture.release();
    await callback(page, id);
    await settled(page);
    await expect(
      player(page).getByRole("button", { name: "Play", exact: true }).first(),
    ).toBeVisible();
    expect(fixture.requests.streams).toEqual([]);
    expect(fixture.requests.posts).toHaveLength(1);
    await noAudio(page);
  } finally {
    await fixture.release();
  }
});

test("a new track replaces verification and rejects the previous widget callback", async ({
  page,
  baseURL,
}) => {
  const fixture = await syntheticGuest(page, baseURL);
  await restore(page);
  const firstWidget = await begin(page);
  await transport(page, "Next track");
  await expect(
    player(page).getByText(second.title, { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).guestVerificationFixture.rendered
            .length,
      ),
    )
    .toBe(2);
  const secondWidget = await page.evaluate(() =>
    (window as unknown as FixtureWindow).guestVerificationFixture.rendered.at(
      -1,
    )!,
  );
  await callback(page, firstWidget);
  await settled(page);
  await expect(dialog(page)).toBeVisible();
  expect(fixture.requests.posts).toEqual([]);
  expect(fixture.requests.streams).toEqual([]);
  await callback(page, secondWidget);
  await expect.poll(() => fixture.requests.streams).toEqual([second.id]);
  expect(fixture.requests.posts).toEqual([
    { token: `synthetic-token:${secondWidget}` },
  ]);
  await noAudio(page);
});

test("provider and admission errors allow Retry without a recording request", async ({
  page,
  baseURL,
}) => {
  const fixture = await syntheticGuest(page, baseURL);
  await restore(page);
  const id = await begin(page);
  await callback(page, id, "error");
  await expect(dialog(page).getByRole("alert")).toContainText(
    "Verification is unavailable",
  );
  expect(fixture.requests.posts).toEqual([]);
  expect(fixture.requests.streams).toEqual([]);
  await dialog(page)
    .getByRole("button", { name: "Retry verification" })
    .click();
  await expect(dialog(page).getByRole("alert")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).guestVerificationFixture.resets,
    ),
  ).toEqual([id]);
  fixture.failNextPost();
  await callback(page, id);
  await expect(dialog(page).getByRole("alert")).toContainText(
    "Could not verify access",
  );
  expect(fixture.requests.streams).toEqual([]);
  await dialog(page)
    .getByRole("button", { name: "Retry verification" })
    .click();
  await callback(page, id);
  await expect.poll(() => fixture.requests.streams).toEqual([first.id]);
  expect(fixture.requests.posts).toHaveLength(2);
  await noAudio(page);
});

test("authenticated allowed admission proceeds without rendering a widget", async ({
  page,
  baseURL,
}) => {
  const fixture = await syntheticGuest(page, baseURL, { authenticated: true });
  await restore(page);
  expect(fixture.requests.gets).toBe(0);
  expect(fixture.requests.streams).toEqual([]);
  await play(page);
  await expect.poll(() => fixture.requests.streams).toEqual([first.id]);
  await expect(dialog(page)).toHaveCount(0);
  expect(fixture.requests.gets).toBe(1);
  expect(fixture.requests.posts).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).guestVerificationFixture.rendered,
    ),
  ).toEqual([]);
  await noAudio(page);
});

test("a failed provider script can reload on Retry and recover without a page refresh", async ({
  page,
  baseURL,
}) => {
  const fixture = await syntheticGuest(page, baseURL, { scriptFailure: true });
  await restore(page);
  await play(page);
  await expect(dialog(page).getByRole("alert")).toContainText(
    "Verification could not load",
  );
  expect(fixture.requests.scripts).toBe(1);
  expect(fixture.requests.posts).toEqual([]);
  expect(fixture.requests.streams).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).guestVerificationFixture.rendered,
    ),
  ).toEqual([]);
  await dialog(page)
    .getByRole("button", { name: "Retry verification" })
    .click();
  await expect(
    dialog(page).getByText("Synthetic guest verification ready"),
  ).toBeVisible();
  expect(fixture.requests.scripts).toBe(2);
  const id = await page.evaluate(() =>
    (window as unknown as FixtureWindow).guestVerificationFixture.rendered.at(
      -1,
    )!,
  );
  await callback(page, id);
  await expect.poll(() => fixture.requests.streams).toEqual([first.id]);
  expect(fixture.requests.posts).toEqual([{ token: `synthetic-token:${id}` }]);
  await noAudio(page);
});

test("a loaded script without the provider API shows an error and can recover on Retry", async ({
  page,
  baseURL,
}) => {
  const fixture = await syntheticGuest(page, baseURL, { scriptNoApi: true });
  await restore(page);
  await play(page);
  await expect(dialog(page).getByRole("alert")).toContainText(
    "Verification could not load",
  );
  expect(fixture.requests.scripts).toBe(1);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).guestVerificationFixture.rendered,
    ),
  ).toEqual([]);
  expect(fixture.requests.posts).toEqual([]);
  expect(fixture.requests.streams).toEqual([]);
  await dialog(page)
    .getByRole("button", { name: "Retry verification" })
    .click();
  await expect(
    dialog(page).getByText("Synthetic guest verification ready"),
  ).toBeVisible();
  expect(fixture.requests.scripts).toBe(2);
  const id = await page.evaluate(() =>
    (window as unknown as FixtureWindow).guestVerificationFixture.rendered.at(
      -1,
    )!,
  );
  await callback(page, id);
  await expect.poll(() => fixture.requests.streams).toEqual([first.id]);
  await noAudio(page);
});

test("a timed-out script cannot mount from a late load event before explicit Retry", async ({
  page,
  baseURL,
}) => {
  // The installed Playwright Clock API advances the application deadline without
  // a real 15-second wait; no application timer handler is invoked by the test.
  await page.clock.install({ time: new Date("2026-11-10T12:00:00.000Z") });
  const fixture = await syntheticGuest(page, baseURL, { holdScript: true });
  try {
    await restore(page);
    await play(page);
    await expect.poll(() => fixture.requests.scripts).toBe(1);
    await page.evaluate(() => {
      const script = document.querySelector<HTMLScriptElement>(
        'script[src^="https://challenges.cloudflare.com/turnstile/"]',
      );
      if (!script)
        throw new Error("Expected the pending synthetic script element");
      (window as unknown as FixtureWindow).guestVerificationFixture.lateScript =
        script;
    });
    await page.clock.fastForward(15_001);
    await expect(dialog(page).getByRole("alert")).toContainText(
      "Verification could not load",
    );
    expect(
      await page.evaluate(
        () =>
          (window as unknown as FixtureWindow).guestVerificationFixture
            .lateScript!.isConnected,
      ),
    ).toBe(false);
    await page.evaluate(() => {
      const fixture = (window as unknown as FixtureWindow)
        .guestVerificationFixture;
      // Install only the test double and dispatch a browser DOM event. Application
      // mount/Retry callbacks remain private and are never called by the fixture.
      fixture.installWidget();
      fixture.lateScript!.dispatchEvent(new Event("load"));
    });
    await fixture.release();
    await settled(page);
    await expect(dialog(page).getByRole("alert")).toContainText(
      "Verification could not load",
    );
    expect(
      await page.evaluate(
        () =>
          (window as unknown as FixtureWindow).guestVerificationFixture
            .rendered,
      ),
    ).toEqual([]);
    expect(fixture.requests.posts).toEqual([]);
    expect(fixture.requests.streams).toEqual([]);
    await dialog(page)
      .getByRole("button", { name: "Retry verification" })
      .click();
    await expect(
      dialog(page).getByText("Synthetic guest verification ready"),
    ).toBeVisible();
    const id = await page.evaluate(() =>
      (window as unknown as FixtureWindow).guestVerificationFixture.rendered.at(
        -1,
      )!,
    );
    await callback(page, id);
    await expect.poll(() => fixture.requests.streams).toEqual([first.id]);
    await noAudio(page);
  } finally {
    await fixture.release();
  }
});

test("an expired callback from the previous track cannot reset the new widget", async ({
  page,
  baseURL,
}) => {
  const fixture = await syntheticGuest(page, baseURL);
  await restore(page);
  const oldWidget = await begin(page);
  await transport(page, "Next track");
  await expect(
    player(page).getByText(second.title, { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).guestVerificationFixture.rendered
            .length,
      ),
    )
    .toBe(2);
  const newWidget = await page.evaluate(() =>
    (window as unknown as FixtureWindow).guestVerificationFixture.rendered.at(
      -1,
    )!,
  );
  await callback(page, oldWidget, "expired");
  await callback(page, oldWidget, "error");
  await settled(page);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).guestVerificationFixture.resets,
    ),
  ).toEqual([]);
  await expect(dialog(page).getByRole("alert")).toHaveCount(0);
  expect(fixture.requests.posts).toEqual([]);
  expect(fixture.requests.streams).toEqual([]);
  // The current widget still owns its expiry handler.
  await callback(page, newWidget, "expired");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).guestVerificationFixture.resets,
    ),
  ).toEqual([newWidget]);
  await callback(page, newWidget);
  await expect.poll(() => fixture.requests.streams).toEqual([second.id]);
  await noAudio(page);
});
