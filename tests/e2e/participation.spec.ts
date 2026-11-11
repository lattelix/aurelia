import { randomUUID } from "node:crypto";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { productRegistryV1, type Account } from "@aurelia/core";
import type { ProductFeedback } from "@aurelia/database";

test.use({ serviceWorkers: "block", actionTimeout: 10_000 });
const featureID = "appearance-account-sync";
const feedbackRegion = (page: Page) =>
  page.getByRole("region", { name: "Расскажите о своём опыте", exact: true });
const votingRegion = (page: Page) =>
  page.getByRole("region", { name: "Голос за возможность", exact: true });
const card = (scope: Locator, title: string) =>
  scope.getByRole("listitem").filter({ hasText: title });
const originFor = (baseURL?: string) =>
  new URL(baseURL ?? "http://localhost:3000").origin;

async function forbidPlayerAndExternal(page: Page, origin: string) {
  const unexpected: string[] = [];
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      unexpected.push("external-api");
      return route.abort();
    }
    const path = url.pathname;
    if (
      path === "/api/bootstrap" ||
      path === "/api/audio" ||
      path === "/api/stream"
    ) {
      unexpected.push(path);
      return route.abort();
    }
    return route.continue();
  });
  return unexpected;
}
async function noPlayer(page: Page) {
  await expect(page.locator("audio, video, iframe, .app-shell")).toHaveCount(0);
}
async function noHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
}
async function fillFeedback(page: Page, title: string, body: string) {
  const scope = feedbackRegion(page);
  await scope
    .getByRole("textbox", { name: "Заголовок", exact: true })
    .fill(title);
  const description = scope.getByRole("textbox", {
    name: "Описание",
    exact: true,
  });
  await expect(description).toHaveAccessibleName("Описание");
  await description.fill(body);
}
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test("a local registered account can vote, withdraw and privately create, edit and delete feedback", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(120000);
  const origin = originFor(baseURL);
  // This journey creates and removes synthetic records only on a local test server.
  test.skip(
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname),
    "Synthetic account journey is local-only",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const unexpected = await forbidPlayerAndExternal(page, origin);
  let owner: string | undefined;
  let failed = false;
  try {
    const registration = await context.request.post("/api/auth/register", {
      headers: { Origin: origin },
      data: {
        name: "Synthetic participation QA",
        email: `participation-${randomUUID()}@example.test`,
        password: randomUUID(),
      },
    });
    expect(registration.status()).toBe(200);
    owner = (await registration.json()).user.id as string;
    const headers = { "X-Aurelia-Account": owner };
    const baselineResponse = await context.request.get("/api/product/votes", {
      headers,
    });
    expect(baselineResponse.status()).toBe(200);
    const baseline = (await baselineResponse.json()).counts[
      featureID
    ] as number;

    await page.goto("/roadmap");
    const votes = votingRegion(page);
    const row = votes
      .getByRole("listitem")
      .filter({ has: page.locator(`a[href="/features/${featureID}"]`) });
    await expect(row.getByRole("button")).toBeEnabled();
    await expect(row.getByRole("button")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await row.getByRole("button").click();
    await expect(row.getByRole("button")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(row).toContainText(`${baseline + 1} голосов`);
    await page.reload();
    await expect(row.getByRole("button")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await row.getByRole("button").click();
    await expect(row.getByRole("button")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(row).toContainText(`${baseline} голосов`);
    await page.goto(`/features/${featureID}`);
    await expect(row.getByRole("button")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(row).toContainText(`${baseline} голосов`);

    await page.goto("/feedback");
    const title = `Synthetic feedback ${randomUUID()}`;
    const plain =
      'Literal <strong data-participation-probe="true">plain text</strong> remains text.';
    await fillFeedback(page, title, plain);
    await noHorizontalOverflow(page);
    const creation = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/product/feedback" &&
        response.request().method() === "POST",
    );
    await feedbackRegion(page)
      .getByRole("button", { name: "Отправить обращение", exact: true })
      .click();
    expect((await creation).status()).toBe(201);
    await expect(card(feedbackRegion(page), title)).toContainText(plain);
    await expect(page.locator("[data-participation-probe]")).toHaveCount(0);
    await page.reload();
    await expect(card(feedbackRegion(page), title)).toContainText(plain);

    await card(feedbackRegion(page), title)
      .getByRole("button", { name: "Изменить", exact: true })
      .click();
    const changed = `Updated synthetic ${randomUUID()}`;
    await fillFeedback(
      page,
      changed,
      "Edited synthetic private feedback remains after reloading.",
    );
    await noHorizontalOverflow(page);
    await feedbackRegion(page)
      .getByRole("button", { name: "Сохранить изменения", exact: true })
      .click();
    await expect(card(feedbackRegion(page), changed)).toBeVisible();
    await page.reload();
    await expect(card(feedbackRegion(page), changed)).toContainText(
      "Edited synthetic private feedback remains after reloading.",
    );
    await card(feedbackRegion(page), changed)
      .getByRole("button", { name: "Удалить", exact: true })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: "Удалить обращение?",
      exact: true,
    });
    await expect(confirmation).toBeVisible();
    await noHorizontalOverflow(page);
    await confirmation
      .getByRole("button", { name: "Отмена", exact: true })
      .click();
    await expect(confirmation).toHaveCount(0);
    await expect(card(feedbackRegion(page), changed)).toBeVisible();
    await card(feedbackRegion(page), changed)
      .getByRole("button", { name: "Удалить", exact: true })
      .click();
    await confirmation
      .getByRole("button", { name: "Удалить навсегда", exact: true })
      .click();
    await expect(confirmation).toHaveCount(0);
    await expect(card(feedbackRegion(page), changed)).toHaveCount(0);
    await page.reload();
    await expect(
      feedbackRegion(page).getByText(
        "Обращений пока нет. Первое можно оставить в форме выше.",
      ),
    ).toBeVisible();
    await noPlayer(page);
    expect(unexpected).toEqual([]);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (owner) {
      // Reserve five seconds for cleanup even if the original test deadline fired.
      test.info().setTimeout(test.info().timeout + 5000);
      try {
        const removed = await context.request.delete("/api/auth/account", {
          headers: { Origin: origin, "X-Aurelia-Account": owner },
          timeout: 5000,
        });
        if (removed.status() !== 200)
          throw new Error("Synthetic account cleanup did not confirm");
      } catch {
        if (!failed)
          throw new Error(
            "Synthetic account cleanup did not confirm within five seconds",
          );
        await test
          .info()
          .attach("synthetic-account-cleanup", {
            body: "Cleanup did not confirm within five seconds. The original test failure is preserved.",
            contentType: "text/plain",
          })
          .catch(() => {});
      }
    }
  }
});

const userA: Account = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Synthetic A",
  email: "synthetic-a@example.test",
  identities: ["local"],
};
const userB: Account = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Synthetic B",
  email: "synthetic-b@example.test",
  identities: ["local"],
};
const ownA: ProductFeedback = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  kind: "idea",
  featureId: null,
  title: "Private synthetic owner A",
  body: "Private synthetic feedback belongs only to owner A.",
  revision: 1,
  createdAt: "2026-11-10T12:00:00.000Z",
  updatedAt: "2026-11-10T12:00:00.000Z",
};
const ownB: ProductFeedback = {
  ...ownA,
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  title: "Private synthetic owner B",
  body: "Private synthetic feedback belongs only to owner B.",
};
type Owner = "a" | "b" | null;
interface SyntheticOptions {
  guest?: boolean;
  holdList?: boolean;
  holdPost?: boolean;
  losePost?: boolean;
  expirePost?: boolean;
}

