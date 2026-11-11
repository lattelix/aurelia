import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGuestAccess,
  GUEST_CAPABILITY_COOKIE,
  GUEST_CAPABILITY_MAX_SECONDS,
  type GuestAccessConfig,
  type GuestAccessDependencies,
} from "../apps/web/src/lib/guest-access";

const instant = Date.UTC(2026, 10, 10, 12);
const config: GuestAccessConfig = {
  mode: "required",
  appUrl: "https://aurelia.lattelix.com",
  siteKey: "0xSyntheticPublicSiteKey",
  secretKey: "synthetic-provider-secret-never-a-real-key",
};
const valid = () => ({
  success: true,
  action: "listen_guest",
  hostname: "aurelia.lattelix.com",
  challenge_ts: new Date(instant).toISOString(),
});
function fixture(
  record: unknown = valid(),
  extra: GuestAccessDependencies = {},
  settings: Partial<GuestAccessConfig> = {},
) {
  let current = instant;
  let seed = 0;
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(record), {
        headers: { "content-type": "application/json" },
      }),
  );
  const service = createGuestAccess(
    { ...config, ...settings },
    {
      fetch: fetcher,
      now: () => current,
      randomBytes: (size) =>
        Uint8Array.from({ length: size }, (_, i) => (i + ++seed) % 256),
      ...extra,
    },
  );
  return {
    service,
    fetcher,
    setTime: (value: number) => {
      current = value;
    },
  };
}
async function admitted(service: ReturnType<typeof createGuestAccess>) {
  const result = await service.admit({
    token: "synthetic-token",
    origin: config.appUrl,
  });
  if (!result.ok || result.mode !== "required")
    throw new Error("Expected synthetic admission");
  return result;
}
afterEach(() => {
  vi.useRealTimers();
});

