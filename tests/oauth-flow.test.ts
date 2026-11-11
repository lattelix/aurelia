import { createHash } from "node:crypto";
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
import type { Database } from "@aurelia/database";

const context = vi.hoisted(() => ({
  db: undefined as Database | undefined,
  headers: new Headers(),
  cookies: new Map<string, string>(),
  counter: 0,
  authorize: vi.fn(),
  grant: vi.fn(),
  importSpotify: vi.fn(),
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
  getDatabase: async () => {
    if (!context.db) throw new Error("Synthetic database not initialized");
    return context.db;
  },
}));
vi.mock("../apps/web/src/lib/env", () => ({
  env: {
    APP_URL: "https://aurelia.test",
    LOCAL_ACCOUNTS: "true",
    GOOGLE_CLIENT_ID: "synthetic-google",
    GOOGLE_CLIENT_SECRET: "synthetic-only",
    TELEGRAM_CLIENT_ID: "synthetic-telegram",
    TELEGRAM_CLIENT_SECRET: "synthetic-only",
    APPLE_CLIENT_ID: "synthetic-apple",
    APPLE_CLIENT_SECRET: "synthetic-only",
    SPOTIFY_CLIENT_ID: "synthetic-spotify",
    SPOTIFY_CLIENT_SECRET: "synthetic-only",
  },
  capabilities: { google: true, telegram: true, apple: true, spotify: true },
}));
vi.mock("../apps/web/src/lib/import-service", () => ({
  importSpotify: context.importSpotify,
}));
vi.mock("openid-client", async (original) => {
  const { createHash } = await import("node:crypto");
  return {
    ...(await original<typeof import("openid-client")>()),
    Configuration: class {},
    discovery: vi.fn(async () => ({ synthetic: true })),
    ClientSecretBasic: vi.fn(() => "synthetic-basic"),
    ClientSecretPost: vi.fn(() => "synthetic-post"),
    enableNonRepudiationChecks: vi.fn(),
    randomPKCECodeVerifier: () => "synthetic-verifier-".repeat(4),
    randomState: () =>
      `synthetic_state_${String(++context.counter).padStart(24, "0")}`,
    randomNonce: () => `synthetic_nonce_${context.counter}`,
    calculatePKCECodeChallenge: async (verifier: string) =>
      createHash("sha256").update(verifier).digest("base64url"),
    buildAuthorizationUrl: context.authorize,
    authorizationCodeGrant: context.grant,
  };
});

import { createDatabase } from "@aurelia/database";
import {
  createSession,
  hashToken,
  registerAccount,
  sessionAccount,
} from "@aurelia/auth";
import { startOAuth, finishOAuth } from "../apps/web/src/lib/oauth";
import { oauthReturnPath } from "../apps/web/src/lib/oauth-intent";
import { authApi } from "../apps/web/src/lib/api-auth";
import { SESSION_COOKIE } from "../apps/web/src/lib/http";

