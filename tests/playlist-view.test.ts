import { describe, expect, it } from "vitest";
import { catalogue } from "@aurelia/music";
import type { UserPlaylist } from "@aurelia/core";
import {
  movePlaylistTrack,
  playlistTrackView,
  playlistView,
  samePlaylistOrder,
} from "../apps/web/src/components/playlist-view";

const tracks = [
  {
    ...catalogue[0],
    title: "Zulu 10",
    artist: "Artist B",
    album: "Evening",
    duration: 90,
  },
  {
    ...catalogue[1],
    title: "Álpha 2",
    artist: "Artist A",
    album: "Morning",
    duration: 120,
  },
  {
    ...catalogue[2],
    title: "Zulu 2",
    artist: "Artist B",
    album: "Evening",
    duration: 30,
  },
];
const playlists: UserPlaylist[] = [
  {
    id: "older",
    name: "Zulu",
    description: "Quiet favorites",
    tracks: [tracks[0]],
    createdAt: "2026-11-01T00:00:00Z",
  },
  {
    id: "newer",
    name: "Álpha",
    description: "Morning songs",
    tracks,
    createdAt: "2026-11-08T00:00:00Z",
  },
];

describe("playlist views and saved order", () => {
  it("filters playlist names and descriptions with case/accent/spacing normalization", () => {
    expect(
      playlistView(playlists, " ALPHA ", "recent").map((item) => item.id),
    ).toEqual(["newer"]);
    expect(
      playlistView(playlists, "quiet", "recent").map((item) => item.id),
    ).toEqual(["older"]);
    expect(playlistView(playlists, "not found", "recent")).toEqual([]);
  });
  it("sorts library playlists by recency, name and song count without mutating canonical data", () => {
    for (const sort of ["recent", "name", "songs"] as const)
      expect(playlistView(playlists, "", sort).map((item) => item.id)).toEqual([
        "newer",
        "older",
      ]);
    expect(playlists.map((item) => item.id)).toEqual(["older", "newer"]);
  });
  it("filters by title, artist and album, preserving the canonical sequence in Original order", () => {
    expect(playlistTrackView(tracks, "zulu", "custom")).toEqual([
      tracks[0],
      tracks[2],
    ]);
    expect(playlistTrackView(tracks, "artist a", "custom")).toEqual([
      tracks[1],
    ]);
    expect(playlistTrackView(tracks, "evening", "custom")).toEqual([
      tracks[0],
      tracks[2],
    ]);
    expect(playlistTrackView(tracks, "missing", "custom")).toEqual([]);
  });
  it("produces the visible playback sequence for title, artist and duration sort without rewriting saved order", () => {
    expect(playlistTrackView(tracks, "", "title")).toEqual([
      tracks[1],
      tracks[2],
      tracks[0],
    ]);
    expect(playlistTrackView(tracks, "", "artist")).toEqual([
      tracks[1],
      tracks[2],
      tracks[0],
    ]);
    expect(playlistTrackView(tracks, "", "duration")).toEqual([
      tracks[2],
      tracks[0],
      tracks[1],
    ]);
    expect(playlistTrackView(tracks, "artist b", "title")).toEqual([
      tracks[2],
      tracks[0],
    ]);
    expect(tracks.map((track) => track.title)).toEqual([
      "Zulu 10",
      "Álpha 2",
      "Zulu 2",
    ]);
  });
  it("retains the original relative order for equal sort values", () => {
    const equal = tracks.map((track) => ({
      ...track,
      title: "Same",
      artist: "Same",
      duration: 72,
    }));
    expect(
      playlistTrackView(equal, "", "title").map((track) => track.id),
    ).toEqual(equal.map((track) => track.id));
  });
  it("moves one saved entry in either direction without changing its identity or the original array", () => {
    const moved = movePlaylistTrack(tracks, 0, 2);
    expect(moved).toEqual([tracks[1], tracks[2], tracks[0]]);
    expect(movePlaylistTrack(moved, 2, 0)).toEqual(tracks);
    expect(
      samePlaylistOrder(
        tracks.map((track) => track.id),
        moved.map((track) => track.id),
      ),
    ).toBe(false);
    expect(
      samePlaylistOrder(
        tracks.map((track) => track.id),
        tracks.map((track) => track.id),
      ),
    ).toBe(true);
    expect(tracks[0].title).toBe("Zulu 10");
  });
  it("rejects invalid move positions without dropping, duplicating or adding entries", () => {
    for (const [from, to] of [
      [-1, 0],
      [0, 3],
      [NaN, 1],
      [0, 0.5],
    ])
      expect(movePlaylistTrack(tracks, from, to)).toEqual(tracks);
    expect(samePlaylistOrder(["a"], ["a", "b"])).toBe(false);
    expect(movePlaylistTrack([], 0, 0)).toEqual([]);
  });
});
