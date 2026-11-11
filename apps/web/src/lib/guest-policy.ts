import { cookies } from "next/headers";
import { rateLimit } from "@aurelia/auth";
import { AppError, type Account } from "@aurelia/core";
import { getDatabase } from "@aurelia/database";
import { createGuestAccess, GUEST_CAPABILITY_COOKIE } from "./guest-access";
import { env } from "./env";

export const guestAccess = createGuestAccess({
  mode: env.WEB_GUEST_VERIFICATION,
  appUrl: env.APP_URL,
  siteKey: env.TURNSTILE_SITE_KEY,
  secretKey: env.TURNSTILE_SECRET_KEY,
});
export async function guestAuthorization() {
  return guestAccess.authorize(
    (await cookies()).get(GUEST_CAPABILITY_COOKIE)?.value,
  );
}
/** Account sessions are verified by account(); headers and platform names grant nothing. */
export async function mediaRequestBudget(
  user: Account | null,
  family: "audio" | "resolve",
  limit: number,
) {
  const db = await getDatabase();
  if (env.WEB_GUEST_VERIFICATION !== "required") {
    await rateLimit(db, `${family}:${user?.id ?? "guest"}`, limit);
    return;
  }
  const access = user ? null : await guestAuthorization();
  if (access && !access.allowed)
    throw new AppError(
      access.status,
      access.status === 403
        ? "Verify guest access before listening."
        : "Guest access is temporarily unavailable.",
    );
  const owner =
    user?.id ??
    (access?.allowed && access.mode === "required" ? access.guestId : "guest");
  await rateLimit(db, `${family}:${owner}`, limit);
  await rateLimit(db, "browser-media:global", 360);
  if (!user) await rateLimit(db, "browser-media:guest-global", 120);
}
