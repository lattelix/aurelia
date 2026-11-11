import {
  normalize,
  type MusicProvider,
  type SearchResult,
  type Track,
} from "@aurelia/core";
import { albums, artists, catalogue, editorialPlaylists } from "./catalogue";
export class StudioProvider implements MusicProvider {
  readonly id = "studio";
  async search(query: string): Promise<SearchResult> {
    const q = normalize(query);
    const matches = (s: string) => normalize(s).includes(q);
    return {
      tracks: catalogue.filter((t) =>
        matches(`${t.title} ${t.artist} ${t.genre} ${t.album}`),
      ),
      albums: albums.filter((a) => matches(`${a.title} ${a.artist}`)),
      artists: artists.filter((a) => matches(a.name)),
      playlists: editorialPlaylists.filter((p) =>
        matches(`${p.name} ${p.description}`),
      ),
      source: "studio",
    };
  }
  async getTrack(id: string) {
    return catalogue.find((t) => t.id === id) ?? null;
  }
  async getAlbum(id: string) {
    return albums.find((a) => a.id === id) ?? null;
  }
  async getArtist(id: string) {
    return artists.find((a) => a.id === id) ?? null;
  }
  async getPlaylist(id: string) {
    return editorialPlaylists.find((p) => p.id === id) ?? null;
  }
  async getStream(track: Track) {
    if (!catalogue.some((t) => t.id === track.id))
      throw new Error("Unknown studio recording");
    return {
      kind: "audio" as const,
      url: `/audio/${track.externalId}.mp3`,
      capabilities: {
        background: true as const,
        seek: true as const,
        mediaSession: true as const,
      },
    };
  }
  async getLyrics() {
    return null;
  }
  async getRelated(track: Track) {
    return catalogue.filter(
      (t) => t.genre === track.genre && t.id !== track.id,
    );
  }
  async getRecommendations() {
    return catalogue;
  }
  async autocomplete(query: string) {
    return (await this.search(query)).tracks.slice(0, 5).map((t) => t.title);
  }
  async getArtistTopTracks(id: string) {
    return catalogue.filter((t) => t.artistId === id);
  }
}
