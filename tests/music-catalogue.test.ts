import { describe, expect, it, vi } from "vitest";
import { catalogueRequest, MusicCataloguePageSchema, safeCatalogueArtwork } from "../apps/web/src/lib/youtube-media/catalogue-contracts";
import { normalizeMusicCatalogue } from "../apps/web/src/lib/youtube-media/catalogue-metadata";
import { catalogueFetch, albumMetadataItems, metadataItem, validateTask } from "../apps/web/youtube-runtime/catalogue-worker.mjs";
import { YTNodes } from "youtubei.js";

const date = "2026-11-10T12:00:00.000Z";
const artistID = "UC" + "a".repeat(22), albumID = "MPREb_" + "a".repeat(15), playlistID = "VLPL" + "a".repeat(30);
const item = (id = "00000000001", kind = "song") => ({ kind, id, title: "Recording", subtitle: "Album · Artist", artist: "Artist", artistId: artistID,
  album: "Album", albumId: albumID, duration: 123, artwork: "https://untrusted.invalid/signed?secret=ignored" });
const search = (kind = "songs", items = [item()]) => ({ operation: "search", kind, title: "Music search", subtitle: "YouTube Music", query: "Artist",
  items, sections: [], truncated: false });

describe("typed anonymous YouTube Music catalogue contracts", () => {
  it("uses exact bounded query keys, typed browse identity and real country codes", () => {
    const url = (query: string) => new URL("https://aurelia.lattelix.com/api/music/catalogue/search?" + query);
    expect(catalogueRequest("search", url("q=%20Artist%20&kind=songs"))).toEqual({ operation: "search", query: "Artist", kind: "songs" });
    expect(catalogueRequest("charts", url("country=ZZ"))).toEqual({ operation: "charts", country: "ZZ" });
    for (const [kind, id] of [["album", albumID], ["artist", artistID], ["playlist", playlistID]]) {
      expect(catalogueRequest("browse", url(new URLSearchParams({ kind, id }).toString()))).toMatchObject({ kind, id });
    }
    for (const query of ["q=Artist&q=Other", "q=Artist&kind=videos", "q=Artist&token=private", "q=", "q=" + "a".repeat(201), "q=bad%00query"]) {
      expect(() => catalogueRequest("search", url(query))).toThrow();
    }
    for (const query of ["country=AA", "country=EU", "country=us", "country=US&next=evil"]) expect(() => catalogueRequest("charts", url(query))).toThrow();
    for (const id of ["../../private", "https://untrusted.invalid", "FEmusic_library_landing", "UCshort", "VL" + "a".repeat(200)]) {
      expect(() => catalogueRequest("browse", url(new URLSearchParams({ kind: "playlist", id }).toString()))).toThrow();
    }
  });
  it("validates the independent child input protocol without accepting credentials or URLs", () => {
    expect(validateTask({ operation: "search", kind: "songs", query: "Artist" })).toMatchObject({ kind: "songs" });
    for (const task of [{ operation: "search", kind: "songs", query: " Artist" }, { operation: "search", kind: "videos", query: "Artist" },
      { operation: "browse", kind: "album", id: artistID }, { operation: "charts", country: "US", token: "private" },
      { operation: "player", script: "ignored" }]) expect(() => validateTask(task)).toThrow();
  });
  it("keeps songs music-only, dedupes canonical IDs and never forwards upstream media/art locators", () => {
    const raw = search("songs", [item(), item(), item("00000000002", "video"), item("bad")]);
    const result = normalizeMusicCatalogue(raw, { operation: "search", kind: "songs", query: "Artist" }, date);
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({ id: "youtube:00000000001", albumId: albumID, artistId: artistID,
      artwork: "https://i.ytimg.com/vi/00000000001/hqdefault.jpg", sourceUrl: "https://www.youtube.com/watch?v=00000000001" });
    expect(JSON.stringify(result)).not.toMatch(/secret|untrusted|streamingData/);
    const projected = metadataItem({ item_type: "song", id: "00000000001", title: "Song", artists: [{ name: "Artist" }], duration: { seconds: Infinity },
      streamingData: { url: "https://r1.googlevideo.com/private" }, endpoint: { payload: { videoId: "00000000001", token: "private" } } });
    expect(projected).toMatchObject({ duration: 0, title: "Song" });
    expect(JSON.stringify(projected)).not.toMatch(/streamingData|googlevideo|private/);
  });
  it.each([["albums", "album", albumID], ["artists", "artist", artistID], ["playlists", "playlist", playlistID]])("retains only requested %s collections and safe image URLs", (kind, singular, id) => {
    const entry = { ...item(id, singular), artwork: "https://lh3.googleusercontent.com/public-image=w300" };
    const result = normalizeMusicCatalogue(search(kind, [entry, entry, item()]), { operation: "search", kind: kind as "albums" | "artists" | "playlists", query: "Artist" }, date);
    expect(result.tracks).toHaveLength(0); expect(result.collections).toHaveLength(1);
    expect(result.collections[0]).toMatchObject({ id, kind: singular, artwork: entry.artwork });
    expect(safeCatalogueArtwork("https://lh3.googleusercontent.com.evil.invalid/image")).toBe("");
    expect(safeCatalogueArtwork("https://user@lh3.googleusercontent.com/image")).toBe("");
    expect(safeCatalogueArtwork("https://i.ytimg.com:444/image")).toBe("");
  });
  it("truncates the combined item budget explicitly while preserving source order", () => {
    const tracks = Array.from({ length: 101 }, (_, index) => item(String(index).padStart(11, "0")));
    const result = normalizeMusicCatalogue(search("songs", tracks), { operation: "search", kind: "songs", query: "Artist" }, date);
    expect(result.tracks).toHaveLength(100); expect(result.truncated).toBe(true);
    const browse = normalizeMusicCatalogue({ operation: "browse", kind: "artist", title: "Artist", subtitle: "", items: [], truncated: true,
      sections: Array.from({ length: 12 }, (_, index) => ({ id: "ignored", title: "Source section " + index, items: tracks })) },
    { operation: "browse", kind: "artist", id: artistID }, date);
    expect(browse.sections.reduce((sum, section) => sum + section.tracks.length, 0)).toBe(1000);
    expect(browse.truncated).toBe(true); expect(browse.sections[0].title).toBe("Source section 0");
    expect(browse.sections[0].tracks[0].id).toBe("youtube:00000000000");
  });
  it("inherits linked album artists for missing row artists without replacing explicit or conflicting metadata", () => {
    const otherArtistID = "UC" + "b".repeat(22);
    const header = new YTNodes.MusicResponsiveHeader({ title: { runs: [{ text: "50 Mozart Masterworks" }] },
      subtitle: { runs: [{ text: "Album · 2018" }] }, straplineTextOne: { runs: [{ text: "Wolfgang Amadeus Mozart",
        navigationEndpoint: { browseEndpoint: { browseId: artistID } } }] } });
    const row = { item_type: "song", id: "00000000001", title: "Allegro", artists: [], duration: { seconds: 123 } };
    const projected = albumMetadataItems({ header, contents: [row,
      { ...row, id: "00000000002", artists: [{ name: "Track performer", channel_id: otherArtistID }] },
      { ...row, id: "00000000003", artists: [{ name: "", channel_id: otherArtistID }] }] });
    const normalize = (items: Record<string, unknown>[]) => normalizeMusicCatalogue({ operation: "browse", kind: "album",
      title: "50 Mozart Masterworks", subtitle: "Album · 2018", items, sections: [], truncated: false },
    { operation: "browse", kind: "album", id: albumID }, date);
    const result = normalize(projected);
    expect(result.tracks[0]).toMatchObject({ artist: "Wolfgang Amadeus Mozart", artistId: artistID });
    expect(result.tracks[1]).toMatchObject({ artist: "Track performer", artistId: otherArtistID });
    expect(result.tracks[2]).toMatchObject({ artist: "YouTube Music", artistId: otherArtistID });

    const detailHeader = { author: { name: "Album author", channel_id: artistID } };
    expect(normalize(albumMetadataItems({ header: detailHeader, contents: [row] })).tracks[0].artist).toBe("Album author");
    const multipleHeader = { strapline_text_one: { runs: [
      { text: "First album artist", endpoint: { payload: { browseId: artistID } } },
      { text: "Second album artist", endpoint: { payload: { browseId: otherArtistID } } },
    ] } };
    const multi = normalize(albumMetadataItems({ header: multipleHeader, contents: [row,
      { ...row, id: "00000000002", artists: [{ name: "", channel_id: otherArtistID }] }] }));
    expect(multi.tracks[0]).toMatchObject({ artist: "First album artist, Second album artist", artistId: artistID });
    expect(multi.tracks[1]).toMatchObject({ artist: "Second album artist", artistId: otherArtistID });
    for (const header of [{ subtitle: { toString: () => "Album · 2018" } },
      { strapline_text_one: { runs: [{ text: "Unlinked label" }] } },
      { author: { name: "Not a verified artist", channel_id: "invalid" } }]) {
      expect(normalize(albumMetadataItems({ header, contents: [row] })).tracks[0].artist).toBe("YouTube Music");
    }
    // Generic item projection (search/artist/playlist) has no album inheritance.
    expect(metadataItem(row)).toMatchObject({ artist: "", artistId: "" });
  });
  it("keeps chart source titles and observation date without invented rank or period", () => {
    const chart = normalizeMusicCatalogue({ operation: "charts", kind: "charts", title: "YouTube Music charts", subtitle: "Global", country: "ZZ", countryName: "Global",
      items: [], sections: [{ id: "raw", title: "Top music videos", items: [item(playlistID, "playlist"), item(artistID, "artist")] }], truncated: false },
    { operation: "charts", country: "ZZ" }, date);
    expect(chart).toMatchObject({ source: "youtube-music", country: "ZZ", countryName: "Global", fetchedAt: date });
    expect(chart.sections[0].collections.map((entry) => entry.kind)).toEqual(["playlist", "artist"]);
    expect(JSON.stringify(chart)).not.toMatch(/rank|releaseDate|chartDate/);
    expect(() => normalizeMusicCatalogue({ ...search(), query: "Other" }, { operation: "search", kind: "songs", query: "Artist" }, date)).toThrow("protocol");
    expect(() => MusicCataloguePageSchema.parse({ ...chart, audioUrl: "private" })).toThrow();
  });
});

