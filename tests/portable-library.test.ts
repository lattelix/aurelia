import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  saveTrack,
  addToPlaylist,
  createPlaylist,
  getLibrary,
  type Database,
} from "@aurelia/database";
import { catalogue } from "@aurelia/music";
import {
  createPortableLibrary,
  parseLibraryImport,
  type PortableLibrary,
} from "@aurelia/integrations";
import type { Library, Track } from "@aurelia/core";
import { runImport, resolveImport } from "../apps/web/src/lib/import-service";
import { trustedTrack } from "../apps/web/src/lib/providers";

vi.mock("../apps/web/src/lib/env", () => ({
  capabilities: { youtube: false },
}));
vi.mock("../apps/web/src/lib/providers", () => ({
  youtube: {
    search: vi.fn(() => {
      throw new Error("Network disabled in this test");
    }),
  },
  trustedTrack: vi.fn(),
}));

let db: Database;
const sourceUser = randomUUID(),
  targetUser = randomUUID();
const canonical: Track = {
  ...catalogue[0],
  id: "youtube:aqz-KE-bpKQ",
  provider: "youtube",
  externalId: "aqz-KE-bpKQ",
  title: "Canonical public fixture",
  artistId: "fixture-author",
  albumId: "fixture-album",
  sourceUrl: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
};
const empty = (): Library => ({
  likes: [],
  playlists: [],
  history: [],
  searches: [],
  followedArtists: [],
  queue: null,
});
async function user() {
  const id = randomUUID();
  await db.query(
    "INSERT INTO app_user(id,name) VALUES($1,'Synthetic destination')",
    [id],
  );
  return id;
}
beforeAll(async () => {
  db = await createDatabase({ memory: true });
  for (const id of [sourceUser, targetUser])
    await db.query(
      "INSERT INTO app_user(id,name) VALUES($1,'Synthetic user')",
      [id],
    );
  await saveTrack(db, canonical);
  await saveTrack(db, catalogue[0]);
  vi.mocked(trustedTrack).mockImplementation(async (id) => {
    const track = catalogue.find((entry) => entry.id === id);
    if (!track) throw new Error("Unknown synthetic track");
    return track;
  });
});
afterAll(async () => db.close());

