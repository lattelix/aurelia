import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { Database } from "@aurelia/database";
import { AppError } from "@aurelia/core";
import { getAccount, hashToken, randomToken, validateWebSessionHash } from "./accounts";
import { issueAuthorizedSession } from "./session-issuer";

export type EmailAuthPurpose = "login" | "enable" | "disable" | "email-verify";
export const EMAIL_AUTH_EXPIRES_IN = 300;
export const EMAIL_AUTH_RESEND_AFTER = 60;
export const EMAIL_AUTH_MAX_ATTEMPTS = 5;
export const EMAIL_AUTH_ACCOUNT_MAX_FAILURES = 20;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PURPOSES: readonly string[] = ["login", "enable", "disable", "email-verify"];

export type EmailDiscovery =
  | { step: "password" }
  | { step: "register" }
  | { step: "provider" };

export interface EmailLoginSecurity {
  enabled: boolean;
  verifiedEmail: string | null;
}

export interface CreateEmailAuthChallengeInput {
  userId: string;
  purpose: EmailAuthPurpose;
  /** A server-generated browser secret, never an IP address or public user ID. */
  binding: string;
  pepper: string;
  /** Required for every purpose except completing a first-factor login. */
  webSessionToken?: string;
}

/** Server-only delivery material: never serialize code or email to public auth responses/logs. */
export interface CreatedEmailAuthChallenge {
  challengeToken: string;
  code: string;
  email: string;
  expiresIn: number;
  resendAfter: 60;
}

export interface CompleteEmailAuthChallengeInput {
  challengeToken: string;
  code: string;
  purpose: EmailAuthPurpose;
  binding: string;
  pepper: string;
  userId?: string;
  webSessionToken?: string;
  /** Root derives this only from the actual previous browser cookie. Never from request JSON. */
  previousWebSessionHash?: string;
}

export type EmailAuthFailure =
  "invalid" | "expired" | "locked" | "delivery_required" | "stale" | "session_required";

interface SecurityRow extends Record<string, unknown> {
  email: string | null;
  enabled: boolean;
  verified_email: string | null;
  version: number;
  failed_attempts: number;
  failure_window_expired: boolean;
}

interface ChallengeRow extends Record<string, unknown> {
  token_hash: string;
  user_id: string;
  purpose: EmailAuthPurpose;
  email: string;
  binding_hash: string;
  session_hash: string | null;
  code_hash: string;
  policy_version: number;
  attempts: number;
  delivery_status: "pending" | "sent" | "failed";
  consumed_at: Date | string | null;
  expires_at: Date | string;
  expired: boolean;
}

function normalizedEmail(value: string): string {
  if (typeof value !== "string") throw new AppError(400, "Invalid email");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new AppError(400, "Invalid email");
  return email;
}

function validateProofConfiguration(purpose: EmailAuthPurpose, binding: string, pepper: string) {
  if (!PURPOSES.includes(purpose) || typeof binding !== "string" ||
      binding.length < 32 || binding.length > 512)
    throw new AppError(400, "Invalid email challenge");
  if (typeof pepper !== "string" || Buffer.byteLength(pepper, "utf8") < 32 || pepper.length > 1024)
    throw new AppError(503, "Email authentication is unavailable");
}

