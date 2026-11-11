import {
  AppError,
  TrackSchema,
  type AudioQuality,
  type PlaybackSource,
  type SearchResult,
  type Track,
} from "@aurelia/core";
import { YouTubeProvider, youtubeLinkId } from "@aurelia/music";
import { YTNodes } from "youtubei.js";
import { MediaCache } from "./cache";
import { youtubeClient } from "./client";
import { attestedClient } from "./attestation";
import { gatewayStream } from "./gateway-client";

const tracks = new MediaCache<Track>(256);
const searches = new MediaCache<SearchResult>(96);
const related = new MediaCache<Track[]>(96);
const streams = new MediaCache<ResolvedAudio>(96);
const playable = new MediaCache<boolean>(96);
const idPattern = /^[A-Za-z0-9_-]{11}$/;

function trackFromVideo(video: YTNodes.Video | YTNodes.CompactVideo): Track {
  return TrackSchema.parse({
    id: `youtube:${video.video_id}`,
    externalId: video.video_id,
    provider: "youtube",
    title: video.title.toString().slice(0, 500),
    artist: (video.author.name || "YouTube").slice(0, 500),
    artistId: video.author.id || `youtube:channel:${video.author.name}`,
    album: "",
    albumId: "",
    duration: Number.isFinite(video.duration.seconds)
      ? video.duration.seconds
      : 0,
    artwork: `https://i.ytimg.com/vi/${video.video_id}/hqdefault.jpg`,
    genre: "",
    year: 0,
    sourceUrl: `https://www.youtube.com/watch?v=${video.video_id}`,
  });
}
function remember(track: Track) {
  tracks.set(track.externalId, track, 60 * 60_000);
  return track;
}
function unavailable() {
  return new AppError(
    502,
    "YouTube audio is temporarily unavailable. Try again, choose another recording, or watch the video.",
  );
}
export interface ResolvedAudio {
  url: string;
  variant: string;
  contentLength: number;
  mimeType: string;
  bitrate: number;
  duration: number;
  quality: AudioQuality;
  version: string;
}
export function validMediaUrl(input: string): URL {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".googlevideo.com") ||
    url.username ||
    url.password ||
    url.port
  )
    throw new AppError(502, "Invalid media source");
  return url;
}
export async function resolveAudio(
  videoId: string,
  quality: AudioQuality = "balanced",
  variant?: string,
  refresh = false,
): Promise<ResolvedAudio> {
  if (!idPattern.test(videoId)) throw new AppError(400, "Invalid YouTube ID");
  const key = `${videoId}:${quality}:${variant ?? "default"}`;
  if (refresh) {
    streams.delete(key);
    streams.delete(`${videoId}:${quality}:default`);
  }
  try {
    const result = await streams.resolve(key, 8 * 60_000, async () => {
      const { client, token } = await attestedClient(videoId, refresh);
      const info = await client.getBasicInfo(videoId, { client: "MWEB", po_token: token });
      if (info.basic_info.is_live || info.basic_info.is_upcoming)
        throw new AppError(422, "Live streams are available in video mode.");
      const formats = (info.streaming_data?.adaptive_formats ?? []).filter(
        (f) =>
          f.has_audio &&
          !f.has_video &&
          !f.drm_families?.length &&
          f.mime_type.startsWith("audio/mp4") &&
          f.mime_type.includes("mp4a") &&
          (f.url || f.signature_cipher || f.cipher) &&
          !f.is_dubbed &&
          !f.is_descriptive &&
          !f.is_secondary,
      );
      const identifier = (f: (typeof formats)[number]) =>
        `MWEB.${f.itag}.${f.audio_track?.id ?? "original"}.${f.is_drc ? "drc" : "normal"}`;
      const ordered = formats.sort((a, b) => a.bitrate - b.bitrate);
      const preferred = ordered.filter((f) => !f.is_drc);
      const choices = preferred.length ? preferred : ordered;
      const selected = variant
        ? choices.find((f) => identifier(f) === variant)
        : quality === "low"
          ? choices[0]
          : quality === "balanced"
            ? (choices.find((f) => f.itag === 140) ?? choices.at(-1))
            : choices.at(-1);
      if (!selected || !selected.content_length) {
        console.warn("youtube_audio_unavailable", {
          status: info.playability_status?.status,
          formats: formats.length,
        });
        throw unavailable();
      }
      const url = validMediaUrl(await selected.decipher(client.session.player));
      url.searchParams.set("cpn", info.cpn);
      url.searchParams.set("pot", token);
      return {
        url: url.href,
        variant: identifier(selected),
        contentLength: selected.content_length,
        mimeType: selected.mime_type,
        bitrate: selected.bitrate,
        duration:
          info.basic_info.duration ?? selected.approx_duration_ms / 1000,
        quality,
        version: String(selected.last_modified_ms ?? selected.content_length),
      };
    });
    streams.set(`${videoId}:${quality}:${result.variant}`, result, 8 * 60_000);
    return result;
  } catch (error) {
    if (!(error instanceof AppError))
      console.warn("youtube_audio_failure", {
        type: error instanceof Error ? error.name : "Unknown",
        code:
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string" &&
          /^[A-Z_]+$/.test(error.code)
            ? error.code
            : undefined,
      });
    if (error instanceof AppError) throw error;
    // Do not forward raw upstream errors: they can include signed URLs.
    throw unavailable();
  }
}

