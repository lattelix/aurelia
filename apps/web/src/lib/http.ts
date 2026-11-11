import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { AppError } from "@aurelia/core";
import { getDatabase } from "@aurelia/database";
import { sessionAccount } from "@aurelia/auth";
import { env } from "./env";
export const SESSION_COOKIE = "aurelia_session";
export const ACCOUNT_HEADER = "X-Aurelia-Account";
export const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
export async function account(required = false) {
  const db = await getDatabase();
  const credential = await sessionCredential();
  const user = await sessionAccount(db, credential.token, credential.transport);
  if (credential.transport === "native" && !user)
    throw new AppError(401, "Your session expired. Sign in again.");
  if (required && !user) throw new AppError(401, "Sign in to save your music");
  return user;
}
export async function sessionCredential() {
  const authorization = (await headers()).get("authorization");
  if (authorization !== null) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
    if (!match) throw new AppError(401, "Your session is invalid. Sign in again.");
    return { token: match[1], transport: "native" as const };
  }
  return { token: (await cookies()).get(SESSION_COOKIE)?.value, transport: "web" as const };
}
export async function requireAccount() {
  return (await account(true))!;
}
export async function requireWebAccount() {
  if ((await sessionCredential()).transport !== "web")
    throw new AppError(403, "Open your account in the browser to manage sign-in methods.");
  return requireAccount();
}
export async function assertOrigin(request: Request) {
  if (request.headers.has("authorization")) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.get("authorization") ?? "");
    if (!match || !(await sessionAccount(await getDatabase(), match[1], "native")))
      throw new AppError(401, "Your session expired. Sign in again.");
    return;
  }
  const origin = request.headers.get("origin");
  const expected = new URL(env.APP_URL).origin;
  if (origin !== expected)
    throw new AppError(403, "Request origin is not trusted");
}
export async function assertAccountOwner(request: Request) {
  const user = await requireAccount();
  if (request.headers.get(ACCOUNT_HEADER) !== user.id)
    throw new AppError(409, "Your account changed. Refresh before changing your library.");
  return user;
}
export function setSession(response: NextResponse, token: string) {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.APP_URL.startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 86400,
  });
  return response;
}
export async function requestText(request: Request, maximum = 2_000_000) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maximum) throw new AppError(413, "Request is too large");
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximum) {
        await reader.cancel().catch(() => {});
        throw new AppError(413, "Request is too large");
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new AppError(400, "Invalid request encoding"); }
}
export async function body(request: Request, maximum = 2_000_000) {
  const text = await requestText(request, maximum);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError(400, "Invalid JSON");
  }
}
