import { afterEach, describe, expect, it, vi } from "vitest";
import { TrackSchema } from "@aurelia/core";
import { YouTubeProvider } from "@aurelia/music";

const videoId = "aqz-KE-bpKQ";
function metadataFetch() {
  const mock = vi.fn().mockResolvedValue(
    Response.json({
      type: "video",
      title: "Public video",
      author_name: "Public channel",
      author_url: "https://www.youtube.com/@PublicChannel",
      html: "<script>untrusted returned markup</script>",
    }),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}
afterEach(() => vi.unstubAllGlobals());

describe("YouTube links without an API key", () => {
  it.each([
    `https://www.youtube.com/watch?v=${videoId}&list=ignored`,
    `https://youtu.be/${videoId}?si=ignored`,
    `https://music.youtube.com/watch?v=${videoId}`,
    `https://m.youtube.com/watch?v=${videoId}`,
    `https://www.youtube.com/shorts/${videoId}`,
    `https://www.youtube.com/embed/${videoId}`,
    `https://www.youtube.com/live/${videoId}`,
  ])("resolves a supported link: %s", async (link) => {
    const fetchMock = metadataFetch();
    const result = await new YouTubeProvider("").search(link);
    expect(result.tracks).toHaveLength(1);
    const track = TrackSchema.parse(result.tracks[0]);
    expect(track).toMatchObject({
      id: `youtube:${videoId}`,
      title: "Public video",
      artist: "Public channel",
      duration: 0,
      year: 0,
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
    expect(track).not.toHaveProperty("html");
    const endpoint = new URL(fetchMock.mock.calls[0][0]);
    expect(`${endpoint.origin}${endpoint.pathname}`).toBe(
      "https://www.youtube.com/oembed",
    );
    expect(endpoint.searchParams.get("url")).toBe(track.sourceUrl);
  });
  it("rejects deceptive links and never fetches their targets", async () => {
    const fetchMock = metadataFetch();
    const provider = new YouTubeProvider("");
    for (const link of [
      `https://youtube.com.evil.test/watch?v=${videoId}`,
      `https://youtube.com@evil.test/watch?v=${videoId}`,
      `https://evil.test/watch?v=${videoId}`,
      `https://youtube.com:8080/watch?v=${videoId}`,
      `https://youtu.be/${videoId}/extra`,
      "https://www.youtube.com/watch?v=invalid",
      `file://youtube.com/watch?v=${videoId}`,
    ])
      await expect(provider.search(link)).rejects.toThrow("API key");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("keeps private or removed videos out of the library", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );
    const provider = new YouTubeProvider("");
    expect(await provider.getTrack(`youtube:${videoId}`)).toBeNull();
    expect(
      (await provider.search(`https://youtu.be/${videoId}`)).tracks,
    ).toEqual([]);
  });
  it("reports malformed metadata and an upstream outage", async () => {
    const mock = vi.fn().mockResolvedValue(Response.json({ html: "unsafe" }));
    vi.stubGlobal("fetch", mock);
    const provider = new YouTubeProvider("");
    await expect(provider.getTrack(videoId)).rejects.toThrow(
      "incomplete track information",
    );
    mock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(provider.getTrack(videoId)).rejects.toThrow(
      "Cannot reach YouTube",
    );
  });
  it("uses the visible player and does not attempt unavailable related search", async () => {
    metadataFetch();
    const provider = new YouTubeProvider("");
    const track = (await provider.getTrack(videoId))!;
    expect(await provider.getStream(track)).toMatchObject({
      kind: "youtube",
      videoId,
      capabilities: { background: false, mediaSession: false },
    });
    expect(await provider.getRelated(track)).toEqual([]);
  });
});
