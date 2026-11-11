import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  createPlaylist,
  addToPlaylist,
  removeFromPlaylist,
  updatePlaylist,
  deletePlaylist,
  reorderPlaylist,
  getLibrary,
  type Database,
} from "@aurelia/database";
import { catalogue } from "@aurelia/music";
import {
  createPortableLibrary,
  type ImportSnapshot,
} from "@aurelia/integrations";
import { runImport, resolveImport } from "../apps/web/src/lib/import-service";

vi.mock("../apps/web/src/lib/env", () => ({
  capabilities: { youtube: false },
}));
vi.mock("../apps/web/src/lib/providers", async () => {
  const { catalogue } = await import("@aurelia/music");
  return {
    youtube: {
      search: vi.fn(() => {
        throw new Error("Network forbidden");
      }),
    },
    trustedTrack: vi.fn(async (id: string) => {
      const track = catalogue.find((entry) => entry.id === id);
      if (!track) throw new Error("Unknown synthetic track");
      return track;
    }),
  };
});

let db: Database;
const owner = randomUUID(),
  other = randomUUID();
const ids = catalogue.slice(0, 3).map((track) => track.id);
beforeAll(async () => {
  db = await createDatabase({ memory: true });
  for (const id of [owner, other])
    await db.query(
      "INSERT INTO app_user(id,name) VALUES($1,'Synthetic playlist owner')",
      [id],
    );
});
afterAll(async () => db.close());
async function playlist() {
  const id = await createPlaylist(
    db,
    owner,
    "Original",
    "Original description",
  );
  for (const track of catalogue.slice(0, 3))
    await addToPlaylist(db, owner, id, track);
  return id;
}
async function read(id: string) {
  return (await getLibrary(db, owner)).playlists.find(
    (entry) => entry.id === id,
  )!;
}

