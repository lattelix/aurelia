import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { Database } from "@aurelia/database";
import { AppError, type Account } from "@aurelia/core";
import { issueAuthorizedSession } from "./session-issuer";
const scrypt = promisify(nodeScrypt);
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, key] = stored.split(":");
  if (algorithm !== "scrypt" || !salt || !key) return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(key, "hex");
  return (
    expected.length === derived.length && timingSafeEqual(derived, expected)
  );
}
export async function getAccount(
  db: Database,
  userId: string,
): Promise<Account | null> {
  const rows = await db.query<{
    id: string;
    name: string;
    email: string | null;
  }>("SELECT id,name,email FROM app_user WHERE id=$1", [userId]);
  if (!rows[0]) return null;
  const identities = await db.query<{ provider: string }>(
    "SELECT provider FROM identity WHERE user_id=$1",
    [userId],
  );
  return { ...rows[0], identities: identities.map((x) => x.provider) };
}
export type SessionTransport = "web" | "native";

function validateTransport(transport: SessionTransport) {
  if (transport !== "web" && transport !== "native")
    throw new AppError(400, "Invalid session transport");
}

export async function sessionAccount(
  db: Database,
  token: string | undefined,
  transport: SessionTransport = "web",
): Promise<Account | null> {
  validateTransport(transport);
  if (typeof token !== "string" || !token || token.length > 256) return null;
  const rows = await db.query<{ user_id: string }>(
    "SELECT s.user_id FROM session s LEFT JOIN email_login_security e ON e.user_id=s.user_id WHERE s.token_hash=$1 AND s.transport=$2 AND s.expires_at>clock_timestamp() AND s.security_version=COALESCE(e.version,0) AND (NOT COALESCE(e.enabled,false) OR s.email_code_verified)",
    [hashToken(token), transport],
  );
  return rows[0] ? getAccount(db, rows[0].user_id) : null;
}

/** A live session is not sufficient for sensitive linking: old migrated sessions are never recent. */
export async function recentSessionAccount(
  db: Database,
  token: string | undefined,
  transport: SessionTransport = "web",
  maxAgeSeconds = 600,
): Promise<Account | null> {
  validateTransport(transport);
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 600)
    throw new AppError(400, "Invalid recent-session window");
  if (typeof token !== "string" || !token || token.length > 256) return null;
  const rows = await db.query<{ user_id: string }>(
    "SELECT s.user_id FROM session s LEFT JOIN email_login_security e ON e.user_id=s.user_id WHERE s.token_hash=$1 AND s.transport=$2 AND s.expires_at>clock_timestamp() AND s.created_at>clock_timestamp()-($3::int * INTERVAL '1 second') AND s.created_at<=clock_timestamp() AND s.security_version=COALESCE(e.version,0) AND (NOT COALESCE(e.enabled,false) OR s.email_code_verified)",
    [hashToken(token), transport, maxAgeSeconds],
  );
  return rows[0] ? getAccount(db, rows[0].user_id) : null;
}

export async function createSession(
  db: Database,
  userId: string,
  options?: { transport: SessionTransport },
): Promise<string> {
  const transport = options?.transport ?? "web";
  validateTransport(transport);
  return db.transaction(async (tx) => {
    const users = await tx.query("SELECT id FROM app_user WHERE id=$1 FOR UPDATE", [userId]);
    if (!users.length) throw new AppError(404, "Account not found");
    const security = await tx.query<{ enabled: boolean; version: number }>(
      "SELECT enabled,version FROM email_login_security WHERE user_id=$1", [userId],
    );
    if (security[0]?.enabled) throw new AppError(403, "email_challenge_required");
    return issueAuthorizedSession(tx, userId, transport, security[0]?.version ?? 0, false);
  });
}

/** Check inside the caller's existing session-row lock before a sensitive web operation. */
export async function validateWebSessionHash(
  db: Database, input: { hash: string | null; userId: string; recent?: boolean },
): Promise<boolean> {
  if (typeof input.hash !== "string" || !/^[a-f0-9]{64}$/.test(input.hash)) return false;
  const rows = await db.query(
    "SELECT s.user_id FROM session s LEFT JOIN email_login_security e ON e.user_id=s.user_id WHERE s.token_hash=$1 AND s.user_id=$2 AND s.transport='web' AND s.expires_at>clock_timestamp() AND ($3::boolean=false OR (s.created_at>clock_timestamp()-INTERVAL '10 minutes' AND s.created_at<=clock_timestamp())) AND s.security_version=COALESCE(e.version,0) AND (NOT COALESCE(e.enabled,false) OR s.email_code_verified)",
    [input.hash, input.userId, input.recent ?? false],
  );
  return rows.length === 1;
}