async function syntheticParticipation(
  page: Page,
  baseURL: string | undefined,
  options: SyntheticOptions = {},
) {
  const origin = originFor(baseURL);
  const unexpected = await forbidPlayerAndExternal(page, origin);
  let owner: Owner = options.guest ? null : "a";
  const values: Record<"a" | "b", ProductFeedback[]> = { a: [ownA], b: [ownB] };
  const posts: { owner: string | undefined; data: Record<string, unknown> }[] =
    [];
  const getOwners: (string | undefined)[] = [];
  const held: (() => Promise<void>)[] = [];
  const keys = new Map<string, ProductFeedback>();
  let listHeld = false,
    postHeld = false,
    lost = false;
  async function hold(route: Route, json: unknown) {
    await new Promise<void>((resolve) =>
      held.push(async () => {
        try {
          await route.fulfill({ json });
        } catch {
          /* A scope change can abort this deliberately late response. */
        } finally {
          resolve();
        }
      }),
    );
  }
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push("external-api");
      return route.abort();
    }
    const path = url.pathname;
    const user = owner === "a" ? userA : owner === "b" ? userB : null;
    if (path === "/api/auth/me")
      return route.fulfill({
        status: user ? 200 : 401,
        json: user ? { user } : { error: "Synthetic guest" },
      });
    if (path === "/api/product/votes")
      return route.fulfill({
        json: {
          counts: Object.fromEntries(
            productRegistryV1.features.map((item) => [item.id, 0]),
          ),
          votedFeatureIds: [],
        },
      });
    if (path !== "/api/product/feedback") {
      unexpected.push(path);
      return route.fulfill({
        status: 503,
        json: { error: "Unavailable in synthetic participation fixture" },
      });
    }
    const capturedOwner = request.headers()["x-aurelia-account"];
    if (!user || capturedOwner !== user.id)
      return route.fulfill({
        status: user ? 409 : 401,
        json: { error: "Synthetic account boundary" },
      });
    const captured = owner as "a" | "b";
    if (request.method() === "GET") {
      getOwners.push(capturedOwner);
      const result = { feedback: [...values[captured]], nextCursor: null };
      if (options.holdList && !listHeld) {
        listHeld = true;
        return hold(route, result);
      }
      return route.fulfill({ json: result });
    }
    if (request.method() !== "POST")
      return route.fulfill({
        status: 405,
        json: { error: "Synthetic method unavailable" },
      });
    const data = request.postDataJSON() as Record<string, unknown>;
    posts.push({ owner: capturedOwner, data });
    if (options.expirePost) {
      owner = null;
      return route.fulfill({
        status: 401,
        json: { error: "Synthetic expired session" },
      });
    }
    const key = `${captured}:${String(data.requestId)}`;
    let item = keys.get(key);
    if (!item) {
      item = {
        ...ownA,
        id: randomUUID(),
        kind: data.kind as ProductFeedback["kind"],
        title: String(data.title),
        body: String(data.body),
        featureId: typeof data.featureId === "string" ? data.featureId : null,
      };
      keys.set(key, item);
      values[captured].unshift(item);
    }
    if (options.holdPost && !postHeld) {
      postHeld = true;
      return hold(route, { feedback: item });
    }
    if (options.losePost && !lost) {
      lost = true;
      return route.abort("failed");
    }
    return route.fulfill({ status: 201, json: { feedback: item } });
  });
  return {
    unexpected,
    posts,
    getOwners,
    stored: () => [...keys.values()],
    pending: () => held.length,
    switchOwner: (next: Owner) => {
      owner = next;
    },
    release: async () => {
      for (const release of held.splice(0)) await release();
    },
  };
}
async function refreshSession(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}
async function visibility(page: Page, value: "hidden" | "visible") {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => value,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);
}

