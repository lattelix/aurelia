import * as oidc from "openid-client";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDatabase } from "@aurelia/database";
import {
  hashToken,
  randomToken,
  resolveIdentity,
  rateLimit,
  sessionAccount,
  recentSessionAccount,
  createSessionFromWebSession,
  getEmailLoginSecurity,
} from "@aurelia/auth";
import { AppError } from "@aurelia/core";
import { env, capabilities } from "./env";
import { account, json, setSession, SESSION_COOKIE, requestText, assertOrigin, requireWebAccount } from "./http";
import { importSpotify } from "./import-service";
import { oauthIntent, oauthReturnPath, oauthCallbackParameters, appleDisplayName, type OAuthIntent } from "./oauth-intent";
import { rotateWebSession, withCurrentWebSession } from "./web-session";
import { oauthErrorDiagnostics } from "./oauth-errors";
type OAuthProvider = "google" | "telegram" | "apple" | "spotify";
const providerSchema = z.enum(["google", "telegram", "apple", "spotify"]);
const configurations = new Map<string, Promise<oidc.Configuration>>();
function config(provider: OAuthProvider) {
  if (!capabilities[provider])
    throw new AppError(
      503,
      `${provider} login is not configured. Add the server credentials from .env.example.`,
    );
  if (!configurations.has(provider)) {
    const prefix = provider.toUpperCase();
    const clientId = env[`${prefix}_CLIENT_ID` as keyof typeof env] as string;
    const secret = env[`${prefix}_CLIENT_SECRET` as keyof typeof env] as string;
    if (provider === "spotify")
      configurations.set(
        provider,
        Promise.resolve(
          new oidc.Configuration(
            {
              issuer: "https://accounts.spotify.com",
              authorization_endpoint: "https://accounts.spotify.com/authorize",
              token_endpoint: "https://accounts.spotify.com/api/token",
            },
            clientId,
            secret,
            oidc.ClientSecretBasic(secret),
          ),
        ),
      );
    else
      configurations.set(
        provider,
        oidc.discovery(
          new URL(
            provider === "google"
              ? "https://accounts.google.com"
              : provider === "telegram"
                ? "https://oauth.telegram.org"
                : "https://appleid.apple.com",
          ),
          clientId,
          secret,
          provider === "telegram" ? oidc.ClientSecretPost(secret) : undefined,
        ).then((configuration) => {
          if (provider === "telegram") oidc.enableNonRepudiationChecks(configuration);
          return configuration;
        }),
      );
  }
  const pending = configurations.get(provider)!;
  return pending.catch((error: unknown) => {
    if (configurations.get(provider) === pending) configurations.delete(provider);
    throw error;
  });
}
export async function startOAuth(providerInput: string, request: Request) {
  if (request.method === "POST") await assertOrigin(request);
  const provider = providerSchema.parse(providerInput);
  const intent = oauthIntent(provider, request.method);
  if (intent !== "login") await requireWebAccount();
  const current = await account();
  const user = intent === "login" ? null : current;
  if (intent !== "login" && !user) throw new AppError(401, "Sign in before connecting this service");
  const db = await getDatabase();
  const url = new URL(request.url);
  const returnPath = oauthReturnPath(url.searchParams.get("returnTo"), env.APP_URL,
    provider === "spotify" ? "/import" : "/account");
  const sessionToken = (await cookies()).get(SESSION_COOKIE)?.value;
  if (intent !== "login" && url.searchParams.get("expectedUserId") !== user?.id)
    throw new AppError(409, "Your account changed. Refresh before connecting another service.");
  if (intent === "link" && (await recentSessionAccount(db, sessionToken))?.id !== user?.id)
    throw new AppError(403, "Sign in again before adding another sign-in method.");
  await rateLimit(db, `oauth:${user?.id ?? "guest"}`, 30);
  const configuration = await config(provider);
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const browser = randomToken();
  await db.query(
    "INSERT INTO oauth_flow(state_hash,provider,verifier,nonce,browser_hash,user_id,auth_session_hash,expires_at,intent,return_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      hashToken(state),
      provider,
      verifier,
      nonce,
      hashToken(browser),
      user?.id ?? null,
      sessionToken ? hashToken(sessionToken) : null,
      new Date(Date.now() + 600000),
      intent, returnPath,
    ],
  );
  const parameters: Record<string, string> = {
    redirect_uri: `${env.APP_URL}/api/auth/${provider}/callback`,
    scope:
      provider === "spotify"
        ? "user-library-read playlist-read-private playlist-read-collaborative user-follow-read"
        : provider === "telegram"
          ? "openid profile"
          : provider === "apple"
            ? "openid email name"
            : "openid email profile",
    state,
    nonce,
  };
  if (provider !== "apple") {
    parameters.code_challenge = await oidc.calculatePKCECodeChallenge(verifier);
    parameters.code_challenge_method = "S256";
  }
  if (provider === "apple") parameters.response_mode = "form_post";
  const response = NextResponse.redirect(
    oidc.buildAuthorizationUrl(configuration, parameters),
    303,
  );
  response.cookies.set(`aurelia_oauth_${provider}`, browser, {
    httpOnly: true,
    secure: env.APP_URL.startsWith("https:"),
    sameSite: provider === "apple" ? "none" : "lax",
    path: "/api/auth",
    maxAge: 600,
  });
  return response;
}
export async function finishOAuth(providerInput: string, request: Request) {
  const provider = providerSchema.parse(providerInput);
  const db = await getDatabase();
  if (request.method !== (provider === "apple" ? "POST" : "GET"))
    throw new AppError(405, "Invalid callback method");
  if (provider === "apple" && !request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded"))
    throw new AppError(415, "Invalid login response format");
  const params = oauthCallbackParameters(request.method === "POST"
    ? await requestText(request, 32768) : new URL(request.url).search.slice(1));
  const state = params.get("state");
  if (!state) throw new AppError(400, "Missing OAuth state");
  const browser = (await cookies()).get(`aurelia_oauth_${provider}`)?.value;
  const rows = await db.query<{
    provider: string;
    verifier: string;
    nonce: string;
    user_id: string | null;
    auth_session_hash: string | null;
    intent: OAuthIntent;
    return_path: string;
  }>(
    "DELETE FROM oauth_flow WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING provider,verifier,nonce,user_id,auth_session_hash,intent,return_path",
    [hashToken(state), hashToken(browser ?? "")],
  );
  const flow = rows[0];
  if (!flow || flow.provider !== provider)
    throw new AppError(
      400,
      "This login expired or belongs to another browser. Try again.",
    );
  if (!(["login", "link", "import"] as string[]).includes(flow.intent) ||
      (flow.intent === "login") !== (flow.user_id === null) ||
      (provider === "spotify") !== (flow.intent === "import"))
    throw new AppError(400, "Invalid login intent");
  if (flow.user_id) {
    const active = await db.query(
      "SELECT user_id FROM session WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()",
      [flow.auth_session_hash, flow.user_id],
    );
    if (!active.length)
      throw new AppError(
        401,
        "Your session expired. Sign in again before linking accounts.",
      );
    const current = await sessionAccount(
      db,
      (await cookies()).get(SESSION_COOKIE)?.value,
    );
    if (current && current.id !== flow.user_id)
      throw new AppError(409, "Your active account changed during login.");
  }
  let stage: "discovery" | "code-exchange" | "identity" = "discovery";
  try {
    const configuration = await config(provider);
    stage = "code-exchange";
    const callback = new URL(`${env.APP_URL}/api/auth/${provider}/callback`);
    params.forEach((v, k) => callback.searchParams.set(k, v));
    const tokens = await oidc.authorizationCodeGrant(configuration, callback, {
      expectedState: state,
      ...(provider !== "apple" ? { pkceCodeVerifier: flow.verifier } : {}),
      ...(provider !== "spotify"
        ? { expectedNonce: flow.nonce, idTokenExpected: true }
        : {}),
    }, provider === "telegram" ? { client_id: env.TELEGRAM_CLIENT_ID! } : undefined);
    if (provider === "spotify") {
      if (!flow.user_id) throw new AppError(401, "Sign in before importing");
      await withCurrentWebSession(db, flow.user_id, flow.auth_session_hash, async () => {}, false);
      await importSpotify(db, flow.user_id, tokens.access_token);
      const response = NextResponse.redirect(
        new URL("/import", env.APP_URL),
        303,
      );
      clearFlowCookie(response, provider);
      return response;
    }
    stage = "identity";
    const claims = tokens.claims();
    if (!claims?.sub)
      throw new AppError(401, "Provider did not verify your identity");
    const firstConsentName = provider === "apple" ? appleDisplayName(params.get("user")) : undefined;
    const claimName = typeof claims.name === "string" ? claims.name.trim().slice(0, 80) : "";
    const username = provider === "telegram" && typeof claims.preferred_username === "string"
      ? claims.preferred_username.trim().slice(0, 80) : "";
    const profile = {
      name: firstConsentName || claimName || username || "Music lover",
      email:
        typeof claims.email === "string" &&
        (claims.email_verified === true || claims.email_verified === "true")
          ? claims.email
          : undefined,
    };
    const finish = async (tx: typeof db) => {
      const user = await resolveIdentity(tx, provider, claims.sub, profile, flow.user_id);
      if (!flow.user_id && (await getEmailLoginSecurity(tx, user.id)).enabled)
        throw new AppError(503, "Email sign-in verification is unavailable. Please retry later.");
      return flow.user_id && flow.auth_session_hash
        ? createSessionFromWebSession(tx, { userId: user.id, previousHash: flow.auth_session_hash })
        : rotateWebSession(tx, user.id, flow.auth_session_hash);
    };
    const token = flow.user_id
      ? await withCurrentWebSession(db, flow.user_id, flow.auth_session_hash, finish)
      : await finish(db);
    const response = setSession(
      NextResponse.redirect(new URL(oauthReturnPath(flow.return_path, env.APP_URL), env.APP_URL), 303),
      token,
    );
    clearFlowCookie(response, provider);
    return response;
  } catch (error) {
    if (error instanceof AppError) throw error;
    const requestId = crypto.randomUUID();
    console.error("OAuth callback failed", { provider, stage, requestId, ...oauthErrorDiagnostics(error) });
    // Only a validated, browser-bound, one-use flow reaches this path. Never put
    // provider error text, authorization codes or tokens in the redirect URL.
    const target = new URL(oauthReturnPath(flow.return_path, env.APP_URL), env.APP_URL);
    target.searchParams.set("authError", "provider-failed");
    const response = NextResponse.redirect(target, 303);
    clearFlowCookie(response, provider);
    return response;
  }
}
function clearFlowCookie(response: NextResponse, provider: OAuthProvider) {
  response.cookies.set(`aurelia_oauth_${provider}`, "", { path: "/api/auth", maxAge: 0,
    httpOnly: true, secure: env.APP_URL.startsWith("https:"), sameSite: provider === "apple" ? "none" : "lax" });
}
export function oauthFailure(error: unknown) {
  if (error instanceof AppError)
    return json({ error: error.message }, error.status);
  throw error;
}
