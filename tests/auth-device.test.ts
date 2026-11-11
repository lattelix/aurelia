import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createDatabase, createPlaylist, getLibrary, type Database } from "@aurelia/database";
import {
  approveDeviceGrant, attachLocalCredential, createDeviceGrant, createSession,
  getDeviceGrantForApproval, hashToken, loginAccount, recentSessionAccount,
  redeemDeviceGrant, registerAccount, resolveIdentity, sessionAccount,
} from "@aurelia/auth";
import { migrations } from "../packages/database/src/migrations";

let db: Database;
const password = "synthetic-only-long-passphrase";
const verifier = "fixture-pkce-verifier-".repeat(3);
const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
const newGrant = () => createDeviceGrant(db, { codeChallenge, deviceName: "Synthetic QA device" });
const social = (provider = "telegram", email?: string) => resolveIdentity(db, provider,
  `${provider}-${randomUUID()}`, { name: "Synthetic account", ...(email ? { email } : {}) }, null);
const redeem = (deviceCode: string, codeVerifier = verifier) => redeemDeviceGrant(db, { deviceCode, codeVerifier });

beforeAll(async () => { db = await createDatabase({ memory: true }); });
beforeEach(async () => {
  await db.query("DELETE FROM app_user");
  await db.query("DELETE FROM native_device_grant");
  await db.query("DELETE FROM rate_limit");
});
afterAll(async () => db.close());

describe("migration and transport-bound session recency", () => {
  it("upgrades old rows without turning them into recent sessions", async () => {
    const legacy = new PGlite();
    try {
      await legacy.exec(migrations[0].sql);
      await legacy.query("INSERT INTO app_user(id,name) VALUES($1,$2)", ["legacy", "Fixture"]);
      await legacy.query("INSERT INTO session(token_hash,user_id,expires_at) VALUES($1,$2,now()+INTERVAL '1 day')",
        [hashToken("legacy-token"), "legacy"]);
      for (const [provider, owner] of [["google", "legacy"], ["apple", null], ["spotify", "legacy"]]) {
        await legacy.query("INSERT INTO oauth_flow(state_hash,provider,verifier,nonce,browser_hash,user_id,expires_at) VALUES($1,$2,'fixture','fixture','fixture',$3,now()+INTERVAL '1 minute')",
          [provider, provider, owner]);
      }
      await legacy.exec(migrations[1].sql);
      const previous = await legacy.query<{ transport: string; created_at: Date }>(
        "SELECT transport,created_at FROM session WHERE token_hash=$1", [hashToken("legacy-token")]);
      expect(previous.rows[0].transport).toBe("web");
      expect(new Date(previous.rows[0].created_at).getTime()).toBe(0);
      const flows = await legacy.query("SELECT provider,intent,return_path FROM oauth_flow ORDER BY provider");
      expect(flows.rows).toEqual([
        { provider: "apple", intent: "login", return_path: "/account" },
        { provider: "google", intent: "link", return_path: "/account" },
        { provider: "spotify", intent: "import", return_path: "/import" },
      ]);
      await legacy.query("INSERT INTO session(token_hash,user_id,expires_at) VALUES($1,$2,now()+INTERVAL '1 day')",
        [hashToken("new-token"), "legacy"]);
      const recent = await legacy.query<{ recent: boolean }>(
        "SELECT created_at>now()-INTERVAL '1 minute' AS recent FROM session WHERE token_hash=$1", [hashToken("new-token")]);
      expect(recent.rows[0].recent).toBe(true);
    } finally { await legacy.close(); }
  });

  it("keeps the new migration SQL mirror exact", () => {
    const mirror = readFileSync(new URL("../packages/database/migrations/002_identity_device.sql", import.meta.url), "utf8");
    expect(mirror.split("\n").slice(1).join("\n").trim()).toBe(migrations[1].sql.trim());
  });

  it("isolates native tokens from web cookies and web tokens from native bearer auth", async () => {
    const user = await social();
    const web = await createSession(db, user.id);
    const native = await createSession(db, user.id, { transport: "native" });
    expect((await sessionAccount(db, web))?.id).toBe(user.id);
    expect(await sessionAccount(db, native)).toBeNull();
    expect(await sessionAccount(db, web, "native")).toBeNull();
    expect((await sessionAccount(db, native, "native"))?.id).toBe(user.id);
    const stored = await db.query<{ token_hash: string }>("SELECT token_hash FROM session");
    expect(stored.every((row) => row.token_hash.length === 64 && ![web, native].includes(row.token_hash))).toBe(true);
  });

  it("requires live recent creation and the matching transport for sensitive operations", async () => {
    const user = await social();
    const token = await createSession(db, user.id);
    expect((await recentSessionAccount(db, token))?.id).toBe(user.id);
    expect(await recentSessionAccount(db, token, "native")).toBeNull();
    await db.query("UPDATE session SET created_at=now()-INTERVAL '11 minutes' WHERE token_hash=$1", [hashToken(token)]);
    expect(await recentSessionAccount(db, token)).toBeNull();
    expect((await sessionAccount(db, token))?.id).toBe(user.id);
    await db.query("UPDATE session SET created_at='1970-01-01T00:00:00Z' WHERE token_hash=$1", [hashToken(token)]);
    expect(await recentSessionAccount(db, token)).toBeNull();
    await db.query("UPDATE session SET created_at=now()+INTERVAL '1 hour' WHERE token_hash=$1", [hashToken(token)]);
    expect(await recentSessionAccount(db, token)).toBeNull();
    await db.query("UPDATE session SET created_at=now(),expires_at=now()-INTERVAL '1 second' WHERE token_hash=$1", [hashToken(token)]);
    expect(await recentSessionAccount(db, token)).toBeNull();
    await expect(recentSessionAccount(db, token, "web", 601)).rejects.toMatchObject({ status: 400 });
  });
});

