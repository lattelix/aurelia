import { AppError } from "@aurelia/core";
export const MAX_MEDIA_BYTES = 128 * 1024 * 1024;
export function mediaRange(header: string | null, total: number) {
  if (!Number.isSafeInteger(total) || total < 1 || total > MAX_MEDIA_BYTES)
    throw new AppError(502, "Invalid media length");
  if (!header) return { start: 0, end: total - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]))
    throw new AppError(416, "Invalid byte range");
  const suffix = !match[1];
  const requestedEnd = match[2] ? Number(match[2]) : total - 1;
  const start = suffix ? Math.max(0, total - requestedEnd) : Number(match[1]);
  const end = suffix ? total - 1 : Math.min(requestedEnd, total - 1);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= total ||
    end < start ||
    (suffix && requestedEnd < 1)
  )
    throw new AppError(416, "Range outside recording");
  // Honor the full requested range. Truncation breaks WebKit's MP4 metadata
  // loading. The route streams with backpressure instead of buffering media.
  return { start, end };
}
