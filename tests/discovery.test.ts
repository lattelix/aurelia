import { describe, it, expect } from "vitest";
import { matchTrack } from "@aurelia/integrations";
import { catalogue, StudioProvider, YouTubeProvider } from "@aurelia/music";
import { recommend } from "@aurelia/recommendations";
describe("import matching and discovery", () => {
  const source = {
    id: "1",
    title: catalogue[0].title,
    artist: catalogue[0].artist,
    album: catalogue[0].album,
    duration: 72,
  };
  it("matches an exact recording", () =>
    expect(matchTrack(source, catalogue).status).toBe("matched"));
  it("rejects unrelated tracks", () =>
    expect(
      matchTrack(
        { ...source, title: "Unknown title", artist: "Other" },
        catalogue,
      ).status,
    ).toBe("unmatched"));
  it("flags ambiguous matches for review", () =>
    expect(
      matchTrack(source, [catalogue[0], { ...catalogue[0], id: "duplicate" }])
        .status,
    ).toBe("review"));
  it("does not silently map a live version to a studio recording", () =>
    expect(
      matchTrack({ ...source, title: source.title + " Live" }, catalogue)
        .status,
    ).not.toBe("matched"));
  it("uses exact ISRC before metadata", () =>
    expect(
      matchTrack({ ...source, isrc: "TEST0001" }, [
        { ...catalogue[1], isrc: "TEST0001" },
      ]).confidence,
    ).toBe(1));
  it("filters hidden songs and deduplicates recommendations", () => {
    const ranked = recommend(
      [...catalogue, catalogue[0]],
      [
        {
          trackId: catalogue[0].id,
          kind: "hide",
          value: 1,
          createdAt: new Date().toISOString(),
        },
      ],
    );
    expect(ranked.some((r) => r.track.id === catalogue[0].id)).toBe(false);
    expect(new Set(ranked.map((r) => r.track.id)).size).toBe(ranked.length);
  });
  it("reacts to likes and includes exploration", () => {
    const ranked = recommend(catalogue, [
      {
        trackId: catalogue[0].id,
        kind: "like",
        value: 1,
        createdAt: new Date().toISOString(),
      },
    ]);
    expect(ranked[0].track.id).toBe(catalogue[0].id);
    expect(ranked.some((r) => r.reason === "Something new for you")).toBe(true);
  });
  it("searches and plays the credential-free catalogue", async () => {
    const provider = new StudioProvider();
    expect((await provider.search("golden")).tracks[0].id).toBe(
      catalogue[0].id,
    );
    expect((await provider.getStream(catalogue[0])).kind).toBe("audio");
  });
  it("search intent and followed artists influence ranking", () => {
    const preferred = {
      ...catalogue[1],
      artistId: "preferred",
      id: "preferred-track",
    };
    const candidates = [catalogue[0], preferred];
    const searched = recommend(candidates, [
      {
        trackId: null,
        kind: "search",
        query: preferred.title,
        value: 1,
        createdAt: new Date().toISOString(),
      },
    ]);
    expect(searched[0].track.id).toBe(preferred.id);
    expect(
      recommend(candidates, [], 12, Date.now(), {
        followedArtists: ["studio:preferred"],
      })[0].track.id,
    ).toBe(preferred.id);
    expect(
      recommend(candidates, [], 12, Date.now(), {
        queuedTrackIds: [catalogue[0].id],
      })[0].track.id,
    ).toBe(preferred.id);
  });
  it("YouTube fails honestly without credentials and never supplies audio URLs", async () => {
    const provider = new YouTubeProvider("");
    await expect(provider.search("music")).rejects.toThrow("API key");
    const result = await provider.getStream({
      ...catalogue[0],
      provider: "youtube",
      externalId: "jfKfPfyJRdk",
    });
    expect(result.kind).toBe("youtube");
    expect(result.capabilities.background).toBe(false);
  });
});
