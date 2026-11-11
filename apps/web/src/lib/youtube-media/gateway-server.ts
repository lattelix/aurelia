import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { AppError, AudioQualitySchema } from "@aurelia/core";
import { YouTubeAudioProvider } from "./provider";
import { audioResponse } from "./audio-response";

export interface MediaGatewayTlsOptions {
  key: string | Buffer;
  cert: string | Buffer;
}

/** Dedicated host: no account database, browser cookies or OAuth credentials. */
export function createMediaGateway(token: string, tlsOptions?: MediaGatewayTlsOptions) {
  if (token.length < 32 || token.length > 256) throw new Error("Set a 32–256 character MEDIA_GATEWAY_TOKEN");
  const expected = Buffer.from(`Bearer ${token}`);
  const provider = new YouTubeAudioProvider("", true, true);
  let active = 0;
  let minute = 0;
  let requests = 0;
  const listener: RequestListener = async (incoming, outgoing) => {
    const cancellation = new AbortController();
    const deadline = setTimeout(() => { cancellation.abort(); outgoing.destroy(); }, 250_000);
    // Descriptor resolution has its own absolute deadline. Apply inactivity
    // timeout only once a response is ready to stream.
    outgoing.setTimeout(0);
    incoming.on("aborted", () => cancellation.abort());
    outgoing.on("close", () => { if (!outgoing.writableFinished) cancellation.abort(); });
    let admitted = false;
    try {
      const provided = Buffer.from(incoming.headers.authorization ?? "");
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
        throw new AppError(401, "Unauthorized");
      if (!["GET", "HEAD"].includes(incoming.method ?? "")) throw new AppError(405, "Method not allowed");
      const url = new URL(incoming.url ?? "/", "http://localhost");
      if (url.pathname === "/health") {
        outgoing.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        outgoing.end(incoming.method === "HEAD" ? undefined : JSON.stringify({ status: "ok", service: "aurelia-media" }));
        return;
      }
      const currentMinute = Math.floor(Date.now() / 60_000);
      if (minute !== currentMinute) { minute = currentMinute; requests = 0; }
      if (++requests > 2000 || active >= 8) throw new AppError(429, "Audio gateway is busy. Retry later.");
      active++; admitted = true;
      let response: Response;
      if (url.pathname === "/stream" && incoming.method === "GET") {
        const id = z.string().regex(/^[A-Za-z0-9_-]{11}$/).parse(url.searchParams.get("id"));
        const quality = AudioQualitySchema.parse(url.searchParams.get("quality") ?? "balanced");
        const track = await provider.getTrack(id);
        // Metadata work may be shared/bounded independently. Retain admission
        // until it settles, but never start another operation for a lost client.
        if (cancellation.signal.aborted) return;
        if (!track) throw new AppError(404, "Recording unavailable");
        response = Response.json(await provider.getStream(track, quality));
      } else if (url.pathname === "/audio") {
        const headers = new Headers();
        if (incoming.headers.range) headers.set("Range", incoming.headers.range);
        response = (await audioResponse(new Request(url, {
          method: incoming.method, headers, signal: cancellation.signal,
        })))!;
      } else throw new AppError(404, "Endpoint not found");
      if (cancellation.signal.aborted) {
        await response.body?.cancel();
        return;
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.setTimeout(30_000, () => { cancellation.abort(); outgoing.destroy(); });
      if (incoming.method === "HEAD" || !response.body) {
        await response.body?.cancel();
        outgoing.end();
      } else {
        await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), outgoing, { signal: cancellation.signal });
      }
    } catch (error) {
      if (cancellation.signal.aborted || outgoing.headersSent) { outgoing.destroy(); return; }
      const status = error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 502;
      const message = error instanceof AppError ? error.message : "Invalid or unavailable audio request";
      outgoing.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      outgoing.end(JSON.stringify({ error: message }));
    } finally { clearTimeout(deadline); if (admitted) active--; }
  };
  return tlsOptions ? createHttpsServer(tlsOptions, listener) : createHttpServer(listener);
}
