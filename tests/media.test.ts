import { describe, it, expect, vi, afterEach } from "vitest";
import {
  mediaRange,
  MAX_MEDIA_BYTES,
} from "../apps/web/src/lib/youtube-media/range";
import { MediaCache } from "../apps/web/src/lib/youtube-media/cache";

afterEach(() => vi.useRealTimers());
describe("bounded streaming ranges", () => {
  it("serves bounded open ranges, suffixes and seeks", () => {
    expect(mediaRange("bytes=0-", 10_000_000)).toEqual({
      start: 0,
      end: 9_999_999,
    });
    expect(mediaRange("bytes=7000000-", 10_000_000)).toEqual({
      start: 7_000_000,
      end: 9_999_999,
    });
    expect(mediaRange("bytes=-256", 1000)).toEqual({ start: 744, end: 999 });
    expect(mediaRange("bytes=800-2000", 1000)).toEqual({
      start: 800,
      end: 999,
    });
  });
  it("rejects recordings above the service size limit", () => {
    expect(() => mediaRange(null, MAX_MEDIA_BYTES + 1)).toThrow();
  });
  it.each([
    "bytes=1000-",
    "bytes=-0",
    "bytes=8-3",
    "bytes=0-1,4-5",
    "bytes=9007199254740993-",
    "bytes=-",
  ])("rejects invalid or unsatisfiable range %s", (header) => {
    expect(() => mediaRange(header, 1000)).toThrow();
  });
});
describe("media request cache", () => {
  it("deduplicates concurrent requests and retries failed requests", async () => {
    const cache = new MediaCache<number>();
    const load = vi.fn(async () => 42);
    expect(
      await Promise.all([
        cache.resolve("a", 1000, load),
        cache.resolve("a", 1000, load),
      ]),
    ).toEqual([42, 42]);
    expect(load).toHaveBeenCalledTimes(1);
    const retry = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(3);
    await expect(cache.resolve("b", 1000, retry)).rejects.toThrow("offline");
    expect(await cache.resolve("b", 1000, retry)).toBe(3);
  });
  it("expires values and evicts least recently used entries", () => {
    vi.useFakeTimers();
    const cache = new MediaCache<number>(2);
    cache.set("a", 1, 1000);
    cache.set("b", 2, 1000);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3, 1000);
    expect(cache.get("b")).toBeUndefined();
    vi.advanceTimersByTime(1001);
    expect(cache.get("a")).toBeUndefined();
  });
});
