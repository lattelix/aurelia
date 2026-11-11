import { z } from "zod";
export const LyricsSchema = z.object({
  id: z.number().int(),
  trackName: z.string().max(1000),
  artistName: z.string().max(1000),
  albumName: z.string().max(1000),
  duration: z.number().nonnegative(),
  instrumental: z.boolean(),
  plainLyrics: z.string().max(100_000).nullable(),
  syncedLyrics: z.string().max(100_000).nullable(),
});
export type Lyrics = z.infer<typeof LyricsSchema>;
export interface LyricsLine {
  time: number;
  text: string;
}
export function parseLyrics(input: string): LyricsLine[] {
  const lines: LyricsLine[] = [];
  for (const row of input.split(/\r?\n/)) {
    const stamps = [
      ...row.matchAll(/\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g),
    ];
    const text = row.replace(/\[[^\]]*\]/g, "").trim();
    for (const stamp of stamps)
      lines.push({
        time:
          Number(stamp[1]) * 60 +
          Number(stamp[2]) +
          Number(`0.${stamp[3] ?? "0"}`),
        text,
      });
  }
  return lines.sort((a, b) => a.time - b.time);
}
