import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, type Account, type Track } from "@aurelia/core";
import { GUEST_CAPABILITY_COOKIE } from "../apps/web/src/lib/guest-access";

const context = vi.hoisted(() => ({
  env: {
    APP_URL: "https://aurelia.test",
    WEB_GUEST_VERIFICATION: "required" as "off" | "required",
    TURNSTILE_SITE_KEY: "synthetic-public-site-key",
    TURNSTILE_SECRET_KEY: "synthetic-provider-secret-never-a-real-key",
  },
  db: {},
  cookies: new Map<string, string>(),
  user: null as Account | null,
  rateLimit:
    vi.fn<(_db: unknown, key: string, limit: number) => Promise<void>>(),
  fetcher: vi.fn<typeof fetch>(),
  account: vi.fn(),
  gateway: vi.fn(),
  audio: vi.fn(),
  trustedTrack: vi.fn(),
  stream: vi.fn(),
}));
vi.mock("../apps/web/src/lib/env", () => ({
  env: context.env,
  capabilities: { demoCatalogue: false },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = context.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));
vi.mock("@aurelia/database", () => ({
  getDatabase: async () => context.db,
  getLibrary: vi.fn(),
  getSignals: vi.fn(),
}));
vi.mock("@aurelia/auth", () => ({ rateLimit: context.rateLimit }));
vi.mock("@aurelia/player", () => ({
  PlayerSnapshotSchema: { safeParse: vi.fn(() => ({ success: false })) },
}));
vi.mock("../apps/web/src/lib/http", () => ({
  account: context.account,
  json: (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    }),
}));
vi.mock("../apps/web/src/lib/youtube-media/gateway-client", () => ({
  gatewayAudio: context.gateway,
}));
vi.mock("../apps/web/src/lib/youtube-media/audio-response", () => ({
  audioResponse: context.audio,
}));
vi.mock("../apps/web/src/lib/providers", () => ({
  trustedTrack: context.trustedTrack,
  providerFor: () => ({ getStream: context.stream }),
  studio: {},
  youtube: {},
}));
vi.mock("../apps/web/src/lib/youtube-media/discovery", () => ({
  getMusicDiscovery: vi.fn(),
}));
vi.mock("../apps/web/src/lib/youtube-media/catalogue", () => ({
  getMusicCatalogue: vi.fn(),
}));

