import { describe, expect, it, vi } from "vitest";
import { discoveryFetch } from "../apps/web/src/lib/youtube-media/discovery-fetch";

const origin = "https://music.youtube.com/youtubei/v1/browse";
const MiB = 1024 * 1024;

function streamed(chunks: readonly Uint8Array[], options: ResponseInit = {}) {
  let index = 0;
  const cancel = vi.fn();
  const pull = vi.fn(
    (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
  );
  // No eager prefetch: a rejected declared length must not consume any bytes.
  const body = new ReadableStream<Uint8Array>(
    { pull, cancel },
    { highWaterMark: 0 },
  );
  return { body, cancel, pull, response: new Response(body, options) };
}

describe("anonymous bounded discovery fetch", () => {
  it.each([
    "https://untrusted.invalid/youtubei/v1/browse",
    "https://music.youtube.com.evil.invalid/youtubei/v1/browse",
    "https://www.youtube.com:444/youtubei/v1/browse",
    "http://music.youtube.com/youtubei/v1/browse",
    "https://rr1.googlevideo.com/videoplayback",
    "https://user@music.youtube.com/youtubei/v1/browse",
    "https://user:password@www.youtube.com/youtubei/v1/browse",
  ])(
    "rejects a disallowed or credential-bearing origin before fetch: %s",
    async (url) => {
      const upstream = vi.fn<typeof fetch>();
      const load = discoveryFetch(new AbortController().signal, upstream);
      await expect(load(url)).rejects.toThrow(
        "Discovery metadata request rejected",
      );
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it.each(["init", "request"] as const)(
    "strips credentials from %s headers and overrides cookie/redirect policies",
    async (source) => {
      const upstream = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ ok: true }));
      const load = discoveryFetch(new AbortController().signal, upstream);
      const headers = {
        Cookie: "synthetic=private",
        Authorization: "Bearer synthetic-only",
        "Proxy-Authorization": "Basic synthetic-only",
        Accept: "application/json",
        "X-Goog-Visitor-Id": "synthetic-public-visitor",
      };
      const options: RequestInit = {
        method: "POST",
        body: "{}",
        headers,
        credentials: "include",
        redirect: "follow",
      };
      if (source === "init") await load(origin, options);
      else await load(new Request(origin, options));
      const [input, init] = upstream.mock.calls[0];
      const forwarded = new Request(input, init);
      expect(forwarded.headers.get("Cookie")).toBeNull();
      expect(forwarded.headers.get("Authorization")).toBeNull();
      expect(forwarded.headers.get("Proxy-Authorization")).toBeNull();
      expect(forwarded.headers.get("Accept")).toBe("application/json");
      expect(forwarded.headers.get("X-Goog-Visitor-Id")).toBe(
        "synthetic-public-visitor",
      );
      expect(forwarded.credentials).toBe("omit");
      expect(forwarded.redirect).toBe("error");
      expect(forwarded.method).toBe("POST");
      expect(await forwarded.text()).toBe("{}");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    },
  );

  it("rejects an upstream redirect response and cancels its unread body", async () => {
    const source = streamed(
      [new TextEncoder().encode("untrusted redirect body")],
      {
        status: 302,
        headers: { Location: "https://untrusted.invalid/redirect" },
      },
    );
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(source.response);
    await expect(
      discoveryFetch(new AbortController().signal, upstream)(origin),
    ).rejects.toThrow("Discovery metadata response rejected");
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0][1]?.redirect).toBe("error");
    expect(source.pull).not.toHaveBeenCalled();
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(source.body.locked).toBe(false);
  });

  it.each([String(4 * MiB + 1), "-1", "not-a-length", "4.5"])(
    "rejects a declared oversized or malformed content length (%s) without reading",
    async (length) => {
      const source = streamed([new Uint8Array([1])], {
        headers: { "Content-Length": length },
      });
      const upstream = vi.fn<typeof fetch>().mockResolvedValue(source.response);
      await expect(
        discoveryFetch(new AbortController().signal, upstream)(origin),
      ).rejects.toThrow("Discovery metadata response rejected");
      expect(source.pull).not.toHaveBeenCalled();
      expect(source.cancel).toHaveBeenCalledTimes(1);
      expect(source.body.locked).toBe(false);
    },
  );

  it.each([undefined, "1"])(
    "enforces actual decoded bytes even with missing or understated content length (%s)",
    async (length) => {
      const source = streamed(
        [
          new Uint8Array(2 * MiB),
          new Uint8Array(2 * MiB),
          new Uint8Array(1),
          new Uint8Array(1),
        ],
        length === undefined ? {} : { headers: { "Content-Length": length } },
      );
      const upstream = vi.fn<typeof fetch>().mockResolvedValue(source.response);
      await expect(
        discoveryFetch(new AbortController().signal, upstream)(origin),
      ).rejects.toThrow("Discovery metadata response too large");
      expect(source.pull).toHaveBeenCalledTimes(3);
      expect(source.cancel).toHaveBeenCalledTimes(1);
      expect(source.body.locked).toBe(false);
    },
  );

  it("accepts exact per-response and total limits, then rejects an unread declared aggregate overflow", async () => {
    const first = streamed([new Uint8Array(4 * MiB)], {
      headers: { "Content-Length": String(4 * MiB) },
    });
    const second = streamed([new Uint8Array(2 * MiB)], {
      headers: { "Content-Length": String(2 * MiB) },
    });
    const overflow = streamed([new Uint8Array(1)], {
      headers: { "Content-Length": "1" },
    });
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response)
      .mockResolvedValueOnce(overflow.response);
    const load = discoveryFetch(new AbortController().signal, upstream);
    expect((await (await load(origin)).arrayBuffer()).byteLength).toBe(4 * MiB);
    expect((await (await load(origin)).arrayBuffer()).byteLength).toBe(2 * MiB);
    await expect(load(origin)).rejects.toThrow(
      "Discovery metadata response rejected",
    );
    expect(first.cancel).not.toHaveBeenCalled();
    expect(second.cancel).not.toHaveBeenCalled();
    expect(first.body.locked).toBe(false);
    expect(second.body.locked).toBe(false);
    expect(overflow.pull).not.toHaveBeenCalled();
    expect(overflow.cancel).toHaveBeenCalledTimes(1);
  });

  it("counts chunked bytes across responses instead of resetting the 6 MiB budget", async () => {
    const first = streamed([new Uint8Array(3 * MiB)]);
    const overflow = streamed([
      new Uint8Array(3 * MiB),
      new Uint8Array(1),
      new Uint8Array(1),
    ]);
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(overflow.response);
    const load = discoveryFetch(new AbortController().signal, upstream);
    await load(origin);
    await expect(load(origin)).rejects.toThrow(
      "Discovery metadata response too large",
    );
    expect(overflow.pull).toHaveBeenCalledTimes(2);
    expect(overflow.cancel).toHaveBeenCalledTimes(1);
    expect(overflow.body.locked).toBe(false);
  });

  it("permits six requests across approved hosts and rejects the seventh before fetch", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ ok: true }));
    const load = discoveryFetch(new AbortController().signal, upstream);
    const urls = [
      origin,
      "https://www.youtube.com/",
      "https://youtubei.googleapis.com/youtubei/v1/browse",
    ];
    for (let index = 0; index < 6; index++)
      expect(await (await load(urls[index % 3])).json()).toEqual({ ok: true });
    await expect(load(origin)).rejects.toThrow(
      "Discovery metadata request rejected",
    );
    expect(upstream).toHaveBeenCalledTimes(6);
  });

  it("returns intact bounded UTF-8 JSON with decoded length and no encoding or Set-Cookie headers", async () => {
    const value = { title: "Музыка 🎵", contents: [1, 2, 3] };
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const source = streamed(
      [bytes.slice(0, 12), bytes.slice(12, 20), bytes.slice(20)],
      {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Encoding": "gzip",
          "Content-Length": "1",
          "Set-Cookie": "synthetic=private",
          "X-Upstream-Metadata": "retained",
        },
      },
    );
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(source.response);
    const result = await discoveryFetch(
      new AbortController().signal,
      upstream,
    )(origin);
    expect(result.headers.get("Content-Encoding")).toBeNull();
    expect(result.headers.get("Set-Cookie")).toBeNull();
    expect(result.headers.get("Content-Length")).toBe(String(bytes.byteLength));
    expect(result.headers.get("Content-Type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(result.headers.get("X-Upstream-Metadata")).toBe("retained");
    expect(await result.json()).toEqual(value);
    expect(source.cancel).not.toHaveBeenCalled();
    expect(source.body.locked).toBe(false);
  });

  it("preserves an upstream body abort and releases its reader even when cancellation of the errored stream rejects", async () => {
    const failure = new DOMException(
      "Synthetic upstream cancellation",
      "AbortError",
    );
    const pull = vi.fn((stream: ReadableStreamDefaultController<Uint8Array>) =>
      stream.error(failure),
    );
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body));
    const load = discoveryFetch(new AbortController().signal, upstream);
    await expect(load(origin)).rejects.toBe(failure);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    // An errored stream rejects cancel(); cleanup must not replace the original abort.
    await expect(body.cancel()).rejects.toBe(failure);
  });

  it.each(["load", "init", "request"] as const)(
    "combines the %s abort signal and cancels an active stream before reading further",
    async (scope) => {
      const controller = new AbortController();
      const cancel = vi.fn();
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(stream) {
            pulls++;
            controller.abort(
              new DOMException("Synthetic cancellation", "AbortError"),
            );
            stream.enqueue(new Uint8Array([1]));
          },
          cancel,
        },
        { highWaterMark: 0 },
      );
      const upstream = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body));
      const load = discoveryFetch(
        scope === "load" ? controller.signal : new AbortController().signal,
        upstream,
      );
      const request =
        scope === "request"
          ? new Request(origin, { signal: controller.signal })
          : origin;
      await expect(
        load(
          request,
          scope === "init" ? { signal: controller.signal } : undefined,
        ),
      ).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(upstream.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(pulls).toBe(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    },
  );
});
