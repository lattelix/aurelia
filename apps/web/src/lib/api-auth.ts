import { z } from "zod";
import { getDatabase } from "@aurelia/database";
import {
  registerAccount,
  loginAccount,
  hashToken,
  rateLimit,
  attachLocalCredential,
  recentSessionAccount,
  discoverEmail,
  getEmailLoginSecurity,
} from "@aurelia/auth";
import { AppError } from "@aurelia/core";
import { env } from "./env";
import { body, json, setSession, SESSION_COOKIE, requireAccount, requireWebAccount, sessionCredential, assertAccountOwner } from "./http";
import { rotateWebSession, withCurrentWebSession } from "./web-session";
const credentials = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(12).max(256),
  name: z.string().trim().min(1).max(80).optional(),
});
export async function authApi(path: string[], request: Request) {
  const db = await getDatabase();
  if (path.length === 1 && path[0] === "email" && request.method === "POST") {
    if (request.headers.has("authorization")) throw new AppError(400, "Use your browser to sign in.");
    if (env.LOCAL_ACCOUNTS !== "true") throw new AppError(403, "Email sign-in is unavailable");
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const address = /^[0-9a-fA-F:.]{1,64}$/.test(forwarded) ? forwarded : "unknown";
    await rateLimit(db, `auth:discover:address:${address}`, 30, 600);
    await rateLimit(db, "auth:discover:global", 500, 600);
    const input = credentials.pick({ email: true }).strict().parse(await body(request, 1024));
    await rateLimit(db, `auth:discover:email:${hashToken(input.email)}`, 15, 600);
    return json(await discoverEmail(db, input.email));
  }
  if (path.length === 1 && path[0] === "security" && request.method === "GET") {
    await requireWebAccount();
    const user = await assertAccountOwner(request);
    return json({ ...(await getEmailLoginSecurity(db, user.id)), available: false,
      reason: "Email delivery is not connected yet. Email sign-in codes cannot be enabled." });
  }
  if (path.length === 1 && path[0] === "me" && request.method === "GET")
    return json({ user: await requireAccount() });
  if (path.length === 1 && path[0] === "local" && request.method === "POST") {
    await requireWebAccount();
    if (env.LOCAL_ACCOUNTS !== "true") throw new AppError(403, "Email sign-in is unavailable");
    const user = await assertAccountOwner(request);
    const credential = await sessionCredential();
    if ((await recentSessionAccount(db, credential.token, credential.transport))?.id !== user.id)
      throw new AppError(403, "Sign in again before adding another sign-in method.");
    const input = credentials.omit({ name: true }).strict().parse(await body(request, 4096));
    await rateLimit(db, `auth:local-link:${user.id}`, 5, 600);
    const attached = await withCurrentWebSession(db, user.id,
      credential.token ? hashToken(credential.token) : null,
      (tx) => attachLocalCredential(tx, user.id, input));
    return json({ user: attached });
  }
  if (path.length === 1 && ["register", "login"].includes(path[0]) && request.method === "POST") {
    if (request.headers.has("authorization")) throw new AppError(400, "Use your browser to sign in.");
    if (env.LOCAL_ACCOUNTS !== "true")
      throw new AppError(403, "Local accounts are disabled");
    const input = credentials.strict().parse(await body(request, 4096));
    await rateLimit(db, `auth:${input.email.toLowerCase()}`, 10, 600);
    await rateLimit(db, "auth:global", 200, 600);
    const user =
      path[0] === "register"
        ? await registerAccount(db, {
            ...input,
            name: input.name ?? input.email.split("@")[0],
          })
        : await loginAccount(db, input.email, input.password);
    // No email provider is connected. Never issue an unverified session if a future
    // deployment has enabled this policy; activation endpoints are intentionally absent.
    if ((await getEmailLoginSecurity(db, user.id)).enabled)
      throw new AppError(503, "Email sign-in verification is unavailable. Please retry later.");
    const previous = await sessionCredential();
    return setSession(json({ user }), await rotateWebSession(db, user.id, previous.token ? hashToken(previous.token) : null));
  }
  if (path.length === 1 && path[0] === "logout" && request.method === "POST") {
    const { token, transport } = await sessionCredential();
    if (token) await db.transaction(async (tx) => {
      await tx.query("DELETE FROM session WHERE token_hash=$1 AND transport=$2", [hashToken(token), transport]);
      await tx.query("DELETE FROM oauth_flow WHERE auth_session_hash=$1 AND intent IN ('link','import')", [hashToken(token)]);
    });
    const response = json({ ok: true });
    if (transport === "web") response.cookies.delete(SESSION_COOKIE);
    return response;
  }
  if (path.length === 1 && path[0] === "account" && request.method === "DELETE") {
    await requireWebAccount();
    const user = await assertAccountOwner(request);
    const credential = await sessionCredential();
    if ((await recentSessionAccount(db, credential.token, credential.transport))?.id !== user.id)
      throw new AppError(403, "Sign in again before deleting your account.");
    await withCurrentWebSession(db, user.id, credential.token ? hashToken(credential.token) : null,
      async (tx) => { await tx.query("DELETE FROM app_user WHERE id=$1", [user.id]); });
    const response = json({ ok: true });
    response.cookies.delete(SESSION_COOKIE);
    return response;
  }
  return null;
}
