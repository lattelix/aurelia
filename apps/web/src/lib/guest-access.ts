// Server-only: Node cryptography and server-supplied secrets must never enter a client graph.
import {
  createHash,
  createHmac,
  randomBytes as secureRandomBytes,
  timingSafeEqual,
} from "node:crypto";

export const GUEST_CAPABILITY_COOKIE = "__Host-aurelia_guest";
export const GUEST_VERIFICATION_ACTION = "listen_guest";
export const GUEST_CAPABILITY_MAX_SECONDS = 30 * 60;
const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_BYTES = 2048;
const MAX_RESPONSE_BYTES = 8192;
const MAX_VERIFY_MS = 10_000;
const MAX_CHALLENGE_AGE_MS = 300_000;

export interface GuestAccessConfig {
  mode?: "off" | "required";
  appUrl: string;
  siteKey?: string;
  secretKey?: string;
  /** Optional dedicated server key. Otherwise a separated key derives from secretKey. */
  capabilitySecret?: string;
}

export interface GuestAccessDependencies {
  fetch?: typeof globalThis.fetch;
  /** Milliseconds since Unix epoch. */
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  timeoutMs?: number;
  ttlSeconds?: number;
}

type FailureCode =
  | "guest_verification_unavailable"
  | "guest_verification_required"
  | "guest_verification_failed"
  | "guest_invalid_request"
  | "guest_origin_untrusted";
export type GuestAccessFailure = {
  ok: false;
  status: 400 | 403 | 503;
  code: FailureCode;
};
export type GuestCapability = { guestId: string; expiresAt: number };
export type GuestAuthorization =
  | { allowed: true; mode: "off" }
  | ({ allowed: true; mode: "required" } & GuestCapability)
  | { allowed: false; status: 403 | 503; code: FailureCode };
export type GuestAdmission =
  | { ok: true; mode: "off" }
  | ({
      ok: true;
      mode: "required";
      cookie: {
        name: typeof GUEST_CAPABILITY_COOKIE;
        value: string;
        options: {
          httpOnly: true;
          secure: true;
          sameSite: "lax";
          path: "/";
          maxAge: number;
        };
      };
    } & GuestCapability)
  | GuestAccessFailure;

const unavailable = (): GuestAccessFailure => ({
  ok: false,
  status: 503,
  code: "guest_verification_unavailable",
});
const required = (): GuestAuthorization => ({
  allowed: false,
  status: 403,
  code: "guest_verification_required",
});

function canonicalOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return;
    return url.origin;
  } catch {
    return;
  }
}

function boundedSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 32 &&
    Buffer.byteLength(value, "utf8") <= 4096
  );
}

function challengeTimestamp(value: unknown): number | undefined {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  )
    return;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return;
  const canonical = value.replace(
    /(?:\.(\d+))?Z$/,
    (_, fraction: string | undefined) =>
      `.${(fraction ?? "").padEnd(3, "0").slice(0, 3)}Z`,
  );
  if (new Date(parsed).toISOString() !== canonical) return;
  return parsed;
}

async function responseJSON(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (response.status !== 200 || !response.body)
    throw new Error("verification response");
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)
  )
    throw new Error("verification size");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("verification deadline");
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        cancel();
        throw new Error("verification size");
      }
      chunks.push(next.value);
    }
    if (signal.aborted) throw new Error("verification deadline");
    const bytes = Buffer.concat(chunks, size);
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/**
 * Browser media eligibility only. The caller must still apply account policy,
 * atomic per-guest AND global admission budgets. No IP, UA or bearer-header bypass.
 * Cookie values are credentials: set them as HttpOnly cookies, never JSON or logs.
 */
