import { z } from "zod";
import { getDatabase } from "@aurelia/database";
import { createDeviceGrant, redeemDeviceGrant, getDeviceGrantForApproval,
  approveDeviceGrant, rateLimit, hashToken } from "@aurelia/auth";
import { AppError } from "@aurelia/core";
import { env } from "./env";
import { body, json, requireWebAccount, assertAccountOwner, sessionCredential } from "./http";
import { withCurrentWebSession } from "./web-session";

const start = z.object({
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  deviceName: z.string().trim().min(1).max(80),
}).strict();
const token = z.object({
  deviceCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
}).strict();
const userCode = z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

/** These two public PKCE endpoints ignore web cookies and never link identities. */
export async function publicDeviceAuth(operation: string, request: Request) {
  if (request.method !== "POST") throw new AppError(405, "Method not allowed");
  if (request.headers.has("authorization")) throw new AppError(400, "Unexpected authorization header");
  const db = await getDatabase();
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const address = /^[0-9a-fA-F:.]{1,64}$/.test(forwarded) ? forwarded : "unknown";
  if (operation === "start") {
    await rateLimit(db, `device:start:${address}`, 20, 600);
    await rateLimit(db, "device:start:global", 200, 600);
    const grant = await createDeviceGrant(db, start.parse(await body(request, 4096)));
    const verification = new URL("/account", env.APP_URL);
    verification.searchParams.set("connect", grant.userCode);
    return json({ ...grant, verificationUri: verification.href });
  }
  if (operation === "token") {
    await rateLimit(db, `device:poll:${address}`, 400, 600);
    return json(await redeemDeviceGrant(db, token.parse(await body(request, 4096))));
  }
  throw new AppError(404, "Endpoint not found");
}

export async function privateDeviceAuth(operation: string, request: Request) {
  await requireWebAccount();
  const user = await assertAccountOwner(request);
  const db = await getDatabase();
  await rateLimit(db, `device:approve:${user.id}`, 60, 600);
  if (operation === "grant" && request.method === "GET") {
    const code = userCode.parse(new URL(request.url).searchParams.get("userCode"));
    return json(await getDeviceGrantForApproval(db, code));
  }
  if (operation === "approve" && request.method === "POST") {
    const input = z.object({ userCode }).strict().parse(await body(request, 1024));
    const credential = await sessionCredential();
    return json(await withCurrentWebSession(db, user.id, credential.token ? hashToken(credential.token) : null,
      (tx) => approveDeviceGrant(tx, user.id, input.userCode,
        { webSessionHash: credential.token ? hashToken(credential.token) : undefined })));
  }
  throw new AppError(405, "Method not allowed");
}
