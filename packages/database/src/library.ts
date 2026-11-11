import { randomUUID } from "node:crypto";
import {
  AppError,
  TrackSchema,
  type Library,
  type Track,
  type Signal,
  type UserPlaylist,
} from "@aurelia/core";
import type { Database } from "./connection";

export async function saveTrack(db: Database, track: Track) {
  const t = TrackSchema.parse(track);
  // Provider-specific artist/album namespaces prevent unrelated ID collisions.
  const artistId = `${t.provider}:${t.artistId}`;
  const albumId = `${t.provider}:${t.albumId}`;
  await db.query(
    "INSERT INTO artist_reference(id,name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name",
    [artistId, t.artist],
  );
  await db.query(
    "INSERT INTO album_reference(id,title,artist_id) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING",
    [albumId, t.album, artistId],
  );
  await db.query(
    "INSERT INTO track_reference(id,metadata,artist_id,album_id) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET metadata=EXCLUDED.metadata,updated_at=now()",
    [t.id, JSON.stringify(t), artistId, albumId],
  );
  await db.query(
    "INSERT INTO track_provider_id(track_id,provider,external_id) VALUES($1,$2,$3) ON CONFLICT(provider,external_id) DO NOTHING",
    [t.id, t.provider, t.externalId],
  );
}
export async function recordSignal(
  db: Database,
  userId: string,
  kind: Signal["kind"],
  trackId: string | null,
  value = 1,
  query: string | null = null,
) {
  await db.query(
    "INSERT INTO recommendation_signal(id,user_id,track_id,kind,value,query) VALUES($1,$2,$3,$4,$5,$6)",
    [
      randomUUID(),
      userId,
      trackId,
      kind,
      Math.min(1, Math.max(0, value)),
      query,
    ],
  );
}
export async function getSignals(
  db: Database,
  userId: string,
): Promise<Signal[]> {
  const rows = await db.query<{
    track_id: string | null;
    query: string | null;
    kind: Signal["kind"];
    value: number;
    created_at: Date;
  }>(
    "SELECT track_id,query,kind,value,created_at FROM recommendation_signal WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1000",
    [userId],
  );
  return rows.map((r) => ({
    trackId: r.track_id,
    query: r.query,
    kind: r.kind,
    value: r.value,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}
export async function getLibrary(
  db: Database,
  userId: string,
): Promise<Library> {
  const [likes, playlists, history, queue, searches, followed] =
    await Promise.all([
      db.query<{ metadata: unknown }>(
        "SELECT t.metadata FROM liked_track l JOIN track_reference t ON t.id=l.track_id WHERE l.user_id=$1 ORDER BY l.created_at DESC",
        [userId],
      ),
      db.query<{
        id: string;
        name: string;
        description: string;
        created_at: Date;
      }>(
        "SELECT id,name,description,created_at FROM playlist WHERE user_id=$1 ORDER BY created_at DESC",
        [userId],
      ),
      db.query<{
        id: string;
        metadata: unknown;
        played_at: Date;
        completion: number;
      }>(
        "SELECT h.id,t.metadata,h.played_at,h.completion FROM play_history h JOIN track_reference t ON t.id=h.track_id WHERE h.user_id=$1 ORDER BY h.played_at DESC LIMIT 100",
        [userId],
      ),
      db.query<{ state: unknown }>(
        "SELECT state FROM queue_state WHERE user_id=$1",
        [userId],
      ),
      db.query<{ query: string }>(
        "SELECT query FROM recommendation_signal WHERE user_id=$1 AND kind=$2 AND query IS NOT NULL GROUP BY query ORDER BY max(created_at) DESC LIMIT 8",
        [userId, "search"],
      ),
      db.query<{ artist_id: string }>(
        "SELECT artist_id FROM followed_artist WHERE user_id=$1",
        [userId],
      ),
    ]);
  const userPlaylists: UserPlaylist[] = await Promise.all(
    playlists.map(async (p) => {
      const tracks = await db.query<{ metadata: unknown }>(
        "SELECT t.metadata FROM playlist_track pt JOIN track_reference t ON t.id=pt.track_id WHERE pt.playlist_id=$1 ORDER BY pt.position,pt.added_at,pt.track_id",
        [p.id],
      );
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        createdAt: new Date(p.created_at).toISOString(),
        tracks: tracks.map((t) => TrackSchema.parse(t.metadata)),
      };
    }),
  );
  return {
    likes: likes.map((l) => TrackSchema.parse(l.metadata)),
    playlists: userPlaylists,
    history: history.map((h) => ({
      id: h.id,
      track: TrackSchema.parse(h.metadata),
      playedAt: new Date(h.played_at).toISOString(),
      completion: h.completion,
    })),
    queue: queue[0]?.state ?? null,
    searches: searches.map((s) => s.query),
    followedArtists: followed.map((a) => a.artist_id),
  };
}
export async function createPlaylist(
  db: Database,
  userId: string,
  name: string,
  description = "",
) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO playlist(id,user_id,name,description) VALUES($1,$2,$3,$4)",
    [id, userId, name, description],
  );
  return id;
}
export async function assertPlaylistOwner(
  db: Database,
  userId: string,
  playlistId: string,
) {
  const rows = await db.query(
    "SELECT id FROM playlist WHERE id=$1 AND user_id=$2",
    [playlistId, userId],
  );
  if (!rows.length) throw new AppError(404, "Playlist not found");
}
export async function addToPlaylist(
  db: Database,
  userId: string,
  playlistId: string,
  track: Track,
) {
  await db.transaction(async (tx) => {
    await lockPlaylists(tx, userId, [playlistId]);
    await saveTrack(tx, track);
    const result = await tx.query(
      "INSERT INTO playlist_track(playlist_id,track_id,position) SELECT $1,$2,COALESCE(max(position),-1)+1 FROM playlist_track WHERE playlist_id=$1 ON CONFLICT(playlist_id,track_id) DO NOTHING RETURNING track_id",
      [playlistId, track.id],
    );
    if (result.length) await recordSignal(tx, userId, "playlist-add", track.id);
  });
}

