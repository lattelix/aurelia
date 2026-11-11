import { z } from "zod";
import { type Track } from "@aurelia/core";
import { catalogueIDs, MusicCataloguePageSchema, safeCatalogueArtwork, type CatalogueTask, type MusicCataloguePage } from "./catalogue-contracts";

const RawItem = z.object({ kind: z.enum(["song", "video", "album", "artist", "playlist"]), id: z.string().max(160).optional(),
  title: z.string().max(500), subtitle: z.string().max(1000), artist: z.string().max(500), artistId: z.string().max(160),
  album: z.string().max(500), albumId: z.string().max(160), duration: z.number().finite().nonnegative().max(86400), artwork: z.string().max(2048) }).strict();
const RawPage = z.object({ operation: z.enum(["search", "browse", "charts"]), kind: z.string().max(20),
  title: z.string().max(500), subtitle: z.string().max(1000), query: z.string().max(200).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(), countryName: z.string().max(120).optional(),
  items: z.array(RawItem).max(1100), sections: z.array(z.object({ id: z.string(), title: z.string().max(120), items: z.array(RawItem).max(1100) }).strict()).max(12),
  truncated: z.boolean() }).strict();
type Item = z.infer<typeof RawItem>;
type Collection = MusicCataloguePage["collections"][number];
const clean = (value: string, length: number) => value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, length);

export function normalizeMusicCatalogue(value: unknown, task: CatalogueTask, fetchedAt = new Date().toISOString()): MusicCataloguePage {
  const raw = RawPage.parse(value);
  if (raw.operation !== task.operation || raw.kind !== (task.operation === "charts" ? "charts" : task.kind)
    || (task.operation === "search" && raw.query !== task.query) || (task.operation === "charts" && raw.country !== task.country)) throw new Error("Catalogue protocol mismatch");
  const maximumTracks = task.operation === "search" ? 100 : 1000;
  let trackCount = 0, collectionCount = 0, truncated = raw.truncated;
  function normalize(items: Item[]) {
    const tracks: Track[] = [], collections: Collection[] = [], seen = new Set<string>();
    for (const item of items) {
      const title = clean(item.title, 500), id = item.id;
      if (!title || !id || seen.has(id)) continue;
      if (item.kind === "song" || item.kind === "video") {
        if (!/^[A-Za-z0-9_-]{11}$/.test(id) || (task.operation === "search" && (task.kind !== "songs" || item.kind !== "song"))) continue;
        if (trackCount >= maximumTracks || (task.operation === "search" && trackCount + collectionCount >= 100)) { truncated = true; continue; }
        seen.add(id); trackCount++;
        tracks.push({ id: `youtube:${id}`, externalId: id, provider: "youtube", title,
          artist: clean(item.artist, 500) || "YouTube Music", artistId: catalogueIDs.artist.test(item.artistId) ? item.artistId : "",
          album: clean(item.album, 500), albumId: catalogueIDs.album.test(item.albumId) ? item.albumId : "", duration: item.duration,
          artwork: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, sourceUrl: `https://www.youtube.com/watch?v=${id}`, genre: "", year: 0 });
      } else {
        if (!catalogueIDs[item.kind].test(id) || (task.operation === "search" && item.kind + "s" !== task.kind)) continue;
        if (collectionCount >= 100 || (task.operation === "search" && trackCount + collectionCount >= 100)) { truncated = true; continue; }
        seen.add(id); collectionCount++;
        collections.push({ id, kind: item.kind, title, subtitle: clean(item.subtitle || item.artist, 1000), artwork: safeCatalogueArtwork(item.artwork) });
      }
    }
    return { tracks, collections };
  }
  const direct = normalize(raw.items);
  const sections = raw.sections.flatMap((section, index) => {
    const title = clean(section.title, 120), result = normalize(section.items);
    return title && (result.tracks.length || result.collections.length) ? [{ id: `section-${index}`, title, ...result }] : [];
  });
  const title = clean(raw.title, 500) || (task.operation === "browse" ? "YouTube Music collection" : "YouTube Music");
  return MusicCataloguePageSchema.parse({ source: "youtube-music", fetchedAt, kind: raw.kind, title, subtitle: clean(raw.subtitle, 1000),
    ...direct, sections, truncated, ...(task.operation === "search" ? { query: task.query } : {}),
    ...(task.operation === "charts" ? { country: task.country, countryName: clean(raw.countryName ?? "", 120) } : {}) });
}
