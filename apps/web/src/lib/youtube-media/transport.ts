import { AppError, type AudioQuality } from "@aurelia/core";
import { resolveAudio, validMediaUrl, type ResolvedAudio } from "./provider";

const PART_BYTES = 512 * 1024;
/** Serve the browser's exact range through bounded upstream requests. */
export async function mediaBody(
  initial: ResolvedAudio,
  identity: {
    id: string;
    quality: AudioQuality;
    variant: string;
    version: string;
  },
  range: { start: number; end: number },
  requestSignal: AbortSignal,
) {
  let source = initial;
  let position = range.start;
  let remaining = 0;
  const cancellation = new AbortController();
  const signal = AbortSignal.any([
    requestSignal,
    cancellation.signal,
    AbortSignal.timeout(250_000),
  ]);
  async function openPart() {
    const end = Math.min(range.end, position + PART_BYTES - 1);
    const load = () => {
      const url = validMediaUrl(source.url);
      // YouTube.js uses this query parameter for media ranges. A Range header
      // alone can be rejected for larger reads on some public client profiles.
      url.searchParams.set("range", `${position}-${end}`);
      return fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
        redirect: "error",
      });
    };
    let response = await load();
    if ([403, 410].includes(response.status)) {
      await response.body?.cancel();
      source = await resolveAudio(
        identity.id,
        identity.quality,
        identity.variant,
        true,
      );
      if (
        source.version !== identity.version ||
        source.contentLength !== initial.contentLength
      )
        throw new AppError(
          409,
          "This recording changed. Start playback again.",
        );
      response = await load();
    }
    const expected = `bytes ${position}-${end}/${source.contentLength}`;
    const validStatus =
      response.status === 200 ||
      (response.status === 206 &&
        response.headers.get("content-range") === expected);
    if (
      !validStatus ||
      Number(response.headers.get("content-length")) !== end - position + 1 ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new AppError(
        502,
        "The audio source did not return the requested part. Please retry.",
      );
    }
    remaining = end - position + 1;
    return response.body.getReader();
  }
  let reader = await openPart();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const result = await reader.read();
          if (!result.done) {
            if (result.value.byteLength > remaining)
              throw new AppError(502, "Invalid media response length");
            remaining -= result.value.byteLength;
            position += result.value.byteLength;
            controller.enqueue(result.value);
            return;
          }
          reader.releaseLock();
          if (remaining) throw new AppError(502, "Incomplete audio response");
          if (position > range.end) {
            controller.close();
            return;
          }
          reader = await openPart();
        }
      } catch (error) {
        cancellation.abort();
        controller.error(error);
      }
    },
    async cancel() {
      cancellation.abort();
      await reader.cancel().catch(() => {});
    },
  });
}
