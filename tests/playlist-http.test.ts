import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ZodError } from "zod";
import type { Database } from "@aurelia/database";

const context = vi.hoisted(() => ({
  db: undefined as Database | undefined,
  headers: new Headers(),
  cookies: new Map<string, string>(),
}));
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
  getDatabase: async () => context.db!,
}));
vi.mock("../apps/web/src/lib/env", () => ({
  env: { APP_URL: "https://aurelia.test" },
}));
vi.mock("../apps/web/src/lib/providers", async () => {
  const { catalogue } = await import("@aurelia/music");
  return {
    trustedTrack: vi.fn(async (id: string) => {
      const track = catalogue.find((entry) => entry.id === id);
      if (!track) throw new Error("Unknown synthetic track");
      return track;
    }),
  };
});

import {
  createDatabase,
  createPlaylist,
  addToPlaylist,
  getLibrary,
} from "@aurelia/database";
import { createSession } from "@aurelia/auth";
import { catalogue } from "@aurelia/music";
import { libraryApi } from "../apps/web/src/lib/api-library";
import {
  assertOrigin,
  assertAccountOwner,
  json,
  SESSION_COOKIE,
} from "../apps/web/src/lib/http";
import { trustedTrack } from "../apps/web/src/lib/providers";

const origin = "https://aurelia.test";
const owner = randomUUID(),
  other = randomUUID();
