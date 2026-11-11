import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "@aurelia/database";
import { AppError, type Account } from "@aurelia/core";
import { getAccount, hashToken, randomToken, validateWebSessionHash } from "./accounts";
import { issueAuthorizedSession } from "./session-issuer";

export const DEVICE_GRANT_EXPIRES_IN = 600;
export const DEVICE_GRANT_INTERVAL = 3;
const SESSION_EXPIRES_IN = 30 * 86400;
const USER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export interface CreateDeviceGrantInput {
  codeChallenge: string;
  deviceName: string;
}
export interface CreatedDeviceGrant {
  deviceCode: string;
  userCode: string;
  expiresIn: 600;
  interval: 3;
}
export interface DeviceGrantApproval {
  userCode: string;
  deviceName: string;
  status: "pending" | "approved";
  expiresAt: string;
}
export interface RedeemDeviceGrantInput {
  deviceCode: string;
  codeVerifier: string;
}
export type DeviceGrantRedemption =
  | { status: "pending" }
  | { status: "approved"; token: string; user: Account; expiresIn: number };

interface GrantRow extends Record<string, unknown> {
  device_name: string;
  status: "pending" | "approved" | "redeemed";
  user_id: string | null;
  expires_at: Date | string;
  expired: boolean;
}

function invalidGrant(): never { throw new AppError(400, "invalid_grant"); }

function normalizedUserCode(value: string): string {
  if (typeof value !== "string" || value.length > 32) return invalidGrant();
  const code = value.trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/.test(code)) return invalidGrant();
  return code.replace("-", "");
}

function displayedUserCode(code: string): string { return `${code.slice(0, 4)}-${code.slice(4)}`; }

function approval(row: GrantRow, code: string): DeviceGrantApproval {
  if (row.expired) throw new AppError(400, "expired_token");
  if (row.status !== "pending" && row.status !== "approved") return invalidGrant();
  return { userCode: displayedUserCode(code), deviceName: row.device_name,
    status: row.status, expiresAt: new Date(row.expires_at).toISOString() };
}

/** The browser receives only userCode; the 256-bit deviceCode stays on its originating device. */
export async function createDeviceGrant(db: Database, input: CreateDeviceGrantInput): Promise<CreatedDeviceGrant> {
  if (!input || typeof input.codeChallenge !== "string" || !CHALLENGE.test(input.codeChallenge) ||
      typeof input.deviceName !== "string") throw new AppError(400, "invalid_request");
  const name = input.deviceName.trim();
  if (!name || name.length > 80 || /\p{Cc}/u.test(name)) throw new AppError(400, "invalid_request");
  // Expired proof material has no purpose after the ten-minute authorization window.
  await db.query("DELETE FROM native_device_grant WHERE expires_at<clock_timestamp()");
  for (let attempt = 0; attempt < 3; attempt++) {
    const deviceCode = randomToken();
    const userCode = [...randomBytes(8)].map((byte) => USER_ALPHABET[byte & 31]).join("");
    try {
      await db.query(
        "INSERT INTO native_device_grant(device_code_hash,user_code_hash,code_challenge,device_name,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+INTERVAL '10 minutes')",
        [hashToken(deviceCode), hashToken(userCode), input.codeChallenge, name],
      );
      return { deviceCode, userCode: displayedUserCode(userCode),
        expiresIn: DEVICE_GRANT_EXPIRES_IN, interval: DEVICE_GRANT_INTERVAL };
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
    }
  }
  throw new AppError(503, "device_authorization_unavailable");
}

/** Safe consent-page metadata; never returns deviceCode, PKCE, account IDs or credentials. */
export async function getDeviceGrantForApproval(db: Database, userCode: string): Promise<DeviceGrantApproval> {
  const code = normalizedUserCode(userCode);
  const rows = await db.query<GrantRow>(
    "SELECT device_name,status,user_id,expires_at,(expires_at<=clock_timestamp()) AS expired FROM native_device_grant WHERE user_code_hash=$1",
    [hashToken(code)],
  );
  if (!rows[0]) return invalidGrant();
  return approval(rows[0], code);
}