/** Server-only adapter; public @aurelia/music imports stay safe for the UI. */
export class YouTubeAudioProvider extends YouTubeProvider {
  constructor(
    apiKey: string,
    private readonly audioEnabled = true,
    private readonly localOnly = false,
  ) {
    super(apiKey);
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
      };
    }
    if (query.trim().length < 2)
      return {
        tracks: [],
        albums: [],
        artists: [],
        playlists: [],
        source: "youtube",
      };
    try {
      return await searches.resolve(
        query.trim().toLowerCase(),
        2 * 60_000,
        async () => {
          const result = await (
            await youtubeClient()
          ).search(query, { type: "video" });
          const found = result.videos
            .filter(
              (v): v is YTNodes.Video =>
                v.is(YTNodes.Video) && !v.is_live && !v.is_upcoming,
            )
            .slice(0, 20)
            .map((v) => remember(trackFromVideo(v)));
          return {
            tracks: found,
            albums: [],
            artists: [],
            playlists: [],
            source: "youtube",
          };
        },
      );
    } catch {
      throw new AppError(
        502,
        "YouTube search is temporarily unavailable. Please retry.",
      );
    }
  }
  async getTrack(id: string): Promise<Track | null> {
    const videoId = id.replace(/^youtube:/, "");
    if (!idPattern.test(videoId)) return null;
    const cached = tracks.get(videoId);
    if (cached) return cached;
    try {
      const info = await (
        await youtubeClient()
      ).getBasicInfo(videoId, { client: "IOS" });
      const basic = info.basic_info;
      if (!basic.title) return super.getTrack(id);
      return remember(
        TrackSchema.parse({
          id: `youtube:${videoId}`,
          externalId: videoId,
          provider: "youtube",
          title: basic.title || "YouTube recording",
          artist: basic.author || "YouTube",
          artistId: basic.channel_id || `youtube:channel:${videoId}`,
          album: "",
          albumId: "",
          duration: basic.duration ?? 0,
          artwork: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          genre: "",
          year: 0,
          sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
        }),
      );
    } catch {
      // oEmbed metadata can still make unavailable-audio videos usable in video mode.
      return super.getTrack(id);
    }
  }
  async getStream(
    track: Track,
    quality: AudioQuality = "balanced",
  ): Promise<PlaybackSource> {
    if (!this.audioEnabled) return super.getStream(track);
    let source: ResolvedAudio;
    try {
      if (!this.localOnly) {
        const remote = await gatewayStream(track, quality);
        if (remote) return remote;
      }
      source = await resolveAudio(track.externalId, quality);
      const fullAccess = await playable.resolve(
        `${track.externalId}:${source.variant}:${source.version}`,
        2 * 60_000,
        async () => {
          // A cold-start token can serve a preview yet fail later. Probe the
          // start, middle and end before advertising usable audio/seek.
          for (const start of new Set([
            0,
            Math.max(0, Math.floor(source.contentLength / 2) - 512),
            Math.max(0, source.contentLength - 1024),
          ])) {
            const end = Math.min(source.contentLength - 1, start + 1023);
            const url = validMediaUrl(source.url);
            url.searchParams.set("range", `${start}-${end}`);
            const response = await fetch(url, {
              redirect: "error",
              signal: AbortSignal.timeout(10_000),
            });
            if (
              ![200, 206].includes(response.status) ||
              Number(response.headers.get("content-length")) !== end - start + 1
            ) {
              await response.body?.cancel();
              return false;
            }
            if ((await response.arrayBuffer()).byteLength !== end - start + 1)
              return false;
          }
          return true;
        },
      );
      if (!fullAccess) throw unavailable();
    } catch {
      const fallback = await super.getStream(track);
      if (fallback.kind !== "youtube") return fallback;
      return {
        ...fallback,
        notice:
          "YouTube audio is unavailable from this server. Playing the video instead; background audio is unavailable for this recording.",
      };
    }
    const params = new URLSearchParams({
      id: track.externalId,
      quality,
      variant: source.variant,
      version: source.version,
    });
    return {
      kind: "audio",
      url: `/api/audio?${params}`,
      hlsUrl: `/api/audio?${params}&format=hls`,
      duration: source.duration,
      quality,
      bitrate: source.bitrate,
      mimeType: source.mimeType,
      capabilities: { background: true, seek: true, mediaSession: true },
    };
  }
  async getRelated(track: Track): Promise<Track[]> {
    return related.resolve(track.externalId, 10 * 60_000, async () => {
      try {
        const info = await (await youtubeClient()).getInfo(track.externalId);
        const found = Array.from(info.watch_next_feed ?? [])
          .filter(
            (v): v is YTNodes.CompactVideo =>
              v.is(YTNodes.CompactVideo) && !v.is_live,
          )
          .slice(0, 15)
          .map((v) => remember(trackFromVideo(v)));
        if (found.length) return found;
      } catch {
        /* A related-feed failure may still allow an artist search. */
      }
      return (await this.search(track.artist)).tracks.filter(
        (t) => t.id !== track.id,
      );
    });
  }
}