describe("one Aurelia account with explicit provider and credential links", () => {
  for (const first of ["telegram", "google", "apple", "local"]) {
    it(`retains user and library when ${first} is first and other social identities are linked`, async () => {
      const email = `${first}@example.test`;
      const user = first === "local"
        ? await registerAccount(db, { name: "Synthetic", email, password })
        : await social(first, first === "telegram" ? undefined : email);
      const playlistId = await createPlaylist(db, user.id, "Synthetic library");
      for (const provider of ["telegram", "google", "apple"].filter((p) => p !== first)) {
        const linked = await resolveIdentity(db, provider, `${provider}-${randomUUID()}`, { name: "Fixture", email }, user.id);
        expect(linked.id).toBe(user.id);
      }
      const rows = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM app_user");
      expect(rows[0].count).toBe(1);
      expect((await getLibrary(db, user.id)).playlists[0].id).toBe(playlistId);
    });
  }

  it("adds a password only after matching verified Google/Apple proof and retains existing data", async () => {
    const user = await social();
    const playlistId = await createPlaylist(db, user.id, "Keep this library");
    await expect(attachLocalCredential(db, user.id, { email: "verified@example.test", password }))
      .rejects.toMatchObject({ status: 403 });
    const linked = await resolveIdentity(db, "google", "proof-google", { name: "Fixture", email: "Verified@Example.test" }, user.id);
    expect(linked.email).toBe("verified@example.test");
    const attached = await attachLocalCredential(db, user.id, { email: "VERIFIED@example.test", password });
    expect(attached.id).toBe(user.id);
    expect(attached.identities).toContain("local");
    expect((await loginAccount(db, "verified@example.test", password)).id).toBe(user.id);
    expect((await getLibrary(db, user.id)).playlists[0].id).toBe(playlistId);
    await expect(attachLocalCredential(db, user.id, { email: "verified@example.test", password }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("accepts matching Apple proof but never substitutes another user's proof", async () => {
    const user = await social("apple", "apple@example.test");
    const other = await social();
    await expect(attachLocalCredential(db, other.id, { email: "apple@example.test", password }))
      .rejects.toMatchObject({ status: 403 });
    expect((await attachLocalCredential(db, user.id, { email: "apple@example.test", password })).id).toBe(user.id);
  });

  it("never auto-merges email collisions or reassigns an existing provider subject", async () => {
    const owner = await registerAccount(db, { name: "Owner", email: "claimed@example.test", password });
    await expect(resolveIdentity(db, "google", "new-subject", { name: "Fixture", email: "claimed@example.test" }, null))
      .rejects.toMatchObject({ status: 409 });
    const target = await social();
    const linked = await resolveIdentity(db, "google", "new-subject", { name: "Fixture", email: "claimed@example.test" }, target.id);
    expect(linked.id).toBe(target.id);
    expect(linked.email).toBeNull();
    await expect(attachLocalCredential(db, target.id, { email: "claimed@example.test", password }))
      .rejects.toMatchObject({ status: 409 });
    await expect(resolveIdentity(db, "google", "new-subject", { name: "Fixture" }, owner.id))
      .rejects.toMatchObject({ status: 409 });
    expect((await loginAccount(db, "claimed@example.test", password)).id).toBe(owner.id);
  });

  it("serializes competing password attachments and does not replace the winner", async () => {
    const user = await social("google", "race@example.test");
    const outcomes = await Promise.allSettled([
      attachLocalCredential(db, user.id, { email: "race@example.test", password }),
      attachLocalCredential(db, user.id, { email: "race@example.test", password: password + "second" }),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await db.query("SELECT subject FROM identity WHERE user_id=$1 AND provider='local'", [user.id]))).toHaveLength(1);
  });

  it("converges concurrent first logins only on an identical verified provider subject", async () => {
    const results = await Promise.all([
      resolveIdentity(db, "google", "same-proven-subject", { name: "Fixture", email: "same@example.test" }, null),
      resolveIdentity(db, "google", "same-proven-subject", { name: "Fixture", email: "same@example.test" }, null),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect(await db.query("SELECT id FROM app_user")).toHaveLength(1);
    await expect(resolveIdentity(db, "apple", "different-subject", { name: "Fixture", email: "same@example.test" }, null))
      .rejects.toMatchObject({ status: 409 });
  });
});

describe("PKCE native device authorization", () => {
  it("stores only hashes of opaque codes and returns only safe approval metadata", async () => {
    const created = await newGrant();
    expect(created.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(created).toMatchObject({ expiresIn: 600, interval: 3 });
    const rows = await db.query("SELECT * FROM native_device_grant");
    const encoded = JSON.stringify(rows);
    expect(encoded).not.toContain(created.deviceCode);
    expect(encoded).not.toContain(created.userCode);
    expect(encoded).not.toContain(verifier);
    expect(rows[0].device_code_hash).toBe(hashToken(created.deviceCode));
    expect(rows[0].user_code_hash).toBe(hashToken(created.userCode.replace("-", "")));
    const safe = await getDeviceGrantForApproval(db, created.userCode.toLowerCase());
    expect(Object.keys(safe).sort()).toEqual(["deviceName", "expiresAt", "status", "userCode"]);
    expect(safe).toMatchObject({ deviceName: "Synthetic QA device", status: "pending", userCode: created.userCode });
  });

  it("rejects malformed challenges/verifiers and requires PKCE even while pending", async () => {
    await expect(createDeviceGrant(db, { codeChallenge: "bad", deviceName: "Fixture" })).rejects.toMatchObject({ status: 400 });
    await expect(createDeviceGrant(db, { codeChallenge, deviceName: "\n" })).rejects.toMatchObject({ status: 400 });
    const created = await newGrant();
    await expect(redeem(created.deviceCode, "bad")).rejects.toMatchObject({ status: 400 });
    await expect(redeem(created.deviceCode, "w".repeat(64))).rejects.toMatchObject({ message: "invalid_grant" });
    expect(await redeem(created.deviceCode)).toEqual({ status: "pending" });
  });

  it("commits poll backoff and returns no credentials before approval", async () => {
    const created = await newGrant();
    expect(await redeem(created.deviceCode)).toEqual({ status: "pending" });
    await expect(redeem(created.deviceCode)).rejects.toMatchObject({ status: 429, message: "slow_down" });
    const rows = await db.query<{ poll_interval_seconds: number }>("SELECT poll_interval_seconds FROM native_device_grant");
    expect(rows[0].poll_interval_seconds).toBe(8);
    expect(await db.query("SELECT token_hash FROM session")).toHaveLength(0);
    await db.query("UPDATE native_device_grant SET last_poll_at=now()-INTERVAL '2 minutes'");
    expect(await redeem(created.deviceCode)).toEqual({ status: "pending" });
  });

  it("approves once, refuses account reassignment, then atomically redeems one native session", async () => {
    const user = await social();
    const other = await social();
    const created = await newGrant();
    expect((await approveDeviceGrant(db, user.id, created.userCode)).status).toBe("approved");
    expect((await approveDeviceGrant(db, user.id, created.userCode)).status).toBe("approved");
    await expect(approveDeviceGrant(db, other.id, created.userCode)).rejects.toMatchObject({ status: 409 });
    await expect(redeem(created.deviceCode, "w".repeat(64))).rejects.toMatchObject({ message: "invalid_grant" });
    const result = await redeem(created.deviceCode);
    expect(result.status).toBe("approved");
    if (result.status !== "approved") throw new Error("Expected approved synthetic grant");
    expect(result.user.id).toBe(user.id);
    expect(result.expiresIn).toBe(30 * 86400);
    expect(await sessionAccount(db, result.token)).toBeNull();
    expect((await sessionAccount(db, result.token, "native"))?.id).toBe(user.id);
    expect((await recentSessionAccount(db, result.token, "native"))?.id).toBe(user.id);
    await expect(redeem(created.deviceCode)).rejects.toMatchObject({ message: "invalid_grant" });
    await expect(getDeviceGrantForApproval(db, created.userCode)).rejects.toMatchObject({ message: "invalid_grant" });
    expect(await db.query("SELECT token_hash FROM session WHERE transport='native'")).toHaveLength(1);
  });

  it("serializes competing owners and competing redeemers without extra sessions", async () => {
    const first = await social(), second = await social();
    const created = await newGrant();
    const approvals = await Promise.allSettled([
      approveDeviceGrant(db, first.id, created.userCode), approveDeviceGrant(db, second.id, created.userCode),
    ]);
    expect(approvals.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const redemptions = await Promise.allSettled([redeem(created.deviceCode), redeem(created.deviceCode)]);
    expect(redemptions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.query("SELECT token_hash FROM session WHERE transport='native'")).toHaveLength(1);
  });

  it("expires pending/approved grants and purges stale proof material on new authorization", async () => {
    const user = await social();
    const created = await newGrant();
    await approveDeviceGrant(db, user.id, created.userCode);
    await db.query("UPDATE native_device_grant SET expires_at=now()-INTERVAL '1 second'");
    await expect(redeem(created.deviceCode)).rejects.toMatchObject({ message: "expired_token" });
    await expect(getDeviceGrantForApproval(db, created.userCode)).rejects.toMatchObject({ message: "expired_token" });
    await expect(approveDeviceGrant(db, user.id, created.userCode)).rejects.toMatchObject({ message: "expired_token" });
    expect(await db.query("SELECT token_hash FROM session")).toHaveLength(0);
    await newGrant();
    expect(await db.query("SELECT device_code_hash FROM native_device_grant WHERE device_code_hash=$1", [hashToken(created.deviceCode)])).toHaveLength(0);
  });

  it("cascades approved grants when their account is deleted", async () => {
    const user = await social();
    const created = await newGrant();
    await approveDeviceGrant(db, user.id, created.userCode);
    await db.query("DELETE FROM app_user WHERE id=$1", [user.id]);
    expect(await db.query("SELECT device_code_hash FROM native_device_grant")).toHaveLength(0);
    await expect(redeem(created.deviceCode)).rejects.toMatchObject({ message: "invalid_grant" });
  });

  it("rolls back grant consumption if native session creation fails", async () => {
    const user = await social();
    const created = await newGrant();
    await approveDeviceGrant(db, user.id, created.userCode);
    const failing: Database = {
      query: (sql, parameters) => db.query(sql, parameters),
      close: async () => {},
      transaction: (operation) => db.transaction((tx) => operation({
        ...tx,
        query: (sql, parameters) => {
          if (sql.startsWith("INSERT INTO session(")) throw new Error("synthetic-session-write-failure");
          return tx.query(sql, parameters);
        },
      })),
    };
    await expect(redeemDeviceGrant(failing, { deviceCode: created.deviceCode, codeVerifier: verifier }))
      .rejects.toThrow("synthetic-session-write-failure");
    expect((await getDeviceGrantForApproval(db, created.userCode)).status).toBe("approved");
    expect(await db.query("SELECT token_hash FROM session")).toHaveLength(0);
    expect((await redeem(created.deviceCode)).status).toBe("approved");
  });

  it("rejects a grant that expires after its redemption transaction starts", async () => {
    const user = await social();
    const created = await newGrant();
    await approveDeviceGrant(db, user.id, created.userCode);
    await db.query("UPDATE native_device_grant SET expires_at=clock_timestamp()+INTERVAL '100 milliseconds'");
    const delayed: Database = {
      query: (sql, parameters) => db.query(sql, parameters), close: async () => {},
      transaction: (operation) => db.transaction(async (tx) => {
        await tx.query("SELECT now()");
        await new Promise((resolve) => setTimeout(resolve, 150));
        return operation(tx);
      }),
    };
    await expect(redeemDeviceGrant(delayed, { deviceCode: created.deviceCode, codeVerifier: verifier }))
      .rejects.toMatchObject({ message: "expired_token" });
    expect(await db.query("SELECT token_hash FROM session")).toHaveLength(0);
  });
});
