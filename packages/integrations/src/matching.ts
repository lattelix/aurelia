import { normalize, type Track } from "@aurelia/core";
export interface ImportTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  isrc?: string;
  sourceUrl?: string;
}
export interface Match {
  source: ImportTrack;
  track: Track | null;
  confidence: number;
  status: "matched" | "review" | "unmatched";
  candidates: { track: Track; confidence: number }[];
}
function similarity(a: string, b: string) {
  const left = new Set(normalize(a).split(" ").filter(Boolean));
  const right = new Set(normalize(b).split(" ").filter(Boolean));
  if (!left.size || !right.size) return 0;
  return (
    [...left].filter((x) => right.has(x)).length /
    new Set([...left, ...right]).size
  );
}
export function matchTrack(source: ImportTrack, candidates: Track[]): Match {
  const scored = candidates
    .map((track) => {
      const isrc =
        source.isrc &&
        track.isrc &&
        source.isrc.toUpperCase() === track.isrc.toUpperCase();
      const title = similarity(source.title, track.title);
      const artist = similarity(source.artist, track.artist);
      const album = similarity(source.album, track.album);
      const time =
        source.duration > 0 && track.duration > 0
          ? Math.max(0, 1 - Math.abs(source.duration - track.duration) / 20)
          : 0;
      const incompatibleVersion =
        /\b(live|remix|karaoke|cover|instrumental)\b/i;
      const a = normalize(source.title).match(incompatibleVersion)?.[0];
      const b = normalize(track.title).match(incompatibleVersion)?.[0];
      const penalty = a !== b ? 0.3 : 0;
      return {
        track,
        confidence: isrc
          ? 1
          : Math.max(
              0,
              title * 0.45 + artist * 0.35 + album * 0.1 + time * 0.1 - penalty,
            ),
      };
    })
    .sort((a, b) => b.confidence - a.confidence);
  const best = scored[0];
  const ambiguous =
    best && scored[1] && best.confidence - scored[1].confidence < 0.06;
  const status =
    !best || best.confidence < 0.5
      ? "unmatched"
      : best.confidence >= 0.86 && !ambiguous
        ? "matched"
        : "review";
  return {
    source,
    track: status === "matched" ? best.track : null,
    confidence: best?.confidence ?? 0,
    status,
    candidates: scored.slice(0, 3),
  };
}
