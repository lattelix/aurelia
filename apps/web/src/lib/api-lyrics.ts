import { z } from "zod";
import { getDatabase } from "@aurelia/database";
import { rateLimit } from "@aurelia/auth";
import { AppError } from "@aurelia/core";
import { account, json } from "./http";
import { LyricsSchema, type Lyrics } from "./lyrics";
import { MediaCache } from "./youtube-media/cache";
const cache = new MediaCache<Lyrics[]>(64);
export async function lyricsApi(request: Request) {
  const query = z
    .string()
    .trim()
    .min(2)
    .max(200)
    .parse(new URL(request.url).searchParams.get("q"));
  const user = await account();
  await rateLimit(await getDatabase(), `lyrics:${user?.id ?? "guest"}`, 30);
  try {
    const records = await cache.resolve(
      query.toLowerCase(),
      30 * 60_000,
      async () => {
        const url = new URL("https://lrclib.net/api/search");
        url.searchParams.set("q", query);
        const response = await fetch(url, {
          headers: {
            "User-Agent": "Aurelia/0.1 (https://aurelia.lattelix.com)",
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error("Lyrics search failed");
        const text = await response.text();
        if (text.length > 2_000_000)
          throw new Error("Lyrics response too large");
        return z
          .array(LyricsSchema)
          .max(100)
          .parse(JSON.parse(text))
          .slice(0, 10);
      },
    );
    return json(records);
  } catch {
    throw new AppError(
      502,
      "Lyrics are temporarily unavailable. Please retry.",
    );
  }
}
