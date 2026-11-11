import { z } from "zod";

export const TrackSchema = z.object({
  id: z.string().min(1).max(160),
  title: z.string().min(1).max(500),
  artist: z.string().min(1).max(500),
  artistId: z.string().max(160),
  album: z.string().max(500),
  albumId: z.string().max(160),
  duration: z.number().finite().nonnegative().max(86400),
  artwork: z.string().max(2048),
  provider: z.enum(["studio", "youtube"]),
  externalId: z.string().max(160),
  genre: z.string().max(80),
  year: z.number().int(),
  isrc: z.string().optional(),
  sourceUrl: z.string().max(2048).optional(),
});
export type Track = z.infer<typeof TrackSchema>;

// Public discovery metadata only. Locators for audio playback never enter this DTO.
const DiscoveryTrackSchema = TrackSchema.extend({
  provider: z.literal("youtube"),
  externalId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  id: z.string().regex(/^youtube:[A-Za-z0-9_-]{11}$/),
}).superRefine((track, context) => {
  if (track.id !== `youtube:${track.externalId}` ||
      track.artwork !== `https://i.ytimg.com/vi/${track.externalId}/hqdefault.jpg` ||
      track.sourceUrl !== `https://www.youtube.com/watch?v=${track.externalId}`)
    context.addIssue({ code: "custom", message: "Invalid discovery metadata" });
});
export const DiscoveryPageSchema = z.object({
  source: z.literal("youtube-music"),
  fetchedAt: z.iso.datetime(),
  sections: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,80}$/),
    title: z.string().min(1).max(120),
    tracks: z.array(DiscoveryTrackSchema).max(24),
  })).max(4),
});
export type DiscoveryPage = z.infer<typeof DiscoveryPageSchema>;
export interface Album {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  artwork: string;
  year: number;
  tracks: Track[];
}
export interface Artist {
  id: string;
  name: string;
  artwork: string;
  genres: string[];
  tracks: Track[];
  albums: Album[];
}
export interface MusicPlaylist {
  id: string;
  name: string;
  description: string;
  artwork: string;
  tracks: Track[];
}
export interface SearchResult {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: MusicPlaylist[];
  source: "studio" | "youtube";
  notice?: string;
}
export const AudioQualitySchema = z.enum(["low", "balanced", "high"]);
export type AudioQuality = z.infer<typeof AudioQualitySchema>;
export type PlaybackSource =
  | {
      kind: "audio";
      url: string;
      hlsUrl?: string;
      duration?: number;
      quality?: AudioQuality;
      bitrate?: number;
      mimeType?: string;
      capabilities: { background: true; seek: true; mediaSession: true };
    }
  | {
      kind: "youtube";
      videoId: string;
      notice?: string;
      capabilities: { background: false; seek: true; mediaSession: false };
    };
export interface MusicProvider {
  readonly id: string;
  search(query: string): Promise<SearchResult>;
  getTrack(id: string): Promise<Track | null>;
  getAlbum(id: string): Promise<Album | null>;
  getArtist(id: string): Promise<Artist | null>;
  getPlaylist(id: string): Promise<MusicPlaylist | null>;
  getStream(track: Track, quality?: AudioQuality): Promise<PlaybackSource>;
  getLyrics(id: string): Promise<string | null>;
  getRelated(track: Track): Promise<Track[]>;
  getRecommendations(): Promise<Track[]>;
  autocomplete(query: string): Promise<string[]>;
  getArtistTopTracks(id: string): Promise<Track[]>;
}
export interface Account {
  id: string;
  name: string;
  email: string | null;
  identities: string[];
}
export interface UserPlaylist {
  id: string;
  name: string;
  description: string;
  tracks: Track[];
  createdAt: string;
}
export type SignalKind =
  "play" | "skip" | "complete" | "like" | "playlist-add" | "hide" | "search";
export interface Signal {
  trackId: string | null;
  query?: string | null;
  kind: SignalKind;
  value: number;
  createdAt: string;
}
export interface Library {
  likes: Track[];
  playlists: UserPlaylist[];
  history: { id: string; track: Track; playedAt: string; completion: number }[];
  followedArtists: string[];
  queue: unknown;
  searches: string[];
}
export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
export const normalize = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
export const formatTime = (s: number) =>
  `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
export * from "./product-registry";
