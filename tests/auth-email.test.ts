import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createDatabase, type Database } from "@aurelia/database";
import {
  approveDeviceGrant, completeEmailAuthChallenge, createDeviceGrant,
  createEmailAuthChallenge, createSession, createSessionFromWebSession, discoverEmail,
  getEmailLoginSecurity, hashToken, loginAccount, markEmailAuthChallengeDelivery,
  recentSessionAccount, redeemDeviceGrant, registerAccount, resendEmailAuthChallenge,
  resolveIdentity, sessionAccount, validateWebSessionHash,
  type CreatedEmailAuthChallenge, type EmailAuthPurpose,
} from "@aurelia/auth";
import { migrations } from "../packages/database/src/migrations";

let db: Database;
const pepper = "synthetic-email-otp-pepper-not-a-production-secret";
const binding = "synthetic-browser-binding-".repeat(2);
const password = "synthetic-only-long-passphrase";
const verifier = "synthetic-pkce-verifier-".repeat(3);
const codeChallenge = createHash("sha256").update(verifier).digest("base64url");

const local = () => registerAccount(db, { name: "Fixture", email: `${randomUUID()}@example.test`, password });
const create = (userId: string, purpose: EmailAuthPurpose, webSessionToken?: string) =>
  createEmailAuthChallenge(db, { userId, purpose, webSessionToken, binding, pepper });
const delivered = async (challenge: CreatedEmailAuthChallenge) => {
  expect(await markEmailAuthChallengeDelivery(db, { challengeToken: challenge.challengeToken, delivered: true })).toBe(true);
  return challenge;
};
const complete = (challenge: CreatedEmailAuthChallenge, purpose: EmailAuthPurpose, webSessionToken?: string) =>
  completeEmailAuthChallenge(db, { challengeToken: challenge.challengeToken, code: challenge.code,
    purpose, binding, pepper, webSessionToken });
async function protectedAccount() {
  const user = await local();
  const token = await createSession(db, user.id);
  const challenge = await delivered(await create(user.id, "enable", token));
  expect((await complete(challenge, "enable", token)).status).toBe("approved");
  return { user, token };
}

beforeAll(async () => { db = await createDatabase({ memory: true }); });
beforeEach(async () => { await db.query("DELETE FROM app_user"); });
afterAll(async () => { await db.close(); });

describe("email security migration and discovery", () => {
  it("keeps the SQL mirror exact and upgrades existing sessions without fabricating verification", async () => {
    const mirror = readFileSync(new URL("../packages/database/migrations/003_email_login.sql", import.meta.url), "utf8");
    expect(mirror.split("\n").slice(1).join("\n").trim()).toBe(migrations[2].sql.trim());
    const old = new PGlite();
    try {
      await old.exec(migrations[0].sql);
      await old.exec(migrations[1].sql);
      await old.query("INSERT INTO app_user(id,name,email) VALUES('legacy','Fixture','legacy@example.test')");
      await old.query("INSERT INTO session(token_hash,user_id,expires_at) VALUES('fixture','legacy',now()+INTERVAL '1 day')");
      await old.exec(migrations[2].sql);
      expect((await old.query("SELECT email_code_verified,security_version FROM session")).rows)
        .toEqual([{ email_code_verified: false, security_version: 0 }]);
      expect((await old.query("SELECT * FROM email_login_security")).rows).toEqual([]);
    } finally { await old.close(); }
  });

  it("discovers the requested branch only, without creating users or exposing provider identities", async () => {
    expect(await discoverEmail(db, " new@example.test ")).toEqual({ step: "register" });
    const user = await local();
    expect(await discoverEmail(db, ` ${user.email!.toUpperCase()} `)).toEqual({ step: "password" });
    await resolveIdentity(db, "google", "fixture-google", { name: "Fixture", email: "social@example.test" }, null);
    expect(await discoverEmail(db, "social@example.test")).toEqual({ step: "provider" });
    expect((await db.query("SELECT id FROM app_user")).length).toBe(2);
    await expect(discoverEmail(db, "not-an-email")).rejects.toMatchObject({ status: 400 });
    expect(await getEmailLoginSecurity(db, user.id)).toEqual({ enabled: false, verifiedEmail: null });
  });
});