describe("owned playlist mutations", () => {
  it("updates only supplied metadata and can explicitly clear the description", async () => {
    const id = await playlist();
    await updatePlaylist(db, owner, id, { description: "Changed" });
    expect(await read(id)).toMatchObject({
      name: "Original",
      description: "Changed",
    });
    await updatePlaylist(db, owner, id, { name: "Renamed" });
    expect(await read(id)).toMatchObject({
      name: "Renamed",
      description: "Changed",
    });
    await updatePlaylist(db, owner, id, { description: "" });
    expect((await read(id)).description).toBe("");
    expect((await read(id)).tracks.map((track) => track.id)).toEqual(ids);
  });

  it("keeps foreign playlist metadata, membership and order private and unchanged", async () => {
    const id = await playlist();
    for (const mutation of [
      () => updatePlaylist(db, other, id, { name: "Forged" }),
      () => removeFromPlaylist(db, other, id, ids[0]),
      () => reorderPlaylist(db, other, id, [...ids].reverse(), ids),
      () => deletePlaylist(db, other, id),
    ])
      await expect(mutation()).rejects.toMatchObject({ status: 404 });
    expect(await read(id)).toMatchObject({
      name: "Original",
      description: "Original description",
    });
    expect((await read(id)).tracks.map((track) => track.id)).toEqual(ids);
    expect((await getLibrary(db, other)).playlists).toEqual([]);
  });

  it("persists the requested order in library/export without changing timestamps or recommendation signals", async () => {
    const id = await playlist();
    const before = await db.query(
      "SELECT track_id,added_at FROM playlist_track WHERE playlist_id=$1 ORDER BY track_id",
      [id],
    );
    const signals = await db.query(
      "SELECT id FROM recommendation_signal WHERE user_id=$1 ORDER BY id",
      [owner],
    );
    const order = [ids[2], ids[0], ids[1]];
    await reorderPlaylist(db, owner, id, order, ids);
    expect((await read(id)).tracks.map((track) => track.id)).toEqual(order);
    const positions = await db.query<{ position: number }>(
      "SELECT position FROM playlist_track WHERE playlist_id=$1 ORDER BY position",
      [id],
    );
    expect(positions.map((row) => row.position)).toEqual([0, 1, 2]);
    expect(
      await db.query(
        "SELECT track_id,added_at FROM playlist_track WHERE playlist_id=$1 ORDER BY track_id",
        [id],
      ),
    ).toEqual(before);
    expect(
      await db.query(
        "SELECT id FROM recommendation_signal WHERE user_id=$1 ORDER BY id",
        [owner],
      ),
    ).toEqual(signals);
    expect(
      createPortableLibrary(await getLibrary(db, owner)).playlists.find(
        (entry) => entry.id === id,
      )?.trackIds,
    ).toEqual(order);
  });

  it("rejects stale expected order even when the membership is unchanged", async () => {
    const id = await playlist();
    const current = [...ids].reverse();
    await reorderPlaylist(db, owner, id, current, ids);
    await expect(
      reorderPlaylist(db, owner, id, ids, ids),
    ).rejects.toMatchObject({ status: 409 });
    expect((await read(id)).tracks.map((track) => track.id)).toEqual(current);
  });

  it("rejects expected membership invalidated by an add or removal", async () => {
    const id = await playlist();
    await addToPlaylist(db, owner, id, catalogue[3]);
    await expect(
      reorderPlaylist(db, owner, id, [...ids].reverse(), ids),
    ).rejects.toMatchObject({ status: 409 });
    const beforeRemove = [...ids, catalogue[3].id];
    await removeFromPlaylist(db, owner, id, ids[1]);
    await expect(
      reorderPlaylist(db, owner, id, [...beforeRemove].reverse(), beforeRemove),
    ).rejects.toMatchObject({ status: 409 });
    expect((await read(id)).tracks.map((track) => track.id)).toEqual([
      ids[0],
      ids[2],
      catalogue[3].id,
    ]);
  });

  it("rejects incomplete, extra, duplicate and oversized permutations without partial mutation", async () => {
    const id = await playlist();
    for (const order of [
      ids.slice(1),
      [...ids, catalogue[3].id],
      [ids[0], ids[0], ids[2]],
      ["", ids[1], ids[2]],
      ["x".repeat(161), ids[1], ids[2]],
      Array.from({ length: 5001 }, (_, index) => `synthetic-${index}`),
    ])
      await expect(
        reorderPlaylist(db, owner, id, order, ids),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      reorderPlaylist(db, owner, id, ids, [ids[0], ids[0]]),
    ).rejects.toMatchObject({ status: 400 });
    expect((await read(id)).tracks.map((track) => track.id)).toEqual(ids);
  });

  it("supports the empty playlist and reorders after remove/append without duplicating entries", async () => {
    const empty = await createPlaylist(db, owner, "Empty");
    await reorderPlaylist(db, owner, empty, [], []);
    expect((await read(empty)).tracks).toEqual([]);
    const id = await playlist();
    await removeFromPlaylist(db, owner, id, ids[1]);
    await addToPlaylist(db, owner, id, catalogue[3]);
    await addToPlaylist(db, owner, id, catalogue[3]);
    const current = [ids[0], ids[2], catalogue[3].id];
    expect((await read(id)).tracks.map((track) => track.id)).toEqual(current);
    await reorderPlaylist(db, owner, id, [...current].reverse(), current);
    expect((await read(id)).tracks.map((track) => track.id)).toEqual(
      [...current].reverse(),
    );
    await deletePlaylist(db, owner, id);
    await expect(reorderPlaylist(db, owner, id, [], [])).rejects.toMatchObject({
      status: 404,
    });
    expect(
      await db.query(
        "SELECT track_id FROM playlist_track WHERE playlist_id=$1",
        [id],
      ),
    ).toEqual([]);
  });

  it("rolls back an order update if the transaction fails after the batch write", async () => {
    const id = await playlist();
    const failing = (database: Database): Database => ({
      query: async <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) => {
        const result = await database.query<T>(sql, params);
        if (sql.startsWith("UPDATE playlist_track AS target"))
          throw new Error("Synthetic post-write failure");
        return result;
      },
      transaction: (fn) => database.transaction((tx) => fn(failing(tx))),
      close: async () => {},
    });
    await expect(
      reorderPlaylist(failing(db), owner, id, [...ids].reverse(), ids),
    ).rejects.toThrow("Synthetic post-write failure");
    expect((await read(id)).tracks.map((track) => track.id)).toEqual(ids);
  });
});

