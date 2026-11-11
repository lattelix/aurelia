import { AppError, type DiscoveryPage } from "@aurelia/core";
import { Innertube, Log, YTNodes } from "youtubei.js";
import { MediaCache } from "./cache";
import { normalizeExplore, type ExploreTrackInput } from "./discovery-metadata";
import { discoveryFetch } from "./discovery-fetch";

const cache = new MediaCache<DiscoveryPage>(1);
function itemMetadata(node: YTNodes.MusicResponsiveListItem | YTNodes.MusicTwoRowItem): ExploreTrackInput | null {
  if (node.item_type !== "song" && node.item_type !== "video") return null;
  const endpointId: unknown = node.endpoint?.payload.videoId;
  const videoId = node.id && /^[A-Za-z0-9_-]{11}$/.test(node.id)
    ? node.id : typeof endpointId === "string" ? endpointId : undefined;
  const names = node.artists?.map((artist) => artist.name).filter(Boolean);
  return {
    videoId, title: node.title?.toString(),
    artist: names?.length ? names.join(", ") : node.author?.name,
    artistId: node.artists?.[0]?.channel_id ?? node.author?.channel_id,
    ...(node.is(YTNodes.MusicResponsiveListItem) ? {
      duration: node.duration?.seconds, album: node.album?.name, albumId: node.album?.id,
    } : {}),
  };
}

/** Anonymous YouTube Music Explore; no account personalization or fabricated chart dates. */
export function getMusicDiscovery(): Promise<DiscoveryPage> {
  return cache.resolve("explore-en", 15 * 60_000, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      Log.setLevel(Log.Level.NONE);
      const client = await Innertube.create({
        lang: "en", location: "US", retrieve_player: false,
        fetch: discoveryFetch(controller.signal),
      });
      const explore = await client.music.getExplore();
      return normalizeExplore(explore.sections.slice(0, 24).map((section) => ({
        title: section.header?.title?.toString() ?? "",
        items: section.contents.slice(0, 100).flatMap((node) => {
          if (!node.is(YTNodes.MusicResponsiveListItem, YTNodes.MusicTwoRowItem)) return [];
          const item = itemMetadata(node);
          return item ? [item] : [];
        }),
      })), new Date().toISOString());
    } catch {
      throw new AppError(502, "YouTube Music discovery is unavailable. You can still search for music.");
    } finally { clearTimeout(timer); controller.abort(); }
  });
}
