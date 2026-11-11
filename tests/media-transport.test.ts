import { it, expect, vi, afterEach } from "vitest";
vi.mock("../apps/web/src/lib/youtube-media/provider", () => ({
  validMediaUrl: (value: string) => new URL(value),
  resolveAudio: vi.fn(),
}));
import { mediaBody } from "../apps/web/src/lib/youtube-media/transport";
import {
  resolveAudio,
  type ResolvedAudio,
} from "../apps/web/src/lib/youtube-media/provider";
const source: ResolvedAudio = {
  url: "https://media.googlevideo.com/videoplayback",
  variant: "140.original.normal",
  version: "123",
  contentLength: 600_000,
  mimeType: "audio/mp4",
  bitrate: 128000,
  duration: 30,
  quality: "balanced",
};
const identity = {
  id: "aqz-KE-bpKQ",
  quality: "balanced" as const,
  variant: source.variant,
  version: source.version,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("streams an exact browser range across bounded upstream parts", async () => {
  const ranges: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL) => {
      const range = input.searchParams.get("range")!;
      ranges.push(range);
      const [start, end] = range.split("-").map(Number);
      return new Response(new Uint8Array(end - start + 1).fill(7), {
        headers: { "Content-Length": String(end - start + 1) },
      });
    }),
  );
  const body = await mediaBody(
    source,
    identity,
    { start: 0, end: 599999 },
    new AbortController().signal,
  );
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  expect(ranges).toEqual(["0-524287", "524288-599999"]);
  expect(bytes.length).toBe(600_000);
  expect(bytes.every((byte) => byte === 7)).toBe(true);
});
it("rejects refreshes that change the recording version before mixing bytes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 403 })),
  );
  vi.mocked(resolveAudio).mockResolvedValue({ ...source, version: "124" });
  await expect(
    mediaBody(
      source,
      identity,
      { start: 0, end: 1023 },
      new AbortController().signal,
    ),
  ).rejects.toThrow("This recording changed");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("rejects truncated upstream bodies", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(new Uint8Array(10), {
          headers: { "Content-Length": "1024" },
        }),
    ),
  );
  const body = await mediaBody(
    source,
    identity,
    { start: 0, end: 1023 },
    new AbortController().signal,
  );
  await expect(new Response(body).arrayBuffer()).rejects.toThrow(
    "Incomplete audio response",
  );
});