test("a guest sees the account link without a private feedback form or player bootstrap", async ({
  page,
  baseURL,
}) => {
  const fixture = await syntheticParticipation(page, baseURL, { guest: true });
  await page.goto("/feedback");
  await expect(
    feedbackRegion(page).getByRole("link", {
      name: "Войдите в аккаунт",
      exact: true,
    }),
  ).toHaveAttribute("href", "/app/account");
  await expect(feedbackRegion(page).locator("form")).toHaveCount(0);
  await page.goto("/roadmap");
  await expect(
    votingRegion(page).getByRole("link", {
      name: "Войдите в аккаунт",
      exact: true,
    }),
  ).toBeVisible();
  expect(await votingRegion(page).getByRole("button").count()).toBeGreaterThan(
    0,
  );
  for (const button of await votingRegion(page).getByRole("button").all())
    await expect(button).toBeDisabled();
  await noPlayer(page);
  expect(fixture.unexpected).toEqual([]);
});

test("an old owner's late feedback GET cannot render after a new owner refresh", async ({
  page,
  baseURL,
}) => {
  const fixture = await syntheticParticipation(page, baseURL, {
    holdList: true,
  });
  try {
    await page.goto("/feedback");
    await expect.poll(fixture.pending).toBe(1);
    fixture.switchOwner("b");
    await refreshSession(page);
    await expect(
      feedbackRegion(page).getByRole("heading", {
        name: ownB.title,
        exact: true,
      }),
    ).toBeVisible();
    await fixture.release();
    await settle(page);
    await expect(
      feedbackRegion(page).getByText(ownA.title, { exact: true }),
    ).toHaveCount(0);
    await expect(
      feedbackRegion(page).getByRole("heading", {
        name: ownB.title,
        exact: true,
      }),
    ).toBeVisible();
    expect(fixture.getOwners).toEqual([userA.id, userB.id]);
    await noPlayer(page);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await fixture.release();
  }
});

