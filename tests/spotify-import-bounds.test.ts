import { afterEach, describe, expect, it, vi } from "vitest";
import { SpotifyImportProvider } from "@aurelia/integrations";

const credential = "synthetic-spotify-bearer-only";
const track = {
  id: "test-track",
  name: "Metadata",
  artists: [{ name: "Artist" }],
  album: { name: "Album" },
  duration_ms: 1000,
};
const json = (value: unknown, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", ...headers },
  });
const empty = () => json({ items: [], next: null });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("bounded Spotify metadata reader", () => {
  it("rejects injected or oversized bearer values before creating a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const token of [
      "synthetic\r\nAuthorization: injected",
      "abcdefghijklmnop" + "=".repeat(4096),
    ])
      await expect(new SpotifyImportProvider(token).read()).rejects.toThrow(
        "Invalid Spotify credential",
      );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses fixed HTTPS requests without redirects or cookies and preserves current item endpoints", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        urls.push(url.href);
        expect(url.origin).toBe("https://api.spotify.com");
        expect(init?.redirect).toBe("error");
        expect(init?.credentials).toBe("omit");
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Bearer ${credential}`,
        );
        expect(new Headers(init?.headers).has("Cookie")).toBe(false);
        if (url.pathname === "/v1/me/tracks")
          return json({ items: [{ track }], next: null });
        if (url.pathname === "/v1/me/playlists")
          return json({ items: [{ id: "fixture", name: "List" }], next: null });
        if (url.pathname === "/v1/playlists/fixture/items")
          return json({ items: [{ item: track }], next: null });
        return json({ artists: { items: [], next: null } });
      },
    );
    vi.stubGlobal("fetch", fetch);
    const result = await new SpotifyImportProvider(credential).read();
    expect(result.tracks).toHaveLength(1);
    expect(result.likes).toEqual([track.id]);
    expect(result.playlists[0].trackIds).toEqual([track.id]);
    expect(urls).toContain(
      "https://api.spotify.com/v1/playlists/fixture/items?limit=50",
    );
  });

  it("rejects redirected responses and never requests the Location", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://example.test/token-collector" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(new SpotifyImportProvider(credential).read()).rejects.toThrow(
      "redirect",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://api.spotify.com.evil.test/v1/me/tracks",
    "http://api.spotify.com/v1/me/tracks",
    "https://user:password@api.spotify.com/v1/me/tracks",
    "https://api.spotify.com/outside",
  ])("rejects unsafe pagination %s before bearer dispatch", async (next) => {
    const fetch = vi.fn(async () => json({ items: [{ track }], next }));
    vi.stubGlobal("fetch", fetch);
    await expect(new SpotifyImportProvider(credential).read()).rejects.toThrow(
      "pagination URL",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects cycles and empty advancing pages", async () => {
    let fetch = vi.fn(async () =>
      json({
        items: [{ track }],
        next: "https://api.spotify.com/v1/me/tracks?limit=50",
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(new SpotifyImportProvider(credential).read()).rejects.toThrow(
      "cycle",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch = vi.fn(async () => json({ items: [], next: "me/tracks?offset=50" }));
    vi.stubGlobal("fetch", fetch);
    await expect(new SpotifyImportProvider(credential).read()).rejects.toThrow(
      "empty page",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("caps the aggregate request count even when every pagination URL is different", async () => {
    let offset = 0;
    const fetch = vi.fn(async () =>
      json({ items: [{ track }], next: `me/tracks?offset=${++offset}` }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(new SpotifyImportProvider(credential).read()).rejects.toThrow(
      "128 requests",
    );
    expect(fetch).toHaveBeenCalledTimes(128);
  });

  it("enforces a shared wallclock deadline between collections", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetch = vi.fn(async () => {
      now = 120_001;
      return empty();
    });
    vi.stubGlobal("fetch", fetch);
    await expect(new SpotifyImportProvider(credential).read()).rejects.toThrow(
      "deadline",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds both declared and chunked response bytes", async () => {
    let fetch = vi.fn(async () => json({}, { "Content-Length": "2000001" }));
    vi.stubGlobal("fetch", fetch);
    await expect(new SpotifyImportProvider(credential).read()).rejects.toThrow(
      "2,000,000",
    );
    fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(2_000_001));
              controller.close();
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(new SpotifyImportProvider(credential).read()).rejects.toThrow(
      "2,000,000",
    );
  });

  it("fails explicitly at the collection limit and does not silently truncate", async () => {
    const fetch = vi.fn(async () =>
      json({
        items: Array.from({ length: 1000 }, () => ({ track })),
        next: "me/tracks?offset=1000",
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(new SpotifyImportProvider(credential).read()).rejects.toThrow(
      "1000 entries",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry access errors or violate a long Retry-After", async () => {
    for (const status of [401, 403, 429]) {
      const fetch = vi.fn(
        async () =>
          new Response(null, { status, headers: { "Retry-After": "120" } }),
      );
      vi.stubGlobal("fetch", fetch);
      await expect(
        new SpotifyImportProvider(credential).read(),
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("bounds a stalled body with the same per-request deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ start() {} }))),
    );
    const result = new SpotifyImportProvider(credential).read();
    const check = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15_000);
    await check;
  });
  it("does not strand a rejected response on an uncooperative cleanup promise", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                return new Promise<void>(() => {});
              },
            }),
            { headers: { "Content-Length": "2000001" } },
          ),
      ),
    );
    await expect(new SpotifyImportProvider(credential).read()).rejects.toThrow(
      "2,000,000",
    );
  }, 1000);
});
