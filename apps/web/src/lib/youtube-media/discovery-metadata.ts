import { DiscoveryPageSchema, type DiscoveryPage } from "@aurelia/core";

export interface ExploreTrackInput {
  videoId?: string;
  title?: string;
  artist?: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  duration?: number;
}
export interface ExploreSectionInput {
  title: string;
  items: readonly ExploreTrackInput[];
}
const text = (value: string | undefined, maximum: number) =>
  (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum);

/** Normalizes upstream metadata, retaining its order and never accepting upstream URLs. */
export function normalizeExplore(
  sections: readonly ExploreSectionInput[],
  fetchedAt: string,
): DiscoveryPage {
  return DiscoveryPageSchema.parse({
    source: "youtube-music",
    fetchedAt,
    sections: sections.slice(0, 24).flatMap((section, index) => {
      const title = text(section.title, 120);
      const seen = new Set<string>();
      const tracks = section.items.slice(0, 100).flatMap((item) => {
        const id = item.videoId;
        const name = text(item.title, 500);
        if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id) || !name || seen.has(id)) return [];
        seen.add(id);
        return [{
          id: `youtube:${id}`, externalId: id, provider: "youtube" as const,
          title: name, artist: text(item.artist, 500) || "YouTube Music",
          artistId: text(item.artistId, 160), album: text(item.album, 500),
          albumId: text(item.albumId, 160),
          duration: Number.isFinite(item.duration) && item.duration! >= 0 && item.duration! <= 86400 ? item.duration! : 0,
          artwork: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          sourceUrl: `https://www.youtube.com/watch?v=${id}`,
          genre: "", year: 0,
        }];
      }).slice(0, 24);
      return title && tracks.length ? [{ id: `explore-${index}`, title, tracks }] : [];
    }).slice(0, 4),
  });
}
