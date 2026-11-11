import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Database, ProductFeedback } from "@aurelia/database";
import type { ProductRegistryV1 } from "@aurelia/core";

const context = vi.hoisted(() => ({
  db: undefined as Database | undefined,
  headers: new Headers(),
  cookies: new Map<string, string>(),
  registry: undefined as ProductRegistryV1 | undefined,
  baseline: undefined as ProductRegistryV1 | undefined,
}));
vi.mock("@aurelia/core", async (original) => {
  const actual = await original<typeof import("@aurelia/core")>();
  context.baseline = structuredClone(actual.productRegistryV1);
  context.registry = structuredClone(actual.productRegistryV1);
  return { ...actual, productRegistryV1: context.registry };
});
vi.mock("next/headers", () => ({
  headers: async () => context.headers,
  cookies: async () => ({
    get: (name: string) => {
      const value = context.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));
vi.mock("@aurelia/database", async (original) => ({
  ...(await original<typeof import("@aurelia/database")>()),
  getDatabase: async () => {
    if (!context.db) throw new Error("Synthetic database not initialized");
    return context.db;
  },
}));
vi.mock("../apps/web/src/lib/env", () => ({
  env: { APP_URL: "https://aurelia.test" },
}));

import { ProductRegistryV1Schema } from "@aurelia/core";
import { createDatabase, createProductFeedback } from "@aurelia/database";
import { createSession, hashToken } from "@aurelia/auth";
import { productApi } from "../apps/web/src/lib/api-product";
import { assertOrigin, SESSION_COOKIE } from "../apps/web/src/lib/http";

const origin = "https://aurelia.test";
const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";
const feature = "listening-rooms";
const instant = Date.now();
let webA: string, webB: string, nativeA: string;
const db = () => context.db!;
const registry = () => context.registry!;
function draft(overrides: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    kind: "idea",
    title: "Synthetic private feedback",
    body: "A bounded synthetic feedback description.",
    featureId: feature,
    ...overrides,
  };
}
function signIn(owner: "a" | "b" | null = "a") {
  context.cookies.clear();
  if (owner) context.cookies.set(SESSION_COOKIE, owner === "a" ? webA : webB);
}
function input(
  path: string,
  method = "GET",
  data?: unknown,
  headers: HeadersInit = {},
) {
  const values = new Headers({
    Origin: origin,
    "X-Aurelia-Account": ownerA,
  });
  new Headers(headers).forEach((value, key) => values.set(key, value));
  if (data !== undefined) values.set("Content-Type", "application/json");
  const request = new Request(`${origin}/api/product/${path}`, {
    method,
    headers: values,
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  context.headers = request.headers;
  return request;
}
async function call(
  path: string,
  method = "GET",
  data?: unknown,
  headers: HeadersInit = {},
) {
  const request = input(path, method, data, headers);
  // The existing dispatcher applies this guard before dispatching any mutation.
  if (!["GET", "HEAD"].includes(method)) await assertOrigin(request);
  return productApi(path.split("?")[0].split("/"), request);
}
async function created(data = draft()) {
  const response = await call("feedback", "POST", data);
  expect(response?.status).toBe(201);
  return (await response!.json()).feedback as ProductFeedback;
}
async function ownFeedback(query = "") {
  return (await (await call(`feedback${query}`))!.json()) as {
    feedback: ProductFeedback[];
    nextCursor: string | null;
  };
}
function enableVoting() {
  registry().services.voting = "connected";
  const item = registry().features.find((item) => item.id === feature)!;
  const reviewed = {
    assessment: "reviewed" as const,
    result: "unknown" as const,
    summary: "Synthetic review records an explicit unknown estimate.",
    assumptions: "Synthetic assumptions require a bounded discovery exercise.",
    risks: "Synthetic risks remain unknown until the discovery exercise.",
  };
  item.assessment = {
    status: "reviewed",
    reviewedAt: "2026-11-10",
    effort: { ...reviewed },
    runningCash: { ...reviewed },
    maintenance: { ...reviewed },
  };
  item.voting.enabled = true;
  ProductRegistryV1Schema.parse(registry());
}
async function fillBudget(key: string, count: number, seconds = 60) {
  await db().query(
    "INSERT INTO rate_limit(key,bucket,count) VALUES($1,$2,$3)",
    [hashToken(key), Math.floor(instant / (seconds * 1000)), count],
  );
}

beforeAll(async () => {
  context.db = await createDatabase({ memory: true });
});
afterAll(async () => {
  await context.db?.close();
});
beforeEach(async () => {
  await db().query("DELETE FROM app_user");
  await db().query("DELETE FROM rate_limit");
  for (const [id, name] of [
    [ownerA, "Synthetic A"],
    [ownerB, "Synthetic B"],
  ])
    await db().query("INSERT INTO app_user(id,name) VALUES($1,$2)", [id, name]);
  webA = await createSession(db(), ownerA);
  webB = await createSession(db(), ownerB);
  nativeA = await createSession(db(), ownerA, { transport: "native" });
  Object.assign(registry(), structuredClone(context.baseline!));
  registry().services.voting = "not-connected";
  for (const item of registry().features) item.voting.enabled = false;
  const item = registry().features.find((item) => item.id === feature)!;
  item.assessment = {
    status: "unestimated",
    effort: { assessment: "unestimated" },
    runningCash: { assessment: "unestimated" },
    maintenance: { assessment: "unestimated" },
  };
  signIn();
  vi.spyOn(Date, "now").mockReturnValue(instant);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network forbidden in synthetic product checks");
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("product votes over verified HTTP ownership and a temporary database", () => {
  it("returns complete zero counts to guests without exposing any owner information", async () => {
    signIn(null);
    const response = await call("votes");
    const value = await response!.json();
    expect(value).toEqual({
      counts: Object.fromEntries(
        registry().features.map((item) => [item.id, 0]),
      ),
      votedFeatureIds: [],
    });
    expect(response!.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects an unestimated feature even for a verified owner", async () => {
    await expect(call(`votes/${feature}`, "PUT", {})).rejects.toMatchObject({
      status: 409,
    });
    expect((await (await call("votes"))!.json()).counts[feature]).toBe(0);
  });

  it("never infers voting eligibility from an account or an enabled service alone", async () => {
    registry().services.voting = "connected";
    await expect(call(`votes/${feature}`, "PUT", {})).rejects.toMatchObject({
      status: 409,
    });
    enableVoting();
    registry().services.voting = "not-connected";
    await expect(call(`votes/${feature}`, "PUT", {})).rejects.toMatchObject({
      status: 409,
    });
  });

  it("keeps concurrent duplicate votes at one account vote and separates another account", async () => {
    enableVoting();
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => call(`votes/${feature}`, "PUT", {})),
    );
    expect(outcomes.every((item) => item?.status === 200)).toBe(true);
    expect(await (await call("votes"))!.json()).toMatchObject({
      counts: { [feature]: 1 },
      votedFeatureIds: [feature],
    });
    signIn("b");
    expect(
      await (await call("votes", "GET", undefined, {
        "X-Aurelia-Account": ownerB,
      }))!.json(),
    ).toMatchObject({ counts: { [feature]: 1 }, votedFeatureIds: [] });
    await call(`votes/${feature}`, "PUT", {}, { "X-Aurelia-Account": ownerB });
    expect(
      await (await call("votes", "GET", undefined, {
        "X-Aurelia-Account": ownerB,
      }))!.json(),
    ).toMatchObject({ counts: { [feature]: 2 }, votedFeatureIds: [feature] });
  });

  it("allows idempotent withdrawal after voting closes without removing another account's vote", async () => {
    enableVoting();
    await call(`votes/${feature}`, "PUT", {});
    signIn("b");
    await call(`votes/${feature}`, "PUT", {}, { "X-Aurelia-Account": ownerB });
    signIn();
    registry().services.voting = "not-connected";
    registry().features.find((item) => item.id === feature)!.voting.enabled =
      false;
    for (let index = 0; index < 2; index++)
      expect(
        await (await call(`votes/${feature}`, "DELETE", {}))!.json(),
      ).toMatchObject({ counts: { [feature]: 1 }, votedFeatureIds: [] });
    signIn("b");
    expect(
      (
        await (await call("votes", "GET", undefined, {
          "X-Aurelia-Account": ownerB,
        }))!.json()
      ).votedFeatureIds,
    ).toEqual([feature]);
  });

  it.each(["PUT", "DELETE"])(
    "requires a verified owner for %s even with native-looking headers",
    async (method) => {
      signIn(null);
      await expect(
        call(
          `votes/${feature}`,
          method,
          {},
          { "User-Agent": "Aurelia Native", "X-Aurelia-Native": "true" },
        ),
      ).rejects.toMatchObject({ status: 401 });
    },
  );

  it("rejects a stale account header for both own-vote reads and changes", async () => {
    await expect(
      call("votes", "GET", undefined, { "X-Aurelia-Account": ownerB }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      call(`votes/${feature}`, "PUT", {}, { "X-Aurelia-Account": ownerB }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("accepts a live native session only with a matching owner and rejects a forged bearer", async () => {
    enableVoting();
    signIn(null);
    expect(
      (
        await call(
          `votes/${feature}`,
          "PUT",
          {},
          { Authorization: `Bearer ${nativeA}` },
        )
      )?.status,
    ).toBe(200);
    await expect(
      call(
        `votes/${feature}`,
        "DELETE",
        {},
        { Authorization: `Bearer ${"x".repeat(43)}` },
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      call(
        `votes/${feature}`,
        "DELETE",
        {},
        { Authorization: `Bearer ${nativeA}`, "X-Aurelia-Account": ownerB },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects an unknown feature and does not accept arbitrary vote payload fields", async () => {
    await expect(
      call("votes/not-a-registry-feature", "PUT", {}),
    ).rejects.toMatchObject({ name: "ZodError" });
    enableVoting();
    await expect(
      call(`votes/${feature}`, "PUT", { userId: ownerB, weight: 99 }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect((await (await call("votes"))!.json()).counts[feature]).toBe(0);
  });

  it.each([`product:votes-write:${ownerA}`, "product:votes-write:global"])(
    "enforces the atomic %s budget before a vote is stored",
    async (key) => {
      enableVoting();
      await fillBudget(key, key.endsWith(":global") ? 300 : 30);
      await expect(call(`votes/${feature}`, "PUT", {})).rejects.toMatchObject({
        status: 429,
      });
      expect((await (await call("votes"))!.json()).counts[feature]).toBe(0);
    },
  );
});

describe("private product feedback HTTP contract", () => {
  it("creates trimmed feedback with an explicit response allowlist and no owner/request identifier", async () => {
    const item = await created(
      draft({
        title: "  Synthetic title  ",
        body: "  Synthetic private description.  ",
      }),
    );
    expect(Object.keys(item).sort()).toEqual(
      [
        "id",
        "kind",
        "featureId",
        "title",
        "body",
        "revision",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
    expect(item).toMatchObject({
      title: "Synthetic title",
      body: "Synthetic private description.",
      revision: 1,
      kind: "idea",
      featureId: feature,
    });
    expect(Date.parse(item.createdAt)).toBeGreaterThan(0);
    const response = await call("feedback");
    expect(response!.headers.get("cache-control")).toBe("no-store");
    expect(await response!.json()).toEqual({
      feedback: [item],
      nextCursor: null,
    });
  });

  it("replays a concurrent client request ID once and rejects a changed payload", async () => {
    const data = draft();
    const pair = await Promise.all([created(data), created(data)]);
    expect(pair[0]).toEqual(pair[1]);
    expect((await ownFeedback()).feedback).toHaveLength(1);
    await expect(
      call("feedback", "POST", {
        ...data,
        body: "A different synthetic request body.",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await ownFeedback()).feedback).toHaveLength(1);
  });

  it("lists only the current owner and does not distinguish someone else's ID from a missing ID", async () => {
    const item = await created();
    signIn("b");
    const response = await call("feedback", "GET", undefined, {
      "X-Aurelia-Account": ownerB,
    });
    expect(await response!.json()).toEqual({ feedback: [], nextCursor: null });
    const missing = await call(
      `feedback/${randomUUID()}`,
      "PATCH",
      { expectedRevision: 1, title: "Synthetic change" },
      { "X-Aurelia-Account": ownerB },
    ).catch((error: unknown) => error);
    const foreign = await call(
      `feedback/${item.id}`,
      "PATCH",
      { expectedRevision: 1, title: "Synthetic change" },
      { "X-Aurelia-Account": ownerB },
    ).catch((error: unknown) => error);
    expect(missing).toMatchObject({ status: 404 });
    expect(foreign).toMatchObject({
      status: 404,
      message: (missing as Error).message,
    });
    await expect(
      call(
        `feedback/${item.id}`,
        "DELETE",
        { expectedRevision: 1 },
        { "X-Aurelia-Account": ownerB },
      ),
    ).rejects.toMatchObject({ status: 404 });
    signIn();
    expect((await ownFeedback()).feedback).toEqual([item]);
  });

  it("uses revisions to reject a stale edit and deletion without losing the current item", async () => {
    const item = await created();
    const response = await call(`feedback/${item.id}`, "PATCH", {
      expectedRevision: 1,
      title: "Updated synthetic title",
      featureId: null,
    });
    const update = (await response!.json()).feedback as ProductFeedback;
    expect(update).toMatchObject({
      id: item.id,
      revision: 2,
      title: "Updated synthetic title",
      featureId: null,
    });
    await expect(
      call(`feedback/${item.id}`, "PATCH", {
        expectedRevision: 1,
        body: "Stale synthetic description.",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      call(`feedback/${item.id}`, "DELETE", { expectedRevision: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await ownFeedback()).feedback).toEqual([update]);
    expect(
      await (await call(`feedback/${item.id}`, "DELETE", {
        expectedRevision: 2,
      }))!.json(),
    ).toEqual({ ok: true });
    expect((await ownFeedback()).feedback).toEqual([]);
  });

  it("accepts only one of two edits that started from the same revision", async () => {
    const item = await created();
    const updates = await Promise.allSettled([
      call(`feedback/${item.id}`, "PATCH", {
        expectedRevision: 1,
        title: "First synthetic revision",
      }),
      call(`feedback/${item.id}`, "PATCH", {
        expectedRevision: 1,
        title: "Second synthetic revision",
      }),
    ]);
    expect(updates.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(
      updates
        .filter((item) => item.status === "rejected")
        .map((item) =>
          item.status === "rejected"
            ? (item.reason as { status: number }).status
            : null,
        ),
    ).toEqual([409]);
    expect((await ownFeedback()).feedback[0].revision).toBe(2);
  });

  it("paginates a bounded owner-only list without losing or repeating an item", async () => {
    for (let index = 0; index < 3; index++)
      await createProductFeedback(
        db(),
        ownerA,
        draft({ title: `Synthetic item ${index}` }) as Parameters<
          typeof createProductFeedback
        >[2],
      );
    await createProductFeedback(
      db(),
      ownerB,
      draft() as Parameters<typeof createProductFeedback>[2],
    );
    const first = await ownFeedback("?limit=2");
    expect(first.feedback).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await ownFeedback(
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(second.feedback).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.feedback, ...second.feedback].map((item) => item.id))
        .size,
    ).toBe(3);
  });

  it.each([null, "wrong-owner"])(
    "requires a live account and matching captured owner for private feedback (%s)",
    async (owner) => {
      if (owner === null) signIn(null);
      const headers: HeadersInit =
        owner === null ? {} : { "X-Aurelia-Account": ownerB };
      await expect(
        call("feedback", "GET", undefined, headers),
      ).rejects.toMatchObject({ status: owner === null ? 401 : 409 });
      await expect(
        call("feedback", "POST", draft(), headers),
      ).rejects.toMatchObject({ status: owner === null ? 401 : 409 });
    },
  );

  it.each([
    { title: "xx" },
    { title: "x".repeat(161) },
    { body: "short" },
    { body: "x".repeat(4001) },
    { kind: "question" },
    { featureId: "unknown-feature" },
    { requestId: "not-a-uuid" },
    { userId: ownerB },
    { body: "Synthetic\0invalid text" },
  ])("rejects invalid feedback fields before storage: %j", async (invalid) => {
    await expect(
      call("feedback", "POST", draft(invalid)),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect((await ownFeedback()).feedback).toEqual([]);
  });

  it("bounds UTF-8 request bytes independently of character limits", async () => {
    const data = draft({ body: "界".repeat(3000) });
    expect([...String(data.body)].length).toBeLessThan(4000);
    await expect(call("feedback", "POST", data)).rejects.toMatchObject({
      status: 413,
    });
    expect((await ownFeedback()).feedback).toEqual([]);
  });

  it("requires an actual change and a positive revision for edits and deletion", async () => {
    const item = await created();
    for (const value of [
      { expectedRevision: 1 },
      { expectedRevision: 0, title: "Synthetic" },
      { expectedRevision: 1, requestId: randomUUID(), title: "Synthetic" },
    ])
      await expect(
        call(`feedback/${item.id}`, "PATCH", value),
      ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      call(`feedback/${item.id}`, "DELETE", { expectedRevision: 0 }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect((await ownFeedback()).feedback).toEqual([item]);
  });

  it.each([
    ["?limit=51", { name: "ZodError" }],
    ["?limit=1&limit=2", { status: 400 }],
    ["?ownerId=other", { name: "ZodError" }],
    ["?cursor=" + "x".repeat(513), { name: "ZodError" }],
  ])("rejects invalid pagination %s", async (query, failure) => {
    await expect(call("feedback" + query)).rejects.toMatchObject(failure);
  });

  it.each([
    `product:feedback-create:${ownerA}`,
    "product:feedback-create:global",
  ])("applies the atomic %s admission limit before storage", async (key) => {
    await fillBudget(key, key.endsWith(":global") ? 100 : 5, 3600);
    await expect(call("feedback", "POST", draft())).rejects.toMatchObject({
      status: 429,
    });
    expect((await ownFeedback()).feedback).toEqual([]);
  });

  it("keeps the dispatcher's canonical Origin guard ahead of mutation work", async () => {
    await expect(
      call("feedback", "POST", draft(), {
        Origin: "https://untrusted.invalid",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await ownFeedback()).feedback).toEqual([]);
  });

  it("returns null for unknown paths and 405 for known paths with unsupported methods", async () => {
    expect(await call("unknown")).toBeNull();
    expect(await call("votes/extra/path")).toBeNull();
    for (const [path, method] of [
      ["votes", "POST"],
      [`votes/${feature}`, "GET"],
      ["feedback", "PUT"],
      [`feedback/${randomUUID()}`, "GET"],
    ]) {
      const response = await call(path, method);
      expect(response?.status).toBe(405);
      expect(await response!.json()).toEqual({ error: "Method not allowed" });
    }
  });
});
