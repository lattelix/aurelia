import { z } from "zod";
import { TrackSchema, type SearchResult } from "@aurelia/core";

export const publicMetadataOrigin = "https://aurelia.lattelix.com";
const thumbnail = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        [
          "i.ytimg.com",
          "img.youtube.com",
          "yt3.ggpht.com",
          "yt3.googleusercontent.com",
        ].includes(url.hostname)
      );
    } catch {
      return false;
    }
  });
const publicTrack = TrackSchema.omit({ sourceUrl: true }).extend({
  provider: z.literal("youtube"),
  externalId: z.string().regex(/^[a-zA-Z0-9_-]{11}$/),
  artwork: thumbnail,
});
const searchResponse = z.object({
  tracks: z.array(publicTrack).max(100),
  source: z.literal("youtube"),
  notice: z.string().max(1000).optional(),
});

/** One public, read-only endpoint; never accept arbitrary URLs or API paths. */
export function publicSearchURL(path: string): string {
  const input = new URL(path, "https://bundled.invalid/");
  if (
    input.origin !== "https://bundled.invalid" ||
    input.pathname !== "/search" ||
    input.hash
  )
    throw new Error("This operation is unavailable in the guest preview.");
  const keys = [...input.searchParams.keys()];
  if (
    keys.length !== 2 ||
    new Set(keys).size !== 2 ||
    !keys.includes("q") ||
    !keys.includes("provider") ||
    input.searchParams.get("provider") !== "youtube"
  )
    throw new Error("This operation is unavailable in the guest preview.");
  const query = input.searchParams.get("q")?.trim() ?? "";
  if (!query || query.length > 200)
    throw new Error("Enter a search of 1–200 characters.");
  const output = new URL("/api/search", publicMetadataOrigin);
  output.searchParams.set("q", query);
  output.searchParams.set("provider", "youtube");
  return output.href;
}

export function parsePublicSearch(data: unknown): SearchResult {
  // The native HTTP bridge buffers JSON; this bounds the accepted UI payload,
  // rather than claiming a streaming transport byte limit.
  const serialized = JSON.stringify(data);
  if (
    !serialized ||
    new TextEncoder().encode(serialized).length > 2 * 1024 * 1024
  )
    throw new Error("The search response is too large.");
  const parsed = searchResponse.parse(data);
  return { ...parsed, albums: [], artists: [], playlists: [] };
}
