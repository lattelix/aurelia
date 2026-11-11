import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { AppError, TrackSchema, type Track } from "@aurelia/core";
import {
  saveTrack,
  addToPlaylist,
  lockPlaylists,
  type Database,
} from "@aurelia/database";
import { catalogue } from "@aurelia/music";
import {
  matchTrack,
  SpotifyImportProvider,
  type ImportSnapshot,
  type Match,
  type ImportedHistory,
  IMPORT_TRACK_LIMIT,
  IMPORT_BYTE_LIMIT,
} from "@aurelia/integrations";
import { capabilities } from "./env";
import { youtube, trustedTrack } from "./providers";
export const fixture: ImportSnapshot = {
  provider: "fixture",
  tracks: [
    {
      id: "sample-1",
      title: "Golden Hour",
      artist: "Aurelia Studio",
      album: "Afterglow",
      duration: 72,
    },
    {
      id: "sample-2",
      title: "Slow Motion",
      artist: "Aurelia Studio",
      album: "Blue Hours",
      duration: 72,
    },
    {
      id: "sample-3",
      title: "A Song That Is Not Here",
      artist: "Another Artist",
      album: "Lost Recordings",
      duration: 214,
    },
  ],
  likes: ["sample-1", "sample-3"],
  playlists: [
    {
      id: "sample-playlist",
      name: "Imported discoveries",
      description: "A sample library to try the import and review flow.",
      trackIds: ["sample-1", "sample-2", "sample-3"],
    },
  ],
  artists: [],
  notices: ["Sample import. No Spotify account was contacted."],
};
export async function runImport(
  db: Database,
  userId: string,
  snapshot: ImportSnapshot,
) {
  if (
    snapshot.tracks.length > IMPORT_TRACK_LIMIT ||
    snapshot.playlists.length > 100 ||
    new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
      IMPORT_BYTE_LIMIT
  )
    throw new AppError(
      422,
      "The MVP supports at most 1,000 unique tracks, 100 playlists and 2,000,000 bytes per import.",
    );
  const started = Date.now();
  const checkBudget = () => {
    if (Date.now() - started >= 240_000)
      throw new AppError(
        504,
        "Import paused at its processing limit. Upload the same file to resume.",
      );
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
  let jobId: string = randomUUID();
  const inserted = await db.query<{ id: string }>(
    "INSERT INTO import_job(id,user_id,provider,fingerprint,status,total,notice) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,fingerprint) DO NOTHING RETURNING id",
    [
      jobId,
      userId,
      snapshot.provider,
      fingerprint,
      "running",
      snapshot.tracks.length,
      snapshot.notices.join(" "),
    ],
  );
  if (!inserted.length) {
    const prior = await db.query<{ id: string; status: string }>(
      "SELECT id,status FROM import_job WHERE user_id=$1 AND fingerprint=$2",
      [userId, fingerprint],
    );
    if (!prior[0]) throw new AppError(409, "Import changed. Please try again.");
    if (prior[0].status !== "failed") return prior[0].id;
    const claimed = await db.query<{ id: string }>(
      "UPDATE import_job SET status='running',failed=0 WHERE id=$1 AND user_id=$2 AND status='failed' RETURNING id",
      [prior[0].id, userId],
    );
    if (!claimed.length) return prior[0].id;
    jobId = claimed[0].id;
  }
  try {
    checkBudget();
    const processed = await db.query<{ source_id: string; status: string }>(
      "SELECT source_id,status FROM import_item WHERE job_id=$1",
      [jobId],
    );
    const completed = new Set(processed.map((entry) => entry.source_id));
    let matched = processed.filter(
        (entry) => entry.status === "matched",
      ).length,
      unmatched = processed.length - matched,
      failed = 0;
    const playlistMap = new Map<string, string>();
    for (const p of snapshot.playlists) {
      checkBudget();
      const key = `${snapshot.provider}:${p.id}`;
      const rows = await db.query<{ id: string }>(
        "INSERT INTO playlist(id,user_id,name,description,import_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,import_key) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description RETURNING id",
        [randomUUID(), userId, p.name, p.description, key],
      );
      playlistMap.set(p.id, rows[0].id);
    }
    for (const source of snapshot.tracks) {
      checkBudget();
      if (completed.has(source.id)) continue;
      let candidates: Track[] = catalogue;
      if (snapshot.provider === "spotify" && capabilities.youtube) {
        try {
          candidates = (
            await youtube.search(`${source.artist} ${source.title}`)
          ).tracks;
        } catch {
          failed++;
        }
      }
      let match = matchTrack(source, candidates);
      if (snapshot.provider === "aurelia") {
        const canonical = await portableCanonical(db, source);
        match = canonical
          ? {
              source,
              track: canonical,
              confidence: 1,
              status: "matched",
              candidates: [{ track: canonical, confidence: 1 }],
            }
          : {
              ...match,
              track: null,
              status: match.status === "unmatched" ? "unmatched" : "review",
            };
      }
      const playlistIds = snapshot.playlists
        .filter((p) => p.trackIds.includes(source.id))
        .map((p) => playlistMap.get(p.id)!);
      const liked = snapshot.likes.includes(source.id);
      const playlistPositions = snapshot.playlists
        .filter((entry) => entry.trackIds.includes(source.id))
        .map((entry) => ({
          id: playlistMap.get(entry.id)!,
          position: entry.trackIds.indexOf(source.id),
        }));
      await db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO import_item(id,job_id,source_id,source,match,status,playlist_ids,liked) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            randomUUID(),
            jobId,
            source.id,
            JSON.stringify({ ...source, playlistPositions }),
            JSON.stringify(match),
            match.status,
            JSON.stringify(playlistIds),
            liked,
          ],
        );
        if (match.status === "matched" && match.track) {
          await acceptTrack(
            tx,
            userId,
            match.track,
            playlistIds,
            liked,
            snapshot.provider,
            source.id,
            source.history,
            checkBudget,
          );
        }
      });
      if (match.status === "matched") matched++;
      else unmatched++;
      await db.query(
        "UPDATE import_job SET imported=$2,matched=$3,unmatched=$4,failed=$5 WHERE id=$1",
        [jobId, matched, matched, unmatched, failed],
      );
    }
    checkBudget();
    let artists = snapshot.artists.map((artist) => ({
      ...artist,
      id:
        snapshot.provider === "aurelia"
          ? artist.id
          : `${snapshot.provider}:${artist.id}`,
    }));
    const artistCount = artists.length;
    if (artists.length && snapshot.provider === "aurelia") {
      const known = await db.query<{ id: string }>(
        "SELECT id FROM artist_reference WHERE id=ANY($1::text[])",
        [artists.map((artist) => artist.id)],
      );
      const ids = new Set(known.map((artist) => artist.id));
      artists = artists.filter((artist) => ids.has(artist.id));
    } else if (artists.length) {
      await db.query(
        "INSERT INTO artist_reference(id,name) SELECT id,name FROM jsonb_to_recordset($1::jsonb) AS artist(id text,name text) ON CONFLICT(id) DO NOTHING",
        [JSON.stringify(artists)],
      );
    }
    checkBudget();
    if (artists.length)
      await db.query(
        "INSERT INTO followed_artist(user_id,artist_id) SELECT $1,id FROM unnest($2::text[]) AS artist(id) ON CONFLICT DO NOTHING",
        [userId, artists.map((artist) => artist.id)],
      );
    const unknownArtists = artistCount - artists.length;
    // Importing track metadata in one global order must not reorder individual playlists.
    checkBudget();
    const accepted = await db.query<{ source_id: string; match: unknown }>(
      "SELECT source_id,match FROM import_item WHERE job_id=$1 AND status='matched'",
      [jobId],
    );
    const trackIds = new Map(
      accepted.map((entry) => [
        entry.source_id,
        z.object({ track: TrackSchema }).parse(entry.match).track.id,
      ]),
    );
    await db.transaction(async (tx) => {
      await lockPlaylists(tx, userId, [...playlistMap.values()]);
      for (const playlist of snapshot.playlists) {
        checkBudget();
        const positions = new Map<string, number>();
        for (const [position, sourceId] of playlist.trackIds.entries()) {
          const trackId = trackIds.get(sourceId);
          if (trackId && !positions.has(trackId))
            positions.set(trackId, position);
        }
        if (positions.size)
          await tx.query(
            "UPDATE playlist_track AS target SET position=source.position FROM jsonb_to_recordset($2::jsonb) AS source(track_id text,position integer) WHERE target.playlist_id=$1 AND target.track_id=source.track_id",
            [
              playlistMap.get(playlist.id),
              JSON.stringify(
                [...positions].map(([track_id, position]) => ({
                  track_id,
                  position,
                })),
              ),
            ],
          );
      }
    });
    checkBudget();
    await db.transaction(async (tx) => {
      checkBudget();
      const importedAt = Date.now();
      const searches = (snapshot.searches ?? []).map((query, index) => ({
        id: deterministicId(userId, "search", query),
        query,
        created_at: new Date(importedAt - index).toISOString(),
      }));
      if (searches.length)
        await tx.query(
          "INSERT INTO recommendation_signal(id,user_id,kind,value,query,created_at) SELECT id,$1,'search',1,query,created_at FROM jsonb_to_recordset($2::jsonb) AS search(id text,query text,created_at timestamptz) ON CONFLICT(id) DO NOTHING",
          [userId, JSON.stringify(searches)],
        );
      checkBudget();
      const notice = [
        ...snapshot.notices,
        ...(unknownArtists
          ? [
              `${unknownArtists} unknown followed artists were not imported; only canonical artist references are accepted.`,
            ]
          : []),
      ].join(" ");
      await tx.query(
        "UPDATE import_job SET status='complete',notice=$2,imported=$3,matched=$3,unmatched=$4,failed=$5 WHERE id=$1",
        [jobId, notice, matched, unmatched, failed],
      );
    });
    return jobId;
  } catch (error) {
    await db.query(
      "UPDATE import_job SET status=$2,notice=$3,failed=failed+1 WHERE id=$1",
      [
        jobId,
        "failed",
        "Import failed. Upload the same file to retry; committed items will be preserved.",
      ],
    );
    throw error;
  }
}
async function portableCanonical(
  db: Database,
  source: ImportSnapshot["tracks"][number],
): Promise<Track | null> {
  if (source.provider === "studio")
    return (
      catalogue.find(
        (entry) =>
          entry.id === source.id && entry.externalId === source.externalId,
      ) ?? null
    );
  if (
    source.provider !== "youtube" ||
    source.id !== `youtube:${source.externalId}` ||
    !/^[A-Za-z0-9_-]{11}$/.test(source.externalId ?? "")
  )
    return null;
  const rows = await db.query<{ metadata: unknown }>(
    "SELECT metadata FROM track_reference WHERE id=$1",
    [source.id],
  );
  const parsed = TrackSchema.safeParse(rows[0]?.metadata);
  return parsed.success &&
    parsed.data.id === source.id &&
    parsed.data.provider === source.provider &&
    parsed.data.externalId === source.externalId
    ? parsed.data
    : null;
}
function deterministicId(userId: string, kind: string, sourceId: string) {
  const hash = createHash("sha256")
    .update(JSON.stringify([userId, kind, sourceId]))
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
const importedHistory = z
  .array(
    z.object({
      id: z.string().min(1).max(160),
      playedAt: z.iso.datetime(),
      completion: z.number().finite().min(0).max(1),
    }),
  )
  .max(1000);
async function acceptHistory(
  db: Database,
  userId: string,
  trackId: string,
  history: ImportedHistory[],
) {
  const entries = importedHistory.parse(history).map((entry) => ({
    id: deterministicId(userId, "history", entry.id),
    played_at: entry.playedAt,
    completion: entry.completion,
  }));
  if (entries.length)
    await db.query(
      "INSERT INTO play_history(id,user_id,track_id,played_at,completion) SELECT id,$1,$2,played_at,completion FROM jsonb_to_recordset($3::jsonb) AS event(id text,played_at timestamptz,completion real) ON CONFLICT(id) DO NOTHING",
      [userId, trackId, JSON.stringify(entries)],
    );
}
async function acceptTrack(
  db: Database,
  userId: string,
  track: Track,
  playlistIds: string[],
  liked: boolean,
  provider: string,
  sourceId: string,
  history: ImportedHistory[] = [],
  checkBudget: () => void = () => {},
) {
  checkBudget();
  await lockPlaylists(db, userId, playlistIds);
  await saveTrack(db, track);
  if (provider !== "aurelia")
    await db.query(
      "INSERT INTO track_provider_id(track_id,provider,external_id) VALUES($1,$2,$3) ON CONFLICT(provider,external_id) DO NOTHING",
      [track.id, provider, sourceId],
    );
  if (liked)
    await db.query(
      "INSERT INTO liked_track(user_id,track_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [userId, track.id],
    );
  for (const playlistId of playlistIds) {
    checkBudget();
    await addToPlaylist(db, userId, playlistId, track);
  }
  checkBudget();
  if (provider === "aurelia")
    await acceptHistory(db, userId, track.id, history);
}
export async function resolveImport(
  db: Database,
  userId: string,
  itemId: string,
  trackId: string,
) {
  const rows = await db.query<{
    job_id: string;
    source_id: string;
    provider: string;
    playlist_ids: unknown;
    liked: boolean;
    status: string;
    source: unknown;
  }>(
    "SELECT i.job_id,i.source_id,j.provider,i.playlist_ids,i.liked,i.status,i.source FROM import_item i JOIN import_job j ON j.id=i.job_id WHERE i.id=$1 AND j.user_id=$2",
    [itemId, userId],
  );
  const item = rows[0];
  if (!item) throw new AppError(404, "Import item not found");
  if (item.status === "matched") return;
  const track = await trustedTrack(trackId);
  await db.transaction(async (tx) => {
    const locked = await tx.query<{ status: string }>(
      "SELECT status FROM import_item WHERE id=$1 FOR UPDATE",
      [itemId],
    );
    if (locked[0].status === "matched") return;
    const playlistIds = z.array(z.string()).parse(item.playlist_ids);
    const positions = z
      .object({
        playlistPositions: z
          .array(
            z.object({
              id: z.uuid(),
              position: z.number().int().min(0).max(999),
            }),
          )
          .max(100)
          .default([]),
      })
      .parse(item.source);
    await lockPlaylists(tx, userId, [
      ...playlistIds,
      ...positions.playlistPositions.map((entry) => entry.id),
    ]);
    await acceptTrack(
      tx,
      userId,
      track,
      playlistIds,
      item.liked,
      item.provider,
      item.source_id,
      item.provider === "aurelia"
        ? z.object({ history: importedHistory.default([]) }).parse(item.source)
            .history
        : [],
    );
    for (const entry of positions.playlistPositions)
      await tx.query(
        "UPDATE playlist_track SET position=$3 WHERE playlist_id=$1 AND track_id=$2",
        [entry.id, track.id, entry.position],
      );
    await tx.query("UPDATE import_item SET status=$2 WHERE id=$1", [
      itemId,
      "matched",
    ]);
    await tx.query(
      "UPDATE import_job SET matched=matched+1,imported=imported+1,unmatched=GREATEST(0,unmatched-1) WHERE id=$1",
      [item.job_id],
    );
  });
}
export async function importSpotify(
  db: Database,
  userId: string,
  token: string,
) {
  const snapshot = await new SpotifyImportProvider(token).read();
  return runImport(db, userId, snapshot);
}
export async function getImports(db: Database, userId: string) {
  const jobs = await db.query(
    "SELECT id,provider,status,total,imported,matched,unmatched,failed,notice,created_at FROM import_job WHERE user_id=$1 ORDER BY created_at DESC",
    [userId],
  );
  const items = await db.query<{
    id: string;
    job_id: string;
    source: Match["source"];
    match: Match;
    status: string;
  }>(
    "SELECT i.id,i.job_id,i.source,i.match,i.status FROM import_item i JOIN import_job j ON j.id=i.job_id WHERE j.user_id=$1 AND i.status<>$2 ORDER BY j.created_at DESC LIMIT 100",
    [userId, "matched"],
  );
  return { jobs, items };
}
