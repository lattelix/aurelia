import { z } from "zod";
import { AppError, AudioQualitySchema } from "@aurelia/core";
import { mediaRange } from "./range";
import { mediaBody } from "./transport";
import { resolveAudio } from "./provider";
import { audioIndex, audioPlaylist } from "./hls";
import { MediaCache } from "./cache";

const playlists = new MediaCache<string>(96);

export async function audioResponse(request: Request) {
  if (!["GET", "HEAD"].includes(request.method)) return null;
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new AppError(403, "Open this recording in Aurelia");
  const params = new URL(request.url).searchParams;
  const id = z
    .string()
    .regex(/^[A-Za-z0-9_-]{11}$/)
    .parse(params.get("id"));
  const quality = AudioQualitySchema.parse(params.get("quality") ?? "balanced");
  const format = z.enum(["raw", "hls"]).parse(params.get("format") ?? "raw");
  const variant = z
    .string()
    .min(1)
    .max(160)
    .regex(/^[\w.-]+$/)
    .parse(params.get("variant"));
  const version = z
    .string()
    .regex(/^\d+$/)
    .max(32)
    .parse(params.get("version"));
  const source = await resolveAudio(id, quality, variant);
  if (source.version !== version)
    throw new AppError(409, "This recording changed. Start playback again.");
  if (format === "hls") {
    const identity = { id, quality, variant, version };
    const playlist = await playlists.resolve(`${id}:${quality}:${variant}:${version}`, 8 * 60_000, async () => {
      const end = Math.min(65_535, source.contentLength - 1);
      // A cancelled first subscriber must not abort shared cache population.
      const stream = await mediaBody(source, identity, { start: 0, end }, AbortSignal.timeout(30_000));
      const prefix = new Uint8Array(await new Response(stream).arrayBuffer());
      const index = audioIndex(prefix, source.contentLength);
      const uri = `/api/audio?${new URLSearchParams(identity)}`;
      return audioPlaylist(index, uri);
    });
    return new Response(request.method === "HEAD" ? null : playlist, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "private, no-store",
        "Content-Length": String(Buffer.byteLength(playlist)),
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  }
  let range;
  const hasRange = request.headers.has("range");
  try {
    range = mediaRange(request.headers.get("range"), source.contentLength);
  } catch (error) {
    if (error instanceof AppError && error.status === 416)
      return new Response(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${source.contentLength}`,
          "Cache-Control": "no-store",
        },
      });
    throw error;
  }
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type": source.mimeType,
    "Cache-Control": "private, no-store",
    "Content-Length": String(range.end - range.start + 1),
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  if (hasRange)
    headers.set(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${source.contentLength}`,
    );
  const status = hasRange ? 206 : 200;
  if (request.method === "HEAD") return new Response(null, { status, headers });
  const stream = await mediaBody(
    source,
    { id, quality, variant, version },
    range,
    request.signal,
  );
  return new Response(stream, { status, headers });
}
