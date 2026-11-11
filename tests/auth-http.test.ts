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
  env: { APP_URL: "https://aurelia.test", LOCAL_ACCOUNTS: "true" },
  capabilities: {},
}));

import { createDatabase } from "@aurelia/database";
import {
  createSession,
  hashToken,
  registerAccount,
  resolveIdentity,
  sessionAccount,
} from "@aurelia/auth";
import {
  account,
  assertAccountOwner,
  assertOrigin,
  body,
  requestText,
  SESSION_COOKIE,
} from "../apps/web/src/lib/http";
import { authApi } from "../apps/web/src/lib/api-auth";
import {
  publicDeviceAuth,
  privateDeviceAuth,
} from "../apps/web/src/lib/native-auth";

const origin = "https://aurelia.test";
const password = "synthetic-only-passphrase";
const verifier = "synthetic-pkce-proof-".repeat(3);
const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
let a: { id: string }, b: { id: string }, webA: string, nativeB: string;
const db = () => context.db!;
function request(
  path: string,
  method = "GET",
  data?: unknown,
  headers: HeadersInit = {},
) {
  const values = new Headers(headers);
  if (data !== undefined) values.set("Content-Type", "application/json");
  const result = new Request(origin + "/api/" + path, {
    method,
    headers: values,
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  context.headers = result.headers;
  return result;
}
function deferredJsonRequest(path: string, data: unknown, ownerId: string) {
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        entered();
        await ready;
        controller.enqueue(bytes);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const input = new Request(`${origin}/api/${path}`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Aurelia-Account": ownerId,
    },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  context.headers = input.headers;
  return { input, reading, release };
}
beforeAll(async () => {
  context.db = await createDatabase({ memory: true });
});
afterAll(async () => {
  await db().close();
});
beforeEach(async () => {
  await db().query("DELETE FROM oauth_flow");
  await db().query("DELETE FROM app_user");
  await db().query("DELETE FROM native_device_grant");
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
  nativeB = await createSession(db(), b.id, { transport: "native" });
  context.cookies.clear();
  context.cookies.set(SESSION_COOKIE, webA);
  context.headers = new Headers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Network forbidden in synthetic auth checks");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("HTTP session and owner boundaries", () => {
  it("discovers the email-first branch without exposing identity providers", async () => {
    await resolveIdentity(db(), "telegram", "synthetic-email-discovery", {
      name: "Synthetic provider", email: "provider@example.test",
    }, null);
    for (const [email, step] of [[" A@EXAMPLE.TEST ", "password"],
      ["new@example.test", "register"], ["provider@example.test", "provider"]]) {
      const response = await authApi(["email"], request("auth/email", "POST", { email }));
      expect(await response!.json()).toEqual({ step });
      expect(response!.headers.get("cache-control")).toBe("no-store");
    }
    await expect(authApi(["email"], request("auth/email", "POST", { email: "a@example.test" },
      { Authorization: `Bearer ${nativeB}` }))).rejects.toMatchObject({ status: 400 });
  });

  it("bounds and rate-limits discovery before leaking account information", async () => {
    await expect(authApi(["email"], request("auth/email", "POST", {
      email: "a@example.test", extra: "x".repeat(1200),
    }))).rejects.toMatchObject({ status: 413 });
    for (let attempt = 0; attempt < 15; attempt++)
      await authApi(["email"], request("auth/email", "POST", { email: "a@example.test" }));
    await expect(authApi(["email"], request("auth/email", "POST", { email: "a@example.test" })))
      .rejects.toMatchObject({ status: 429 });
  });

  it("shows email security as unavailable and never enables it without delivery", async () => {
    const response = await authApi(["security"], request("auth/security", "GET", undefined,
      { "X-Aurelia-Account": a.id }));
    expect(await response!.json()).toMatchObject({ enabled: false, available: false });
    for (const method of ["POST", "PUT", "DELETE"])
      expect(await authApi(["security"], request("auth/security", method, {},
        { "X-Aurelia-Account": a.id }))).toBeNull();
    await expect(authApi(["security"], request("auth/security", "GET", undefined,
      { "X-Aurelia-Account": b.id }))).rejects.toMatchObject({ status: 409 });
    await expect(authApi(["security"], request("auth/security", "GET", undefined,
      { Authorization: `Bearer ${nativeB}`, "X-Aurelia-Account": b.id })))
      .rejects.toMatchObject({ status: 403 });
  });

  it("fails closed if an email policy is enabled without a delivery implementation", async () => {
    await db().query("INSERT INTO email_login_security(user_id,enabled,verified_email) VALUES($1,true,'b@example.test')", [b.id]);
    await expect(authApi(["login"], request("auth/login", "POST",
      { email: "b@example.test", password }))).rejects.toMatchObject({ status: 503 });
    expect((await sessionAccount(db(), webA))?.id).toBe(a.id);
    expect(await db().query("SELECT token_hash FROM session WHERE user_id=$1 AND transport='web'", [b.id])).toHaveLength(0);
  });
  it("uses the valid native bearer rather than a different browser cookie for auth/me", async () => {
    const input = request("auth/me", "GET", undefined, {
      Authorization: `Bearer ${nativeB}`,
    });
    const result = await authApi(["me"], input);
    expect((await result!.json()).user.id).toBe(b.id);
    context.headers = new Headers();
    expect((await account())?.id).toBe(a.id);
  });

  it("never falls back to a valid cookie for malformed, unknown, or web-transport bearer credentials", async () => {
    for (const authorization of [
      "",
      "Basic synthetic",
      "Bearer short",
      `Bearer ${"x".repeat(43)}`,
      `Bearer ${webA}`,
    ]) {
      request("auth/me", "GET", undefined, { Authorization: authorization });
      await expect(account(false)).rejects.toMatchObject({ status: 401 });
    }
    context.cookies.set(SESSION_COOKIE, nativeB);
    context.headers = new Headers();
    expect(await account(false)).toBeNull();
    await expect(account(true)).rejects.toMatchObject({ status: 401 });
  });

  it("allows native bearer Origin exemption only after authenticating its transport", async () => {
    await expect(
      assertOrigin(
        request(
          "library/likes",
          "POST",
          {},
          { Authorization: `Bearer ${nativeB}` },
        ),
      ),
    ).resolves.toBeUndefined();
    for (const authorization of [
      `Bearer ${webA}`,
      `Bearer ${"x".repeat(43)}`,
      "Basic synthetic",
    ]) {
      await expect(
        assertOrigin(
          request(
            "library/likes",
            "POST",
            {},
            { Authorization: authorization, Origin: origin },
          ),
        ),
      ).rejects.toMatchObject({ status: 401 });
    }
    await expect(
      assertOrigin(
        request(
          "library/likes",
          "POST",
          {},
          { Origin: "https://untrusted.invalid" },
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      assertOrigin(request("library/likes", "POST", {}, { Origin: origin })),
    ).resolves.toBeUndefined();
  });

  it("rejects missing/stale owners for private reads and writes, including cookie changes across tabs", async () => {
    const webB = await createSession(db(), b.id);
    context.cookies.set(SESSION_COOKIE, webB);
    for (const method of ["GET", "PUT", "DELETE"]) {
      for (const headers of [
        new Headers(),
        new Headers({ "X-Aurelia-Account": a.id }),
      ]) {
        await expect(
          assertAccountOwner(
            request("library/export", method, undefined, headers),
          ),
        ).rejects.toMatchObject({ status: 409 });
      }
      expect(
        (
          await assertAccountOwner(
            request("library/export", method, undefined, {
              "X-Aurelia-Account": b.id,
            }),
          )
        ).id,
      ).toBe(b.id);
    }
  });

  it("prevents native credentials from approving devices, adding credentials or deleting accounts", async () => {
    const headers = {
      Authorization: `Bearer ${nativeB}`,
      "X-Aurelia-Account": b.id,
    };
    await expect(
      privateDeviceAuth(
        "grant",
        request(
          "auth/device/grant?userCode=ABCD-EFGH",
          "GET",
          undefined,
          headers,
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      privateDeviceAuth(
        "approve",
        request(
          "auth/device/approve",
          "POST",
          { userCode: "ABCD-EFGH" },
          headers,
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      authApi(
        ["local"],
        request(
          "auth/local",
          "POST",
          { email: "b@example.test", password },
          headers,
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      authApi(
        ["account"],
        request("auth/account", "DELETE", undefined, headers),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await db().query("SELECT id FROM app_user")).toHaveLength(2);
  });

  it("requires a recent owner-bound browser session for credential changes and deletion", async () => {
    await db().query(
      "UPDATE session SET created_at=now()-INTERVAL '11 minutes' WHERE token_hash=$1",
      [hashToken(webA)],
    );
    for (const [path, method] of [
      ["local", "POST"],
      ["account", "DELETE"],
    ]) {
      await expect(
        authApi(
          [path],
          request(
            `auth/${path}`,
            method,
            method === "POST"
              ? { email: "a@example.test", password }
              : undefined,
            { "X-Aurelia-Account": a.id, Origin: origin },
          ),
        ),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  it("native logout revokes only its bearer and does not clear a different browser cookie", async () => {
    const response = await authApi(
      ["logout"],
      request("auth/logout", "POST", undefined, {
        Authorization: `Bearer ${nativeB}`,
      }),
    );
    expect(await sessionAccount(db(), nativeB, "native")).toBeNull();
    expect((await sessionAccount(db(), webA))?.id).toBe(a.id);
    expect(response!.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("does not interpret extra auth path segments as login, logout or account deletion", async () => {
    for (const [operation, method] of [
      ["login", "POST"],
      ["logout", "POST"],
      ["account", "DELETE"],
    ]) {
      const response = await authApi(
        [operation, "unexpected"],
        request(
          `auth/${operation}/unexpected`,
          method,
          operation === "login"
            ? { email: "b@example.test", password }
            : undefined,
          { Origin: origin, "X-Aurelia-Account": a.id },
        ),
      );
      expect(response).toBeNull();
    }
    expect((await sessionAccount(db(), webA))?.id).toBe(a.id);
    expect(await db().query("SELECT id FROM app_user")).toHaveLength(2);
  });

  it("rotates login B atomically, revoking previous A web session and pending link/import intents", async () => {
    for (const [provider, intent] of [
      ["apple", "link"],
      ["spotify", "import"],
      ["google", "login"],
    ]) {
      await db().query(
        "INSERT INTO oauth_flow(state_hash,provider,verifier,nonce,browser_hash,user_id,auth_session_hash,expires_at,intent) VALUES($1,$2,'fixture','fixture','fixture',$3,$4,now()+INTERVAL '1 minute',$5)",
        [
          provider,
          provider,
          intent === "login" ? null : a.id,
          hashToken(webA),
          intent,
        ],
      );
    }
    const nativeA = await createSession(db(), a.id, { transport: "native" });
    const input = request(
      "auth/login",
      "POST",
      { email: "b@example.test", password },
      { Origin: origin },
    );
    await assertOrigin(input);
    const response = await authApi(["login"], input);
    const next = response!.cookies.get(SESSION_COOKIE)!;
    expect(next.httpOnly).toBe(true);
    expect(next.secure).toBe(true);
    expect(next.path).toBe("/");
    expect((await sessionAccount(db(), next.value))?.id).toBe(b.id);
    expect(await sessionAccount(db(), webA)).toBeNull();
    expect((await sessionAccount(db(), nativeA, "native"))?.id).toBe(a.id);
    expect(
      (
        await db().query<{ intent: string }>("SELECT intent FROM oauth_flow")
      ).map((row) => row.intent),
    ).toEqual(["login"]);
  });
});

describe("bounded request parsing and public native authorization", () => {
  it("rejects credential attachment if its web session is revoked while the bounded body is arriving", async () => {
    const user = await resolveIdentity(
      db(),
      "google",
      "synthetic-local-proof",
      { name: "Synthetic attachment", email: "attach@example.test" },
      null,
    );
    const token = await createSession(db(), user.id);
    context.cookies.set(SESSION_COOKIE, token);
    const deferred = deferredJsonRequest(
      "auth/local",
      { email: "attach@example.test", password },
      user.id,
    );
    const result = authApi(["local"], deferred.input).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
    try {
      await deferred.reading;
      await db().query("DELETE FROM session WHERE token_hash=$1", [
        hashToken(token),
      ]);
    } finally {
      deferred.release();
    }
    expect(await result).toMatchObject({ error: { status: 401 } });
    expect(
      await db().query(
        "SELECT subject FROM identity WHERE user_id=$1 AND provider='local'",
        [user.id],
      ),
    ).toHaveLength(0);
    expect(
      (
        await db().query("SELECT password_hash FROM app_user WHERE id=$1", [
          user.id,
        ])
      )[0].password_hash,
    ).toBeNull();
  });

  it("rejects device approval if its browser session is revoked during streamed consent body delivery", async () => {
    const started = await publicDeviceAuth(
      "start",
      request("auth/device/start", "POST", {
        codeChallenge,
        deviceName: "Synthetic device",
      }),
    );
    const grant = await started.json();
    const deferred = deferredJsonRequest(
      "auth/device/approve",
      { userCode: grant.userCode },
      a.id,
    );
    const result = privateDeviceAuth("approve", deferred.input).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
    try {
      await deferred.reading;
      await db().query("DELETE FROM session WHERE token_hash=$1", [
        hashToken(webA),
      ]);
    } finally {
      deferred.release();
    }
    expect(await result).toMatchObject({ error: { status: 401 } });
    expect(
      (await db().query("SELECT status,user_id FROM native_device_grant"))[0],
    ).toMatchObject({ status: "pending", user_id: null });
  });

  it("limits actual UTF-8 bytes and rejects invalid encoding rather than trusting Content-Length", async () => {
    const input = request("auth/login", "POST", { name: "éééé" });
    await expect(body(input, 15)).rejects.toMatchObject({ status: 413 });
    await expect(
      requestText(
        new Request(origin, { method: "POST", body: new Uint8Array([0xff]) }),
        8,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(12));
      },
      cancel,
    });
    const streamed = new Request(origin, {
      method: "POST",
      headers: { "Content-Length": "1" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(requestText(streamed, 10)).rejects.toMatchObject({
      status: 413,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("public PKCE start ignores a logged-in cookie and does not auto-approve", async () => {
    const response = await publicDeviceAuth(
      "start",
      request("auth/device/start", "POST", {
        codeChallenge,
        deviceName: "Synthetic device",
      }),
    );
    const grant = await response.json();
    expect(grant.verificationUri).toBe(
      `${origin}/account?connect=${grant.userCode}`,
    );
    expect(grant).not.toHaveProperty("token");
    expect(
      (await db().query("SELECT user_id,status FROM native_device_grant"))[0],
    ).toMatchObject({ user_id: null, status: "pending" });
    const pending = await publicDeviceAuth(
      "token",
      request("auth/device/token", "POST", {
        deviceCode: grant.deviceCode,
        codeVerifier: verifier,
      }),
    );
    expect(await pending.json()).toEqual({ status: "pending" });
  });

  it("rejects Authorization on both public device endpoints, even with a valid native token", async () => {
    for (const operation of ["start", "token"]) {
      await expect(
        publicDeviceAuth(
          operation,
          request(
            `auth/device/${operation}`,
            "POST",
            {},
            { Authorization: `Bearer ${nativeB}` },
          ),
        ),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(
      await db().query("SELECT device_code_hash FROM native_device_grant"),
    ).toHaveLength(0);
  });

  it("requires matching web owner approval then releases a one-use native-only session", async () => {
    const started = await publicDeviceAuth(
      "start",
      request("auth/device/start", "POST", {
        codeChallenge,
        deviceName: "Synthetic device",
      }),
    );
    const grant = await started.json();
    await expect(
      privateDeviceAuth(
        "grant",
        request(`auth/device/grant?userCode=${grant.userCode}`, "GET"),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const safe = await privateDeviceAuth(
      "grant",
      request(
        `auth/device/grant?userCode=${grant.userCode}`,
        "GET",
        undefined,
        { "X-Aurelia-Account": a.id },
      ),
    );
    expect(await safe.json()).not.toHaveProperty("deviceCode");
    const approval = request(
      "auth/device/approve",
      "POST",
      { userCode: grant.userCode },
      { Origin: origin, "X-Aurelia-Account": a.id },
    );
    await assertOrigin(approval);
    await privateDeviceAuth("approve", approval);
    const token = await publicDeviceAuth(
      "token",
      request("auth/device/token", "POST", {
        deviceCode: grant.deviceCode,
        codeVerifier: verifier,
      }),
    );
    const approved = await token.json();
    expect(approved.status).toBe("approved");
    expect(approved.user.id).toBe(a.id);
    expect(await sessionAccount(db(), approved.token)).toBeNull();
    expect((await sessionAccount(db(), approved.token, "native"))?.id).toBe(
      a.id,
    );
    await expect(
      publicDeviceAuth(
        "token",
        request("auth/device/token", "POST", {
          deviceCode: grant.deviceCode,
          codeVerifier: verifier,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
