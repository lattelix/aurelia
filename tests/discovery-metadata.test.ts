import { describe, expect, it } from "vitest";
import { DiscoveryPageSchema } from "@aurelia/core";
import {
  normalizeExplore,
  type ExploreTrackInput,
} from "../apps/web/src/lib/youtube-media/discovery-metadata";

const fetchedAt = "2026-11-08T09:00:00.000Z";
const firstId = "aqz-KE-bpKQ";
const secondId = "YE7VzlLtp-4";
const input = (
  videoId = firstId,
  patch: Partial<ExploreTrackInput> = {},
): ExploreTrackInput => ({ videoId, title: "Public fixture", ...patch });
const page = () =>
  normalizeExplore([{ title: "Explore", items: [input()] }], fetchedAt);
const syntheticId = (index: number) =>
  `v${index.toString(36).padStart(10, "0")}`;

describe("YouTube Music discovery metadata normalization", () => {
  it("keeps upstream section and recording order, retaining the first duplicate only within each section", () => {
    const result = normalizeExplore(
      [
        {
          title: "Upstream second label",
          items: [
            input(secondId, { title: "First occurrence" }),
            input(firstId),
            input(secondId, { title: "Duplicate must not replace metadata" }),
          ],
        },
        { title: "Upstream first label", items: [input(secondId)] },
      ],
      fetchedAt,
    );
    expect(result.source).toBe("youtube-music");
    expect(result.fetchedAt).toBe(fetchedAt);
    expect(result.sections.map((section) => section.title)).toEqual([
      "Upstream second label",
      "Upstream first label",
    ]);
    expect(result.sections[0].tracks.map((track) => track.externalId)).toEqual([
      secondId,
      firstId,
    ]);
    expect(result.sections[0].tracks[0].title).toBe("First occurrence");
    expect(result.sections[1].tracks[0].externalId).toBe(secondId);
  });

  it("excludes album/browse entries and malformed or URL-shaped video identities", () => {
    const entries = [
      { title: "Album only", albumId: "MPREb_synthetic_album" },
      { title: "Browse only", browseId: "FEmusic_explore", id: firstId },
      ...[
        "MPREb_synthetic_album",
        "FEmusic_explore",
        "UCsynthetic_channel_id",
        `youtube:${firstId}`,
        `https://www.youtube.com/watch?v=${firstId}`,
        `${firstId}?x=1`,
        `${firstId}/`,
        ` ${firstId}`,
        `${firstId}\n`,
        "short",
        "!!!!!!!!!!!",
      ].map((videoId) => input(videoId)),
      input(secondId),
    ];
    const result = normalizeExplore(
      [{ title: "Mixed upstream", items: entries }],
      fetchedAt,
    );
    expect(result.sections[0].tracks.map((track) => track.externalId)).toEqual([
      secondId,
    ]);
  });

  it("removes controls, bounds text, and drops sections or recordings with no visible title", () => {
    const result = normalizeExplore(
      [
        { title: "\u0000\t\u007f ", items: [input()] },
        {
          title: "  A\u0000B\tC\r\nD\u007f  ",
          items: [
            input(firstId, { title: "\t\u0000\r\n\u007f" }),
            input(secondId, {
              title: "  E\u0000F\tG\r\nH\u007f  ",
              artist: "\u0000\t\u007f ",
            }),
          ],
        },
        {
          title: "s".repeat(121),
          items: [
            input(firstId, {
              title: "t".repeat(501),
              artist: "r".repeat(501),
              artistId: "i".repeat(161),
              album: "a".repeat(501),
              albumId: "b".repeat(161),
            }),
          ],
        },
      ],
      fetchedAt,
    );
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].title).toBe("A B C  D");
    expect(result.sections[0].tracks).toHaveLength(1);
    expect(result.sections[0].tracks[0]).toMatchObject({
      title: "E F G  H",
      artist: "YouTube Music",
    });
    expect(result.sections[1].title).toBe("s".repeat(120));
    expect(result.sections[1].tracks[0]).toMatchObject({
      title: "t".repeat(500),
      artist: "r".repeat(500),
      artistId: "i".repeat(160),
      album: "a".repeat(500),
      albumId: "b".repeat(160),
    });
    expect(JSON.stringify(result)).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it.each([undefined, Number.NaN, Infinity, -Infinity, -1, 86400.01])(
    "replaces an invalid duration (%s) with zero",
    (duration) => {
      const result = normalizeExplore(
        [{ title: "Durations", items: [input(firstId, { duration })] }],
        fetchedAt,
      );
      expect(result.sections[0].tracks[0].duration).toBe(0);
    },
  );

  it.each([0, 63.125, 86400])("retains a valid duration (%s)", (duration) => {
    const result = normalizeExplore(
      [{ title: "Durations", items: [input(firstId, { duration })] }],
      fetchedAt,
    );
    expect(result.sections[0].tracks[0].duration).toBe(duration);
  });

  it("caps the page at four sections and 24 recordings per section without reordering", () => {
    const sections = Array.from({ length: 6 }, (_, section) => ({
      title: `Section ${section}`,
      items: Array.from({ length: 30 }, (_, track) =>
        input(syntheticId(section * 30 + track)),
      ),
    }));
    const result = normalizeExplore(sections, fetchedAt);
    expect(result.sections.map((section) => section.title)).toEqual([
      "Section 0",
      "Section 1",
      "Section 2",
      "Section 3",
    ]);
    for (let section = 0; section < 4; section++) {
      expect(
        result.sections[section].tracks.map((track) => track.externalId),
      ).toEqual(
        sections[section].items.slice(0, 24).map((track) => track.videoId),
      );
    }
  });

  it("constructs canonical public artwork/watch URLs and ignores upstream locator fields", () => {
    const signed =
      "https://rr1.googlevideo.com/videoplayback?expire=1&sig=synthetic";
    const upstream = {
      ...input("Ab_cD-Ef012"),
      artwork: "https://untrusted.invalid/artwork",
      sourceUrl: signed,
      audioUrl: signed,
      url: signed,
    };
    const result = normalizeExplore(
      [{ title: "Public only", items: [upstream] }],
      fetchedAt,
    );
    expect(result.sections[0].tracks[0]).toMatchObject({
      id: "youtube:Ab_cD-Ef012",
      externalId: "Ab_cD-Ef012",
      provider: "youtube",
      artwork: "https://i.ytimg.com/vi/Ab_cD-Ef012/hqdefault.jpg",
      sourceUrl: "https://www.youtube.com/watch?v=Ab_cD-Ef012",
    });
    expect(result.sections[0].tracks[0]).not.toHaveProperty("audioUrl");
    expect(result.sections[0].tracks[0]).not.toHaveProperty("url");
    expect(JSON.stringify(result)).not.toContain(signed);
    expect(JSON.stringify(result)).not.toContain("untrusted.invalid");
  });

  it("returns an honestly empty page for empty or unusable upstream data", () => {
    for (const sections of [
      [],
      [{ title: "Empty", items: [] }],
      [
        {
          title: "Only non-recordings",
          items: [{ title: "Album", albumId: "MPREb_album" }],
        },
      ],
    ]) {
      expect(normalizeExplore(sections, fetchedAt)).toEqual({
        source: "youtube-music",
        fetchedAt,
        sections: [],
      });
    }
  });
});