function equalDigest(actual: string, expected: string): boolean {
  return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function codeDigest(pepper: string, row: Pick<ChallengeRow,
  "token_hash" | "user_id" | "purpose" | "email" | "binding_hash">, code: string): string {
  return createHmac("sha256", pepper).update(JSON.stringify([
    row.token_hash, row.user_id, row.purpose, row.email, row.binding_hash, code,
  ])).digest("hex");
}

/** Intentionally exposes only the requested sign-in branch. HTTP must rate-limit discovery. */
export async function discoverEmail(db: Database, email: string): Promise<EmailDiscovery> {
  const rows = await db.query<{ id: string; has_password: boolean }>(
    "SELECT id,(password_hash IS NOT NULL) AS has_password FROM app_user WHERE email=$1",
    [normalizedEmail(email)],
  );
  if (!rows[0]) return { step: "register" };
  return { step: rows[0].has_password ? "password" : "provider" };
}

export async function getEmailLoginSecurity(db: Database, userId: string): Promise<EmailLoginSecurity> {
  const rows = await db.query<SecurityRow>(
    "SELECT u.email,COALESCE(s.enabled,false) AS enabled,s.verified_email,COALESCE(s.version,0) AS version FROM app_user u LEFT JOIN email_login_security s ON s.user_id=u.id WHERE u.id=$1",
    [userId],
  );
  if (!rows[0]) throw new AppError(404, "Account not found");
  return { enabled: rows[0].enabled, verifiedEmail: rows[0].verified_email };
}

async function lockRecentWebSession(tx: Database, userId: string, token?: string): Promise<boolean> {
  if (typeof token !== "string" || !TOKEN.test(token)) return false;
  const rows = await tx.query<{ token_hash: string }>(
    "SELECT token_hash FROM session WHERE token_hash=$1 AND user_id=$2 AND transport='web' AND expires_at>clock_timestamp() AND created_at>clock_timestamp()-INTERVAL '10 minutes' AND created_at<=clock_timestamp() FOR UPDATE",
    [hashToken(token), userId],
  );
  return rows.length === 1 && await validateWebSessionHash(tx, { hash: hashToken(token), userId, recent: true });
}

async function lockSecurity(tx: Database, userId: string): Promise<SecurityRow> {
  const users = await tx.query<{ email: string | null }>(
    "SELECT email FROM app_user WHERE id=$1 FOR UPDATE", [userId],
  );
  if (!users[0]) throw new AppError(404, "Account not found");
  await tx.query("INSERT INTO email_login_security(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING", [userId]);
  const security = await tx.query<SecurityRow>(
    "SELECT enabled,verified_email,version,failed_attempts,(failure_window_started_at IS NULL OR failure_window_started_at<=clock_timestamp()-INTERVAL '15 minutes') AS failure_window_expired FROM email_login_security WHERE user_id=$1 FOR UPDATE", [userId],
  );
  return { ...security[0], email: users[0].email };
}

async function createChallenge(
  db: Database, input: CreateEmailAuthChallengeInput, priorTokenHash?: string,
): Promise<CreatedEmailAuthChallenge> {
  validateProofConfiguration(input.purpose, input.binding, input.pepper);
  return db.transaction(async (tx) => {
    if (input.purpose !== "login" && !(await lockRecentWebSession(tx, input.userId, input.webSessionToken)))
      throw new AppError(401, "A recent web session is required");
    const security = await lockSecurity(tx, input.userId);
    if (input.purpose !== "login" && !(await validateWebSessionHash(tx, {
      hash: hashToken(input.webSessionToken!), userId: input.userId, recent: true,
    }))) throw new AppError(401, "A recent web session is required");
    let originalExpiry: Date | string | null = null;
    let attempts = 0;
    if (!security.failure_window_expired && security.failed_attempts >= EMAIL_AUTH_ACCOUNT_MAX_FAILURES)
      throw new AppError(429, "Too many email verification attempts. Please try again later.");
    if (priorTokenHash) {
      const previous = await tx.query<ChallengeRow>(
        "SELECT *,(expires_at<=clock_timestamp()) AS expired FROM email_auth_challenge WHERE token_hash=$1 FOR UPDATE", [priorTokenHash],
      );
      const row = previous[0];
      if (!row || row.expired || row.consumed_at !== null || row.user_id !== input.userId ||
          row.purpose !== input.purpose || !equalDigest(row.binding_hash, hashToken(input.binding)) ||
          row.policy_version !== security.version || row.email !== security.email ||
          (row.session_hash !== null && row.session_hash !== hashToken(input.webSessionToken ?? "")))
        throw new AppError(400, "Invalid email challenge");
      if (row.attempts >= EMAIL_AUTH_MAX_ATTEMPTS)
        throw new AppError(429, "Too many email verification attempts. Please sign in again later.");
      originalExpiry = row.expires_at;
      attempts = row.attempts;
    }
    if (!security.email) throw new AppError(403, "An account email is required");
    const email = normalizedEmail(security.email);
    if (input.purpose === "login" && (!security.enabled || security.verified_email !== email))
      throw new AppError(409, "Email login verification is not enabled");
    if ((input.purpose === "enable" && security.enabled) || (input.purpose === "disable" && !security.enabled))
      throw new AppError(409, "Email login verification already has this setting");
    const recent = await tx.query(
      "SELECT token_hash FROM email_auth_challenge WHERE user_id=$1 AND purpose=$2 AND created_at>clock_timestamp()-INTERVAL '60 seconds' LIMIT 1",
      [input.userId, input.purpose],
    );
    if (recent.length) throw new AppError(429, "Please wait before requesting another email code");
    // A resend invalidates every previous challenge for this owner and purpose, including other browsers.
    await tx.query(
      "UPDATE email_auth_challenge SET consumed_at=clock_timestamp() WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL",
      [input.userId, input.purpose],
    );
    const challengeToken = randomToken();
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const row = { token_hash: hashToken(challengeToken), user_id: input.userId,
      purpose: input.purpose, email, binding_hash: hashToken(input.binding) };
    const inserted = await tx.query<{ expires_in: number }>(
      "INSERT INTO email_auth_challenge(token_hash,user_id,purpose,email,binding_hash,session_hash,code_hash,policy_version,expires_at,attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz,clock_timestamp()+INTERVAL '5 minutes'),$10) RETURNING CEIL(EXTRACT(EPOCH FROM expires_at-clock_timestamp()))::int AS expires_in",
      [row.token_hash, row.user_id, row.purpose, row.email, row.binding_hash,
        input.purpose === "login" ? null : hashToken(input.webSessionToken!),
        codeDigest(input.pepper, row, code), security.version, originalExpiry, attempts],
    );
    await tx.query("DELETE FROM email_auth_challenge WHERE expires_at<clock_timestamp()-INTERVAL '1 day'");
    return { challengeToken, code, email, expiresIn: inserted[0].expires_in, resendAfter: EMAIL_AUTH_RESEND_AFTER };
  });
}

/** Caller may request login challenges only after password/OIDC first-factor proof. */
export async function createEmailAuthChallenge(
  db: Database, input: CreateEmailAuthChallengeInput,
): Promise<CreatedEmailAuthChallenge> {
  return createChallenge(db, input);
}

/** Resending requires the original browser binding and never extends an expired first-factor proof. */
export async function resendEmailAuthChallenge(
  db: Database, input: { challengeToken: string; binding: string; pepper: string; webSessionToken?: string },
): Promise<CreatedEmailAuthChallenge> {
  if (typeof input.challengeToken !== "string" || !TOKEN.test(input.challengeToken))
    throw new AppError(400, "Invalid email challenge");
  const tokenHash = hashToken(input.challengeToken);
  const rows = await db.query<{ user_id: string; purpose: EmailAuthPurpose }>(
    "SELECT user_id,purpose FROM email_auth_challenge WHERE token_hash=$1", [tokenHash],
  );
  if (!rows[0]) throw new AppError(400, "Invalid email challenge");
  return createChallenge(db, { userId: rows[0].user_id, purpose: rows[0].purpose,
    binding: input.binding, pepper: input.pepper, webSessionToken: input.webSessionToken }, tokenHash);
}

/** Only the server's actual delivery result may call this. Failed delivery is terminal. */
export async function markEmailAuthChallengeDelivery(
  db: Database, input: { challengeToken: string; delivered: boolean },
): Promise<boolean> {
  if (!input || typeof input.challengeToken !== "string" || !TOKEN.test(input.challengeToken) || typeof input.delivered !== "boolean")
    throw new AppError(400, "Invalid email delivery result");
  const changed = await db.query(
    "UPDATE email_auth_challenge SET delivery_status=$2 WHERE token_hash=$1 AND delivery_status='pending' AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING token_hash",
    [hashToken(input.challengeToken), input.delivered ? "sent" : "failed"],
  );
  return changed.length === 1;
}

export type EmailAuthCompletion =
  | { status: EmailAuthFailure }
  | { status: "approved"; user: NonNullable<Awaited<ReturnType<typeof getAccount>>>;
      security: EmailLoginSecurity; token?: string };

/** Failures are values so committed attempt penalties survive nested caller transactions. */
export async function completeEmailAuthChallenge(
  db: Database, input: CompleteEmailAuthChallengeInput,
): Promise<EmailAuthCompletion> {
  validateProofConfiguration(input.purpose, input.binding, input.pepper);
  if (typeof input.challengeToken !== "string" || !TOKEN.test(input.challengeToken)) return { status: "invalid" };
  if (input.previousWebSessionHash !== undefined && !/^[a-f0-9]{64}$/.test(input.previousWebSessionHash))
    return { status: "invalid" };
  return db.transaction(async (tx) => {
    // Read ownership before locking, then consistently acquire session -> user -> challenge.
    const owners = await tx.query<{ user_id: string }>(
      "SELECT user_id FROM email_auth_challenge WHERE token_hash=$1", [hashToken(input.challengeToken)],
    );
    const userId = owners[0]?.user_id;
    if (!userId || (input.userId !== undefined && input.userId !== userId)) return { status: "invalid" };
    if (input.purpose !== "login" && !(await lockRecentWebSession(tx, userId, input.webSessionToken)))
      return { status: "session_required" };
    if (input.purpose === "login" && input.previousWebSessionHash) await tx.query(
      "SELECT user_id FROM session WHERE token_hash=$1 AND transport='web' FOR UPDATE", [input.previousWebSessionHash],
    );
    const security = await lockSecurity(tx, userId);
    if (input.purpose !== "login" && !(await validateWebSessionHash(tx, {
      hash: hashToken(input.webSessionToken!), userId, recent: true,
    }))) return { status: "session_required" };
    const rows = await tx.query<ChallengeRow>(
      "SELECT *,(expires_at<=clock_timestamp()) AS expired FROM email_auth_challenge WHERE token_hash=$1 FOR UPDATE",
      [hashToken(input.challengeToken)],
    );
    const row = rows[0];
    if (!row || row.purpose !== input.purpose || !equalDigest(row.binding_hash, hashToken(input.binding)) ||
        (row.session_hash !== null && row.session_hash !== hashToken(input.webSessionToken ?? "")))
      return { status: "invalid" };
    if (row.consumed_at !== null) return { status: "invalid" };
    if (row.expired) return { status: "expired" };
    if (row.attempts >= EMAIL_AUTH_MAX_ATTEMPTS) return { status: "locked" };
    if (!security.failure_window_expired && security.failed_attempts >= EMAIL_AUTH_ACCOUNT_MAX_FAILURES)
      return { status: "locked" };
    if (row.delivery_status !== "sent") return { status: "delivery_required" };
    if (security.version !== row.policy_version || security.email !== row.email ||
        (row.purpose === "login" && (!security.enabled || security.verified_email !== row.email)))
      return { status: "stale" };
    const correct = typeof input.code === "string" && /^\d{6}$/.test(input.code) &&
      equalDigest(row.code_hash, codeDigest(input.pepper, row, input.code));
    await tx.query("UPDATE email_auth_challenge SET attempts=attempts+1 WHERE token_hash=$1", [row.token_hash]);
    if (!correct) {
      const failures = security.failure_window_expired ? 1 : security.failed_attempts + 1;
      await tx.query(
        "UPDATE email_login_security SET failed_attempts=$2,failure_window_started_at=CASE WHEN $3 THEN clock_timestamp() ELSE failure_window_started_at END WHERE user_id=$1",
        [userId, failures, security.failure_window_expired],
      );
      return { status: row.attempts + 1 >= EMAIL_AUTH_MAX_ATTEMPTS || failures >= EMAIL_AUTH_ACCOUNT_MAX_FAILURES ? "locked" : "invalid" };
    }
    if (row.purpose !== "login" && !(await validateWebSessionHash(tx, { hash: row.session_hash, userId, recent: true })))
      return { status: "session_required" };
    const consumed = await tx.query(
      "UPDATE email_auth_challenge SET consumed_at=clock_timestamp() WHERE token_hash=$1 AND expires_at>clock_timestamp() RETURNING token_hash", [row.token_hash],
    );
    if (!consumed.length) return { status: "expired" };
    await tx.query("UPDATE email_login_security SET failed_attempts=0,failure_window_started_at=NULL WHERE user_id=$1", [userId]);
    let token: string | undefined;
    if (row.purpose === "login") {
      token = await issueAuthorizedSession(tx, userId, "web", security.version, true);
      if (input.previousWebSessionHash) {
        await tx.query("DELETE FROM session WHERE token_hash=$1 AND transport='web'", [input.previousWebSessionHash]);
        await tx.query("DELETE FROM oauth_flow WHERE auth_session_hash=$1 AND intent IN ('link','import')", [input.previousWebSessionHash]);
      }
    } else {
      const enabled = row.purpose === "enable" ? true : row.purpose === "disable" ? false : security.enabled;
      const policyChanged = row.purpose === "enable" || row.purpose === "disable";
      const version = security.version + (policyChanged ? 1 : 0);
      await tx.query(
        "UPDATE email_login_security SET verified_email=$2,enabled=$3,version=$4,updated_at=clock_timestamp() WHERE user_id=$1",
        [userId, row.email, enabled, version],
      );
      if (policyChanged) {
        // Version checks revoke every other session without locking another device's
        // session while holding this user row. Only our already-locked session survives.
        await tx.query("UPDATE session SET security_version=$2,email_code_verified=true WHERE token_hash=$1", [row.session_hash, version]);
        await tx.query("DELETE FROM native_device_grant WHERE user_id=$1", [userId]);
        await tx.query("DELETE FROM oauth_flow WHERE user_id=$1 AND intent IN ('link','import')", [userId]);
        await tx.query("UPDATE email_auth_challenge SET consumed_at=clock_timestamp() WHERE user_id=$1 AND consumed_at IS NULL", [userId]);
      }
      security.verified_email = row.email;
      security.enabled = enabled;
    }
    return { status: "approved", user: (await getAccount(tx, userId))!,
      security: { enabled: security.enabled, verifiedEmail: security.verified_email }, ...(token ? { token } : {}) };
  });
}
