import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayAudio, gatewayConfig, gatewayStream } from "../apps/web/src/lib/youtube-media/gateway-client";
import { catalogue } from "@aurelia/music";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function configured() {
  vi.stubEnv("MEDIA_GATEWAY_URL", "https://media.example.com");
  vi.stubEnv("MEDIA_GATEWAY_TOKEN", "a".repeat(64));
}
describe("authenticated audio gateway relay", () => {
  it("allows HTTPS or loopback and rejects ambiguous origins/incomplete configuration", () => {
    vi.stubEnv("MEDIA_GATEWAY_URL", ""); vi.stubEnv("MEDIA_GATEWAY_TOKEN", "");
    expect(gatewayConfig()).toBeNull();
    configured();
    expect(gatewayConfig()?.base.origin).toBe("https://media.example.com");
    for (const url of ["http://media.example.com", "https://user:password@media.example.com", "https://media.example.com/path", "https://media.example.com?next=elsewhere"] ) {
      vi.stubEnv("MEDIA_GATEWAY_URL", url);
      expect(() => gatewayConfig()).toThrow();
    }
    vi.stubEnv("MEDIA_GATEWAY_URL", "http://127.0.0.1:3103");
    expect(gatewayConfig()?.base.port).toBe("3103");
    vi.stubEnv("MEDIA_GATEWAY_TOKEN", "");
    expect(() => gatewayConfig()).toThrow();
  });
  it("never accepts signed upstream URLs as a browser playback descriptor", async () => {
    configured();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      kind: "audio", url: "https://r1.googlevideo.com/media?signed=secret",
      capabilities: { background: true, seek: true, mediaSession: true },
    })));
    await expect(gatewayStream({ ...catalogue[0], provider: "youtube", externalId: "abcdefghijk" }, "balanced")).rejects.toThrow();
  });
  it("forwards only its token and Range, and removes remote cookie/security headers", async () => {
    configured();
    const load = vi.fn(async () => new Response(new Uint8Array([1, 2]), {
      status: 206, headers: { "Content-Type": "audio/mp4", "Content-Length": "2", "Content-Range": "bytes 0-1/200", "Set-Cookie": "remote=session", "Access-Control-Allow-Origin": "*" },
    }));
    vi.stubGlobal("fetch", load);
    const response = await gatewayAudio(new Request("https://aurelia.example/api/audio?id=abcdefghijk&variant=MWEB.140&version=1&host=evil", {
      headers: { Cookie: "session=private", Range: "bytes=0-1" },
    }));
    const [url, init] = load.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin).toBe("https://media.example.com");
    expect(url.searchParams.has("host")).toBe(false);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${"a".repeat(64)}`);
    expect(headers.get("range")).toBe("bytes=0-1");
    expect(headers.has("cookie")).toBe(false);
    expect(init.redirect).toBe("error");
    expect(response?.status).toBe(206);
    expect(response?.headers.has("set-cookie")).toBe(false);
    expect(response?.headers.has("access-control-allow-origin")).toBe(false);
    expect(Array.from(new Uint8Array(await response!.arrayBuffer()))).toEqual([1, 2]);
  });
  it("turns remote failures into safe playback errors without forwarding the response body", async () => {
    configured();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret-token-in-remote-error", { status: 500 })));
    await expect(gatewayAudio(new Request("https://aurelia.example/api/audio?id=abcdefghijk&variant=MWEB.140&version=1")))
      .rejects.toThrow("Audio gateway is temporarily unavailable");
  });
  it("cancels oversized descriptor bodies before buffering the whole response", async () => {
    configured();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(5000)); }, cancel,
    }))));
    await expect(gatewayStream({ ...catalogue[0], provider: "youtube", externalId: "abcdefghijk" }, "balanced"))
      .rejects.toThrow("Invalid audio gateway response");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
