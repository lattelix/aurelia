import { normalize, type Track, type UserPlaylist } from "@aurelia/core";

export type PlaylistSort = "recent" | "name" | "songs";
export type PlaylistTrackSort = "custom" | "title" | "artist" | "duration";
const compare = (left: string, right: string) =>
  normalize(left).localeCompare(normalize(right), "en", { numeric: true });

export function playlistView(
  playlists: readonly UserPlaylist[],
  query: string,
  sort: PlaylistSort,
): UserPlaylist[] {
  const text = normalize(query);
  const result = playlists.filter(
    (playlist) =>
      !text ||
      normalize(`${playlist.name} ${playlist.description}`).includes(text),
  );
  if (sort === "name") result.sort((a, b) => compare(a.name, b.name));
  else if (sort === "songs")
    result.sort((a, b) => b.tracks.length - a.tracks.length);
  else
    result.sort(
      (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0),
    );
  return result;
}

export function playlistTrackView(
  tracks: readonly Track[],
  query: string,
  sort: PlaylistTrackSort,
): Track[] {
  const text = normalize(query);
  const result = tracks.filter(
    (track) =>
      !text ||
      normalize(`${track.title} ${track.artist} ${track.album}`).includes(text),
  );
  if (sort === "title") result.sort((a, b) => compare(a.title, b.title));
  else if (sort === "artist")
    result.sort(
      (a, b) => compare(a.artist, b.artist) || compare(a.title, b.title),
    );
  else if (sort === "duration") result.sort((a, b) => a.duration - b.duration);
  return result;
}

export function movePlaylistTrack(
  tracks: readonly Track[],
  from: number,
  to: number,
): Track[] {
  const result = [...tracks];
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= result.length ||
    to >= result.length
  )
    return result;
  const [track] = result.splice(from, 1);
  result.splice(to, 0, track);
  return result;
}

export function samePlaylistOrder(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}
