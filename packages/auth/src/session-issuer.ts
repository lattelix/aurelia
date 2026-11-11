import { createHash, randomBytes } from "node:crypto";
import type { Database } from "@aurelia/database";

/** Internal primitive. Call only while holding the validated authorization/policy transaction. */
export async function issueAuthorizedSession(
  db: Database, userId: string, transport: "web" | "native",
  securityVersion: number, emailCodeVerified: boolean,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO session(token_hash,user_id,expires_at,transport,security_version,email_code_verified) VALUES($1,$2,clock_timestamp()+INTERVAL '30 days',$3,$4,$5)",
    [createHash("sha256").update(token).digest("hex"), userId, transport, securityVersion, emailCodeVerified],
  );
  return token;
}
