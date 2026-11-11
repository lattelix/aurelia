import { describe, expect, it } from "vitest";
import { audioIndex, audioPlaylist } from "../apps/web/src/lib/youtube-media/hls";

function fixture(version = 0) {
  const width = version === 0 ? 4 : 8;
  const size = 8 + 12 + width * 2 + 4 + 24;
  const bytes = new Uint8Array(8 + size);
  const view = new DataView(bytes.buffer);
  const box = (offset: number, length: number, type: string) => {
    view.setUint32(offset, length);
    bytes.set(new TextEncoder().encode(type), offset + 4);
  };
  box(0, 8, "moov");
  box(8, size, "sidx");
  view.setUint8(16, version);
  view.setUint32(24, 44100);
  const countOffset = 28 + width * 2;
  view.setUint16(countOffset + 2, 2);
  let offset = countOffset + 4;
  for (const [length, duration] of [[200, 441000], [100, 220500]]) {
    view.setUint32(offset, length);
    view.setUint32(offset + 4, duration);
    offset += 12;
  }
  return { bytes, view, countOffset, total: bytes.length + 300 };
}
describe("native HLS audio index", () => {
  it.each([0, 1])("maps exact bytes and durations from a v%s sidx", (version) => {
    const { bytes, total } = fixture(version);
    const index = audioIndex(bytes, total);
    expect(index).toEqual({ initLength: bytes.length, segments: [
      { start: bytes.length, length: 200, duration: 10 },
      { start: bytes.length + 200, length: 100, duration: 5 },
    ] });
    const playlist = audioPlaylist(index, "/api/audio?id=abcdefghijk&variant=MWEB.140");
    expect(playlist).toContain(`#EXT-X-MAP:URI="/api/audio?id=abcdefghijk&variant=MWEB.140",BYTERANGE="${bytes.length}@0"`);
    expect(playlist).toContain(`#EXTINF:5.000000,\n#EXT-X-BYTERANGE:100@${bytes.length + 200}`);
    expect(playlist).toContain("#EXT-X-TARGETDURATION:10");
    expect(playlist.endsWith("#EXT-X-ENDLIST\n")).toBe(true);
  });
  it("rejects hierarchical references, missing timescale and a truncated index", () => {
    const { bytes, total, view, countOffset } = fixture();
    const valid = bytes.slice();
    view.setUint32(countOffset + 4, 0x800000c8);
    expect(() => audioIndex(bytes, total)).toThrow("Unsupported audio container");
    bytes.set(valid);
    view.setUint32(24, 0);
    expect(() => audioIndex(bytes, total)).toThrow();
    expect(() => audioIndex(valid.subarray(0, valid.length - 1), total)).toThrow();
  });
  it("rejects unindexed tails, out-of-file segments and unsafe 64-bit offsets", () => {
    const { bytes, total } = fixture();
    expect(() => audioIndex(bytes, total + 1)).toThrow();
    expect(() => audioIndex(bytes, total - 1)).toThrow();
    const v1 = fixture(1);
    v1.view.setBigUint64(36, 9007199254740992n);
    expect(() => audioIndex(v1.bytes, v1.total)).toThrow();
  });
  it("prevents playlist URI injection or forwarding to arbitrary hosts", () => {
    const { bytes, total } = fixture();
    const index = audioIndex(bytes, total);
    for (const uri of ["https://example.com/media", '/api/audio?id=x"\n#EXT-X-ENDLIST', "/api/audio?id=x#fragment"])
      expect(() => audioPlaylist(index, uri)).toThrow();
  });
});