export function createGuestAccess(
  config: GuestAccessConfig,
  dependencies: GuestAccessDependencies = {},
) {
  const mode = config.mode ?? "off";
  const origin = canonicalOrigin(config.appUrl);
  const siteKeyValid =
    typeof config.siteKey === "string" &&
    /^[A-Za-z0-9_-]{1,256}$/.test(config.siteKey);
  const secret = config.capabilitySecret ?? config.secretKey;
  const timeoutMs = dependencies.timeoutMs ?? MAX_VERIFY_MS;
  const ttlSeconds = dependencies.ttlSeconds ?? GUEST_CAPABILITY_MAX_SECONDS;
  const boundsValid =
    Number.isInteger(timeoutMs) &&
    timeoutMs > 0 &&
    timeoutMs <= MAX_VERIFY_MS &&
    Number.isInteger(ttlSeconds) &&
    ttlSeconds > 0 &&
    ttlSeconds <= GUEST_CAPABILITY_MAX_SECONDS;
  const ready =
    !!origin &&
    siteKeyValid &&
    boundedSecret(config.secretKey) &&
    boundedSecret(secret) &&
    boundsValid;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const randomBytes = dependencies.randomBytes ?? secureRandomBytes;
  const key = ready
    ? createHmac("sha256", secret!)
        .update("aurelia.browser-media-guest.key.v1\0")
        .update(origin!)
        .digest()
    : undefined;
  const signature = (payload: string) =>
    createHmac("sha256", key!).update(payload).digest();
  const guestId = (nonce: string) =>
    createHash("sha256")
      .update("aurelia.browser-media-guest.id.v1\0")
      .update(origin!)
      .update("\0")
      .update(nonce)
      .digest("hex");

  function authorize(cookieValue?: string): GuestAuthorization {
    if (mode === "off") return { allowed: true, mode: "off" };
    if (mode !== "required" || !ready || !key)
      return {
        allowed: false,
        status: 503,
        code: "guest_verification_unavailable",
      };
    if (typeof cookieValue !== "string" || cookieValue.length > 160)
      return required();
    const match =
      /^v1\.(0|[1-9]\d{0,11})\.(0|[1-9]\d{0,11})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(
        cookieValue,
      );
    if (!match) return required();
    const issued = Number(match[1]);
    const expires = Number(match[2]);
    const current = now();
    if (
      !Number.isSafeInteger(issued * 1000) ||
      !Number.isSafeInteger(expires * 1000) ||
      !Number.isFinite(current) ||
      issued * 1000 > current ||
      expires * 1000 <= current ||
      expires <= issued ||
      expires - issued > GUEST_CAPABILITY_MAX_SECONDS
    )
      return required();
    const nonce = Buffer.from(match[3], "base64url");
    const actual = Buffer.from(match[4], "base64url");
    if (
      nonce.length !== 32 ||
      nonce.toString("base64url") !== match[3] ||
      actual.length !== 32 ||
      actual.toString("base64url") !== match[4]
    )
      return required();
    const payload = cookieValue.slice(0, cookieValue.lastIndexOf("."));
    if (!timingSafeEqual(signature(payload), actual)) return required();
    return {
      allowed: true,
      mode: "required",
      guestId: guestId(match[3]),
      expiresAt: expires * 1000,
    };
  }

  async function admit(input: {
    token: unknown;
    origin: string | null;
  }): Promise<GuestAdmission> {
    if (!origin) return unavailable();
    if (input.origin !== origin)
      return { ok: false, status: 403, code: "guest_origin_untrusted" };
    if (mode === "off") return { ok: true, mode: "off" };
    if (mode !== "required" || !ready || !key) return unavailable();
    if (
      typeof input.token !== "string" ||
      !input.token.trim() ||
      Buffer.byteLength(input.token, "utf8") > MAX_TOKEN_BYTES
    )
      return { ok: false, status: 400, code: "guest_invalid_request" };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("verification deadline"));
        }, timeoutMs);
      });
      const verify = async () => {
        const response = await fetcher(SITEVERIFY_URL, {
          method: "POST",
          redirect: "error",
          cache: "no-store",
          credentials: "omit",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            secret: config.secretKey!,
            response: input.token as string,
          }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) throw new Error("verification deadline");
        return responseJSON(response, controller.signal);
      };
      const data = await Promise.race([verify(), deadline]);
      const record =
        data && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : undefined;
      const checkedAt = record
        ? challengeTimestamp(record.challenge_ts)
        : undefined;
      const current = now();
      if (
        !record ||
        record.success !== true ||
        record.action !== GUEST_VERIFICATION_ACTION ||
        record.hostname !== new URL(origin).hostname ||
        checkedAt === undefined ||
        !Number.isFinite(current) ||
        current < checkedAt ||
        current - checkedAt > MAX_CHALLENGE_AGE_MS
      )
        return { ok: false, status: 403, code: "guest_verification_failed" };
      const nonce = randomBytes(32);
      if (!(nonce instanceof Uint8Array) || nonce.byteLength !== 32)
        return unavailable();
      const issued = Math.floor(current / 1000);
      const expires = issued + ttlSeconds;
      if (
        !Number.isSafeInteger(issued) ||
        issued < 0 ||
        !Number.isSafeInteger(expires * 1000)
      )
        return unavailable();
      const encoded = Buffer.from(nonce).toString("base64url");
      const payload = `v1.${issued}.${expires}.${encoded}`;
      return {
        ok: true,
        mode: "required",
        guestId: guestId(encoded),
        expiresAt: expires * 1000,
        cookie: {
          name: GUEST_CAPABILITY_COOKIE,
          value: `${payload}.${signature(payload).toString("base64url")}`,
          options: {
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            path: "/",
            maxAge: ttlSeconds,
          },
        },
      };
    } catch {
      return unavailable();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }

  return {
    publicConfig: () => ({
      mode,
      ready: mode === "off" || (mode === "required" && ready),
      action: GUEST_VERIFICATION_ACTION,
      ...(mode === "required" && ready ? { siteKey: config.siteKey! } : {}),
    }),
    authorize,
    admit,
  };
}
