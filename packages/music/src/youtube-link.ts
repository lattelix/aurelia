import { AppError, type Track } from "@aurelia/core";
import { z } from "zod";

const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const hosts = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

export function youtubeLinkId(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    !hosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const id = url.hostname.endsWith("youtu.be")
    ? segments.length === 1
      ? segments[0]
      : null
    : url.pathname === "/watch"
      ? url.searchParams.get("v")
      : segments.length === 2 &&
          ["shorts", "embed", "live"].includes(segments[0])
        ? segments[1]
        : null;
  return id && videoIdPattern.test(id) ? id : null;
}

const MetadataSchema = z.object({
  type: z.literal("video"),
  title: z.string().min(1).max(500),
  author_name: z.string().min(1).max(500),
  author_url: z.url().max(2048),
});

export async function youtubeLinkTrack(videoId: string): Promise<Track | null> {
  if (!videoIdPattern.test(videoId)) return null;
  const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
  // Only the fixed official endpoint is fetched; user URLs never become fetch targets.
  const endpoint = new URL("https://www.youtube.com/oembed");
  endpoint.searchParams.set("url", sourceUrl);
  endpoint.searchParams.set("format", "json");
  let response: Response;
  try {
    response = await fetch(endpoint, {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
  } catch {
    throw new AppError(502, "Cannot reach YouTube. Please try again.");
  }
  if ([401, 403, 404].includes(response.status)) return null;
  if (!response.ok)
    throw new AppError(
      502,
      "YouTube is temporarily unavailable. Please try again.",
    );
  const data = MetadataSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!data.success)
    throw new AppError(502, "YouTube returned incomplete track information.");
  const channel = new URL(data.data.author_url).pathname.slice(1, 141);
  return {
    id: `youtube:${videoId}`,
    title: data.data.title,
    artist: data.data.author_name,
    artistId: `youtube:${channel || videoId}`,
    album: "YouTube",
    albumId: "youtube",
    // oEmbed does not publish duration or release year; the player obtains duration.
    duration: 0,
    year: 0,
    artwork: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    provider: "youtube",
    externalId: videoId,
    genre: "Music",
    sourceUrl,
  };
}
