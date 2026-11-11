import { AppError } from "@aurelia/core";
import { MAX_MEDIA_BYTES } from "./range";

interface Segment { start: number; length: number; duration: number }
export interface AudioIndex { initLength: number; segments: Segment[] }
function invalid(): never { throw new AppError(502, "Unsupported audio container. Try video playback."); }

/** Read a bounded ISO-BMFF sidx; media bytes remain unchanged. */
export function audioIndex(prefix: Uint8Array, total: number): AudioIndex {
  if (!Number.isSafeInteger(total) || total < 1 || total > MAX_MEDIA_BYTES || prefix.length > 65_536) invalid();
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  const integer64 = (offset: number) => {
    const value = view.getBigUint64(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
    return Number(value);
  };
  let offset = 0;
  let initialization = false;
  while (offset + 8 <= prefix.length) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...prefix.subarray(offset + 4, offset + 8));
    const header = size === 1 ? 16 : 8;
    if (size === 1) {
      if (offset + 16 > prefix.length) invalid();
      size = integer64(offset + 8);
    }
    if (size < header || offset + size > prefix.length) invalid();
    if (type === "moov") initialization = true;
    if (type === "sidx") {
      const base = offset + header;
      if (!initialization || size < header + 24) invalid();
      const version = view.getUint8(base);
      if (version !== 0 && version !== 1) invalid();
      const timescale = view.getUint32(base + 8);
      const width = version === 0 ? 4 : 8;
      let cursor = base + 12;
      if (!timescale || cursor + width * 2 + 4 > offset + size) invalid();
      // A non-zero presentation origin needs an explicit timeline mapping.
      const earliest = version === 0 ? view.getUint32(cursor) : integer64(cursor);
      cursor += width;
      const firstOffset = version === 0 ? view.getUint32(cursor) : integer64(cursor);
      cursor += width;
      const count = view.getUint16(cursor + 2);
      cursor += 4;
      if (earliest !== 0 || !count || count > 4096 || cursor + count * 12 !== offset + size) invalid();
      let start = offset + size + firstOffset;
      const initLength = start;
      if (initLength > prefix.length) invalid();
      const segments: Segment[] = [];
      for (let i = 0; i < count; i++, cursor += 12) {
        const reference = view.getUint32(cursor);
        const length = reference & 0x7fffffff;
        const duration = view.getUint32(cursor + 4) / timescale;
        if (reference >>> 31 || !length || !duration || duration > 60 || start + length > total) invalid();
        segments.push({ start, length, duration });
        start += length;
      }
      // Do not silently publish a truncated recording or an unindexed tail.
      if (start !== total) invalid();
      return { initLength, segments };
    }
    offset += size;
  }
  return invalid();
}

export function audioPlaylist(index: AudioIndex, uri: string): string {
  if (!/^\/api\/audio\?[A-Za-z0-9%&=._~-]+$/.test(uri)) invalid();
  return [
    "#EXTM3U", "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...index.segments.map((s) => s.duration)))}`,
    "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-MEDIA-SEQUENCE:0",
    `#EXT-X-MAP:URI="${uri}",BYTERANGE="${index.initLength}@0"`,
    ...index.segments.flatMap((segment) => [
      `#EXTINF:${segment.duration.toFixed(6)},`,
      `#EXT-X-BYTERANGE:${segment.length}@${segment.start}`, uri,
    ]),
    "#EXT-X-ENDLIST", "",
  ].join("\n");
}
