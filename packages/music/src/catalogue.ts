import type { Album, Artist, MusicPlaylist, Track } from "@aurelia/core";

const releases = [
  {
    id: "afterglow",
    title: "Afterglow",
    artist: "Aurelia Studio",
    artistId: "aurelia-studio",
    genre: "Electronic",
    art: "afterglow",
    titles: ["Golden Hour", "Weightless", "The Last Light"],
    year: 2026,
  },
  {
    id: "blue-hours",
    title: "Blue Hours",
    artist: "Aurelia Studio",
    artistId: "aurelia-studio",
    genre: "Ambient",
    art: "blue-hours",
    titles: ["Slow Motion", "Between the Tides", "Blue Hour"],
    year: 2026,
  },
  {
    id: "parallel",
    title: "Parallel Worlds",
    artist: "Aurelia Studio",
    artistId: "aurelia-studio",
    genre: "Electronic",
    art: "parallel",
    titles: ["Parallel", "Soft Focus", "Night Drive"],
    year: 2026,
  },
  {
    id: "still-life",
    title: "Still Life",
    artist: "Aurelia Studio",
    artistId: "aurelia-studio",
    genre: "Lo-fi",
    art: "still-life",
    titles: ["Sunday Morning", "Paper Planes", "Somewhere Quiet"],
    year: 2026,
  },
];
export const catalogue: Track[] = releases.flatMap((r, albumIndex) =>
  r.titles.map((title, i) => ({
    id: `studio:${r.id}-${i + 1}`,
    title,
    artist: r.artist,
    artistId: r.artistId,
    album: r.title,
    albumId: r.id,
    duration: 72,
    artwork: `/art/${r.art}.svg`,
    provider: "studio" as const,
    externalId: `${albumIndex * 3 + i + 1}`,
    genre: r.genre,
    year: r.year,
  })),
);
export const albums: Album[] = releases.map((r) => ({
  id: r.id,
  title: r.title,
  artist: r.artist,
  artistId: r.artistId,
  artwork: `/art/${r.art}.svg`,
  year: r.year,
  tracks: catalogue.filter((t) => t.albumId === r.id),
}));
export const artists: Artist[] = [
  {
    id: "aurelia-studio",
    name: "Aurelia Studio",
    artwork: "/art/artist.svg",
    genres: ["Electronic", "Ambient", "Lo-fi"],
    tracks: catalogue,
    albums,
  },
];
export const editorialPlaylists: MusicPlaylist[] = [
  {
    id: "golden-hour",
    name: "Golden hour",
    description: "Warm textures. Wide open skies. Let the day linger.",
    artwork: "/art/afterglow.svg",
    tracks: [
      catalogue[0],
      catalogue[6],
      catalogue[9],
      catalogue[1],
      catalogue[4],
      catalogue[8],
    ],
  },
  {
    id: "deep-focus",
    name: "A little more focus",
    description: "Find your flow with soft, spacious instrumentals.",
    artwork: "/art/blue-hours.svg",
    tracks: [
      catalogue[3],
      catalogue[10],
      catalogue[5],
      catalogue[7],
      catalogue[11],
    ],
  },
  {
    id: "night-swim",
    name: "Night swim",
    description: "For the hours that belong to you.",
    artwork: "/art/parallel.svg",
    tracks: [
      catalogue[8],
      catalogue[6],
      catalogue[4],
      catalogue[2],
      catalogue[7],
    ],
  },
  {
    id: "slow-sundays",
    name: "Slow Sundays",
    description: "Nowhere to be. Nothing to rush.",
    artwork: "/art/still-life.svg",
    tracks: [
      catalogue[9],
      catalogue[11],
      catalogue[10],
      catalogue[3],
      catalogue[1],
    ],
  },
];
