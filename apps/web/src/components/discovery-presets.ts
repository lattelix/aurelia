import type { Track } from "@aurelia/core";

/** Editorial search shortcuts, not upstream playlists or chart rankings. */
export const moodSearchPresets = [
  {
    id: "focus",
    title: "Focus",
    query: "instrumental focus music",
    caption: "Stay with the task",
    artwork: "/art/still-life.svg",
  },
  {
    id: "unwind",
    title: "Unwind",
    query: "chill relaxing music",
    caption: "Room to breathe",
    artwork: "/art/blue-hours.svg",
  },
  {
    id: "energy",
    title: "Energy",
    query: "upbeat electronic music",
    caption: "A little momentum",
    artwork: "/art/afterglow.svg",
  },
] as const;

export function moodSearchHref(query: string): string {
  return `/search?${new URLSearchParams({ q: query, provider: "youtube" })}`;
}

export function searchQueryFromUrl(value: string | null): string {
  if (
    value === null ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return "";
  return value.trim();
}

export function visibleDiscoveryTracks(
  tracks: readonly Track[],
  demoCatalogue = false,
): Track[] {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    if ((!demoCatalogue && track.provider !== "youtube") || seen.has(track.id))
      return false;
    seen.add(track.id);
    return true;
  });
}

/** A card can only play its visible collection, or the clicked recording itself. */
export function trackCollection(
  track: Track,
  collection?: readonly Track[],
): { tracks: Track[]; index: number } {
  if (!collection) return { tracks: [track], index: 0 };
  const index = collection.findIndex((entry) => entry.id === track.id);
  return index < 0
    ? { tracks: [track], index: 0 }
    : { tracks: [...collection], index };
}
