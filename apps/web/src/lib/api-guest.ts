import { getDatabase } from "@aurelia/database";
import { rateLimit } from "@aurelia/auth";
import { account, body, json } from "./http";
import { guestAccess, guestAuthorization } from "./guest-policy";

export async function guestApi(request: Request) {
  if (request.method === "GET") {
    const config = guestAccess.publicConfig();
    const user = await account();
    const access = user ? { allowed: true } : await guestAuthorization();
    return json({
      required: config.mode === "required",
      allowed: access.allowed,
      ready: config.ready,
      action: config.action,
      ...(config.siteKey ? { siteKey: config.siteKey } : {}),
    });
  }
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  await rateLimit(await getDatabase(), "guest-admission:global", 60);
  const input = await body(request, 3072);
  const token =
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    "token" in input
      ? input.token
      : undefined;
  const result = await guestAccess.admit({
    token,
    origin: request.headers.get("origin"),
  });
  if (!result.ok)
    return json(
      {
        error:
          result.status === 503
            ? "Guest access is temporarily unavailable."
            : "Guest verification failed. Please retry.",
        code: result.code,
      },
      result.status,
    );
  const response = json({ ok: true });
  if (result.mode === "required")
    response.cookies.set(
      result.cookie.name,
      result.cookie.value,
      result.cookie.options,
    );
  return response;
}
