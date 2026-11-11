import { z } from "zod";
import {
  getDatabase,
  getLibrary,
  saveTrack,
  recordSignal,
  createPlaylist,
  addToPlaylist,
  assertPlaylistOwner,
  updatePlaylist,
  removeFromPlaylist,
  deletePlaylist,
  reorderPlaylist,
} from "@aurelia/database";
import { PlayerSnapshotSchema } from "@aurelia/player";
import { body, json, requireAccount } from "./http";
import { trustedTrack } from "./providers";
import { rateLimit } from "@aurelia/auth";
import { createPortableLibrary } from "@aurelia/integrations";
const trackInput = z.object({ trackId: z.string().max(160) });
const playlistUpdate = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(1000).optional(),
  })
  .strict()
  .refine(
    (input) => input.name !== undefined || input.description !== undefined,
    { message: "Provide a name or description" },
  );
const playlistTrackIds = z
  .array(z.string().min(1).max(160))
  .max(5000)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Track IDs must be unique",
  });
const playlistOrder = z
  .object({
    trackIds: playlistTrackIds,
    expectedTrackIds: playlistTrackIds,
  })
  .strict();
export async function libraryApi(path: string[], request: Request) {
  const user = await requireAccount();
  const db = await getDatabase();
  await rateLimit(db, `library:${user.id}`, 180);
  if (!path.length && request.method === "GET")
    return json(await getLibrary(db, user.id));
  if (path[0] === "likes" && ["POST", "DELETE"].includes(request.method)) {
    const { trackId } = trackInput.parse(await body(request));
    if (request.method === "DELETE") {
      await db.transaction(async (tx) => {
        await tx.query(
          "DELETE FROM liked_track WHERE user_id=$1 AND track_id=$2",
          [user.id, trackId],
        );
        await tx.query(
          "DELETE FROM recommendation_signal WHERE user_id=$1 AND track_id=$2 AND kind=$3",
          [user.id, trackId, "like"],
        );
      });
      return json({ ok: true });
    }
    const track = await trustedTrack(trackId);
    await db.transaction(async (tx) => {
      await saveTrack(tx, track);
      {
        const inserted = await tx.query(
          "INSERT INTO liked_track(user_id,track_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING track_id",
          [user.id, track.id],
        );
        if (inserted.length) await recordSignal(tx, user.id, "like", track.id);
      }
    });
    return json({ ok: true });
  }
  if (path[0] === "playlists") {
    if (path.length === 1 && request.method === "POST") {
      const input = z
        .object({
          name: z.string().trim().min(1).max(120),
          description: z.string().max(1000).default(""),
        })
        .strict()
        .parse(await body(request));
      return json(
        {
          id: await createPlaylist(db, user.id, input.name, input.description),
        },
        201,
      );
    }
    if (path.length > 1 && !z.uuid().safeParse(path[1]).success) return null;
    if (path.length === 3 && path[2] === "order" && request.method === "PUT") {
      const input = playlistOrder.parse(await body(request));
      await reorderPlaylist(
        db,
        user.id,
        path[1],
        input.trackIds,
        input.expectedTrackIds,
      );
      return json({ ok: true });
    }
    if (
      path.length === 3 &&
      path[2] === "tracks" &&
      ["POST", "DELETE"].includes(request.method)
    ) {
      await assertPlaylistOwner(db, user.id, path[1]);
      const input = trackInput.parse(await body(request));
      if (request.method === "POST")
        await addToPlaylist(
          db,
          user.id,
          path[1],
          await trustedTrack(input.trackId),
        );
      else if (request.method === "DELETE")
        await removeFromPlaylist(db, user.id, path[1], input.trackId);
      return json({ ok: true });
    }
    if (path.length === 2) {
      if (request.method === "DELETE") {
        await deletePlaylist(db, user.id, path[1]);
        return json({ ok: true });
      }
      if (request.method === "PATCH") {
        const input = playlistUpdate.parse(await body(request, 8192));
        await updatePlaylist(db, user.id, path[1], input);
        return json({ ok: true });
      }
    }
  }
  if (path[0] === "queue" && request.method === "PUT") {
    const snapshot = PlayerSnapshotSchema.parse(await body(request));
    await db.query(
      "INSERT INTO queue_state(user_id,state) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()",
      [user.id, JSON.stringify({ ...snapshot, playing: false })],
    );
    return json({ ok: true });
  }
  if (path[0] === "history" && request.method === "POST") {
    const input = z
      .object({
        trackId: z.string(),
        playId: z.uuid(),
        completion: z.number().min(0).max(1),
      })
      .parse(await body(request));
    const track = await trustedTrack(input.trackId);
    await db.transaction(async (tx) => {
      await saveTrack(tx, track);
      const inserted = await tx.query(
        "INSERT INTO play_history(id,user_id,track_id,completion) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING RETURNING id",
        [input.playId, user.id, track.id, input.completion],
      );
      if (inserted.length) await recordSignal(tx, user.id, "play", track.id);
      else
        await tx.query(
          "UPDATE play_history SET completion=GREATEST(completion,$1) WHERE id=$2 AND user_id=$3 AND track_id=$4",
          [input.completion, input.playId, user.id, track.id],
        );
    });
    return json({ ok: true });
  }
  if (path[0] === "signals" && request.method === "POST") {
    const input = z
      .object({
        trackId: z.string().optional(),
        kind: z.enum(["skip", "complete", "hide", "search"]),
        value: z.number().min(0).max(1).default(1),
        query: z.string().trim().max(200).optional(),
      })
      .parse(await body(request));
    let trackId: string | null = null;
    if (input.trackId) {
      const track = await trustedTrack(input.trackId);
      await saveTrack(db, track);
      trackId = track.id;
    }
    await recordSignal(
      db,
      user.id,
      input.kind,
      trackId,
      input.value,
      input.query ?? null,
    );
    return json({ ok: true });
  }
  if (path[0] === "artists" && request.method === "POST") {
    const input = z
      .object({
        artistId: z.string().max(160),
        name: z.string().max(500),
        follow: z.boolean(),
      })
      .parse(await body(request));
    if (input.follow) {
      await db.query(
        "INSERT INTO artist_reference(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING",
        [input.artistId, input.name],
      );
      await db.query(
        "INSERT INTO followed_artist(user_id,artist_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [user.id, input.artistId],
      );
    } else
      await db.query(
        "DELETE FROM followed_artist WHERE user_id=$1 AND artist_id=$2",
        [user.id, input.artistId],
      );
    return json({ ok: true });
  }
  if (path[0] === "export" && request.method === "GET") {
    const library = await getLibrary(db, user.id);
    const artists = library.followedArtists.length
      ? await db.query<{ id: string; name: string }>(
          "SELECT id,name FROM artist_reference WHERE id=ANY($1::text[]) ORDER BY id",
          [library.followedArtists],
        )
      : [];
    return json(createPortableLibrary(library, artists));
  }
  return null;
}