describe("discovery page public metadata boundary", () => {
  it.each([
    { id: `youtube:${secondId}` },
    { externalId: secondId },
    { provider: "studio" },
    { sourceUrl: "https://rr1.googlevideo.com/videoplayback?sig=synthetic" },
    { artwork: "https://rr1.googlevideo.com/videoplayback?sig=synthetic" },
    { sourceUrl: `https://www.youtube.com/watch?v=${secondId}` },
    { sourceUrl: `https://www.youtube.com/watch?v=${firstId}&token=synthetic` },
    { sourceUrl: `http://www.youtube.com/watch?v=${firstId}` },
    { artwork: `https://i.ytimg.com/vi/${secondId}/hqdefault.jpg` },
    { artwork: `https://i.ytimg.com.evil.invalid/vi/${firstId}/hqdefault.jpg` },
  ])("rejects forged identities or noncanonical locators: %j", (patch) => {
    const value = page();
    const track = { ...value.sections[0].tracks[0], ...patch };
    expect(
      DiscoveryPageSchema.safeParse({
        ...value,
        sections: [{ ...value.sections[0], tracks: [track] }],
      }).success,
    ).toBe(false);
  });

  it("accepts normalized and empty pages but rejects an invalid timestamp or oversized collections", () => {
    const value = page();
    expect(DiscoveryPageSchema.parse(value)).toEqual(value);
    expect(
      DiscoveryPageSchema.safeParse({ ...value, sections: [] }).success,
    ).toBe(true);
    for (const invalid of [
      { ...value, fetchedAt: "yesterday" },
      {
        ...value,
        sections: Array.from({ length: 5 }, () => value.sections[0]),
      },
      {
        ...value,
        sections: [
          {
            ...value.sections[0],
            tracks: Array.from(
              { length: 25 },
              () => value.sections[0].tracks[0],
            ),
          },
        ],
      },
    ])
      expect(DiscoveryPageSchema.safeParse(invalid).success).toBe(false);
  });
});