describe("bounded browser guest admission", () => {
  it("preserves the existing off path without a provider request or cookie", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = createGuestAccess(
      { appUrl: config.appUrl },
      { fetch: fetcher },
    );
    expect(service.publicConfig()).toEqual({
      mode: "off",
      ready: true,
      action: "listen_guest",
    });
    expect(service.authorize()).toEqual({ allowed: true, mode: "off" });
    expect(await service.admit({ token: null, origin: config.appUrl })).toEqual(
      { ok: true, mode: "off" },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses only the fixed Siteverify origin with a credential-free bounded POST", async () => {
    const value = fixture();
    await admitted(value.service);
    expect(value.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = value.fetcher.mock.calls[0];
    expect(url).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const body = init?.body as URLSearchParams;
    expect([...body.keys()].sort()).toEqual(["response", "secret"]);
    expect(body.get("response")).toBe("synthetic-token");
    expect(body.get("secret")).toBe(config.secretKey);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("exposes only the explicitly public widget configuration", () => {
    const value = fixture();
    expect(value.service.publicConfig()).toEqual({
      mode: "required",
      ready: true,
      action: "listen_guest",
      siteKey: config.siteKey,
    });
    expect(JSON.stringify(value.service.publicConfig())).not.toContain(
      config.secretKey!,
    );
  });

  it.each([
    { secretKey: undefined },
    { siteKey: undefined },
    { siteKey: "not a public key" },
    { secretKey: "short" },
    { capabilitySecret: "short" },
    { appUrl: "https://user:password@aurelia.lattelix.com" },
    { appUrl: "file:///private/example" },
    { appUrl: "https://aurelia.lattelix.com/path" },
  ])("fails closed for required configuration %j", async (settings) => {
    const value = fixture(valid(), {}, settings);
    expect(value.service.publicConfig()).toMatchObject({
      mode: "required",
      ready: false,
    });
    expect(value.service.publicConfig()).not.toHaveProperty("siteKey");
    expect(value.service.authorize()).toMatchObject({
      allowed: false,
      status: 503,
    });
    expect(
      await value.service.admit({
        token: "synthetic-token",
        origin: config.appUrl,
      }),
    ).toMatchObject({ ok: false, status: 503 });
    expect(value.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    null,
    "null",
    "https://aurelia.lattelix.com/",
    "https://aurelia.lattelix.com.evil",
    "http://aurelia.lattelix.com",
    "https://other.invalid",
  ])("requires the exact configured admission Origin %s", async (origin) => {
    const value = fixture();
    expect(
      await value.service.admit({ token: "synthetic-token", origin }),
    ).toEqual({ ok: false, status: 403, code: "guest_origin_untrusted" });
    expect(value.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    123,
    {},
    "",
    " ",
    "a".repeat(2049),
    "é".repeat(1025),
  ])(
    "bounds untrusted token input before contacting the provider",
    async (token) => {
      const value = fixture();
      expect(
        await value.service.admit({ token, origin: config.appUrl }),
      ).toEqual({ ok: false, status: 400, code: "guest_invalid_request" });
      expect(value.fetcher).not.toHaveBeenCalled();
    },
  );

  it("accepts the inclusive 2048-byte token bound", async () => {
    const value = fixture();
    expect(
      await value.service.admit({
        token: "a".repeat(2048),
        origin: config.appUrl,
      }),
    ).toMatchObject({ ok: true, mode: "required" });
    expect(value.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { success: "true" },
    { success: 1 },
    { success: false },
    { action: "other" },
    { action: undefined },
    { hostname: "aurelia.lattelix.com.evil" },
    { hostname: "other.invalid" },
    { challenge_ts: undefined },
    { challenge_ts: "yesterday" },
    { challenge_ts: "2026-11-10" },
    { challenge_ts: new Date(instant + 1).toISOString() },
    { challenge_ts: new Date(instant - 300_001).toISOString() },
  ])(
    "requires exact success, action, hostname and recent timestamp %j",
    async (change) => {
      const value = fixture({ ...valid(), ...change });
      expect(
        await value.service.admit({
          token: "synthetic-token",
          origin: config.appUrl,
        }),
      ).toEqual({ ok: false, status: 403, code: "guest_verification_failed" });
    },
  );

  it("accepts a challenge exactly five minutes old but rejects invalid calendar dates", async () => {
    const boundary = fixture({
      ...valid(),
      challenge_ts: new Date(instant - 300_000).toISOString(),
    });
    await admitted(boundary.service);
    const invalid = fixture({
      ...valid(),
      challenge_ts: "2026-02-30T12:00:00.000Z",
    });
    invalid.setTime(Date.UTC(2026, 2, 2, 12));
    expect(
      await invalid.service.admit({
        token: "synthetic-token",
        origin: config.appUrl,
      }),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it.each([null, [], "success", true])(
    "rejects non-object verification payload %j",
    async (payload) => {
      const value = fixture(payload);
      expect(
        await value.service.admit({
          token: "synthetic-token",
          origin: config.appUrl,
        }),
      ).toMatchObject({ ok: false, status: 403 });
    },
  );

  it.each([302, 429, 500])(
    "fails closed for upstream status %s",
    async (status) => {
      const fetcher = vi.fn<typeof fetch>(
        async () => new Response("upstream", { status }),
      );
      expect(
        await fixture(valid(), { fetch: fetcher }).service.admit({
          token: "synthetic-token",
          origin: config.appUrl,
        }),
      ).toMatchObject({ ok: false, status: 503 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("maps network and decoding failures to a fixed error without payload disclosure", async () => {
    const network = fixture(valid(), {
      fetch: async () => {
        throw new Error("synthetic-private-upstream-detail");
      },
    });
    expect(
      await network.service.admit({
        token: "synthetic-token",
        origin: config.appUrl,
      }),
    ).toEqual({
      ok: false,
      status: 503,
      code: "guest_verification_unavailable",
    });
    for (const bytes of [
      new Uint8Array([0xff]),
      new TextEncoder().encode("not JSON"),
    ]) {
      const malformed = fixture(valid(), {
        fetch: async () => new Response(bytes),
      });
      expect(
        await malformed.service.admit({
          token: "synthetic-token",
          origin: config.appUrl,
        }),
      ).toEqual({
        ok: false,
        status: 503,
        code: "guest_verification_unavailable",
      });
    }
  });

  it("bounds both declared and streamed response bytes and cancels oversized streams", async () => {
    const declared = fixture(valid(), {
      fetch: async () =>
        new Response("{}", { headers: { "content-length": "8193" } }),
    });
    expect(
      await declared.service.admit({
        token: "synthetic-token",
        origin: config.appUrl,
      }),
    ).toMatchObject({ ok: false, status: 503 });
    let cancelled = false;
    const streamed = fixture(valid(), {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(8192));
              controller.enqueue(new Uint8Array(1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    expect(
      await streamed.service.admit({
        token: "synthetic-token",
        origin: config.appUrl,
      }),
    ).toMatchObject({ ok: false, status: 503 });
    expect(cancelled).toBe(true);
  });

  it("enforces a ten-second deadline even when injected fetch ignores cancellation", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const service = fixture(valid(), {
      fetch: async (_, init) => {
        signal = init?.signal;
        return new Promise<Response>(() => {});
      },
    }).service;
    const result = service.admit({
      token: "synthetic-token",
      origin: config.appUrl,
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ ok: false, status: 503 });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies the same deadline while reading a stalled body", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const service = fixture(valid(), {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    }).service;
    const result = service.admit({
      token: "synthetic-token",
      origin: config.appUrl,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ ok: false, status: 503 });
    expect(cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects unsafe timeout, lifetime and randomness configuration", async () => {
    for (const extra of [
      { timeoutMs: 10_001 },
      { timeoutMs: 0 },
      { ttlSeconds: 1801 },
      { ttlSeconds: 0 },
    ]) {
      const value = fixture(valid(), extra);
      expect(value.service.publicConfig().ready).toBe(false);
      expect(
        await value.service.admit({
          token: "synthetic-token",
          origin: config.appUrl,
        }),
      ).toMatchObject({ ok: false, status: 503 });
      expect(value.fetcher).not.toHaveBeenCalled();
    }
    for (const randomBytes of [
      () => new Uint8Array(31),
      () => {
        throw new Error("random unavailable");
      },
    ]) {
      expect(
        await fixture(valid(), { randomBytes }).service.admit({
          token: "synthetic-token",
          origin: config.appUrl,
        }),
      ).toMatchObject({ ok: false, status: 503 });
    }
  });
});

describe("reusable signed guest capability", () => {
  it("sets a secure host-only HttpOnly cookie and exposes only a hashed rate-limit identity", async () => {
    const value = fixture();
    const result = await admitted(value.service);
    expect(result.cookie.name).toBe(GUEST_CAPABILITY_COOKIE);
    expect(result.cookie.options).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 1800,
    });
    expect(result.cookie.options).not.toHaveProperty("domain");
    expect(result.expiresAt - instant).toBe(
      GUEST_CAPABILITY_MAX_SECONDS * 1000,
    );
    expect(result.guestId).toMatch(/^[a-f0-9]{64}$/);
    expect(result.cookie.value).not.toContain(result.guestId);
    expect(value.service.authorize(result.cookie.value)).toEqual({
      allowed: true,
      mode: "required",
      guestId: result.guestId,
      expiresAt: result.expiresAt,
    });
    expect(value.service.authorize(result.cookie.value)).toMatchObject({
      allowed: true,
      guestId: result.guestId,
    });
    expect(value.fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not renew the lifetime on repeated reads and expires at the exact deadline", async () => {
    const value = fixture();
    const result = await admitted(value.service);
    value.setTime(result.expiresAt - 1);
    expect(value.service.authorize(result.cookie.value)).toMatchObject({
      allowed: true,
      expiresAt: result.expiresAt,
    });
    value.setTime(result.expiresAt);
    expect(value.service.authorize(result.cookie.value)).toMatchObject({
      allowed: false,
      status: 403,
    });
    value.setTime(instant - 1);
    expect(value.service.authorize(result.cookie.value)).toMatchObject({
      allowed: false,
      status: 403,
    });
  });

  it("uses new 256-bit nonces for separate admissions", async () => {
    const value = fixture();
    const first = await admitted(value.service);
    const second = await admitted(value.service);
    expect(first.cookie.value).not.toBe(second.cookie.value);
    expect(first.guestId).not.toBe(second.guestId);
    expect(
      Buffer.from(first.cookie.value.split(".")[3], "base64url"),
    ).toHaveLength(32);
  });

  it("rejects nonce, version, expiry and MAC tampering", async () => {
    const value = fixture();
    const result = await admitted(value.service);
    const fields = result.cookie.value.split(".");
    for (let index = 0; index < fields.length; index++) {
      const changed = [...fields];
      changed[index] =
        index === 0
          ? "v2"
          : index < 3
            ? String(Number(fields[index]) + 1)
            : `${fields[index][0] === "A" ? "B" : "A"}${fields[index].slice(1)}`;
      expect(value.service.authorize(changed.join("."))).toMatchObject({
        allowed: false,
        status: 403,
      });
    }
    expect(value.service.authorize(`${result.cookie.value}=`)).toMatchObject({
      allowed: false,
      status: 403,
    });
    expect(value.service.authorize("a".repeat(161))).toMatchObject({
      allowed: false,
      status: 403,
    });
    expect(value.service.authorize()).toMatchObject({
      allowed: false,
      status: 403,
    });
  });

  it("rejects noncanonical base64 aliases even if decoded MAC bytes match", async () => {
    const value = fixture();
    const result = await admitted(value.service);
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const fields = result.cookie.value.split(".");
    const mac = fields[4];
    fields[4] = `${mac.slice(0, -1)}${alphabet[alphabet.indexOf(mac.at(-1)!) + 1]}`;
    expect(Buffer.from(fields[4], "base64url")).toEqual(
      Buffer.from(mac, "base64url"),
    );
    expect(value.service.authorize(fields.join("."))).toMatchObject({
      allowed: false,
      status: 403,
    });
  });

  it("binds the MAC to its server secret and canonical app origin", async () => {
    const value = fixture();
    const result = await admitted(value.service);
    expect(
      fixture(
        valid(),
        {},
        { secretKey: "another-synthetic-provider-secret-at-least-32" },
      ).service.authorize(result.cookie.value),
    ).toMatchObject({ allowed: false });
    expect(
      fixture(
        valid(),
        {},
        { appUrl: "https://another.invalid" },
      ).service.authorize(result.cookie.value),
    ).toMatchObject({ allowed: false });
    const dedicated = fixture(
      valid(),
      {},
      { capabilitySecret: "dedicated-synthetic-capability-secret-at-least-32" },
    );
    const dedicatedResult = await admitted(dedicated.service);
    expect(value.service.authorize(dedicatedResult.cookie.value)).toMatchObject(
      { allowed: false },
    );
    expect(
      dedicated.service.authorize(dedicatedResult.cookie.value),
    ).toMatchObject({ allowed: true });
  });
});
