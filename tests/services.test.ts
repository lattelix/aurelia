import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createDatabase,
  migrate,
  migrations,
  saveTrack,
  addToPlaylist,
  createPlaylist,
  getLibrary,
  type Database,
} from "@aurelia/database";
import {
  registerAccount,
  loginAccount,
  resolveIdentity,
  createSession,
  sessionAccount,
  hashToken,
  rateLimit,
} from "@aurelia/auth";
import { catalogue } from "@aurelia/music";
let db: Database;
let userId: string;
let otherId: string;
beforeAll(async () => {
  db = await createDatabase({ memory: true });
  userId = (
    await registerAccount(db, {
      name: "Alex",
      email: "alex@example.test",
      password: "correct horse battery staple",
    })
  ).id;
  otherId = (
    await registerAccount(db, {
      name: "Other",
      email: "other@example.test",
      password: "another strong password",
    })
  ).id;
});
afterAll(async () => db.close());
describe("database and account services", () => {
  it("migrates clean PostgreSQL and is idempotent", async () => {
    await migrate(db);
    const rows = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM schema_migration",
    );
    expect(rows[0].count).toBe(migrations.length);
  });
  it("authenticates hashed passwords and rejects invalid credentials", async () => {
    expect(
      (
        await loginAccount(
          db,
          "ALEX@example.test",
          "correct horse battery staple",
        )
      ).id,
    ).toBe(userId);
    await expect(
      loginAccount(db, "alex@example.test", "incorrect long password"),
    ).rejects.toThrow("incorrect");
  });
  it("stores hashed sessions and revokes them", async () => {
    const token = await createSession(db, userId);
    expect((await sessionAccount(db, token))?.id).toBe(userId);
    await db.query("DELETE FROM session WHERE token_hash=$1", [
      hashToken(token),
    ]);
    expect(await sessionAccount(db, token)).toBeNull();
  });
  it("links Telegram and Google to the same existing account", async () => {
    const telegram = await resolveIdentity(
      db,
      "telegram",
      "tg-1",
      { name: "Alex" },
      userId,
    );
    const google = await resolveIdentity(
      db,
      "google",
      "google-1",
      { name: "Alex", email: "verified@example.test" },
      userId,
    );
    expect(telegram.id).toBe(userId);
    expect(google.id).toBe(userId);
    expect(google.identities).toContain("telegram");
    await expect(
      resolveIdentity(db, "google", "google-1", { name: "Other" }, otherId),
    ).rejects.toThrow("another account");
  });
  it("never merges identities based on an email alone", async () => {
    await expect(
      resolveIdentity(
        db,
        "apple",
        "apple-1",
        { name: "Other", email: "alex@example.test" },
        null,
      ),
    ).rejects.toThrow("existing account");
  });
  it("persists playlists and prevents unauthorized writes", async () => {
    const id = await createPlaylist(db, userId, "My queue");
    await addToPlaylist(db, userId, id, catalogue[0]);
    await addToPlaylist(db, userId, id, catalogue[0]);
    const library = await getLibrary(db, userId);
    expect(library.playlists[0].tracks).toHaveLength(1);
    await expect(addToPlaylist(db, otherId, id, catalogue[1])).rejects.toThrow(
      "not found",
    );
    expect((await getLibrary(db, otherId)).playlists).toHaveLength(0);
  });
  it("shares track references without sharing user likes", async () => {
    await saveTrack(db, catalogue[1]);
    await db.query("INSERT INTO liked_track(user_id,track_id) VALUES($1,$2)", [
      userId,
      catalogue[1].id,
    ]);
    expect((await getLibrary(db, userId)).likes).toHaveLength(1);
    expect((await getLibrary(db, otherId)).likes).toHaveLength(0);
  });
  it("rolls back failed transactions", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO artist_reference(id,name) VALUES($1,$2)", [
          "rollback",
          "Rollback",
        ]);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(
      await db.query("SELECT id FROM artist_reference WHERE id=$1", [
        "rollback",
      ]),
    ).toHaveLength(0);
  });
  it("enforces durable rate limits", async () => {
    await rateLimit(db, "test-key", 1);
    await expect(rateLimit(db, "test-key", 1)).rejects.toThrow("Too many");
  });
  it("account deletion cascades across personal data", async () => {
    await db.query("DELETE FROM app_user WHERE id=$1", [userId]);
    expect(
      await db.query("SELECT * FROM identity WHERE user_id=$1", [userId]),
    ).toHaveLength(0);
    expect(
      await db.query("SELECT * FROM playlist WHERE user_id=$1", [userId]),
    ).toHaveLength(0);
    expect(
      await db.query("SELECT * FROM liked_track WHERE user_id=$1", [userId]),
    ).toHaveLength(0);
  });
});
