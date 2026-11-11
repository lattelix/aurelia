import { describe, expect, it } from "vitest";
import { catalogue } from "@aurelia/music";
import type { Track } from "@aurelia/core";
import {
  moodSearchHref,
  moodSearchPresets,
  searchQueryFromUrl,
  trackCollection,
  visibleDiscoveryTracks,
} from "../apps/web/src/components/discovery-presets";

const youtube = (id: string): Track => ({
  ...catalogue[0],
  id: `youtube:${id}`,
  externalId: id,
  provider: "youtube",
});

describe("YouTube discovery presentation", () => {
  it("excludes Studio and duplicate history entries without seeding or changing upstream order", () => {
    const first = youtube("abcdefghijk"),
      second = youtube("lmnopqrstuv");
    const input = [catalogue[0], first, first, catalogue[1], second];
    expect(visibleDiscoveryTracks(input)).toEqual([first, second]);
    expect(input).toHaveLength(5);
    expect(visibleDiscoveryTracks(catalogue)).toEqual([]);
    expect(visibleDiscoveryTracks([])).toEqual([]);
  });
  it("keeps the explicit demo catalogue available for QA", () => {
    expect(visibleDiscoveryTracks(catalogue, true)).toEqual(catalogue);
  });
  it("plays the clicked card from its actual visible collection, including newly fetched recommendations", () => {
    const first = youtube("abcdefghijk"),
      selected = youtube("lmnopqrstuv");
    const collection = [first, selected];
    const queue = trackCollection(selected, collection);
    expect(queue).toEqual({ tracks: [first, selected], index: 1 });
    expect(queue.tracks).not.toBe(collection);
    expect(trackCollection(selected, [first])).toEqual({
      tracks: [selected],
      index: 0,
    });
    expect(trackCollection(selected)).toEqual({ tracks: [selected], index: 0 });
  });
  it("opens mood shortcuts as explicit bounded YouTube searches, never playlist or chart routes", () => {
    for (const preset of moodSearchPresets) {
      const url = new URL(
        moodSearchHref(preset.query),
        "https://aurelia.invalid",
      );
      expect(url.pathname).toBe("/search");
      expect([...url.searchParams.keys()]).toEqual(["q", "provider"]);
      expect(url.searchParams.get("provider")).toBe("youtube");
      expect(searchQueryFromUrl(url.searchParams.get("q"))).toBe(preset.query);
    }
    expect(
      new URL(
        moodSearchHref("jazz & soul"),
        "https://aurelia.invalid",
      ).searchParams.get("q"),
    ).toBe("jazz & soul");
  });
  it("accepts normal search links but rejects overlong or control-bearing URL queries", () => {
    expect(searchQueryFromUrl("  ambient music  ")).toBe("ambient music");
    expect(searchQueryFromUrl("a".repeat(200))).toHaveLength(200);
    expect(searchQueryFromUrl("a".repeat(201))).toBe("");
    expect(searchQueryFromUrl("music\nextra")).toBe("");
    expect(searchQueryFromUrl(null)).toBe("");
  });
});