/** Same-account explicit link rotation inherits only a live, recent web session's assurance. */
export async function createSessionFromWebSession(
  db: Database, input: { userId: string; previousHash: string },
): Promise<string> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<{ email_code_verified: boolean }>(
      "SELECT email_code_verified FROM session WHERE token_hash=$1 AND user_id=$2 AND transport='web' FOR UPDATE",
      [input.previousHash, input.userId],
    );
    if (!rows.length) throw new AppError(401, "A recent web session is required");
    await tx.query("SELECT id FROM app_user WHERE id=$1 FOR UPDATE", [input.userId]);
    if (!(await validateWebSessionHash(tx, { hash: input.previousHash, userId: input.userId, recent: true })))
      throw new AppError(401, "A recent web session is required");
    const security = await tx.query<{ version: number }>(
      "SELECT version FROM email_login_security WHERE user_id=$1", [input.userId],
    );
    const token = await issueAuthorizedSession(tx, input.userId, "web", security[0]?.version ?? 0, rows[0].email_code_verified);
    await tx.query("DELETE FROM session WHERE token_hash=$1", [input.previousHash]);
    await tx.query("DELETE FROM oauth_flow WHERE auth_session_hash=$1 AND intent IN ('link','import')", [input.previousHash]);
    return token;
  });
}
export async function registerAccount(
  db: Database,
  input: { name: string; email: string; password: string },
) {
  const email = input.email.toLowerCase();
  const id = randomUUID();
  const digest = await passwordHash(input.password);
  try {
    await db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO app_user(id,name,email,password_hash) VALUES($1,$2,$3,$4)",
        [id, input.name, email, digest],
      );
      await tx.query(
        "INSERT INTO identity(provider,subject,user_id) VALUES($1,$2,$3)",
        ["local", email, id],
      );
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505")
      throw new AppError(
        409,
        "This email is already registered. Sign in to your account.",
      );
    throw e;
  }
  return (await getAccount(db, id))!;
}
export async function loginAccount(
  db: Database,
  email: string,
  password: string,
) {
  const rows = await db.query<{ id: string; password_hash: string | null }>(
    "SELECT id,password_hash FROM app_user WHERE email=$1",
    [email.toLowerCase()],
  );
  const stored = rows[0]?.password_hash;
  // Always run scrypt, including nonexistent accounts, to avoid a timing oracle.
  const valid = await verifyPassword(
    password,
    stored ?? "scrypt:00000000000000000000000000000000:" + "00".repeat(64),
  );
  if (!stored || !valid)
    throw new AppError(401, "Email or password is incorrect");
  return (await getAccount(db, rows[0].id))!;
}
/** profile.email must come exclusively from validated, verified provider claims. */
export async function resolveIdentity(
  db: Database,
  provider: string,
  subject: string,
  profile: { name: string; email?: string },
  linkUserId: string | null,
): Promise<Account> {
  const email = profile.email?.toLowerCase() ?? null;
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    throw new AppError(400, "Invalid verified email");
  try {
    return await db.transaction(async (tx) => {
      const identity = await tx.query<{ user_id: string }>(
        "SELECT user_id FROM identity WHERE provider=$1 AND subject=$2",
        [provider, subject],
      );
      if (identity[0] && linkUserId && identity[0].user_id !== linkUserId)
        throw new AppError(409, "This identity belongs to another account.");
      const userId = identity[0]?.user_id ?? linkUserId ?? randomUUID();
      if (linkUserId) {
        const target = await tx.query<{ id: string }>(
          "SELECT id FROM app_user WHERE id=$1 FOR UPDATE", [linkUserId],
        );
        if (!target.length) throw new AppError(404, "Account not found");
      }
      if (!identity.length && !linkUserId) {
        if (email) {
          const existing = await tx.query("SELECT id FROM app_user WHERE email=$1", [email]);
          if (existing.length) throw new AppError(409,
            "Sign in to your existing account, then link this provider from Account.");
        }
        await tx.query("INSERT INTO app_user(id,name,email) VALUES($1,$2,$3)", [userId, profile.name, email]);
      }
      if (identity.length) {
        // Preserve established subject ownership; only verified claims may refresh this field.
        if (email && provider !== "local") await tx.query(
          "UPDATE identity SET verified_email=$3 WHERE provider=$1 AND subject=$2 AND user_id=$4",
          [provider, subject, email, userId],
        );
      } else {
        await tx.query("INSERT INTO identity(provider,subject,user_id,verified_email) VALUES($1,$2,$3,$4)",
          [provider, subject, userId, provider === "local" ? null : email]);
      }
      if (linkUserId && email && provider !== "local") {
        // An address conflict never transfers ownership or merges libraries.
        await tx.query(
          "UPDATE app_user SET email=$2 WHERE id=$1 AND email IS NULL AND NOT EXISTS(SELECT 1 FROM app_user WHERE email=$2)",
          [userId, email],
        );
      }
      return (await getAccount(tx, userId))!;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      // Concurrent first logins for the same proven subject converge on its one owner.
      // A matching email without that exact identity is never sufficient.
      const existing = await db.query<{ user_id: string }>(
        "SELECT user_id FROM identity WHERE provider=$1 AND subject=$2", [provider, subject],
      );
      if (existing[0] && (!linkUserId || existing[0].user_id === linkUserId)) {
        const user = await getAccount(db, existing[0].user_id);
        if (user) return user;
      }
      throw new AppError(409, "This identity or email is already linked. Sign in and try again.");
    }
    throw error;
  }
}

/** Attach credentials to the authenticated account; does not create or merge app users. */
export async function attachLocalCredential(
  db: Database,
  userId: string,
  input: { email: string; password: string },
): Promise<Account> {
  if (!input || typeof input.email !== "string" || typeof input.password !== "string")
    throw new AppError(400, "Invalid credentials");
  const email = input.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      input.password.length < 12 || input.password.length > 256)
    throw new AppError(400, "Invalid credentials");
  // Expensive hashing occurs outside the row lock; authorization is rechecked in the transaction.
  const digest = await passwordHash(input.password);
  try {
    return await db.transaction(async (tx) => {
      const users = await tx.query<{ email: string | null; password_hash: string | null }>(
        "SELECT email,password_hash FROM app_user WHERE id=$1 FOR UPDATE", [userId],
      );
      if (!users.length) throw new AppError(404, "Account not found");
      const local = await tx.query("SELECT subject FROM identity WHERE user_id=$1 AND provider='local'", [userId]);
      if (local.length || users[0].password_hash) throw new AppError(409, "A password is already linked to this account.");
      const proof = await tx.query(
        "SELECT subject FROM identity WHERE user_id=$1 AND provider IN ('google','apple') AND verified_email=$2",
        [userId, email],
      );
      if (!proof.length) throw new AppError(403,
        "A matching verified Google or Apple email is required before adding a password.");
      const claimed = await tx.query("SELECT id FROM app_user WHERE email=$1 AND id<>$2", [email, userId]);
      if (claimed.length || (users[0].email !== null && users[0].email !== email))
        throw new AppError(409, "This email is already claimed or differs from your account email.");
      await tx.query("INSERT INTO identity(provider,subject,user_id) VALUES('local',$1,$2)", [email, userId]);
      await tx.query("UPDATE app_user SET email=$2,password_hash=$3 WHERE id=$1", [userId, email, digest]);
      return (await getAccount(tx, userId))!;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505")
      throw new AppError(409, "This email or password sign-in is already linked.");
    throw error;
  }
}
export async function rateLimit(
  db: Database,
  key: string,
  limit: number,
  windowSeconds = 60,
) {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const rows = await db.query<{ count: number }>(
    "INSERT INTO rate_limit(key,bucket,count) VALUES($1,$2,1) ON CONFLICT(key,bucket) DO UPDATE SET count=rate_limit.count+1 RETURNING count",
    [hashToken(key), bucket],
  );
  if (rows[0].count > limit)
    throw new AppError(429, "Too many attempts. Please try again shortly.");
  // A bounded cleanup also prevents unbounded session/rate data growth.
  if (Math.random() < 0.02) {
    await db.query("DELETE FROM rate_limit WHERE bucket<$1", [bucket - 86400]);
    await db.query("DELETE FROM session WHERE expires_at<now()");
    await db.query("DELETE FROM oauth_flow WHERE expires_at<now()");
    await db.query("DELETE FROM native_device_grant WHERE expires_at<now()");
  }
}
