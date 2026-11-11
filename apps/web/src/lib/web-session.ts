import { createSession, validateWebSessionHash } from "@aurelia/auth";
import type { Database } from "@aurelia/database";
import { AppError } from "@aurelia/core";

/** Final authorization and credential changes serialize with session revocation. */
export async function withCurrentWebSession<T>(
  db: Database,
  userId: string,
  sessionHash: string | null,
  action: (tx: Database) => Promise<T>,
  recent = true,
) {
  return db.transaction(async (tx) => {
    const sessions = await tx.query(
      `SELECT user_id FROM session WHERE token_hash=$1 AND user_id=$2 AND transport='web'
       AND expires_at>clock_timestamp()
       AND ($3::boolean=false OR created_at>clock_timestamp()-interval '10 minutes') FOR UPDATE`,
      [sessionHash, userId, recent],
    );
    // Policy changes lock the same owner after their session row. Revalidate
    // assurance after waiting, so an in-flight link cannot outlive revocation.
    await tx.query("SELECT id FROM app_user WHERE id=$1 FOR UPDATE", [userId]);
    if (!sessions.length || !(await validateWebSessionHash(tx, { hash: sessionHash, userId, recent })))
      throw new AppError(401, "Sign in again before completing this account operation.");
    return action(tx);
  });
}

/** Replacing a browser account also invalidates its unfinished linking intents. */
export async function rotateWebSession(db: Database, userId: string, previousHash: string | null) {
  return db.transaction(async (tx) => {
    if (previousHash) await tx.query("SELECT user_id FROM session WHERE token_hash=$1 AND transport='web' FOR UPDATE", [previousHash]);
    const token = await createSession(tx, userId);
    if (previousHash) {
      await tx.query("DELETE FROM session WHERE token_hash=$1 AND transport='web'", [previousHash]);
      await tx.query("DELETE FROM oauth_flow WHERE auth_session_hash=$1 AND intent IN ('link','import')", [previousHash]);
    }
    return token;
  });
}