/** Observes statement ordering, not PostgreSQL lock contention. */
function checkedImport(
  database: Database,
  observations: { metadata: number; order: number },
  held?: Set<string>,
): Database {
  return {
    query: async <T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => {
      if (
        sql === "SELECT id FROM playlist WHERE id=$1 AND user_id=$2 FOR UPDATE"
      )
        held?.add(String(params?.[0]));
      if (
        sql.startsWith("INSERT INTO artist_reference") ||
        sql.startsWith("UPDATE playlist_track")
      ) {
        expect(held?.size).toBe(2);
        expect([...held!]).toEqual([...held!].sort());
        if (sql.startsWith("INSERT INTO artist_reference"))
          observations.metadata++;
        else observations.order++;
      }
      return database.query<T>(sql, params);
    },
    transaction: (fn) =>
      database.transaction((tx) =>
        fn(checkedImport(tx, observations, held ?? new Set())),
      ),
    close: async () => {},
  };
}

describe("import playlist writer lock discipline", () => {
  it("locks both parents in sorted order before imported metadata/member writes and final order updates", async () => {
    const observations = { metadata: 0, order: 0 };
    const snapshot: ImportSnapshot = {
      provider: "fixture",
      tracks: catalogue
        .slice(0, 2)
        .map((track) => ({
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          duration: track.duration,
        })),
      likes: [],
      artists: [],
      notices: [],
      playlists: [
        {
          id: randomUUID(),
          name: "Import forward",
          description: "",
          trackIds: ids.slice(0, 2),
        },
        {
          id: randomUUID(),
          name: "Import reverse",
          description: "",
          trackIds: ids.slice(0, 2).reverse(),
        },
      ],
    };
    await runImport(checkedImport(db, observations), owner, snapshot);
    expect(observations.metadata).toBeGreaterThan(0);
    expect(observations.order).toBe(2);
    const library = await getLibrary(db, owner);
    expect(
      library.playlists
        .find((entry) => entry.name === "Import reverse")
        ?.tracks.map((track) => track.id),
    ).toEqual(ids.slice(0, 2).reverse());
  });

  it("uses the same sorted parent locks before resolving a review item and restoring its positions", async () => {
    const snapshot: ImportSnapshot = {
      provider: "fixture",
      tracks: [
        {
          id: "unknown-synthetic",
          title: "Not a catalogue recording",
          artist: "Unknown",
          album: "",
          duration: 213,
        },
      ],
      likes: [],
      artists: [],
      notices: [],
      playlists: [
        {
          id: randomUUID(),
          name: "Review A",
          description: "",
          trackIds: ["unknown-synthetic"],
        },
        {
          id: randomUUID(),
          name: "Review B",
          description: "",
          trackIds: ["unknown-synthetic"],
        },
      ],
    };
    const job = await runImport(db, owner, snapshot);
    const [item] = await db.query<{ id: string }>(
      "SELECT id FROM import_item WHERE job_id=$1",
      [job],
    );
    const observations = { metadata: 0, order: 0 };
    await resolveImport(
      checkedImport(db, observations),
      owner,
      item.id,
      catalogue[0].id,
    );
    expect(observations.metadata).toBeGreaterThan(0);
    expect(observations.order).toBe(2);
    for (const name of ["Review A", "Review B"])
      expect(
        (await getLibrary(db, owner)).playlists
          .find((entry) => entry.name === name)
          ?.tracks.map((track) => track.id),
      ).toEqual([catalogue[0].id]);
  });
});