describe("catalogue metadata network boundaries", () => {
  const url = "https://music.youtube.com/youtubei/v1/search";
  it("allows metadata endpoints only and strips credentials before every fetch", async () => {
    const upstream = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: true }, { headers: { "set-cookie": "discard=true" } }));
    const load = catalogueFetch(new AbortController().signal, upstream);
    await load(new Request(url, { method: "POST", body: "{}", headers: { Authorization: "Bearer synthetic", Cookie: "synthetic=true", "Proxy-Authorization": "Basic synthetic" } }));
    const [input, init] = upstream.mock.calls[0], forwarded = new Request(input, init);
    expect(forwarded.credentials).toBe("omit"); expect(forwarded.redirect).toBe("error");
    for (const header of ["Authorization", "Cookie", "Proxy-Authorization"]) expect(forwarded.headers.get(header)).toBeNull();
    for (const target of ["https://rr1.googlevideo.com/videoplayback", "https://www.youtube.com/youtubei/v1/player", "https://evil.invalid/youtubei/v1/search",
      "https://user@music.youtube.com/youtubei/v1/search", "https://music.youtube.com:444/youtubei/v1/search"]) await expect(load(target)).rejects.toThrow("request rejected");
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("bounds requests and declared/streamed decoded bodies, refuses redirects and honors cancellation", async () => {
    const over = vi.fn<typeof fetch>().mockImplementation(async () => new Response("x", { headers: { "content-length": String(4 * 1024 * 1024 + 1) } }));
    await expect(catalogueFetch(new AbortController().signal, over)(url)).rejects.toThrow("response rejected");
    const redirect = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 302 }));
    await expect(catalogueFetch(new AbortController().signal, redirect)(url)).rejects.toThrow("response rejected");
    const bytes = new Uint8Array(4 * 1024 * 1024 + 1), streamed = vi.fn<typeof fetch>().mockImplementation(async () => new Response(bytes));
    await expect(catalogueFetch(new AbortController().signal, streamed)(url)).rejects.toThrow("too large");
    const upstream = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({})), load = catalogueFetch(new AbortController().signal, upstream);
    for (let index = 0; index < 8; index++) await load(url);
    await expect(load(url)).rejects.toThrow("request rejected"); expect(upstream).toHaveBeenCalledTimes(8);
    const controller = new AbortController(); controller.abort();
    await expect(catalogueFetch(controller.signal, upstream)(url)).rejects.toThrow(); expect(upstream).toHaveBeenCalledTimes(8);
  });
});