const origin = "https://aurelia.test";
const password = "synthetic-only-passphrase";
const db = () => context.db!;
let a: { id: string }, b: { id: string }, webA: string;
const claims = (patch: Record<string, unknown> = {}) => ({
  sub: "synthetic-provider-subject",
  name: "Provider Fixture",
  email: "provider@example.test",
  email_verified: true,
  ...patch,
});
function request(
  path: string,
  method = "GET",
  text?: string,
  headers: HeadersInit = {},
) {
  const result = new Request(origin + "/api/" + path, {
    method,
    headers,
    ...(text !== undefined ? { body: text } : {}),
  });
  context.headers = result.headers;
  return result;
}
async function begin(provider = "google", method = "GET", query = "") {
  const response = await startOAuth(
    provider,
    request(
      `auth/${provider}/start${query}`,
      method,
      undefined,
      method === "POST" ? { Origin: origin } : {},
    ),
  );
  const parameters = context.authorize.mock.calls.at(-1)![1] as Record<
    string,
    string
  >;
  context.cookies.set(
    `aurelia_oauth_${provider}`,
    response.cookies.get(`aurelia_oauth_${provider}`)!.value,
  );
  return { response, parameters };
}
function callback(
  provider: string,
  state: string,
  extras: Record<string, string> = {},
) {
  const parameters = new URLSearchParams({
    state,
    code: "synthetic-code",
    ...extras,
  });
  return provider === "apple"
    ? request("auth/apple/callback", "POST", parameters.toString(), {
        "Content-Type": "application/x-www-form-urlencoded",
      })
    : request(`auth/${provider}/callback?${parameters}`);
}
beforeAll(async () => {
  context.db = await createDatabase({ memory: true });
});
afterAll(async () => db().close());
beforeEach(async () => {
  await db().query("DELETE FROM oauth_flow");
  await db().query("DELETE FROM app_user");
  await db().query("DELETE FROM rate_limit");
  a = await registerAccount(db(), {
    name: "Synthetic A",
    email: "a@example.test",
    password,
  });
  b = await registerAccount(db(), {
    name: "Synthetic B",
    email: "b@example.test",
    password,
  });
  webA = await createSession(db(), a.id);
  context.cookies.clear();
  context.cookies.set(SESSION_COOKIE, webA);
  context.headers = new Headers();
  context.counter = 0;
  vi.clearAllMocks();
  context.authorize.mockImplementation(
    (_configuration, parameters) =>
      new URL(
        "https://provider.invalid/authorize?" + new URLSearchParams(parameters),
      ),
  );
  context.grant.mockResolvedValue({
    access_token: "synthetic-access-token",
    claims: () => claims(),
  });
  context.importSpotify.mockResolvedValue("synthetic-import-job");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Network forbidden in synthetic OAuth checks");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("explicit OAuth start intent", () => {
  it("GET login with an existing cookie never links to that account", async () => {
    const { response, parameters } = await begin();
    const row = (await db().query("SELECT * FROM oauth_flow"))[0];
    expect(row).toMatchObject({
      intent: "login",
      user_id: null,
      auth_session_hash: hashToken(webA),
      return_path: "/account",
    });
    expect(row.state_hash).toBe(hashToken(parameters.state));
    expect(row.browser_hash).toBe(
      hashToken(response.cookies.get("aurelia_oauth_google")!.value),
    );
    expect(parameters.code_challenge_method).toBe("S256");
    expect(parameters.code_challenge).toBe(
      createHash("sha256")
        .update(row.verifier as string)
        .digest("base64url"),
    );
    expect(response.status).toBe(303);
    expect(response.cookies.get("aurelia_oauth_google")).toMatchObject({
      path: "/api/auth",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });
  });

  it("POST linking requires Origin, current expected user and a recent web session", async () => {
    await expect(
      startOAuth(
        "google",
        request(`auth/google/start?expectedUserId=${a.id}`, "POST"),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      startOAuth(
        "google",
        request(`auth/google/start?expectedUserId=${b.id}`, "POST", undefined, {
          Origin: origin,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await db().query(
      "UPDATE session SET created_at=now()-INTERVAL '11 minutes' WHERE token_hash=$1",
      [hashToken(webA)],
    );
    await expect(
      begin("google", "POST", `?expectedUserId=${a.id}`),
    ).rejects.toMatchObject({ status: 403 });
    expect(await db().query("SELECT state_hash FROM oauth_flow")).toHaveLength(
      0,
    );
  });

  it("stores an explicit recent link and refuses native bearer management", async () => {
    await begin("google", "POST", `?expectedUserId=${a.id}`);
    expect(
      (
        await db().query(
          "SELECT intent,user_id,auth_session_hash FROM oauth_flow",
        )
      )[0],
    ).toMatchObject({
      intent: "link",
      user_id: a.id,
      auth_session_hash: hashToken(webA),
    });
    const native = await createSession(db(), a.id, { transport: "native" });
    await expect(
      startOAuth(
        "apple",
        request(`auth/apple/start?expectedUserId=${a.id}`, "POST", undefined, {
          Authorization: `Bearer ${native}`,
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("Spotify GET cannot start an import; explicit POST remains metadata-read scope only", async () => {
    await expect(begin("spotify")).rejects.toMatchObject({ status: 405 });
    const { parameters } = await begin(
      "spotify",
      "POST",
      `?expectedUserId=${a.id}`,
    );
    expect(
      (
        await db().query("SELECT intent,user_id,return_path FROM oauth_flow")
      )[0],
    ).toMatchObject({
      intent: "import",
      user_id: a.id,
      return_path: "/import",
    });
    expect(parameters.scope).toContain("user-library-read");
    expect(parameters.scope).not.toContain("modify");
    expect(parameters.code_challenge_method).toBe("S256");
  });

  it("only permits the fixed account/import return paths", async () => {
    for (const value of [
      "https://evil.invalid/account",
      "//evil.invalid/account",
      "/account#token",
      "/stream",
      "/account?connect=ABCD-EFGH&x=1",
    ]) {
      expect(() => oauthReturnPath(value, origin)).toThrow();
    }
    expect(oauthReturnPath("/account?connect=ABCD-EFGH", origin)).toBe(
      "/account?connect=ABCD-EFGH",
    );
    expect(oauthReturnPath(`/account?expectedUserId=${a.id}`, origin)).toBe(
      `/account?expectedUserId=${a.id}`,
    );
  });
});

describe("one-shot callback and delegated OIDC validation", () => {
  it.each(["google", "apple", "spotify"])(
    "does not finalize %s linking/import when login B revokes A during deferred provider exchange",
    async (provider) => {
      const { parameters } = await begin(
        provider,
        "POST",
        `?expectedUserId=${a.id}`,
      );
      let entered!: () => void, release!: () => void;
      const exchanging = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      context.grant.mockImplementationOnce(async () => {
        entered();
        await ready;
        return {
          access_token: "synthetic-access-token",
          claims: () => claims(),
        };
      });
      if (provider === "apple") context.cookies.delete(SESSION_COOKIE);
      const result = finishOAuth(
        provider,
        callback(provider, parameters.state),
      ).then(
        (response) => ({ response }),
        (error: unknown) => ({ error }),
      );
      try {
        await exchanging;
        // A same-origin browser login sends its existing cookie even while Apple's cross-site POST omitted it.
        context.cookies.set(SESSION_COOKIE, webA);
        const login = await authApi(
          ["login"],
          request(
            "auth/login",
            "POST",
            JSON.stringify({ email: "b@example.test", password }),
            { Origin: origin, "Content-Type": "application/json" },
          ),
        );
        expect(
          (
            await sessionAccount(
              db(),
              login!.cookies.get(SESSION_COOKIE)!.value,
            )
          )?.id,
        ).toBe(b.id);
        expect(await sessionAccount(db(), webA)).toBeNull();
        if (provider === "apple") context.cookies.delete(SESSION_COOKIE);
      } finally {
        release();
      }
      expect(await result).toMatchObject({ error: { status: 401 } });
      expect(
        await db().query(
          "SELECT subject FROM identity WHERE user_id=$1 AND provider=$2",
          [a.id, provider],
        ),
      ).toHaveLength(0);
      expect(
        await db().query("SELECT token_hash FROM session WHERE user_id=$1", [
          a.id,
        ]),
      ).toHaveLength(0);
      expect(context.importSpotify).not.toHaveBeenCalled();
    },
  );

  it("passes exact state/nonce/PKCE to OpenID and consumes the browser-bound flow once", async () => {
    const { parameters } = await begin();
    const flow = (await db().query("SELECT verifier,nonce FROM oauth_flow"))[0];
    const response = await finishOAuth(
      "google",
      callback("google", parameters.state),
    );
    expect(context.grant.mock.calls[0][2]).toEqual({
      expectedState: parameters.state,
      expectedNonce: flow.nonce,
      pkceCodeVerifier: flow.verifier,
      idTokenExpected: true,
    });
    expect(response.cookies.get("aurelia_oauth_google")).toMatchObject({
      value: "",
      path: "/api/auth",
      maxAge: 0,
    });
    const token = response.cookies.get(SESSION_COOKIE)!.value;
    const signedIn = await sessionAccount(db(), token);
    expect(signedIn?.id).not.toBe(a.id);
    expect(signedIn?.identities).toContain("google");
    expect(await sessionAccount(db(), webA)).toBeNull();
    await expect(
      finishOAuth("google", callback("google", parameters.state)),
    ).rejects.toMatchObject({ status: 400 });
    expect(context.grant).toHaveBeenCalledOnce();
  });

  it("rejects another browser, expired state and provider mismatch before code exchange", async () => {
    const { parameters, response } = await begin();
    context.cookies.set("aurelia_oauth_google", "wrong-synthetic-browser");
    await expect(
      finishOAuth("google", callback("google", parameters.state)),
    ).rejects.toMatchObject({ status: 400 });
    context.cookies.set(
      "aurelia_oauth_google",
      response.cookies.get("aurelia_oauth_google")!.value,
    );
    await db().query(
      "UPDATE oauth_flow SET expires_at=now()-INTERVAL '1 second'",
    );
    await expect(
      finishOAuth("google", callback("google", parameters.state)),
    ).rejects.toMatchObject({ status: 400 });
    const next = await begin("google");
    context.cookies.set(
      "aurelia_oauth_telegram",
      next.response.cookies.get("aurelia_oauth_google")!.value,
    );
    await expect(
      finishOAuth("telegram", callback("telegram", next.parameters.state)),
    ).rejects.toMatchObject({ status: 400 });
    expect(context.grant).not.toHaveBeenCalled();
  });

  it("cannot replay a flow after the OIDC verifier rejects its token/code", async () => {
    const { parameters } = await begin();
    context.grant.mockRejectedValueOnce(
      new Error("synthetic-OIDC-verification-failure"),
    );
    const response = await finishOAuth("google", callback("google", parameters.state));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${origin}/account?authError=provider-failed`);
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    await expect(
      finishOAuth("google", callback("google", parameters.state)),
    ).rejects.toMatchObject({ status: 400 });
    expect(context.grant).toHaveBeenCalledOnce();
    expect(
      await db().query("SELECT subject FROM identity WHERE provider='google'"),
    ).toHaveLength(0);
  });

  it("requires the initiating link session to remain live and rejects a changed current account", async () => {
    const first = await begin("google", "POST", `?expectedUserId=${a.id}`);
    await db().query("DELETE FROM session WHERE token_hash=$1", [
      hashToken(webA),
    ]);
    await expect(
      finishOAuth("google", callback("google", first.parameters.state)),
    ).rejects.toMatchObject({ status: 401 });
    webA = await createSession(db(), a.id);
    context.cookies.set(SESSION_COOKIE, webA);
    const second = await begin("google", "POST", `?expectedUserId=${a.id}`);
    context.cookies.set(SESSION_COOKIE, await createSession(db(), b.id));
    await expect(
      finishOAuth("google", callback("google", second.parameters.state)),
    ).rejects.toMatchObject({ status: 409 });
    expect(context.grant).not.toHaveBeenCalled();
  });

  it("imports Spotify only for the initiating account and clears the matching cookie path", async () => {
    const { parameters } = await begin(
      "spotify",
      "POST",
      `?expectedUserId=${a.id}`,
    );
    const response = await finishOAuth(
      "spotify",
      callback("spotify", parameters.state),
    );
    expect(context.importSpotify).toHaveBeenCalledWith(
      db(),
      a.id,
      "synthetic-access-token",
    );
    expect(context.grant.mock.calls[0][2]).toMatchObject({
      expectedState: parameters.state,
    });
    expect(context.grant.mock.calls[0][2]).not.toHaveProperty(
      "idTokenExpected",
    );
    expect(response.headers.get("location")).toBe(origin + "/import");
    expect(response.cookies.get("aurelia_oauth_spotify")).toMatchObject({
      path: "/api/auth",
      maxAge: 0,
    });
  });

  it("does not trust an unverified provider email", async () => {
    const { parameters } = await begin();
    context.grant.mockResolvedValueOnce({
      claims: () => claims({ email: "a@example.test", email_verified: false }),
    });
    const response = await finishOAuth(
      "google",
      callback("google", parameters.state),
    );
    const user = await sessionAccount(
      db(),
      response.cookies.get(SESSION_COOKIE)!.value,
    );
    expect(user?.email).toBeNull();
    expect(user?.id).not.toBe(a.id);
    expect(
      (
        await db().query(
          "SELECT verified_email FROM identity WHERE provider='google'",
        )
      )[0].verified_email,
    ).toBeNull();
  });

  it("falls back to a nonempty display name when verified claims contain only whitespace", async () => {
    const { parameters } = await begin();
    context.grant.mockResolvedValueOnce({
      claims: () => claims({ name: "   " }),
    });
    const response = await finishOAuth(
      "google",
      callback("google", parameters.state),
    );
    const user = await sessionAccount(
      db(),
      response.cookies.get(SESSION_COOKIE)!.value,
    );
    expect(user!.name.trim().length).toBeGreaterThan(0);
  });

  it("uses a nonempty fallback for a blank Telegram username without inventing an email", async () => {
    const { parameters } = await begin("telegram");
    context.grant.mockResolvedValueOnce({
      claims: () =>
        claims({
          name: undefined,
          preferred_username: "   ",
          email: undefined,
        }),
    });
    const response = await finishOAuth(
      "telegram",
      callback("telegram", parameters.state),
    );
    const user = await sessionAccount(
      db(),
      response.cookies.get(SESSION_COOKIE)!.value,
    );
    expect(user).toMatchObject({ name: "Music lover", email: null });
  });
});

describe("Apple form_post and account-switch boundary", () => {
  it("accepts first-consent full name but takes verified email only from ID claims", async () => {
    const { parameters, response: started } = await begin("apple");
    expect(parameters.response_mode).toBe("form_post");
    expect(parameters).not.toHaveProperty("code_challenge");
    expect(started.cookies.get("aurelia_oauth_apple")).toMatchObject({
      path: "/api/auth",
      sameSite: "none",
      secure: true,
    });
    context.cookies.delete(SESSION_COOKIE); // Lax session cookie need not accompany cross-site form_post.
    context.grant.mockResolvedValueOnce({
      claims: () => claims({ name: undefined, email_verified: "true" }),
    });
    const response = await finishOAuth(
      "apple",
      callback("apple", parameters.state, {
        user: JSON.stringify({
          name: { firstName: "First", lastName: "Last" },
          email: "not-trusted@example.test",
        }),
      }),
    );
    const user = await sessionAccount(
      db(),
      response.cookies.get(SESSION_COOKIE)!.value,
    );
    expect(user).toMatchObject({
      name: "First Last",
      email: "provider@example.test",
    });
    expect(context.grant.mock.calls[0][2]).toEqual({
      expectedState: parameters.state,
      expectedNonce: parameters.nonce,
      idTokenExpected: true,
    });
    expect(response.cookies.get("aurelia_oauth_apple")).toMatchObject({
      value: "",
      maxAge: 0,
      path: "/api/auth",
      sameSite: "none",
    });
  });

  it("rejects callback method/format/UTF8 byte overflow and duplicate state before code exchange", async () => {
    const { parameters } = await begin("apple");
    await expect(
      finishOAuth(
        "apple",
        request(`auth/apple/callback?state=${parameters.state}`),
      ),
    ).rejects.toMatchObject({ status: 405 });
    await expect(
      finishOAuth(
        "apple",
        request("auth/apple/callback", "POST", "{}", {
          "Content-Type": "application/json",
        }),
      ),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      finishOAuth(
        "apple",
        request(
          "auth/apple/callback",
          "POST",
          `state=${parameters.state}&user=${"é".repeat(17000)}`,
          { "Content-Type": "application/x-www-form-urlencoded" },
        ),
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      finishOAuth(
        "apple",
        request(
          "auth/apple/callback",
          "POST",
          `state=${parameters.state}&state=${parameters.state}`,
          { "Content-Type": "application/x-www-form-urlencoded" },
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(context.grant).not.toHaveBeenCalled();
  });

  it("email login B invalidates pending Apple linking even when the callback omits its Lax session cookie", async () => {
    const { parameters } = await begin(
      "apple",
      "POST",
      `?expectedUserId=${a.id}`,
    );
    await authApi(
      ["login"],
      request(
        "auth/login",
        "POST",
        JSON.stringify({ email: "b@example.test", password }),
        { "Content-Type": "application/json", Origin: origin },
      ),
    );
    expect(await sessionAccount(db(), webA)).toBeNull();
    context.cookies.delete(SESSION_COOKIE);
    await expect(
      finishOAuth("apple", callback("apple", parameters.state)),
    ).rejects.toMatchObject({ status: 400 });
    expect(context.grant).not.toHaveBeenCalled();
    expect(
      await db().query("SELECT subject FROM identity WHERE provider='apple'"),
    ).toHaveLength(0);
  });
});
