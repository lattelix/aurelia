import { appHref } from "../../apps/web/src/lib/app-navigation";
import { test, expect, type Page } from "@playwright/test";
import type { Account, Library } from "@aurelia/core";
import { catalogue, albums, artists, editorialPlaylists } from "@aurelia/music";
import { signInWithEmail } from "./auth-helpers";

// Every API response in this file must come from its synthetic route fixture.
// WebKit service-worker-controlled requests can bypass Playwright page.route.
test.use({ serviceWorkers: "block" });

const accountA: Account = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Account A fixture",
  email: "a@example.test",
  identities: ["local"],
};
const accountB: Account = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Account B fixture",
  email: "b@example.test",
  identities: ["local"],
};
const queue = (index: number) => ({
  queue: [catalogue[index]],
  index: 0,
  position: 11,
  duration: 72,
  playing: false,
  shuffle: false,
  repeat: "off",
  volume: 0,
  autoplay: false,
  mode: "audio",
  quality: "balanced",
});
function library(owner: "a" | "b"): Library {
  return {
    likes: [],
    playlists: [
      {
        id: `playlist-${owner}`,
        name: `Private ${owner.toUpperCase()} playlist`,
        description: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        tracks: [],
      },
    ],
    history: [],
    searches: [],
    followedArtists: [],
    queue: queue(owner === "a" ? 0 : 1),
  };
}

/** All account/API responses are synthetic; no real login, cookie, DB write or media transport. */
async function syntheticAccounts(page: Page) {
  let user: Account | null = accountA;
  let data = library("a");
  let holdNext = false;
  let release: (() => Promise<void>) | null = null;
  const writes: {
    owner: string | undefined;
    state: ReturnType<typeof queue>;
  }[] = [];
  const bootstrap = () => ({
    user,
    library: user ? data : null,
    catalogue,
    albums,
    artists,
    editorialPlaylists,
    capabilities: {
      localAccounts: true,
      google: false,
      telegram: false,
      apple: false,
      youtube: false,
    },
    recommendations: [],
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(
      /^\/api\//,
      "",
    );
    if (path === "bootstrap") {
      const captured = structuredClone(bootstrap());
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => {
          release = async () => {
            await route.fulfill({ json: captured });
            resolve();
          };
        });
      } else await route.fulfill({ json: captured });
    } else if (path === "auth/logout") {
      user = null;
      await route.fulfill({ json: { ok: true } });
    } else if (path === "auth/email") {
      await route.fulfill({ json: { step: "password" } });
    } else if (path === "auth/login" || path === "auth/register") {
      user = accountB;
      data = library("b");
      await route.fulfill({ json: { user } });
    } else if (path === "library/queue") {
      const owner = route.request().headers()["x-aurelia-account"];
      writes.push({ owner, state: route.request().postDataJSON() });
      await route.fulfill({
        status: owner === user?.id ? 200 : 409,
        json: { ok: owner === user?.id },
      });
    } else if (path === "library/playlists") {
      const owner = route.request().headers()["x-aurelia-account"];
      if (owner !== user?.id) {
        await route.fulfill({
          status: 409,
          json: { error: "Wrong synthetic owner" },
        });
        return;
      }
      data = {
        ...data,
        queue: queue(1),
        playlists: [
          ...data.playlists,
          {
            id: "new-playlist-a",
            name: "New A discovery",
            description: "",
            createdAt: "2026-01-01T00:00:00.000Z",
            tracks: [],
          },
        ],
      };
      await route.fulfill({ json: { id: "new-playlist-a" } });
    } else
      await route.fulfill({
        status: 503,
        json: { error: "Unavailable in synthetic account QA" },
      });
  });
  return {
    writes,
    hold: () => {
      holdNext = true;
    },
    pending: () => release !== null,
    release: async () => {
      if (!release) throw new Error("Synthetic delayed bootstrap missing");
      const current = release;
      release = null;
      await current();
    },
  };
}

test("late A bootstrap cannot replace B library/player or save A queue under B", async ({
  page,
}) => {
  const fixture = await syntheticAccounts(page);
  try {
    await page.goto(appHref("/account"));
    await expect(
      page.getByRole("heading", { name: accountA.name, exact: true }),
    ).toBeVisible();
    fixture.hold();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(fixture.pending).toBe(true);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page
      .getByRole("button", { name: "Create account or sign in", exact: true })
      .click();
    await signInWithEmail(page, {
      email: accountB.email!,
      password: "synthetic-only-passphrase",
    });
    await expect(
      page.getByRole("heading", { name: accountB.name, exact: true }),
    ).toBeVisible();
    await fixture.release();
    await expect(
      page.getByRole("heading", { name: accountB.name, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Private A playlist", exact: false }),
    ).toHaveCount(0);
    await expect(page.locator(".playing-text strong")).toHaveText(
      catalogue[1].title,
    );
    await expect
      .poll(() => fixture.writes.some((write) => write.owner === accountB.id), {
        timeout: 12000,
      })
      .toBe(true);
    expect(
      fixture.writes
        .filter((write) => write.owner === accountB.id)
        .every((write) =>
          write.state.queue.every((track) => track.id !== catalogue[0].id),
        ),
    ).toBe(true);
    await expect(
      page.getByText("Your account changed. Please try again.", {
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    if (fixture.pending()) await fixture.release();
  }
});

test("new same-owner mutation wins over older focus refresh and leaves the local paused queue intact", async ({
  page,
}) => {
  const fixture = await syntheticAccounts(page);
  try {
    await page.goto(appHref("/library"));
    await expect(page.locator(".playing-text strong")).toHaveText(
      catalogue[0].title,
    );
    fixture.hold();
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(fixture.pending).toBe(true);
    await page
      .getByRole("button", { name: "New playlist", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("Name", { exact: true })
      .fill("New A discovery");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create playlist", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "New A discovery", exact: true }),
    ).toBeVisible();
    await fixture.release();
    await expect(
      page.getByRole("heading", { name: "New A discovery", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".playing-text strong")).toHaveText(
      catalogue[0].title,
    );
    expect(
      await page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem(
              `aurelia.player.${"11111111-1111-4111-8111-111111111111"}`,
            ) ?? "{}",
          ).playing ?? false,
      ),
    ).toBe(false);
  } finally {
    if (fixture.pending()) await fixture.release();
  }
});
