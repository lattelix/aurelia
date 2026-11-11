import { z } from "zod";
import { AppError, AudioQualitySchema, type AudioQuality, type PlaybackSource, type Track } from "@aurelia/core";
import { gatewayCertificates, gatewayFetch } from "./gateway-fetch";

const uri = z.string().max(1024).regex(/^\/api\/audio\?[A-Za-z0-9%&=._~-]+$/);
const descriptor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("audio"), url: uri, hlsUrl: uri.optional(),
    duration: z.number().nonnegative().max(86400).optional(),
    bitrate: z.number().nonnegative().max(10_000_000).optional(),
    quality: AudioQualitySchema.optional(), mimeType: z.string().max(160).optional(),
    capabilities: z.object({ background: z.literal(true), seek: z.literal(true), mediaSession: z.literal(true) }),
  }),
  z.object({ kind: z.literal("youtube"), videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/), notice: z.string().max(1000).optional(),
    capabilities: z.object({ background: z.literal(false), seek: z.literal(true), mediaSession: z.literal(false) }),
  }),
]);
export function gatewayConfig(): { base: URL; token: string; caPem?: string } | null {
  const address = process.env.MEDIA_GATEWAY_URL;
  const token = process.env.MEDIA_GATEWAY_TOKEN;
  const certificate = process.env.MEDIA_GATEWAY_CA_PEM;
  if (!address && !token && !certificate) return null;
  if (!address || !token || token.length < 32 || token.length > 256)
    throw new AppError(503, "Audio gateway is not configured correctly.");
  const base = new URL(address);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(local && base.protocol === "http:")) || base.username || base.password || base.search || base.hash || base.pathname !== "/")
    throw new AppError(503, "Invalid audio gateway origin.");
  if (certificate && base.protocol !== "https:")
    throw new AppError(503, "Gateway certificates require HTTPS.");
  return { base, token, ...(certificate ? { caPem: gatewayCertificates(certificate) } : {}) };
}
export async function gatewayStream(track: Track, quality: AudioQuality): Promise<PlaybackSource | null> {
  const config = gatewayConfig();
  if (!config) return null;
  const url = new URL("/stream", config.base);
  url.search = new URLSearchParams({ id: track.externalId, quality }).toString();
  const response = await gatewayFetch(url, config, {
    headers: { Authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(40_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(502, "Audio gateway is temporarily unavailable.");
  }
  if (!response.body) throw new AppError(502, "Invalid audio gateway response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > 8192) {
        await reader.cancel();
        throw new AppError(502, "Invalid audio gateway response.");
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const body = Buffer.concat(chunks).toString("utf8");
  return descriptor.parse(JSON.parse(body));
}
export async function gatewayAudio(request: Request): Promise<Response | null> {
  const config = gatewayConfig();
  if (!config) return null;
  const params = new URL(request.url).searchParams;
  const identity = z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{11}$/), quality: AudioQualitySchema,
    variant: z.string().min(1).max(160).regex(/^[\w.-]+$/),
    version: z.string().max(32).regex(/^\d+$/),
    format: z.enum(["raw", "hls"]),
  }).parse({ id: params.get("id"), quality: params.get("quality") ?? "balanced", variant: params.get("variant"), version: params.get("version"), format: params.get("format") ?? "raw" });
  const url = new URL("/audio", config.base);
  url.search = new URLSearchParams(identity).toString();
  const headers = new Headers({ Authorization: `Bearer ${config.token}`, "Accept-Encoding": "identity" });
  if (request.headers.has("range")) headers.set("Range", request.headers.get("range")!);
  const response = await gatewayFetch(url, config, {
    method: request.method, headers,
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(250_000)]),
  });
  if (![200, 206, 416].includes(response.status)) {
    await response.body?.cancel();
    throw new AppError(response.status === 409 ? 409 : 502, "Audio gateway is temporarily unavailable. Retry Play.");
  }
  const safeHeaders = new Headers({ "Cache-Control": "private, no-store", "Cross-Origin-Resource-Policy": "same-origin" });
  for (const key of ["content-type", "content-length", "content-range", "accept-ranges"])
    if (response.headers.has(key)) safeHeaders.set(key, response.headers.get(key)!);
  if (response.headers.has("content-encoding") && response.headers.get("content-encoding") !== "identity")
    safeHeaders.delete("content-length");
  return new Response(response.body, { status: response.status, headers: safeHeaders });
}
