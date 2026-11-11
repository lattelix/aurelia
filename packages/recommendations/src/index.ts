import { normalize, type Signal, type Track } from "@aurelia/core";
const weights = {
  play: 1,
  complete: 3,
  like: 6,
  "playlist-add": 4,
  skip: -2,
  hide: -100,
  search: 0.3,
};
export interface RankedTrack {
  track: Track;
  score: number;
  reason: string;
}
export interface RecommendationContext {
  followedArtists?: readonly string[];
  queuedTrackIds?: readonly string[];
}
export function recommend(
  candidates: Track[],
  signals: Signal[],
  limit = 12,
  now = Date.now(),
  context: RecommendationContext = {},
): RankedTrack[] {
  const unique = [...new Map(candidates.map((t) => [t.id, t])).values()];
  const hidden = new Set(
    signals.filter((s) => s.kind === "hide").map((s) => s.trackId),
  );
  const byId = new Map(unique.map((t) => [t.id, t]));
  const affinity = new Map<string, number>();
  const genreAffinity = new Map<string, number>();
  const trackScores = new Map<string, number>();
  for (const s of signals) {
    const ageDays = Math.max(0, now - Date.parse(s.createdAt)) / 86400000;
    const value =
      weights[s.kind] *
      Math.min(1, Math.max(0, s.value)) *
      Math.exp(-ageDays / 30);
    if (s.kind === "search" && s.query) {
      const query = normalize(s.query);
      if (query.length >= 2)
        for (const candidate of unique) {
          if (
            normalize(
              `${candidate.title} ${candidate.artist} ${candidate.album} ${candidate.genre}`,
            ).includes(query)
          )
            trackScores.set(
              candidate.id,
              (trackScores.get(candidate.id) ?? 0) + value,
            );
        }
    }
    const track = byId.get(s.trackId ?? "");
    if (!track) continue;
    affinity.set(track.artistId, (affinity.get(track.artistId) ?? 0) + value);
    if (track.genre)
      genreAffinity.set(
        track.genre,
        (genreAffinity.get(track.genre) ?? 0) + value,
      );
    trackScores.set(track.id, (trackScores.get(track.id) ?? 0) + value);
  }
  const ranked = unique
    .filter((t) => !hidden.has(t.id))
    .map((track) => {
      const direct = trackScores.get(track.id) ?? 0;
      const familiar =
        (genreAffinity.get(track.genre) ?? 0) * 0.4 +
        (affinity.get(track.artistId) ?? 0) * 0.1;
      const recentlyPlayed = signals.some(
        (s) =>
          s.trackId === track.id &&
          s.kind === "play" &&
          now - Date.parse(s.createdAt) < 3600000,
      );
      const engaged = signals.some(
        (s) =>
          s.trackId === track.id &&
          ["play", "complete", "like", "playlist-add"].includes(s.kind),
      );
      const discovery = engaged ? 0 : 2;
      const followed =
        context.followedArtists?.includes(
          `${track.provider}:${track.artistId}`,
        ) || context.followedArtists?.includes(track.artistId);
      const sessionPenalty = context.queuedTrackIds?.includes(track.id)
        ? 0.5
        : 0;
      return {
        track,
        score:
          direct +
          familiar +
          discovery +
          (followed ? 2 : 0) -
          sessionPenalty -
          (recentlyPlayed ? 8 : 0),
        reason: followed
          ? "From an artist you follow"
          : direct > 3
            ? "In your rotation"
            : familiar > 1
              ? track.genre
                ? `More ${track.genre.toLowerCase()} for you`
                : `More from ${track.artist}`
              : "Something new for you",
      };
    });
  const output: RankedTrack[] = [];
  const genreCount = new Map<string, number>();
  const albumCount = new Map<string, number>();
  while (ranked.length && output.length < limit) {
    ranked.sort(
      (a, b) =>
        b.score -
        (genreCount.get(b.track.genre) ?? 0) * 2 -
        (albumCount.get(b.track.albumId) ?? 0) * 3 -
        (a.score -
          (genreCount.get(a.track.genre) ?? 0) * 2 -
          (albumCount.get(a.track.albumId) ?? 0) * 3),
    );
    const next = ranked.shift()!;
    output.push(next);
    genreCount.set(
      next.track.genre,
      (genreCount.get(next.track.genre) ?? 0) + 1,
    );
    albumCount.set(
      next.track.albumId,
      (albumCount.get(next.track.albumId) ?? 0) + 1,
    );
  }
  return output;
}