let web: string, native: string, playlistId: string;
const ids = catalogue.slice(0, 3).map((track) => track.id);
beforeAll(async () => {
  context.db = await createDatabase({ memory: true });
  for (const id of [owner, other])
    await context.db.query(
      "INSERT INTO app_user(id,name) VALUES($1,'Synthetic HTTP owner')",
      [id],
    );
  web = await createSession(context.db, owner);
  native = await createSession(context.db, other, { transport: "native" });
});
afterAll(async () => context.db!.close());
beforeEach(async () => {
  context.cookies.clear();
  context.cookies.set(SESSION_COOKIE, web);
  context.headers = new Headers();
  vi.mocked(trustedTrack).mockClear();
  await context.db!.query("DELETE FROM rate_limit");
  playlistId = await createPlaylist(
    context.db!,
    owner,
    "Original",
    "Keep this description",
  );
  for (const track of catalogue.slice(0, 3))
    await addToPlaylist(context.db!, owner, playlistId, track);
});
function request(
  path: string,
  method: string,
  data?: unknown,
  headers: HeadersInit = {},
) {
  const values = new Headers({
    Origin: origin,
    "X-Aurelia-Account": owner,
    "Content-Type": "application/json",
  });
  new Headers(headers).forEach((value, name) => values.set(name, value));
  const input = new Request(`${origin}/api/library/${path}`, {
    method,
    headers: values,
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  context.headers = input.headers;
  return input;
}
// Exercise the real library handler with the catch-all route's existing security preconditions.
// Full network routing remains covered by the project's E2E suite.
async function execute(
  path: string,
  method: string,
  data?: unknown,
  headers?: HeadersInit,
) {
  const input = request(path, method, data, headers);
  if (!["GET", "HEAD"].includes(method)) await assertOrigin(input);
  await assertAccountOwner(input);
  return (
    (await libraryApi(path.split("/"), input)) ??
    json({ error: "Endpoint not found" }, 404)
  );
}
async function read() {
  return (await getLibrary(context.db!, owner)).playlists.find(
    (entry) => entry.id === playlistId,
  )!;
}

describe("playlist HTTP contracts", () => {
  it("rejects unknown creation fields instead of accepting owner overrides", async () => {
    const before = (await getLibrary(context.db!, owner)).playlists.length;
    await expect(
      execute("playlists", "POST", { name: "Forged owner", userId: other }),
    ).rejects.toBeInstanceOf(ZodError);
    expect((await getLibrary(context.db!, owner)).playlists).toHaveLength(
      before,
    );
  });

  it("accepts partial metadata changes, trims names and preserves omitted fields", async () => {
    const response = await execute(`playlists/${playlistId}`, "PATCH", {
      name: "  Renamed  ",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
    expect(await read()).toMatchObject({
      name: "Renamed",
      description: "Keep this description",
    });
    await execute(`playlists/${playlistId}`, "PATCH", {
      description: "Updated description",
    });
    expect(await read()).toMatchObject({
      name: "Renamed",
      description: "Updated description",
    });
    await execute(`playlists/${playlistId}`, "PATCH", { description: "" });
    expect((await read()).description).toBe("");
  });

  it.each([
    {},
    { name: "  " },
    { name: "x".repeat(121) },
    { description: "x".repeat(1001) },
    { name: null },
    { description: null },
    { name: "Valid", userId: "forged" },
    { title: "Wrong field" },
  ])(
    "rejects invalid or unknown metadata fields without mutation: %j",
    async (input) => {
      await expect(
        execute(`playlists/${playlistId}`, "PATCH", input),
      ).rejects.toBeInstanceOf(ZodError);
      expect(await read()).toMatchObject({
        name: "Original",
        description: "Keep this description",
      });
    },
  );

  it("accepts the maximum metadata lengths and rejects an oversized raw body", async () => {
    await execute(`playlists/${playlistId}`, "PATCH", {
      name: "n".repeat(120),
      description: "d".repeat(1000),
    });
    expect(await read()).toMatchObject({
      name: "n".repeat(120),
      description: "d".repeat(1000),
    });
    await expect(
      execute(`playlists/${playlistId}`, "PATCH", {
        description: "x".repeat(8193),
      }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("uses exact order plus expectedTrackIds for optimistic reorder and returns no-store", async () => {
    const response = await execute(`playlists/${playlistId}/order`, "PUT", {
      trackIds: [...ids].reverse(),
      expectedTrackIds: ids,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
    expect((await read()).tracks.map((track) => track.id)).toEqual(
      [...ids].reverse(),
    );
    await expect(
      execute(`playlists/${playlistId}/order`, "PUT", {
        trackIds: ids,
        expectedTrackIds: ids,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await read()).tracks.map((track) => track.id)).toEqual(
      [...ids].reverse(),
    );
  });

  it("accepts the 5000-ID schema boundary before rejecting stale membership", async () => {
    const trackIds = Array.from(
      { length: 5000 },
      (_, index) => `synthetic-${index}`,
    );
    await expect(
      execute(`playlists/${playlistId}/order`, "PUT", {
        trackIds,
        expectedTrackIds: trackIds,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await read()).tracks.map((track) => track.id)).toEqual(ids);
  });

  it.each([
    { trackIds: [] },
    { trackIds: ids, expectedTrackIds: ids, extra: true },
    { trackIds: [ids[0], ids[0]], expectedTrackIds: ids },
    { trackIds: ids, expectedTrackIds: [ids[0], ids[0]] },
    { trackIds: [""], expectedTrackIds: ids },
    { trackIds: ["x".repeat(161)], expectedTrackIds: ids },
    {
      trackIds: Array.from(
        { length: 5001 },
        (_, index) => `synthetic-${index}`,
      ),
      expectedTrackIds: ids,
    },
  ])("rejects malformed reorder payloads", async (input) => {
    await expect(
      execute(`playlists/${playlistId}/order`, "PUT", input),
    ).rejects.toBeInstanceOf(ZodError);
    expect((await read()).tracks.map((track) => track.id)).toEqual(ids);
  });

  it("never treats trailing/unknown playlist routes as metadata, membership or deletion requests", async () => {
    for (const [suffix, method, input] of [
      ["/unexpected", "PATCH", { name: "Forged" }],
      ["/unexpected", "DELETE", undefined],
      ["/tracks/extra", "DELETE", { trackId: ids[0] }],
      ["/tracks/extra", "POST", { trackId: catalogue[3].id }],
      [
        "/order/extra",
        "PUT",
        { trackIds: [...ids].reverse(), expectedTrackIds: ids },
      ],
      ["/order", "DELETE", undefined],
      ["/order", "PATCH", { name: "Forged" }],
      ["/tracks", "PATCH", { name: "Forged" }],
    ] as const) {
      expect(
        (await execute(`playlists/${playlistId}${suffix}`, method, input))
          .status,
      ).toBe(404);
    }
    expect(vi.mocked(trustedTrack)).not.toHaveBeenCalled();
    expect(await read()).toMatchObject({
      name: "Original",
      description: "Keep this description",
    });
    expect((await read()).tracks.map((track) => track.id)).toEqual(ids);
  });

  it("returns 404 for malformed playlist identities without resolving tracks or executing mutations", async () => {
    for (const id of [
      "not-a-uuid",
      "123",
      "x".repeat(200),
      "ffffffff-ffff-ffff-ffff-fffffffffffZ",
    ]) {
      expect(
        (await execute(`playlists/${id}`, "PATCH", { name: "Forged" })).status,
      ).toBe(404);
      expect((await execute(`playlists/${id}`, "DELETE")).status).toBe(404);
      expect(
        (
          await execute(`playlists/${id}/order`, "PUT", {
            trackIds: ids,
            expectedTrackIds: ids,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await execute(`playlists/${id}/tracks`, "POST", {
            trackId: catalogue[3].id,
          })
        ).status,
      ).toBe(404);
    }
    expect(vi.mocked(trustedTrack)).not.toHaveBeenCalled();
    expect((await read()).tracks.map((track) => track.id)).toEqual(ids);
  });

  it("requires a live owner session, matching account header and trusted web Origin", async () => {
    const path = `playlists/${playlistId}`;
    await expect(
      execute(
        path,
        "PATCH",
        { name: "Forged" },
        { Origin: "https://evil.invalid" },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      execute(
        path,
        "PATCH",
        { name: "Forged" },
        { "X-Aurelia-Account": other },
      ),
    ).rejects.toMatchObject({ status: 409 });
    context.cookies.clear();
    await expect(
      execute(path, "PATCH", { name: "Forged" }),
    ).rejects.toMatchObject({ status: 401 });
    context.cookies.set(SESSION_COOKIE, web);
    expect((await read()).name).toBe("Original");
  });

  it("permits native bearer owner changes while denying access to another owner's playlist", async () => {
    const own = await createPlaylist(context.db!, other, "Native original");
    const headers = {
      Authorization: `Bearer ${native}`,
      "X-Aurelia-Account": other,
      Origin: "https://irrelevant-for-authenticated-native.invalid",
    };
    expect(
      (
        await execute(
          `playlists/${own}`,
          "PATCH",
          { description: "Native update" },
          headers,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await execute(
          `playlists/${own}/order`,
          "PUT",
          { trackIds: [], expectedTrackIds: [] },
          headers,
        )
      ).status,
    ).toBe(200);
    await expect(
      execute(`playlists/${playlistId}`, "PATCH", { name: "Forged" }, headers),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      execute(
        `playlists/${playlistId}/order`,
        "PUT",
        { trackIds: ids, expectedTrackIds: ids },
        headers,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      execute(
        `playlists/${randomUUID()}`,
        "PATCH",
        { name: "Missing" },
        headers,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect((await read()).name).toBe("Original");
  });
});