test("hiding a pending write clears private UI and ignores its late owner A success in owner B", async ({
  page,
  baseURL,
}) => {
  const fixture = await syntheticParticipation(page, baseURL, {
    holdPost: true,
  });
  const title = "Late synthetic owner A submission";
  try {
    await page.goto("/feedback");
    await fillFeedback(
      page,
      title,
      "This deliberately held write belongs only to owner A.",
    );
    await feedbackRegion(page)
      .getByRole("button", { name: "Отправить обращение", exact: true })
      .click();
    await expect.poll(fixture.pending).toBe(1);
    await visibility(page, "hidden");
    await expect(feedbackRegion(page).locator("form")).toHaveCount(0);
    await expect(
      feedbackRegion(page).getByText(ownA.title, { exact: true }),
    ).toHaveCount(0);
    fixture.switchOwner("b");
    await visibility(page, "visible");
    await expect(
      feedbackRegion(page).getByRole("heading", {
        name: ownB.title,
        exact: true,
      }),
    ).toBeVisible();
    await fixture.release();
    await settle(page);
    await expect(
      feedbackRegion(page).getByText(title, { exact: true }),
    ).toHaveCount(0);
    await expect(
      feedbackRegion(page).getByText("Обращение сохранено.", { exact: true }),
    ).toHaveCount(0);
    expect(fixture.posts).toHaveLength(1);
    expect(fixture.posts[0].owner).toBe(userA.id);
    await noPlayer(page);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await fixture.release();
  }
});

test("a lost creation response retries the same request ID without duplicating private feedback", async ({
  page,
  baseURL,
}) => {
  const fixture = await syntheticParticipation(page, baseURL, {
    losePost: true,
  });
  const title = "Synthetic unchanged retry";
  await page.goto("/feedback");
  await fillFeedback(
    page,
    title,
    "A lost response must preserve this unchanged draft and request ID.",
  );
  const send = feedbackRegion(page).getByRole("button", {
    name: "Отправить обращение",
    exact: true,
  });
  await send.click();
  await expect(feedbackRegion(page).getByRole("alert")).toContainText(
    "Не удалось получить подтверждение сервера",
  );
  await expect(
    feedbackRegion(page).getByLabel("Заголовок", { exact: true }),
  ).toHaveValue(title);
  await send.click();
  await expect(card(feedbackRegion(page), title)).toBeVisible();
  expect(fixture.posts).toHaveLength(2);
  expect(fixture.posts[0].data.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(fixture.posts[1]).toEqual(fixture.posts[0]);
  expect(fixture.stored()).toHaveLength(1);
  await expect(card(feedbackRegion(page), title)).toHaveCount(1);
  await noPlayer(page);
  expect(fixture.unexpected).toEqual([]);
});

test("a 401 on a private mutation removes the old draft and returns to guest controls", async ({
  page,
  baseURL,
}) => {
  const fixture = await syntheticParticipation(page, baseURL, {
    expirePost: true,
  });
  await page.goto("/feedback");
  await fillFeedback(
    page,
    "Synthetic expired draft",
    "An expired session must not keep a prior owner's private workspace.",
  );
  await feedbackRegion(page)
    .getByRole("button", { name: "Отправить обращение", exact: true })
    .click();
  await expect(
    feedbackRegion(page).getByRole("link", {
      name: "Войдите в аккаунт",
      exact: true,
    }),
  ).toBeVisible();
  await expect(feedbackRegion(page).locator("form")).toHaveCount(0);
  await expect(
    feedbackRegion(page).getByText(ownA.title, { exact: true }),
  ).toHaveCount(0);
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.stored()).toEqual([]);
  await noPlayer(page);
  expect(fixture.unexpected).toEqual([]);
});