describe("delivered, bound, one-use email proof", () => {
  it("requires actual delivery plus code proof before verifying an address or enabling the policy", async () => {
    const user = await local();
    const token = await createSession(db, user.id);
    const challenge = await create(user.id, "enable", token);
    expect(challenge.code).toMatch(/^\d{6}$/);
    expect(challenge.expiresIn).toBe(300);
    expect(challenge.resendAfter).toBe(60);
    expect(await complete(challenge, "enable", token)).toEqual({ status: "delivery_required" });
    expect(await getEmailLoginSecurity(db, user.id)).toEqual({ enabled: false, verifiedEmail: null });
    await delivered(challenge);
    expect(await getEmailLoginSecurity(db, user.id)).toEqual({ enabled: false, verifiedEmail: null });
    const result = await complete(challenge, "enable", token);
    expect(result).toMatchObject({ status: "approved", user: { id: user.id }, security: { enabled: true, verifiedEmail: user.email } });
    expect(result).not.toHaveProperty("token");
    expect(await complete(challenge, "enable", token)).toEqual({ status: "invalid" });
  });

  it("makes failed delivery terminal and never enables or verifies the account", async () => {
    const user = await local();
    const token = await createSession(db, user.id);
    const challenge = await create(user.id, "enable", token);
    expect(await markEmailAuthChallengeDelivery(db, { challengeToken: challenge.challengeToken, delivered: false })).toBe(true);
    expect(await markEmailAuthChallengeDelivery(db, { challengeToken: challenge.challengeToken, delivered: true })).toBe(false);
    expect(await complete(challenge, "enable", token)).toEqual({ status: "delivery_required" });
    expect(await getEmailLoginSecurity(db, user.id)).toEqual({ enabled: false, verifiedEmail: null });
  });

  it("stores only HMAC code digests and hashes of browser/challenge/session secrets", async () => {
    const user = await local();
    const token = await createSession(db, user.id);
    const challenge = await create(user.id, "email-verify", token);
    const [row] = await db.query<Record<string, unknown>>("SELECT * FROM email_auth_challenge");
    for (const field of ["token_hash", "binding_hash", "session_hash", "code_hash"])
      expect(row[field]).toMatch(/^[a-f0-9]{64}$/);
    expect(row.code_hash).not.toBe(hashToken(challenge.code));
    const serialized = JSON.stringify(row);
    for (const secret of [challenge.challengeToken, binding, token, pepper]) expect(serialized).not.toContain(secret);
    await expect(createEmailAuthChallenge(db, { userId: user.id, purpose: "enable", binding, pepper: "short", webSessionToken: token }))
      .rejects.toMatchObject({ status: 503, message: "Email authentication is unavailable" });
  });

  it("rejects wrong purpose, browser, owner and session without consuming the valid proof", async () => {
    const user = await local();
    const token = await createSession(db, user.id);
    const second = await createSession(db, user.id);
    const challenge = await delivered(await create(user.id, "email-verify", token));
    const input = { challengeToken: challenge.challengeToken, code: challenge.code, purpose: "email-verify" as const, binding, pepper, webSessionToken: token };
    for (const change of [{ purpose: "enable" as const }, { binding: "different-browser-".repeat(3) },
      { userId: "not-the-owner" }, { webSessionToken: second }])
      expect(await completeEmailAuthChallenge(db, { ...input, ...change })).toEqual({ status: "invalid" });
    expect((await complete(challenge, "email-verify", token)).status).toBe("approved");
    expect(await getEmailLoginSecurity(db, user.id)).toEqual({ enabled: false, verifiedEmail: user.email });
    expect(await sessionAccount(db, second)).toMatchObject({ id: user.id });
  });

  it("commits five failed attempts and rejects even the correct code after exhaustion", async () => {
    const { user, token } = await protectedAccount();
    const challenge = await delivered(await create(user.id, "login"));
    const wrong = challenge.code === "000000" ? "000001" : "000000";
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await completeEmailAuthChallenge(db, { challengeToken: challenge.challengeToken,
        code: wrong, purpose: "login", binding, pepper })).toEqual({ status: attempt === 5 ? "locked" : "invalid" });
    }
    expect(await complete(challenge, "login")).toEqual({ status: "locked" });
    expect((await db.query<{ attempts: number }>("SELECT attempts FROM email_auth_challenge WHERE token_hash=$1", [hashToken(challenge.challengeToken)]))[0].attempts).toBe(5);
    expect((await db.query("SELECT token_hash FROM session")).length).toBe(1);
    expect(await sessionAccount(db, token)).toMatchObject({ id: user.id });
  });

  it("treats malformed codes and a changed pepper as failed proof without leaking code details", async () => {
    const { user } = await protectedAccount();
    const challenge = await delivered(await create(user.id, "login"));
    expect(await completeEmailAuthChallenge(db, { challengeToken: challenge.challengeToken,
      code: "not-six-digits", purpose: "login", binding, pepper })).toEqual({ status: "invalid" });
    expect(await completeEmailAuthChallenge(db, { challengeToken: challenge.challengeToken,
      code: challenge.code, purpose: "login", binding, pepper: `${pepper}-different` })).toEqual({ status: "invalid" });
    expect((await complete(challenge, "login")).status).toBe("approved");
  });

  it("rejects expired proof without creating a session", async () => {
    const { user } = await protectedAccount();
    const challenge = await delivered(await create(user.id, "login"));
    await db.query("UPDATE email_auth_challenge SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE token_hash=$1", [hashToken(challenge.challengeToken)]);
    expect(await complete(challenge, "login")).toEqual({ status: "expired" });
    expect(await markEmailAuthChallengeDelivery(db, { challengeToken: challenge.challengeToken, delivered: true })).toBe(false);
    expect((await db.query("SELECT token_hash FROM session")).length).toBe(1);
  });

  it("enforces cooldown across browsers, invalidates old codes on resend, and retains the original expiry", async () => {
    const { user } = await protectedAccount();
    const original = await delivered(await create(user.id, "login"));
    await expect(createEmailAuthChallenge(db, { userId: user.id, purpose: "login", binding: `${binding}-other`, pepper }))
      .rejects.toMatchObject({ status: 429 });
    await expect(resendEmailAuthChallenge(db, { challengeToken: original.challengeToken, binding, pepper }))
      .rejects.toMatchObject({ status: 429 });
    await db.query("UPDATE email_auth_challenge SET created_at=clock_timestamp()-INTERVAL '61 seconds',expires_at=clock_timestamp()+INTERVAL '2 minutes' WHERE token_hash=$1", [hashToken(original.challengeToken)]);
    const replacement = await resendEmailAuthChallenge(db, { challengeToken: original.challengeToken, binding, pepper });
    expect(replacement.challengeToken).not.toBe(original.challengeToken);
    expect(replacement.expiresIn).toBeGreaterThan(0);
    expect(replacement.expiresIn).toBeLessThanOrEqual(120);
    expect(await complete(original, "login")).toEqual({ status: "invalid" });
    await delivered(replacement);
    expect((await complete(replacement, "login")).status).toBe("approved");
    await expect(resendEmailAuthChallenge(db, { challengeToken: replacement.challengeToken, binding, pepper }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("preserves failed attempts across resends and refuses exhausted proof", async () => {
    const { user } = await protectedAccount();
    const first = await delivered(await create(user.id, "login"));
    const wrong = first.code === "000000" ? "000001" : "000000";
    expect(await completeEmailAuthChallenge(db, { challengeToken: first.challengeToken,
      code: wrong, purpose: "login", binding, pepper })).toEqual({ status: "invalid" });
    await db.query("UPDATE email_auth_challenge SET created_at=clock_timestamp()-INTERVAL '61 seconds' WHERE token_hash=$1", [hashToken(first.challengeToken)]);
    const next = await delivered(await resendEmailAuthChallenge(db, { challengeToken: first.challengeToken, binding, pepper }));
    expect((await db.query<{ attempts: number }>("SELECT attempts FROM email_auth_challenge WHERE token_hash=$1", [hashToken(next.challengeToken)]))[0].attempts).toBe(1);
    await db.query("UPDATE email_auth_challenge SET attempts=5,created_at=clock_timestamp()-INTERVAL '61 seconds' WHERE token_hash=$1", [hashToken(next.challengeToken)]);
    await expect(resendEmailAuthChallenge(db, { challengeToken: next.challengeToken, binding, pepper })).rejects.toMatchObject({ status: 429 });
    expect(await complete(next, "login")).toEqual({ status: "locked" });
  });

  it("enforces a committed account failure budget across fresh first-factor challenges", async () => {
    const { user } = await protectedAccount();
    const challenge = await delivered(await create(user.id, "login"));
    await db.query("UPDATE email_login_security SET failed_attempts=19,failure_window_started_at=clock_timestamp() WHERE user_id=$1", [user.id]);
    const wrong = challenge.code === "000000" ? "000001" : "000000";
    expect(await completeEmailAuthChallenge(db, { challengeToken: challenge.challengeToken,
      code: wrong, purpose: "login", binding, pepper })).toEqual({ status: "locked" });
    expect(await complete(challenge, "login")).toEqual({ status: "locked" });
    await expect(create(user.id, "login")).rejects.toMatchObject({ status: 429 });
    expect((await db.query<{ failed_attempts: number }>("SELECT failed_attempts FROM email_login_security WHERE user_id=$1", [user.id]))[0].failed_attempts).toBe(20);
    await db.query("UPDATE email_login_security SET failure_window_started_at=clock_timestamp()-INTERVAL '16 minutes' WHERE user_id=$1", [user.id]);
    expect((await complete(challenge, "login")).status).toBe("approved");
    expect((await db.query<{ failed_attempts: number }>("SELECT failed_attempts FROM email_login_security WHERE user_id=$1", [user.id]))[0].failed_attempts).toBe(0);
  });
});

describe("policy assurance, session issuance and revocation", () => {
  it("blocks direct web/native session issuance after password or OAuth first-factor success", async () => {
    const { user } = await protectedAccount();
    expect((await loginAccount(db, user.email!, password)).id).toBe(user.id);
    await resolveIdentity(db, "google", "linked-fixture", { name: "Fixture", email: user.email! }, user.id);
    expect((await resolveIdentity(db, "google", "linked-fixture", { name: "Fixture", email: user.email! }, null)).id).toBe(user.id);
    await expect(createSession(db, user.id)).rejects.toMatchObject({ status: 403, message: "email_challenge_required" });
    await expect(createSession(db, user.id, { transport: "native" })).rejects.toMatchObject({ status: 403 });
    expect((await db.query("SELECT token_hash FROM session")).length).toBe(1);
  });

  it("atomically consumes login proof once, issues an assured web-only token and revokes the previous browser identity", async () => {
    const { user } = await protectedAccount();
    const other = await local();
    const previous = await createSession(db, other.id);
    await db.query("INSERT INTO oauth_flow(state_hash,provider,verifier,nonce,browser_hash,auth_session_hash,user_id,expires_at,intent) VALUES('pending-link','apple','fixture','fixture','fixture',$1,$2,now()+INTERVAL '5 minutes','link')", [hashToken(previous), other.id]);
    const challenge = await delivered(await create(user.id, "login"));
    const input = { challengeToken: challenge.challengeToken, code: challenge.code, purpose: "login" as const,
      binding, pepper, previousWebSessionHash: hashToken(previous) };
    const results = await Promise.all([completeEmailAuthChallenge(db, input), completeEmailAuthChallenge(db, input)]);
    expect(results.map((result) => result.status).sort()).toEqual(["approved", "invalid"]);
    const success = results.find((result) => result.status === "approved");
    expect(success?.status).toBe("approved");
    if (success?.status !== "approved" || !success.token) throw new Error("Expected an issued web token");
    expect(await sessionAccount(db, success.token)).toMatchObject({ id: user.id });
    expect(await sessionAccount(db, success.token, "native")).toBeNull();
    expect(await sessionAccount(db, previous)).toBeNull();
    expect(await db.query("SELECT state_hash FROM oauth_flow WHERE state_hash='pending-link'")).toEqual([]);
  });

  it("enabling retains and elevates only the current web session, revoking other devices and approvals", async () => {
    const user = await local();
    const current = await createSession(db, user.id);
    const oldWeb = await createSession(db, user.id);
    const oldNative = await createSession(db, user.id, { transport: "native" });
    const grant = await createDeviceGrant(db, { codeChallenge, deviceName: "Fixture" });
    await approveDeviceGrant(db, user.id, grant.userCode);
    const challenge = await delivered(await create(user.id, "enable", current));
    expect((await complete(challenge, "enable", current)).status).toBe("approved");
    expect(await sessionAccount(db, current)).toMatchObject({ id: user.id });
    expect(await recentSessionAccount(db, current)).toMatchObject({ id: user.id });
    expect(await sessionAccount(db, oldWeb)).toBeNull();
    expect(await sessionAccount(db, oldNative, "native")).toBeNull();
    await expect(redeemDeviceGrant(db, { deviceCode: grant.deviceCode, codeVerifier: verifier })).rejects.toMatchObject({ status: 400 });
    expect(await db.query("SELECT email_code_verified,security_version FROM session WHERE token_hash=$1", [hashToken(current)]))
      .toEqual([{ email_code_verified: true, security_version: 1 }]);
    // Other rows remain until cleanup; policy version invalidation avoids cross-session locks.
    expect((await db.query("SELECT token_hash FROM session")).length).toBe(3);
  });

  it("rejects unassured or stale-version protected sessions in both normal and recent authentication", async () => {
    const { user, token } = await protectedAccount();
    for (const state of ["email_code_verified=false", "email_code_verified=true,security_version=0"]) {
      await db.query(`UPDATE session SET ${state} WHERE token_hash=$1`, [hashToken(token)]);
      expect(await sessionAccount(db, token)).toBeNull();
      expect(await recentSessionAccount(db, token)).toBeNull();
      expect(await validateWebSessionHash(db, { hash: hashToken(token), userId: user.id })).toBe(false);
    }
  });

  it("requires the exact live recent web session to create and complete policy changes", async () => {
    const user = await local();
    const web = await createSession(db, user.id);
    const native = await createSession(db, user.id, { transport: "native" });
    await expect(create(user.id, "enable", native)).rejects.toMatchObject({ status: 401 });
    const challenge = await delivered(await create(user.id, "enable", web));
    await db.query("DELETE FROM session WHERE token_hash=$1", [hashToken(web)]);
    expect(await complete(challenge, "enable", web)).toEqual({ status: "session_required" });
    expect(await getEmailLoginSecurity(db, user.id)).toEqual({ enabled: false, verifiedEmail: null });
    const old = await createSession(db, user.id);
    await db.query("UPDATE session SET created_at=now()-INTERVAL '11 minutes' WHERE token_hash=$1", [hashToken(old)]);
    await expect(create(user.id, "email-verify", old)).rejects.toMatchObject({ status: 401 });
  });

  it("requires delivered email proof to disable and revokes the other assured sessions", async () => {
    const { user, token } = await protectedAccount();
    const login = await delivered(await create(user.id, "login"));
    const loginResult = await complete(login, "login");
    if (loginResult.status !== "approved" || !loginResult.token) throw new Error("Expected a login token");
    const grant = await createDeviceGrant(db, { codeChallenge, deviceName: "Fixture" });
    await approveDeviceGrant(db, user.id, grant.userCode, { webSessionHash: hashToken(token) });
    const native = await redeemDeviceGrant(db, { deviceCode: grant.deviceCode, codeVerifier: verifier });
    if (native.status !== "approved") throw new Error("Expected an approved native session");
    const challenge = await create(user.id, "disable", token);
    expect(await complete(challenge, "disable", token)).toEqual({ status: "delivery_required" });
    expect((await getEmailLoginSecurity(db, user.id)).enabled).toBe(true);
    await delivered(challenge);
    expect((await complete(challenge, "disable", token)).status).toBe("approved");
    expect(await sessionAccount(db, loginResult.token)).toBeNull();
    expect(await recentSessionAccount(db, loginResult.token)).toBeNull();
    expect(await validateWebSessionHash(db, { hash: hashToken(loginResult.token), userId: user.id })).toBe(false);
    expect(await sessionAccount(db, native.token, "native")).toBeNull();
    expect(await recentSessionAccount(db, native.token, "native")).toBeNull();
    expect(await sessionAccount(db, token)).toMatchObject({ id: user.id });
    expect(await getEmailLoginSecurity(db, user.id)).toEqual({ enabled: false, verifiedEmail: user.email });
    expect(await createSession(db, user.id)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rotates only the same account's live recent web session with inherited assurance", async () => {
    const { user, token } = await protectedAccount();
    const other = await local();
    await expect(createSessionFromWebSession(db, { userId: other.id, previousHash: hashToken(token) })).rejects.toMatchObject({ status: 401 });
    const replacement = await createSessionFromWebSession(db, { userId: user.id, previousHash: hashToken(token) });
    expect(await sessionAccount(db, token)).toBeNull();
    expect(await sessionAccount(db, replacement)).toMatchObject({ id: user.id });
    await expect(createSessionFromWebSession(db, { userId: user.id, previousHash: hashToken(token) })).rejects.toMatchObject({ status: 401 });
    await db.query("UPDATE session SET created_at=now()-INTERVAL '11 minutes' WHERE token_hash=$1", [hashToken(replacement)]);
    await expect(createSessionFromWebSession(db, { userId: user.id, previousHash: hashToken(replacement) })).rejects.toMatchObject({ status: 401 });
  });

  it("redeems newly approved native grants without a second email step and stamps current policy assurance", async () => {
    const { user, token } = await protectedAccount();
    const grant = await createDeviceGrant(db, { codeChallenge, deviceName: "Fixture" });
    await expect(approveDeviceGrant(db, user.id, grant.userCode)).rejects.toMatchObject({ status: 401 });
    await approveDeviceGrant(db, user.id, grant.userCode, { webSessionHash: hashToken(token) });
    const result = await redeemDeviceGrant(db, { deviceCode: grant.deviceCode, codeVerifier: verifier });
    expect(result.status).toBe("approved");
    if (result.status !== "approved") throw new Error("Expected native token");
    expect(await sessionAccount(db, result.token, "native")).toMatchObject({ id: user.id });
    expect(await sessionAccount(db, result.token)).toBeNull();
    expect(await db.query("SELECT email_code_verified,security_version FROM session WHERE token_hash=$1", [hashToken(result.token)]))
      .toEqual([{ email_code_verified: true, security_version: 1 }]);
    await expect(createSessionFromWebSession(db, { userId: user.id, previousHash: hashToken(result.token) })).rejects.toMatchObject({ status: 401 });
  });

  it("does not let unassured, stale or native sessions approve protected device grants", async () => {
    const { user, token } = await protectedAccount();
    const grant = await createDeviceGrant(db, { codeChallenge, deviceName: "Fixture" });
    for (const state of ["email_code_verified=false", "email_code_verified=true,security_version=0",
      "email_code_verified=true,security_version=1,transport='native'", "transport='web',created_at=clock_timestamp()-INTERVAL '11 minutes'"]) {
      await db.query(`UPDATE session SET ${state} WHERE token_hash=$1`, [hashToken(token)]);
      await expect(approveDeviceGrant(db, user.id, grant.userCode, { webSessionHash: hashToken(token) })).rejects.toMatchObject({ status: 401 });
    }
    expect((await db.query("SELECT status FROM native_device_grant"))[0]).toEqual({ status: "pending" });
  });

  it("rejects device grant assurance that differs from the current policy version", async () => {
    const { user, token } = await protectedAccount();
    const grant = await createDeviceGrant(db, { codeChallenge, deviceName: "Fixture" });
    await approveDeviceGrant(db, user.id, grant.userCode, { webSessionHash: hashToken(token) });
    await db.query("UPDATE native_device_grant SET security_version=0 WHERE user_id=$1", [user.id]);
    await expect(redeemDeviceGrant(db, { deviceCode: grant.deviceCode, codeVerifier: verifier })).rejects.toMatchObject({ status: 400 });
    expect((await db.query("SELECT token_hash FROM session")).length).toBe(1);
  });

  it("rejects challenges after address or policy version changes rather than issuing stale authority", async () => {
    const { user } = await protectedAccount();
    const challenge = await delivered(await create(user.id, "login"));
    await db.query("UPDATE email_login_security SET version=version+1 WHERE user_id=$1", [user.id]);
    expect(await complete(challenge, "login")).toEqual({ status: "stale" });
    await db.query("UPDATE email_login_security SET version=version-1 WHERE user_id=$1", [user.id]);
    await db.query("UPDATE app_user SET email='changed@example.test' WHERE id=$1", [user.id]);
    expect(await complete(challenge, "login")).toEqual({ status: "stale" });
  });
});
