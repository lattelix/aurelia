import { AppError } from "@aurelia/core";

export type OAuthIntent = "login" | "link" | "import";
export function oauthIntent(provider: string, method: string): OAuthIntent {
  if (method === "GET" && provider !== "spotify") return "login";
  if (method === "POST") return provider === "spotify" ? "import" : "link";
  throw new AppError(405, "Use the account page to connect this service.");
}
export function oauthReturnPath(value: string | null, origin: string, fallback = "/account") {
  if (!value) return fallback;
  let url: URL;
  try { url = new URL(value, origin); } catch { throw new AppError(400, "Invalid return address"); }
  if (url.origin !== new URL(origin).origin || url.username || url.password || url.hash)
    throw new AppError(400, "Invalid return address");
  if (url.pathname === "/import" && !url.search) return "/import";
  if (url.pathname !== "/account") throw new AppError(400, "Invalid return address");
  if (!url.search) return "/account";
  if ([...url.searchParams.keys()].length !== 1) throw new AppError(400, "Invalid return address");
  const connect = url.searchParams.get("connect");
  if (connect && /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(connect)) return `/account?connect=${connect}`;
  const owner = url.searchParams.get("expectedUserId");
  if (owner && /^[a-f0-9-]{36}$/i.test(owner)) return `/account?expectedUserId=${encodeURIComponent(owner)}`;
  throw new AppError(400, "Invalid return address");
}
export function oauthCallbackParameters(text: string) {
  if (new TextEncoder().encode(text).length > 32768) throw new AppError(413, "Callback is too large");
  const parameters = new URLSearchParams(text);
  for (const key of ["state", "code", "error", "user", "id_token"])
    if (parameters.getAll(key).length > 1) throw new AppError(400, "Invalid login response");
  const state = parameters.get("state");
  if (!state || !/^[A-Za-z0-9_-]{16,256}$/.test(state)) throw new AppError(400, "Missing or invalid OAuth state");
  return parameters;
}
export function appleDisplayName(value: string | null): string | undefined {
  if (!value || value.length > 2048) return undefined;
  try {
    const input = JSON.parse(value) as { name?: { firstName?: unknown; lastName?: unknown } };
    const parts = [input.name?.firstName, input.name?.lastName];
    if (!parts.every((x) => x === undefined || typeof x === "string" && x.length <= 100)) return undefined;
    const name = parts.filter((x): x is string => typeof x === "string").join(" ").trim().slice(0, 80);
    return name || undefined;
  } catch { return undefined; }
}
