import { describe, expect, it } from "vitest";
import {
  parsePublicSearch,
  publicSearchURL,
} from "../experiments/mobile-bundle-probe/src/public-metadata";

const track = {
  id: "opaque-database-id",
  title: "Fixture",
  artist: "Artist",
  artistId: "",
  album: "",
  albumId: "",
  duration: 600,
  artwork: "https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg",
  provider: "youtube",
  externalId: "aqz-KE-bpKQ",
  genre: "",
  year: 2008,
};
describe("bundled guest public metadata boundary", () => {
  it("constructs only the fixed public search URL", () => {
    expect(publicSearchURL("search?q=Blender%20film&provider=youtube")).toBe(
      "https://aurelia.lattelix.com/api/search?q=Blender+film&provider=youtube",
    );
    for (const path of [
      "https://evil.invalid/search?q=x&provider=youtube",
      "https://aurelia-music.vercel.app/search?q=x&provider=youtube",
      "https://aurelia.lattelix.com/search?q=x&provider=youtube",
      "//evil.invalid/search",
      "stream?id=x",
      "library/queue",
      "search?q=x&provider=youtube&token=secret",
      "search?q=x&q=y&provider=youtube",
      "search?q=x&provider=studio",
      "search?q=&provider=youtube",
    ])
      expect(() => publicSearchURL(path)).toThrow();
  });
  it("drops media locators and unused collections from public results", () => {
    const result = parsePublicSearch({
      source: "youtube",
      tracks: [
        {
          ...track,
          sourceUrl: "https://media.invalid/signed",
          private: "secret",
        },
      ],
      albums: [{ private: true }],
    });
    expect(result.tracks[0]).toEqual(track);
    expect(result.albums).toEqual([]);
  });
  it("rejects invalid provider identities and unsafe artwork", () => {
    for (const patch of [
      { externalId: "bad-id" },
      { provider: "studio" },
      { artwork: "http://i.ytimg.com/a" },
      { artwork: "https://evil.invalid/a" },
      { artwork: "https://user:pass@i.ytimg.com/a" },
    ])
      expect(() =>
        parsePublicSearch({
          source: "youtube",
          tracks: [{ ...track, ...patch }],
        }),
      ).toThrow();
  });
  it("limits accepted response size and number of results", () => {
    expect(() =>
      parsePublicSearch({ source: "youtube", tracks: Array(101).fill(track) }),
    ).toThrow();
    expect(() =>
      parsePublicSearch({
        source: "youtube",
        tracks: [],
        extra: "x".repeat(2 * 1024 * 1024),
      }),
    ).toThrow();
  });
});
