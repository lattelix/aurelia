import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, type Account } from "@aurelia/core";
import {
  createGuestAccess,
  GUEST_CAPABILITY_COOKIE,
  type GuestAdmission,
} from "../apps/web/src/lib/guest-access";

const context = vi.hoisted(() => ({
  db: {},
  cookies: new Map<string, string>(),
  user: null as Account | null,
  service: undefined as
    | ReturnType<
        typeof import("../apps/web/src/lib/guest-access").createGuestAccess
      >
    | undefined,
  rateLimit:
    vi.fn<(_db: unknown, key: string, limit: number) => Promise<void>>(),
  fetcher: vi.fn<typeof fetch>(),
  account: vi.fn(),
  authorization: vi.fn(),
  admit:
    vi.fn<
      (input: {
        token: unknown;
        origin: string | null;
      }) => Promise<GuestAdmission>
    >(),
}));
vi.mock("../apps/web/src/lib/env", () => ({
  env: { APP_URL: "https://aurelia.test" },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => {
      const value = context.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));
vi.mock("@aurelia/database", () => ({ getDatabase: async () => context.db }));
vi.mock("@aurelia/auth", () => ({
  rateLimit: context.rateLimit,
  sessionAccount: vi.fn(),
}));
vi.mock("../apps/web/src/lib/http", async (original) => ({
  ...(await original<typeof import("../apps/web/src/lib/http")>()),
  account: context.account,
}));
vi.mock("../apps/web/src/lib/guest-policy", () => ({
  guestAccess: {
    publicConfig: () => context.service!.publicConfig(),
    admit: context.admit,
  },
  guestAuthorization: context.authorization,
}));

import { guestApi } from "../apps/web/src/lib/api-guest";

const origin = "https://aurelia.test";
const instant = Date.UTC(2026, 10, 10, 12);
const secret = "synthetic-provider-secret-never-a-real-key";
const siteKey = "synthetic-public-site-key";
function service(mode: "off" | "required" = "required", configured = true) {
  return createGuestAccess(
    {
      mode,
      appUrl: origin,
      siteKey,
      ...(configured ? { secretKey: secret } : {}),
    },
    {
      fetch: context.fetcher,
      now: () => instant,
      randomBytes: (size) =>
        Uint8Array.from({ length: size }, (_, index) => index),
    },
  );
}
function request(
  method = "GET",
  value?: string,
  requestOrigin: string | null = origin,
  extra: HeadersInit = {},
) {
  const headers = new Headers(extra);
  if (requestOrigin !== null) headers.set("Origin", requestOrigin);
  if (value !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`${origin}/api/guest`, {
    method,
    headers,
    ...(value !== undefined ? { body: value } : {}),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  context.cookies.clear();
  context.user = null;
  context.rateLimit.mockReset().mockResolvedValue(undefined);
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
  context.service = service();
  context.account.mockImplementation(async () => context.user);
  context.authorization.mockImplementation(async () =>
    context.service!.authorize(context.cookies.get(GUEST_CAPABILITY_COOKIE)),
  );
  context.admit
    .mockReset()
    .mockImplementation((input) => context.service!.admit(input));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected live network request");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("guest admission HTTP API", () => {
  it("returns only public status fields without a cookie, secret or capability identity", async () => {
    const admission = await context.service!.admit({
      token: "synthetic-token",
      origin,
    });
    if (!admission.ok || admission.mode !== "required")
      throw new Error("Expected synthetic admission");
    context.cookies.set(GUEST_CAPABILITY_COOKIE, admission.cookie.value);
    const response = await guestApi(request());
    expect(await response.json()).toEqual({
      required: true,
      allowed: true,
      ready: true,
      action: "listen_guest",
      siteKey,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(context.rateLimit).not.toHaveBeenCalled();
  });

  it("allows an already verified account without consulting guest credentials", async () => {
    context.user = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Synthetic listener",
      email: null,
      identities: [],
    };
    context.cookies.set(GUEST_CAPABILITY_COOKIE, "synthetic-invalid-cookie");
    expect(await (await guestApi(request())).json()).toEqual({
      required: true,
      allowed: true,
      ready: true,
      action: "listen_guest",
      siteKey,
    });
    expect(context.authorization).not.toHaveBeenCalled();
  });

  it("admits through the canonical origin and places the capability only in an HttpOnly cookie", async () => {
    const response = await guestApi(
      request("POST", JSON.stringify({ token: "synthetic-token" })),
    );
    expect(response.status).toBe(200);
    expect(context.admit).toHaveBeenCalledWith({
      token: "synthetic-token",
      origin,
    });
    expect(context.rateLimit).toHaveBeenCalledWith(
      context.db,
      "guest-admission:global",
      60,
    );
    expect(context.rateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      context.admit.mock.invocationCallOrder[0],
    );
    expect(await response.json()).toEqual({ ok: true });
    const cookie = response.cookies.get(GUEST_CAPABILITY_COOKIE);
    expect(cookie?.value).toMatch(/^v1\./);
    expect(context.service!.authorize(cookie?.value).allowed).toBe(true);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
    expect(response.headers.get("set-cookie")).toContain("Path=/");
  });

  it.each([null, "https://untrusted.invalid", `${origin}/app`])(
    "rejects an untrusted origin %s before any provider call",
    async (requestOrigin) => {
      const response = await guestApi(
        request(
          "POST",
          JSON.stringify({ token: "synthetic-token" }),
          requestOrigin,
        ),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "Guest verification failed. Please retry.",
        code: "guest_origin_untrusted",
      });
      expect(context.admit).toHaveBeenCalledWith({
        token: "synthetic-token",
        origin: requestOrigin,
      });
      expect(context.fetcher).not.toHaveBeenCalled();
      expect(response.headers.get("set-cookie")).toBeNull();
    },
  );

  it("bounds actual UTF-8 body bytes even without content-length", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ token: "é".repeat(1540) }),
    );
    expect(bytes.length).toBeGreaterThan(3072);
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel: cancelled,
    });
    const input = new Request(`${origin}/api/guest`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(guestApi(input)).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(context.admit).not.toHaveBeenCalled();
    expect(context.fetcher).not.toHaveBeenCalled();
  });

  it("accepts exactly three KiB but rejects one extra byte or a larger declared body", async () => {
    const data = JSON.stringify({ token: "synthetic-token" }).padEnd(3072, " ");
    expect((await guestApi(request("POST", data))).status).toBe(200);
    context.admit.mockClear();
    context.fetcher.mockClear();
    await expect(guestApi(request("POST", data + " "))).rejects.toMatchObject({
      status: 413,
    });
    await expect(
      guestApi(request("POST", "{}", origin, { "Content-Length": "3073" })),
    ).rejects.toMatchObject({ status: 413 });
    expect(context.admit).not.toHaveBeenCalled();
    expect(context.fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before attempting verification", async () => {
    await expect(guestApi(request("POST", "{"))).rejects.toMatchObject({
      status: 400,
    });
    expect(context.admit).not.toHaveBeenCalled();
    expect(context.fetcher).not.toHaveBeenCalled();
  });

  it("enforces the admission budget before spending a provider request", async () => {
    context.rateLimit.mockRejectedValue(
      new AppError(429, "Synthetic admission limit"),
    );
    await expect(
      guestApi(request("POST", JSON.stringify({ token: "synthetic-token" }))),
    ).rejects.toMatchObject({ status: 429 });
    expect(context.admit).not.toHaveBeenCalled();
    expect(context.fetcher).not.toHaveBeenCalled();
  });

  it.each(["PUT", "PATCH", "DELETE", "HEAD"])(
    "returns 405 for %s without auth, admission or budget work",
    async (method) => {
      const response = await guestApi(request(method));
      expect(response.status).toBe(405);
      expect(context.account).not.toHaveBeenCalled();
      expect(context.authorization).not.toHaveBeenCalled();
      expect(context.admit).not.toHaveBeenCalled();
      expect(context.rateLimit).not.toHaveBeenCalled();
    },
  );

  it("preserves off mode without generating a cookie or consulting Siteverify", async () => {
    context.service = service("off");
    expect(await (await guestApi(request())).json()).toEqual({
      required: false,
      allowed: true,
      ready: true,
      action: "listen_guest",
    });
    const response = await guestApi(request("POST", "{}"));
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(context.fetcher).not.toHaveBeenCalled();
  });

  it("reports unconfigured verification without exposing server settings", async () => {
    context.service = service("required", false);
    expect(await (await guestApi(request())).json()).toEqual({
      required: true,
      allowed: false,
      ready: false,
      action: "listen_guest",
    });
    const response = await guestApi(
      request("POST", JSON.stringify({ token: "synthetic-token" })),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Guest access is temporarily unavailable.",
      code: "guest_verification_unavailable",
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