/** Call inside the writer's transaction, before track/member writes. */
export async function lockPlaylists(
  tx: Database,
  userId: string,
  playlistIds: readonly string[],
) {
  for (const playlistId of [...new Set(playlistIds)].sort()) {
    const rows = await tx.query(
      "SELECT id FROM playlist WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [playlistId, userId],
    );
    if (!rows.length) throw new AppError(404, "Playlist not found");
  }
}

export async function updatePlaylist(
  db: Database,
  userId: string,
  playlistId: string,
  input: { name?: string; description?: string },
) {
  await db.transaction(async (tx) => {
    await lockPlaylists(tx, userId, [playlistId]);
    await tx.query(
      "UPDATE playlist SET name=COALESCE($1,name),description=COALESCE($2,description) WHERE id=$3 AND user_id=$4",
      [input.name ?? null, input.description ?? null, playlistId, userId],
    );
  });
}

export async function removeFromPlaylist(
  db: Database,
  userId: string,
  playlistId: string,
  trackId: string,
) {
  await db.transaction(async (tx) => {
    await lockPlaylists(tx, userId, [playlistId]);
    await tx.query(
      "DELETE FROM playlist_track WHERE playlist_id=$1 AND track_id=$2",
      [playlistId, trackId],
    );
  });
}

export async function deletePlaylist(
  db: Database,
  userId: string,
  playlistId: string,
) {
  await db.transaction(async (tx) => {
    await lockPlaylists(tx, userId, [playlistId]);
    await tx.query("DELETE FROM playlist WHERE id=$1 AND user_id=$2", [
      playlistId,
      userId,
    ]);
  });
}

export async function reorderPlaylist(
  db: Database,
  userId: string,
  playlistId: string,
  trackIds: readonly string[],
  expectedTrackIds: readonly string[],
) {
  for (const ids of [trackIds, expectedTrackIds]) {
    if (
      ids.length > 5000 ||
      new Set(ids).size !== ids.length ||
      ids.some(
        (id) => typeof id !== "string" || id.length < 1 || id.length > 160,
      )
    )
      throw new AppError(400, "Invalid playlist order");
  }
  await db.transaction(async (tx) => {
    await lockPlaylists(tx, userId, [playlistId]);
    const rows = await tx.query<{ track_id: string }>(
      "SELECT track_id FROM playlist_track WHERE playlist_id=$1 ORDER BY position,added_at,track_id",
      [playlistId],
    );
    if (
      rows.length !== expectedTrackIds.length ||
      rows.some((row, index) => row.track_id !== expectedTrackIds[index])
    )
      throw new AppError(409, "Playlist changed. Refresh before reordering.");
    const current = new Set(rows.map((row) => row.track_id));
    if (
      trackIds.length !== rows.length ||
      trackIds.some((id) => !current.has(id))
    )
      throw new AppError(
        400,
        "The order must contain every playlist track exactly once",
      );
    if (trackIds.length) {
      const updated = await tx.query(
        "UPDATE playlist_track AS target SET position=source.position FROM jsonb_to_recordset($2::jsonb) AS source(track_id text,position integer) WHERE target.playlist_id=$1 AND target.track_id=source.track_id RETURNING target.track_id",
        [
          playlistId,
          JSON.stringify(
            trackIds.map((track_id, position) => ({ track_id, position })),
          ),
        ],
      );
      if (updated.length !== trackIds.length)
        throw new AppError(409, "Playlist changed. Refresh before reordering.");
    }
  });
}
