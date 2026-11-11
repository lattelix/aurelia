import { beforeAll, describe, expect, it } from "vitest";
import * as oidc from "openid-client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { oauthErrorDiagnostics } from "../apps/web/src/lib/oauth-errors";

// Exercise the installed OIDC implementation against serialized HTTP responses
// and real, locally signed JWTs. No provider/owner credentials or network calls.
// Telegram's documented manual endpoints/request shape:
// https://core.telegram.org/bots/telegram-login#manual-implementation
const issuer = "https://oauth.telegram.org";
const clientId = "123456789";
const clientSecret = "synthetic-client_secret.with-hyphens";
const redirectUri = "https://aurelia.example.test/api/auth/telegram/callback";
const state = "synthetic-state";
const nonce = "synthetic-nonce";
const verifier = "synthetic-pkce-verifier-with-at-least-43-characters";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
});

interface TokenRequest {
  body: URLSearchParams;
  headers: Headers;
  redirect: RequestRedirect | undefined;
}
function basicCredentials(header: string | null) {
  if (!header?.startsWith("Basic ")) return undefined;
  const credentials = atob(header.slice(6));
  const separator = credentials.indexOf(":");
  if (separator < 0) return undefined;
  const decode = (value: string) => decodeURIComponent(value.replaceAll("+", " "));
  return [decode(credentials.slice(0, separator)), decode(credentials.slice(separator + 1))];
}
async function providerFixture(options: {
  claims?: Record<string, unknown>;
  clientAuthMethod?: "basic" | "post";
  requireBodyClientId?: boolean;
  response?: () => Response;
  fetchFailure?: Error;
  authorizationResponseIssuerRequired?: boolean;
  tamperSignature?: boolean;
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: issuer,
    aud: clientId,
    sub: "synthetic-telegram-subject",
    iat: now,
    exp: now + 3600,
    nonce,
    name: "Synthetic Telegram listener",
    ...options.claims,
  };
  // Omitting an undefined claim allows a real missing-nonce JWT regression.
  let jwt = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "synthetic-signing-key" })
    .sign(keys.privateKey);
  if (options.tamperSignature) {
    const [header, payload, signature] = jwt.split(".");
    jwt = `${header}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  }
  const publicKey = {
    ...await exportJWK(keys.publicKey),
    kid: "synthetic-signing-key",
    alg: "RS256",
    // The real public Telegram RSA JWKS has key_ops/ext, with no use member.
    key_ops: ["verify"],
    ext: true,
  };
  const configuration = new oidc.Configuration(
    {
      issuer,
      authorization_endpoint: `${issuer}/auth`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: ["RS256"],
      ...(options.authorizationResponseIssuerRequired
        ? { authorization_response_iss_parameter_supported: true }
        : {}),
    },
    clientId,
    clientSecret,
    options.clientAuthMethod === "post"
      ? oidc.ClientSecretPost(clientSecret)
      : oidc.ClientSecretBasic(clientSecret),
  );
  const requests: TokenRequest[] = [];
  let jwksRequests = 0;
  configuration[oidc.customFetch] = async (url, init) => {
    if (options.fetchFailure) throw options.fetchFailure;
    if (String(url) === `${issuer}/.well-known/jwks.json`) {
      jwksRequests++;
      return Response.json({ keys: [publicKey] });
    }
    if (String(url) !== `${issuer}/token`)
      throw new Error("Unexpected synthetic endpoint");
    const body = new URLSearchParams(String(init?.body));
    const headers = new Headers(init?.headers);
    requests.push({ body, headers, redirect: init?.redirect });
    if (options.clientAuthMethod === "post") {
      if (headers.has("authorization") || body.get("client_id") !== clientId || body.get("client_secret") !== clientSecret)
        return Response.json({ error: "invalid_client" }, { status: 401 });
    } else {
      const credentials = basicCredentials(headers.get("authorization"));
      if (credentials?.[0] !== clientId || credentials[1] !== clientSecret)
        return Response.json({ error: "invalid_client" }, { status: 401 });
    }
    if (options.requireBodyClientId && body.get("client_id") !== clientId)
      return Response.json({ error: "invalid_client" }, { status: 401 });
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    if (
      body.get("redirect_uri") !== redirectUri ||
      body.get("grant_type") !== "authorization_code" ||
      body.get("code") !== "synthetic-code" ||
      !body.get("code_verifier") ||
      await oidc.calculatePKCECodeChallenge(body.get("code_verifier")!) !== challenge
    ) return Response.json({ error: "invalid_grant" }, { status: 400 });
    return options.response?.() ?? Response.json({
      access_token: "synthetic-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: jwt,
    });
  };
  const callback = new URL(redirectUri);
  callback.searchParams.set("state", state);
  callback.searchParams.set("code", "synthetic-code");
  const grant = (extra?: URLSearchParams, codeVerifier = verifier) =>
    oidc.authorizationCodeGrant(configuration, callback, {
      expectedState: state,
      expectedNonce: nonce,
      idTokenExpected: true,
      pkceCodeVerifier: codeVerifier,
    }, extra);
  return { configuration, callback, grant, requests, get jwksRequests() { return jwksRequests; } };
}

describe("Telegram-shaped OIDC interoperability and safe error-code diagnosis", () => {
  it("processes a signed RS256 ID token with nonce, PKCE and Basic authentication", async () => {
    const fixture = await providerFixture();
    oidc.enableNonRepudiationChecks(fixture.configuration);
    const result = await fixture.grant();
    expect(result.claims()).toMatchObject({
      iss: issuer,
      aud: clientId,
      sub: "synthetic-telegram-subject",
      nonce,
    });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.jwksRequests).toBe(1);
    const request = fixture.requests[0];
    expect(request.headers.get("content-type")).toMatch(/^application\/x-www-form-urlencoded/);
    expect(request.body.get("code_verifier")).toBe(verifier);
    expect(request.body.get("redirect_uri")).toBe(redirectUri);
    expect(request.redirect).toBe("manual");
  });

  it("rejects a forged signature using the fetched JWKS", async () => {
    const fixture = await providerFixture({ tamperSignature: true });
    oidc.enableNonRepudiationChecks(fixture.configuration);
    const error = await fixture.grant().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(oidc.ClientError);
    expect(oauthErrorDiagnostics(error)).toMatchObject({
      type: "oidc-client", code: "OAUTH_INVALID_RESPONSE", reason: "signature-verification",
    });
    expect(fixture.jwksRequests).toBe(1);
  });

  it("ClientSecretPost sends decoded form credentials without Basic auth and preserves nonce, PKCE and JWKS verification", async () => {
    const fixture = await providerFixture({ clientAuthMethod: "post" });
    oidc.enableNonRepudiationChecks(fixture.configuration);
    const result = await fixture.grant();
    expect(result.claims()).toMatchObject({ iss: issuer, aud: clientId, sub: "synthetic-telegram-subject", nonce });
    expect(fixture.requests).toHaveLength(1);
    const request = fixture.requests[0];
    expect(request.body.get("client_id")).toBe(clientId);
    expect(request.body.get("client_secret")).toBe(clientSecret);
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.body.get("code_verifier")).toBe(verifier);
    expect(request.body.get("redirect_uri")).toBe(redirectUri);
    expect(request.redirect).toBe("manual");
    expect(fixture.jwksRequests).toBe(1);
  });

  it("rejects a callback state mismatch before sending the token code", async () => {
    const fixture = await providerFixture();
    fixture.callback.searchParams.set("state", "different-state");
    await expect(fixture.grant()).rejects.toMatchObject({
      name: "ClientError", code: "OAUTH_INVALID_RESPONSE",
    });
    expect(fixture.requests).toHaveLength(0);
  });

  it("Basic auth alone omits the body client_id shown by Telegram docs; adding the explicit parameter interoperates", async () => {
    const fixture = await providerFixture({ requireBodyClientId: true });
    oidc.enableNonRepudiationChecks(fixture.configuration);
    await expect(fixture.grant()).rejects.toMatchObject({
      name: "ResponseBodyError",
      code: "OAUTH_RESPONSE_BODY_ERROR",
      error: "invalid_client",
      status: 401,
    });
    expect(fixture.requests[0].body.has("client_id")).toBe(false);
    const result = await fixture.grant(new URLSearchParams({ client_id: clientId }));
    expect(result.claims()?.sub).toBe("synthetic-telegram-subject");
    expect(fixture.requests[1].body.get("client_id")).toBe(clientId);
    expect(fixture.requests[1].body.has("client_secret")).toBe(false);
    expect(fixture.jwksRequests).toBe(1);
  });

  it("an HTTP 400 PKCE mismatch is a ResponseBodyError rather than the minified ClientError class", async () => {
    const fixture = await providerFixture();
    await expect(fixture.grant(undefined, "different-synthetic-verifier-with-43-characters")).rejects.toMatchObject({
      name: "ResponseBodyError",
      code: "OAUTH_RESPONSE_BODY_ERROR",
      error: "invalid_grant",
      status: 400,
    });
  });

  it.each([
    ["missing nonce", { nonce: undefined }, "OAUTH_INVALID_RESPONSE"],
    ["wrong nonce", { nonce: "different-nonce" }, "OAUTH_JWT_CLAIM_COMPARISON_FAILED"],
    ["wrong audience", { aud: "different-client" }, "OAUTH_JWT_CLAIM_COMPARISON_FAILED"],
    ["numeric subject", { sub: 123456789 }, "OAUTH_INVALID_RESPONSE"],
    ["expired token", { exp: 1 }, "OAUTH_JWT_TIMESTAMP_CHECK_FAILED"],
  ])("%s produces a stable ClientError.code without relying on its minified name", async (_name, claims, code) => {
    const fixture = await providerFixture({ claims });
    await expect(fixture.grant()).rejects.toMatchObject({ name: "ClientError", code });
  });

  it.each([
    ["non-JSON content type", () => new Response("synthetic html", { headers: { "content-type": "text/html" } }), "OAUTH_RESPONSE_IS_NOT_JSON"],
    ["invalid JSON", () => new Response("{", { headers: { "content-type": "application/json" } }), "OAUTH_PARSE_ERROR"],
    ["non-OAuth HTTP failure", () => new Response("synthetic upstream failure", { status: 500, headers: { "content-type": "text/plain" } }), "OAUTH_RESPONSE_IS_NOT_CONFORM"],
  ])("%s also produces ClientError with a distinct code", async (_name, response, code) => {
    const fixture = await providerFixture({ response });
    await expect(fixture.grant()).rejects.toMatchObject({ name: "ClientError", code });
  });

  it("a required callback issuer fails before any token request if the callback omits iss", async () => {
    const fixture = await providerFixture({ authorizationResponseIssuerRequired: true });
    await expect(fixture.grant()).rejects.toMatchObject({
      name: "ClientError",
      code: "OAUTH_INVALID_RESPONSE",
    });
    expect(fixture.requests).toHaveLength(0);
    fixture.callback.searchParams.set("iss", issuer);
    expect((await fixture.grant()).claims()?.sub).toBe("synthetic-telegram-subject");
  });

  it("a fetch TypeError keeps the transport code in its cause chain", async () => {
    const transport = Object.assign(new Error("Synthetic connection failure"), { code: "ECONNRESET" });
    const fixture = await providerFixture({ fetchFailure: new TypeError("fetch failed", { cause: transport }) });
    await expect(fixture.grant()).rejects.toMatchObject({
      name: "TypeError",
      cause: { code: "ECONNRESET" },
    });
  });
});

describe("Sanitized OIDC error diagnostics", () => {
  it.each([
    ["missing nonce", { nonce: undefined }, { code: "OAUTH_INVALID_RESPONSE", claim: "nonce", reason: "missing-claim" }],
    ["wrong nonce", { nonce: "different-nonce" }, { code: "OAUTH_JWT_CLAIM_COMPARISON_FAILED", claim: "nonce" }],
    ["numeric subject", { sub: 123456789 }, { code: "OAUTH_INVALID_RESPONSE", claim: "sub", reason: "claim-type" }],
  ])("identifies %s without exposing signed claims", async (_name, claims, diagnosis) => {
    const fixture = await providerFixture({ claims });
    const error = await fixture.grant().catch((error: unknown) => error);
    expect(oauthErrorDiagnostics(error)).toMatchObject({ type: "oidc-client", ...diagnosis });
    expect(JSON.stringify(oauthErrorDiagnostics(error))).not.toContain("synthetic");
  });

  it("reports only the provider error identifier and status", async () => {
    const fixture = await providerFixture({ response: () => Response.json({
      error: "invalid_grant",
      error_description: "synthetic-private-code-and-profile",
      state: "synthetic-private-state",
    }, { status: 400 }) });
    const error = await fixture.grant().catch((error: unknown) => error);
    expect(oauthErrorDiagnostics(error)).toEqual({
      type: "provider-response", code: "OAUTH_RESPONSE_BODY_ERROR", oauthError: "invalid_grant", status: 400,
    });
  });

  it("diagnoses an HTTP 200 OAuth error as ClientError without exposing body values or inventing an HTTP status", async () => {
    const fixture = await providerFixture({
      clientAuthMethod: "post",
      response: () => Response.json({
        error: "invalid_client",
        error_description: "synthetic-private-client-detail",
        code: "synthetic-private-authorization-code",
        state: "synthetic-private-state",
      }),
    });
    const error = await fixture.grant().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(oidc.ClientError);
    expect(error).toMatchObject({ code: "OAUTH_INVALID_RESPONSE", cause: { cause: { body: { error: "invalid_client" } } } });
    expect(oauthErrorDiagnostics(error)).toEqual({
      type: "oidc-client", code: "OAUTH_INVALID_RESPONSE", oauthError: "invalid_client",
    });
  });

  it("suppresses an unknown provider error string nested in an HTTP 200 response body", async () => {
    const fixture = await providerFixture({ response: () => Response.json({
      error: "synthetic-private-provider-value",
      error_description: "synthetic-private-provider-detail",
    }) });
    const error = await fixture.grant().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(oidc.ClientError);
    expect(oauthErrorDiagnostics(error)).toEqual({ type: "oidc-client", code: "OAUTH_INVALID_RESPONSE" });
  });

  it("finds an allowlisted transport cause without logging messages or arbitrary string fields", () => {
    const cause = Object.assign(new Error("https://private.example/token?code=secret"), {
      code: "ECONNRESET", error: "private-token", claim: "private-profile",
    });
    const error = Object.assign(new TypeError("private fetch failure", { cause }), { code: "private-code" });
    expect(oauthErrorDiagnostics(error)).toEqual({ type: "type-error", causeCodes: ["ECONNRESET"] });
  });

  it("reports only a non-JSON HTTP response status", async () => {
    const fixture = await providerFixture({ response: () => new Response("synthetic private upstream body", {
      status: 502, headers: { "content-type": "text/plain" },
    }) });
    const error = await fixture.grant().catch((error: unknown) => error);
    expect(oauthErrorDiagnostics(error)).toEqual({
      type: "oidc-client", code: "OAUTH_RESPONSE_IS_NOT_CONFORM", status: 502,
    });
  });

  it("bounds cyclic cause chains and ignores unknown error values", () => {
    const error = { code: "private-code", status: "private-status", claim: "private-claim", cause: {} };
    error.cause = error;
    expect(oauthErrorDiagnostics(error)).toEqual({ type: "unknown" });
  });
});
