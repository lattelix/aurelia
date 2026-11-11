import {
  AppError,
  type MusicProvider,
  type SearchResult,
  type Track,
  type Album,
  type Artist,
  type PlaybackSource,
} from "@aurelia/core";
import { z } from "zod";
import { youtubeLinkId, youtubeLinkTrack } from "./youtube-link";

const ItemSchema = z.object({
  id: z.union([z.string(), z.object({ videoId: z.string() })]),
  snippet: z.object({
    title: z.string(),
    channelTitle: z.string(),
    channelId: z.string(),
    publishedAt: z.string().optional(),
    thumbnails: z
      .object({ medium: z.object({ url: z.string() }).optional() })
      .optional(),
  }),
  contentDetails: z.object({ duration: z.string() }).optional(),
});
function duration(iso: string) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  return m
    ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
    : 0;
}
export class YouTubeProvider implements MusicProvider {
  readonly id = "youtube";
  constructor(private readonly apiKey: string) {}
  private async request(resource: string, params: Record<string, string>) {
    if (!this.apiKey)
      throw new AppError(
        503,
        "Search by title needs a YouTube API key. Paste a YouTube video link to play and save it now.",
      );
    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    Object.entries({ ...params, key: this.apiKey }).forEach(([k, v]) =>
      url.searchParams.set(k, v),
    );
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok)
      throw new AppError(
        res.status === 403 ? 503 : 502,
        "YouTube is temporarily unavailable or its quota has been reached.",
      );
    const data = z
      .object({ items: z.array(ItemSchema) })
      .parse(await res.json());
    return data.items.map((item) => {
      const id = typeof item.id === "string" ? item.id : item.id.videoId;
      return {
        id: `youtube:${id}`,
        title: item.snippet.title,
        artist: item.snippet.channelTitle,
        artistId: item.snippet.channelId,
        album: "YouTube",
        albumId: "youtube",
        duration: duration(item.contentDetails?.duration ?? ""),
        artwork:
          item.snippet.thumbnails?.medium?.url ??
          `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
        provider: "youtube" as const,
        externalId: id,
        genre: "Music",
        year: Number(item.snippet.publishedAt?.slice(0, 4) ?? 2026),
        sourceUrl: `https://www.youtube.com/watch?v=${id}`,
      };
    });
  }
  async search(query: string): Promise<SearchResult> {
    const videoId = youtubeLinkId(query);
    if (videoId) {
      const track = await this.getTrack(videoId);
      return {
        tracks: track ? [track] : [],
        albums: [],
        artists: [],
        playlists: [],
        source: "youtube",
        notice: track
          ? "Play this YouTube video here, then like it or add it to a playlist. Keep the video player visible while listening."
          : "This video is private, unavailable, or cannot be embedded. Try another YouTube link.",
      };
    }
    const results = await this.request("search", {
      part: "snippet",
      q: query,
      type: "video",
      videoCategoryId: "10",
      videoEmbeddable: "true",
      maxResults: "20",
    });
    const tracks = results.length
      ? await this.request("videos", {
          part: "snippet,contentDetails",
          id: results.map((t) => t.externalId).join(","),
        })
      : [];
    return {
      tracks,
      albums: [],
      artists: [],
      playlists: [],
      source: "youtube",
      notice:
        "YouTube results play in a visible video player. Albums and personalized YouTube Music APIs are not exposed by the official Data API.",
    };
  }
  async getTrack(id: string) {
    const videoId = id.replace(/^youtube:/, "");
    if (!/^[\w-]{11}$/.test(videoId)) return null;
    if (!this.apiKey) return youtubeLinkTrack(videoId);
    return (
      (
        await this.request("videos", {
          part: "snippet,contentDetails",
          id: videoId,
        })
      )[0] ?? null
    );
  }
  async getAlbum(): Promise<Album | null> {
    return null;
  }
  async getArtist(): Promise<Artist | null> {
    return null;
  }
  async getPlaylist() {
    return null;
  }
  async getStream(track: Track): Promise<PlaybackSource> {
    if (!/^[\w-]{11}$/.test(track.externalId))
      throw new AppError(400, "Invalid YouTube ID");
    return {
      kind: "youtube" as const,
      videoId: track.externalId,
      capabilities: {
        background: false as const,
        seek: true as const,
        mediaSession: false as const,
      },
    };
  }
  async getLyrics() {
    return null;
  }
  async getRelated(track: Track) {
    if (!this.apiKey) return [];
    return (await this.search(track.artist)).tracks.filter(
      (t) => t.id !== track.id,
    );
  }
  async getRecommendations() {
    return [];
  }
  async autocomplete() {
    return [];
  }
  async getArtistTopTracks() {
    return [];
  }
}