describe("portable metadata library", () => {
  it("roundtrips accountA to B with canonical IDs, playlist order, history and searches, without identity or locators", async () => {
    const playlistId = await createPlaylist(
      db,
      sourceUser,
      "Transfer playlist",
      "Metadata only",
    );
    for (const track of [catalogue[1], canonical, catalogue[0]])
      await addToPlaylist(db, sourceUser, playlistId, track);
    for (const track of [catalogue[0], canonical])
      await db.query(
        "INSERT INTO liked_track(user_id,track_id) VALUES($1,$2)",
        [sourceUser, track.id],
      );
    await db.query(
      "INSERT INTO play_history(id,user_id,track_id,completion,played_at) VALUES($1,$2,$3,0.75,'2026-11-01T12:00:00Z')",
      [randomUUID(), sourceUser, canonical.id],
    );
    await db.query(
      "INSERT INTO recommendation_signal(id,user_id,kind,value,query) VALUES($1,$2,'search',1,'Original query')",
      [randomUUID(), sourceUser],
    );
    await db.query(
      "INSERT INTO followed_artist(user_id,artist_id) VALUES($1,'studio:aurelia-studio')",
      [sourceUser],
    );
    await db.query(
      "INSERT INTO identity(provider,subject,user_id) VALUES('google','synthetic-source-only',$1)",
      [sourceUser],
    );
    const file = createPortableLibrary(await getLibrary(db, sourceUser), [
      { id: "studio:aurelia-studio", name: "Uploaded name is not trusted" },
    ]);
    const encoded = JSON.stringify(file);
    for (const field of [
      "sourceUrl",
      "artwork",
      "password",
      "token",
      "session",
      "synthetic-source-only",
      sourceUser,
    ])
      expect(encoded).not.toContain(field);
    expect(file.format).toBe("aurelia-library");
    expect(file.version).toBe(1);
    file.tracks.find((entry) => entry.id === canonical.id)!.title =
      "Forged uploaded metadata";
    const snapshot = parseLibraryImport(file),
      job = await runImport(db, targetUser, snapshot);
    expect(await runImport(db, targetUser, snapshot)).toBe(job);
    const result = await getLibrary(db, targetUser);
    expect(result.likes.map((entry) => entry.id).sort()).toEqual(
      [canonical.id, catalogue[0].id].sort(),
    );
    expect(result.likes.find((entry) => entry.id === canonical.id)?.title).toBe(
      canonical.title,
    );
    expect(result.playlists).toHaveLength(1);
    expect(result.playlists[0].id).not.toBe(playlistId);
    expect(result.playlists[0].tracks.map((entry) => entry.id)).toEqual([
      catalogue[1].id,
      canonical.id,
      catalogue[0].id,
    ]);
    expect(result.history).toHaveLength(1);
    expect(result.history[0].completion).toBe(0.75);
    expect(result.history[0].playedAt).toBe("2026-11-01T12:00:00.000Z");
    expect(result.searches).toEqual(["Original query"]);
    expect(result.followedArtists).toEqual(["studio:aurelia-studio"]);
    expect(result.queue).toBeNull();
    expect(
      await db.query("SELECT provider FROM identity WHERE user_id=$1", [
        targetUser,
      ]),
    ).toEqual([]);
    expect(
      (
        await db.query<{ metadata: Track }>(
          "SELECT metadata FROM track_reference WHERE id=$1",
          [canonical.id],
        )
      )[0].metadata.title,
    ).toBe(canonical.title);
    const second = createPortableLibrary(result, [
      { id: "studio:aurelia-studio", name: "Aurelia Studio" },
    ]);
    expect(
      second.tracks.find((entry) => entry.id === canonical.id)?.externalId,
    ).toBe("aqz-KE-bpKQ");
  });

  it("unknown IDs and mismatched Studio identities remain review items despite perfect uploaded text", async () => {
    const id = await user();
    const file = createPortableLibrary({
      ...empty(),
      likes: [catalogue[0], catalogue[1]],
    });
    file.tracks[0] = {
      ...file.tracks[0],
      provider: "youtube",
      id: "youtube:ZZZZZZZZZZZ",
      externalId: "ZZZZZZZZZZZ",
    };
    file.likes[0] = file.tracks[0].id;
    file.tracks[1].externalId = "12";
    const job = await runImport(db, id, parseLibraryImport(file));
    const items = await db.query<{ status: string }>(
      "SELECT status FROM import_item WHERE job_id=$1",
      [job],
    );
    expect(items.map((entry) => entry.status)).toEqual(["review", "review"]);
    expect((await getLibrary(db, id)).likes).toEqual([]);
    expect(
      await db.query(
        "SELECT track_id FROM track_provider_id WHERE provider='aurelia'",
      ),
    ).toEqual([]);
  });

  it("explicit review resolution restores pending history and playlist position without rebinding provider IDs", async () => {
    const id = await user();
    const file = createPortableLibrary({
      ...empty(),
      likes: [catalogue[0], catalogue[1]],
      playlists: [
        {
          id: "source-list",
          name: "Review order",
          description: "",
          createdAt: "2026-11-01T00:00:00Z",
          tracks: [catalogue[0], catalogue[1]],
        },
      ],
      history: [
        {
          id: "source-play",
          track: catalogue[0],
          completion: 0.5,
          playedAt: "2026-11-01T00:00:00Z",
        },
      ],
    });
    const unknown = "youtube:YYYYYYYYYYY";
    file.tracks[0] = {
      ...file.tracks[0],
      id: unknown,
      provider: "youtube",
      externalId: "YYYYYYYYYYY",
    };
    file.likes[0] = unknown;
    file.playlists[0].trackIds[0] = unknown;
    file.history[0].trackId = unknown;
    const job = await runImport(db, id, parseLibraryImport(file));
    const item = (
      await db.query<{ id: string }>(
        "SELECT id FROM import_item WHERE job_id=$1 AND source_id=$2",
        [job, unknown],
      )
    )[0];
    await resolveImport(db, id, item.id, catalogue[0].id);
    await resolveImport(db, id, item.id, catalogue[0].id);
    const result = await getLibrary(db, id);
    expect(result.playlists[0].tracks.map((entry) => entry.id)).toEqual([
      catalogue[0].id,
      catalogue[1].id,
    ]);
    expect(result.history).toHaveLength(1);
    expect(result.history[0].track.id).toBe(catalogue[0].id);
    expect(
      await db.query(
        "SELECT track_id FROM track_provider_id WHERE provider='aurelia'",
      ),
    ).toEqual([]);
  });

  it("failed jobs can retry committed items idempotently without creating a second job", async () => {
    const id = await user();
    let failOnce = true;
    const wrap = (database: Database): Database => ({
      query: async <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) => {
        if (
          sql.startsWith("INSERT INTO import_item") &&
          params?.[2] === catalogue[1].id &&
          failOnce
        ) {
          failOnce = false;
          throw new Error("Synthetic interrupted write");
        }
        return database.query<T>(sql, params);
      },
      transaction: (fn) => database.transaction((tx) => fn(wrap(tx))),
      close: async () => {},
    });
    const snapshot = parseLibraryImport(
      createPortableLibrary({
        ...empty(),
        likes: [catalogue[0], catalogue[1]],
      }),
    );
    await expect(runImport(wrap(db), id, snapshot)).rejects.toThrow(
      "Synthetic interrupted write",
    );
    const old = (
      await db.query<{ id: string; status: string }>(
        "SELECT id,status FROM import_job WHERE user_id=$1",
        [id],
      )
    )[0];
    expect(old.status).toBe("failed");
    expect(await runImport(db, id, snapshot)).toBe(old.id);
    expect(
      await db.query("SELECT source_id FROM import_item WHERE job_id=$1", [
        old.id,
      ]),
    ).toHaveLength(2);
    const counters = (
      await db.query(
        "SELECT status,total,matched,unmatched,failed FROM import_job WHERE id=$1",
        [old.id],
      )
    )[0];
    expect(counters).toEqual({
      status: "complete",
      total: 2,
      matched: 2,
      unmatched: 0,
      failed: 0,
    });
    expect((await getLibrary(db, id)).likes).toHaveLength(2);
  });

  it("batches playlist reorder into one statement per playlist", async () => {
    const id = await user();
    let reordered = 0;
    const wrap = (database: Database): Database => ({
      query: async <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) => {
        if (sql.startsWith("UPDATE playlist_track AS target")) reordered++;
        return database.query<T>(sql, params);
      },
      transaction: (fn) => database.transaction((tx) => fn(wrap(tx))),
      close: async () => {},
    });
    const entries = catalogue.slice(0, 3);
    const file = createPortableLibrary({
      ...empty(),
      likes: entries,
      playlists: [
        {
          id: "first",
          name: "First",
          description: "",
          createdAt: "2026-11-01T00:00:00Z",
          tracks: [...entries].reverse(),
        },
        {
          id: "second",
          name: "Second",
          description: "",
          createdAt: "2026-11-01T00:00:00Z",
          tracks: entries,
        },
      ],
    });
    await runImport(wrap(db), id, parseLibraryImport(file));
    expect(reordered).toBe(2);
    const library = await getLibrary(db, id);
    expect(
      library.playlists
        .find((entry) => entry.name === "First")
        ?.tracks.map((entry) => entry.id),
    ).toEqual([...entries].reverse().map((entry) => entry.id));
  });

  it("marks a finishing-phase deadline failed so the same file can resume", async () => {
    const id = await user();
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const wrap = (database: Database): Database => ({
      query: async <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) => {
        const rows = await database.query<T>(sql, params);
        if (sql.startsWith("SELECT id FROM artist_reference WHERE id=ANY"))
          now = 240_001;
        return rows;
      },
      transaction: (fn) => database.transaction((tx) => fn(wrap(tx))),
      close: async () => {},
    });
    const snapshot = parseLibraryImport(
      createPortableLibrary(empty(), [
        { id: "unknown-artist", name: "Unverified artist" },
      ]),
    );
    try {
      await expect(runImport(wrap(db), id, snapshot)).rejects.toThrow(
        "processing limit",
      );
    } finally {
      clock.mockRestore();
    }
    expect(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM import_job WHERE user_id=$1",
          [id],
        )
      )[0].status,
    ).toBe("failed");
    await runImport(db, id, snapshot);
    const result = (
      await db.query<{ status: string; notice: string }>(
        "SELECT status,notice FROM import_job WHERE user_id=$1",
        [id],
      )
    )[0];
    expect(result.status).toBe("complete");
    expect(result.notice).toContain("1 unknown followed artists");
    expect((await getLibrary(db, id)).followedArtists).toEqual([]);
  });

  it("keeps legacy files usable while discarding remote source URLs", () => {
    const snapshot = parseLibraryImport({
      tracks: [
        {
          id: "legacy",
          title: "Golden Hour",
          artist: "Aurelia Studio",
          sourceUrl: "https://example.test/media?token=synthetic",
        },
      ],
      likes: ["legacy"],
    });
    expect(snapshot.provider).toBe("file");
    expect(snapshot.tracks[0]).not.toHaveProperty("sourceUrl");
    expect(snapshot.notices.join(" ")).toContain("Source URLs are ignored");
  });

  it("accepts an empty versioned library and rejects dangling/duplicate refs, unknown versions and credentials", async () => {
    const file = createPortableLibrary(empty());
    expect(parseLibraryImport(file).tracks).toEqual([]);
    await runImport(db, await user(), parseLibraryImport(file));
    for (const invalid of [
      { ...file, version: 2 },
      { ...file, token: "synthetic-secret" },
      { ...file, likes: ["missing"] },
    ])
      expect(() => parseLibraryImport(invalid)).toThrow();
    const one = createPortableLibrary({ ...empty(), likes: [catalogue[0]] });
    expect(() =>
      parseLibraryImport({ ...one, tracks: [one.tracks[0], one.tracks[0]] }),
    ).toThrow("unique");
    expect(() =>
      parseLibraryImport({
        ...one,
        tracks: [{ ...one.tracks[0], sourceUrl: "https://example.test" }],
      }),
    ).toThrow();
  });

  it("rejects limits explicitly instead of slicing a library", () => {
    const file: PortableLibrary = createPortableLibrary(empty());
    expect(() =>
      parseLibraryImport({ ...file, notices: ["x".repeat(2_000_001)] }),
    ).toThrow("2,000,000");
    const tracks = Array.from({ length: 1001 }, (_, index) => ({
      ...catalogue[0],
      id: `studio:synthetic-${index}`,
    }));
    expect(() =>
      createPortableLibrary({ ...empty(), likes: tracks }),
    ).toThrow();
  });
});