/** Protected accounts require the exact recent, email-verified browser session. */
export async function approveDeviceGrant(
  db: Database, userId: string, userCode: string, proof?: { webSessionHash?: string },
): Promise<DeviceGrantApproval> {
  const code = normalizedUserCode(userCode);
  return db.transaction(async (tx) => {
    // Match policy changes and session rotation: session -> user -> grant.
    if (proof?.webSessionHash) await tx.query(
      "SELECT token_hash FROM session WHERE token_hash=$1 AND user_id=$2 AND transport='web' FOR UPDATE",
      [proof.webSessionHash, userId],
    );
    const users = await tx.query("SELECT id FROM app_user WHERE id=$1 FOR UPDATE", [userId]);
    if (!users.length) throw new AppError(404, "Account not found");
    const policies = await tx.query<{ enabled: boolean; version: number }>(
      "SELECT enabled,version FROM email_login_security WHERE user_id=$1", [userId],
    );
    const policy = policies[0];
    if (policy?.enabled && !(await validateWebSessionHash(tx, {
      hash: proof?.webSessionHash ?? null, userId, recent: true,
    }))) throw new AppError(401, "A recent verified web session is required");
    const rows = await tx.query<GrantRow>(
      "SELECT device_name,status,user_id,expires_at,(expires_at<=clock_timestamp()) AS expired FROM native_device_grant WHERE user_code_hash=$1 FOR UPDATE",
      [hashToken(code)],
    );
    if (!rows[0]) return invalidGrant();
    const current = approval(rows[0], code);
    if (rows[0].status === "approved") {
      if (rows[0].user_id !== userId) throw new AppError(409, "already_approved");
      return current;
    }
    const changed = await tx.query<GrantRow>(
      "UPDATE native_device_grant SET status='approved',user_id=$2,approved_at=clock_timestamp(),security_version=$3,email_code_verified=$4 WHERE user_code_hash=$1 AND status='pending' AND expires_at>clock_timestamp() RETURNING device_name,status,user_id,expires_at,false AS expired",
      [hashToken(code), userId, policy?.version ?? 0, policy?.enabled ?? false],
    );
    if (!changed[0]) return invalidGrant();
    return approval(changed[0], code);
  });
}

/** Proof is checked before polling metadata or credentials are released; redemption is atomic. */
export async function redeemDeviceGrant(db: Database, input: RedeemDeviceGrantInput): Promise<DeviceGrantRedemption> {
  if (!input || typeof input.deviceCode !== "string" || !CHALLENGE.test(input.deviceCode) ||
      typeof input.codeVerifier !== "string" || !VERIFIER.test(input.codeVerifier)) return invalidGrant();
  const challenge = createHash("sha256").update(input.codeVerifier).digest("base64url");
  const result = await db.transaction(async (tx): Promise<DeviceGrantRedemption | { status: "slow_down" }> => {
    // Policy changes hold the user row before revoking grants. Match that lock order.
    const owners = await tx.query<{ user_id: string | null }>(
      "SELECT user_id FROM native_device_grant WHERE device_code_hash=$1", [hashToken(input.deviceCode)],
    );
    const lockedUserId = owners[0]?.user_id;
    if (lockedUserId) await tx.query("SELECT id FROM app_user WHERE id=$1 FOR UPDATE", [lockedUserId]);
    const rows = await tx.query<GrantRow & { code_challenge: string; too_soon: boolean; security_version: number; email_code_verified: boolean }>(
      "SELECT device_name,status,user_id,expires_at,code_challenge,security_version,email_code_verified,(expires_at<=clock_timestamp()) AS expired,(last_poll_at>clock_timestamp()-(poll_interval_seconds * INTERVAL '1 second')) AS too_soon FROM native_device_grant WHERE device_code_hash=$1 FOR UPDATE",
      [hashToken(input.deviceCode)],
    );
    const row = rows[0];
    if (!row || row.code_challenge.length !== challenge.length ||
        !timingSafeEqual(Buffer.from(row.code_challenge), Buffer.from(challenge))) return invalidGrant();
    if (row.expired) throw new AppError(400, "expired_token");
    if (row.status === "redeemed") return invalidGrant();
    if (row.too_soon) {
      await tx.query(
        "UPDATE native_device_grant SET last_poll_at=clock_timestamp(),poll_interval_seconds=LEAST(60,poll_interval_seconds+5) WHERE device_code_hash=$1",
        [hashToken(input.deviceCode)],
      );
      // Throw only after committing the penalty; throwing inside the transaction would roll it back.
      return { status: "slow_down" };
    }
    await tx.query("UPDATE native_device_grant SET last_poll_at=clock_timestamp() WHERE device_code_hash=$1", [hashToken(input.deviceCode)]);
    if (row.status === "pending") return { status: "pending" };
    if (row.status !== "approved" || !row.user_id) return invalidGrant();
    // Approval may have happened after the unlocked owner read. Retry on the next bounded poll.
    if (lockedUserId !== row.user_id) return { status: "pending" };
    const consumed = await tx.query<{ user_id: string }>(
      "UPDATE native_device_grant SET status='redeemed',redeemed_at=clock_timestamp() WHERE device_code_hash=$1 AND status='approved' AND expires_at>clock_timestamp() RETURNING user_id",
      [hashToken(input.deviceCode)],
    );
    if (!consumed[0]) return invalidGrant();
    // This grant was authorized by an authenticated web session. Serialize with policy changes.
    const security = await tx.query<{ enabled: boolean; version: number }>(
      "SELECT enabled,version FROM email_login_security WHERE user_id=$1", [consumed[0].user_id],
    );
    if (row.security_version !== (security[0]?.version ?? 0) || (security[0]?.enabled && !row.email_code_verified))
      return invalidGrant();
    const token = await issueAuthorizedSession(tx, consumed[0].user_id, "native",
      row.security_version, row.email_code_verified);
    const user = await getAccount(tx, consumed[0].user_id);
    if (!user) return invalidGrant();
    return { status: "approved", token, user, expiresIn: SESSION_EXPIRES_IN };
  });
  if (result.status === "slow_down") throw new AppError(429, "slow_down");
  return result;
}