const instant = Date.UTC(2026, 10, 10, 12);
const user: Account = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Synthetic listener",
  email: null,
  identities: [],
};
const track: Track = {
  id: "youtube:aqz-KE-bpKQ",
  externalId: "aqz-KE-bpKQ",
  provider: "youtube",
  title: "Synthetic recording",
  artist: "Synthetic artist",
  artistId: "synthetic-artist",
  album: "Synthetic album",
  albumId: "synthetic-album",
  duration: 60,
  artwork: "",
  genre: "Music",
  year: 2026,
};
const policy = () => import("../apps/web/src/lib/guest-policy");
function rateKeys() {
  return context.rateLimit.mock.calls.map(([, key, limit]) => [key, limit]);
}
async function admit() {
  const { guestAccess } = await policy();
  const result = await guestAccess.admit({
    token: "synthetic-token",
    origin: context.env.APP_URL,
  });
  if (!result.ok || result.mode !== "required")
    throw new Error("Expected synthetic admission");
  context.cookies.set(GUEST_CAPABILITY_COOKIE, result.cookie.value);
  return result;
}
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  context.env.WEB_GUEST_VERIFICATION = "required";
  context.cookies.clear();
  context.user = null;
  context.rateLimit.mockReset().mockResolvedValue(undefined);
  context.account.mockImplementation(async () => context.user);
  context.gateway.mockResolvedValue(new Response("synthetic audio"));
  context.audio.mockResolvedValue(new Response("synthetic fallback"));
  context.trustedTrack.mockResolvedValue(track);
  context.stream.mockResolvedValue({
    kind: "youtube",
    videoId: track.externalId,
    capabilities: { background: false, seek: true, mediaSession: false },
  });
  context.fetcher.mockReset().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          action: "listen_guest",
          hostname: "aurelia.test",
          challenge_ts: new Date(instant).toISOString(),
        }),
      ),
  );
  vi.spyOn(Date, "now").mockReturnValue(instant);
  vi.stubGlobal("fetch", context.fetcher);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser media guest policy", () => {
  it.each(["missing", "tampered"])(
    "denies a %s capability before audio gateway or fallback work",
    async (kind) => {
      if (kind === "tampered") {
        const result = await admit();
        const parts = result.cookie.value.split(".");
        parts[3] = `${parts[3][0] === "A" ? "B" : "A"}${parts[3].slice(1)}`;
        context.cookies.set(GUEST_CAPABILITY_COOKIE, parts.join("."));
      }
      const { audioApi } =
        await import("../apps/web/src/lib/youtube-media/audio-api");
      await expect(
        audioApi(
          new Request(
            `${context.env.APP_URL}/api/audio?id=${track.externalId}`,
          ),
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(context.gateway).not.toHaveBeenCalled();
      expect(context.audio).not.toHaveBeenCalled();
      expect(context.rateLimit).not.toHaveBeenCalled();
    },
  );

  it("does not begin a source stream for an unverified anonymous listener", async () => {
    const { musicApi } = await import("../apps/web/src/lib/api-music");
    await expect(
      musicApi(
        ["stream"],
        new Request(`${context.env.APP_URL}/api/stream?id=${track.id}`),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(context.stream).not.toHaveBeenCalled();
    expect(context.trustedTrack).not.toHaveBeenCalled();
  });

  it("applies a valid guest capability to separate guest and shared budgets before media", async () => {
    const access = await admit();
    context.fetcher.mockClear();
    const { audioApi } =
      await import("../apps/web/src/lib/youtube-media/audio-api");
    expect(
      (
        await audioApi(
          new Request(
            `${context.env.APP_URL}/api/audio?id=${track.externalId}`,
          ),
        )
      )?.status,
    ).toBe(200);
    expect(rateKeys()).toEqual([
      [`audio:${access.guestId}`, 120],
      ["browser-media:global", 360],
      ["browser-media:guest-global", 120],
    ]);
    expect(
      Math.max(...context.rateLimit.mock.invocationCallOrder),
    ).toBeLessThan(context.gateway.mock.invocationCallOrder[0]);
    expect(context.fetcher).not.toHaveBeenCalled();
  });

  it("uses the guest identity and the requested family budget for source resolution", async () => {
    const access = await admit();
    const { musicApi } = await import("../apps/web/src/lib/api-music");
    expect(
      (
        await musicApi(
          ["stream"],
          new Request(`${context.env.APP_URL}/api/stream?id=${track.id}`),
        )
      )?.status,
    ).toBe(200);
    expect(rateKeys()).toEqual([
      [`resolve:${access.guestId}`, 30],
      ["browser-media:global", 360],
      ["browser-media:guest-global", 120],
    ]);
    expect(
      Math.max(...context.rateLimit.mock.invocationCallOrder),
    ).toBeLessThan(context.stream.mock.invocationCallOrder[0]);
  });

  it("accepts a verified account without guest proof while retaining account and shared limits", async () => {
    context.user = user;
    context.cookies.set(GUEST_CAPABILITY_COOKIE, "synthetic-invalid-cookie");
    const { audioApi } =
      await import("../apps/web/src/lib/youtube-media/audio-api");
    expect(
      (
        await audioApi(
          new Request(
            `${context.env.APP_URL}/api/audio?id=${track.externalId}`,
          ),
        )
      )?.status,
    ).toBe(200);
    expect(rateKeys()).toEqual([
      [`audio:${user.id}`, 120],
      ["browser-media:global", 360],
    ]);
    expect(context.fetcher).not.toHaveBeenCalled();
  });

  it("stops authenticated media work when the shared budget rejects admission", async () => {
    context.user = user;
    context.rateLimit.mockImplementation(async (_db, key) => {
      if (key === "browser-media:global")
        throw new AppError(429, "Synthetic global limit");
    });
    const { audioApi } =
      await import("../apps/web/src/lib/youtube-media/audio-api");
    await expect(
      audioApi(new Request(`${context.env.APP_URL}/api/audio`)),
    ).rejects.toMatchObject({ status: 429 });
    expect(rateKeys()).toEqual([
      [`audio:${user.id}`, 120],
      ["browser-media:global", 360],
    ]);
    expect(context.gateway).not.toHaveBeenCalled();
  });

  it("does not treat platform or authorization header strings as a verified account", async () => {
    const { audioApi } =
      await import("../apps/web/src/lib/youtube-media/audio-api");
    await expect(
      audioApi(
        new Request(`${context.env.APP_URL}/api/audio`, {
          headers: {
            "User-Agent": "Aurelia for iPhone",
            "X-Aurelia-Native": "true",
            Authorization: "Bearer synthetic-unverified-header",
          },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(context.account).toHaveBeenCalledOnce();
    expect(context.gateway).not.toHaveBeenCalled();
    expect(context.rateLimit).not.toHaveBeenCalled();
  });

  it.each([null, user])(
    "preserves the old family rate when verification is off",
    async (verified) => {
      context.env.WEB_GUEST_VERIFICATION = "off";
      const { mediaRequestBudget } = await policy();
      await mediaRequestBudget(verified, "resolve", 30);
      expect(rateKeys()).toEqual([[`resolve:${verified?.id ?? "guest"}`, 30]]);
      expect(context.fetcher).not.toHaveBeenCalled();
    },
  );

  it("keeps two admitted guests in separate rate buckets", async () => {
    const first = await admit();
    const second = await admit();
    expect(first.guestId).not.toBe(second.guestId);
    const { mediaRequestBudget } = await policy();
    context.cookies.set(GUEST_CAPABILITY_COOKIE, first.cookie.value);
    await mediaRequestBudget(null, "resolve", 30);
    context.cookies.set(GUEST_CAPABILITY_COOKIE, second.cookie.value);
    await mediaRequestBudget(null, "resolve", 30);
    expect(
      rateKeys().filter(([key]) => String(key).startsWith("resolve:")),
    ).toEqual([
      [`resolve:${first.guestId}`, 30],
      [`resolve:${second.guestId}`, 30],
    ]);
  });
});
