import { z } from "zod";
const schema = z.object({
  APP_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().optional(),
  LOCAL_ACCOUNTS: z.enum(["true", "false"]).default("true"),
  STUDIO_DEMO: z.enum(["true", "false"]).default("false"),
  WEB_GUEST_VERIFICATION: z.enum(["off", "required"]).default("off"),
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  YOUTUBE_PLAYBACK: z.enum(["audio", "video"]).default("audio"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  TELEGRAM_CLIENT_ID: z.string().optional(),
  TELEGRAM_CLIENT_SECRET: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),
  APPLE_CLIENT_SECRET: z.string().optional(),
  SPOTIFY_CLIENT_ID: z.string().optional(),
  SPOTIFY_CLIENT_SECRET: z.string().optional(),
});
export const env = schema.parse(
  Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== ""),
  ),
);
if (process.env.VERCEL && !env.DATABASE_URL)
  throw new Error(
    "Set DATABASE_URL before deploying. Local PGlite is not persistent on serverless hosts.",
  );
export const capabilities = {
  demoCatalogue: env.STUDIO_DEMO === "true",
  youtube: true,
  youtubeAudio: env.YOUTUBE_PLAYBACK === "audio",
  localAccounts: env.LOCAL_ACCOUNTS === "true",
  nativeAccounts: true,
  guestVerification: env.WEB_GUEST_VERIFICATION === "required",
  google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  telegram: !!(env.TELEGRAM_CLIENT_ID && env.TELEGRAM_CLIENT_SECRET),
  apple: !!(env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET),
  spotify: !!(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET),
};
