import { createHash, randomUUID } from "node:crypto";
import { AppError } from "@aurelia/core";
import type { Database } from "./connection";

export type ProductFeedbackKind = "bug" | "idea" | "feature";
export interface ProductFeedback {
  id: string;
  kind: ProductFeedbackKind;
  featureId: string | null;
  title: string;
  body: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface CreateProductFeedback {
  requestId: string;
  kind: ProductFeedbackKind;
  title: string;
  body: string;
  featureId?: string | null;
}
export type ProductFeedbackChanges = Partial<
  Omit<CreateProductFeedback, "requestId">
>;
export interface ProductFeedbackPage {
  items: ProductFeedback[];
  nextCursor: string | null;
}

const MAX_FEATURES = 100;
const MAX_FEEDBACK = 100;
const MAX_REVISION = 2_147_483_647;
const stableId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const feedbackColumns = `id,kind,title,body,feature_id,revision,created_at,updated_at,
to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at`;
type FeedbackRow = {
  id: string;
  kind: ProductFeedbackKind;
  title: string;
  body: string;
  feature_id: string | null;
  revision: number;
  created_at: string | Date;
  updated_at: string | Date;
  cursor_created_at: string;
};

const invalid = () => new AppError(400, "Invalid product feedback request");
const missing = () => new AppError(404, "Feedback not found");
const stale = () =>
  new AppError(409, "Feedback changed. Refresh before editing.");
function ownerId(value: string) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 160 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw invalid();
  return value;
}
function featureId(value: unknown): string {
  if (typeof value !== "string" || value.length > 80 || !stableId.test(value))
    throw invalid();
  return value;
}
function feedbackId(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw invalid();
  return value.toLowerCase();
}
function revision(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_REVISION
  )
    throw invalid();
  return value;
}
function plain(
  value: unknown,
  minimum: number,
  maximum: number,
  multiline = false,
) {
  if (typeof value !== "string") throw invalid();
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  const controls = multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  if (length < minimum || length > maximum || controls.test(normalized))
    throw invalid();
  return normalized;
}
function inputFields(input: object, allowed: string[]) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    throw invalid();
}
function kind(value: unknown): ProductFeedbackKind {
  if (value !== "bug" && value !== "idea" && value !== "feature")
    throw invalid();
  return value;
}
function optionalFeature(value: unknown) {
  return value === null || value === undefined ? null : featureId(value);
}
function date(value: Date | string) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    throw new AppError(503, "Feedback is temporarily unavailable");
  return parsed.toISOString();
}
function feedback(row: FeedbackRow): ProductFeedback {
  return {
    id: row.id,
    kind: row.kind,
    featureId: row.feature_id,
    title: row.title,
    body: row.body,
    revision: row.revision,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}
async function lockOwner(tx: Database, userId: string) {
  const rows = await tx.query(
    "SELECT id FROM app_user WHERE id=$1 FOR UPDATE",
    [userId],
  );
  if (!rows.length) throw new AppError(401, "Sign in to continue");
}

/** Public totals only. The API must validate IDs against its current registry. */
export async function getFeatureVoteCounts(
  db: Database,
  featureIds: readonly string[],
): Promise<Record<string, number>> {
  if (
    !Array.isArray(featureIds) ||
    featureIds.length > MAX_FEATURES ||
    new Set(featureIds).size !== featureIds.length
  )
    throw invalid();
  const ids = featureIds.map(featureId);
  if (!ids.length) return {};
  const rows = await db.query<{ feature_id: string; votes: string }>(
    "SELECT feature_id,count(*)::text AS votes FROM feature_vote WHERE feature_id=ANY($1::text[]) GROUP BY feature_id",
    [ids],
  );
  const counts = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const row of rows) {
    const count = Number(row.votes);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new AppError(503, "Vote totals are temporarily unavailable");
    counts[row.feature_id] = count;
  }
  return counts;
}

/** Private account state; never return another account's vote rows or identifiers. */
export async function listOwnVotedFeatureIds(
  db: Database,
  userId: string,
): Promise<string[]> {
  const rows = await db.query<{ feature_id: string }>(
    "SELECT feature_id FROM feature_vote WHERE user_id=$1 ORDER BY feature_id LIMIT 101",
    [ownerId(userId)],
  );
  if (rows.length > MAX_FEATURES)
    throw new AppError(503, "Vote state is temporarily unavailable");
  return rows.map((row) => row.feature_id);
}

export async function setVote(
  db: Database,
  userId: string,
  id: string,
  active: boolean,
): Promise<void> {
  const owner = ownerId(userId);
  const feature = featureId(id);
  if (typeof active !== "boolean") throw invalid();
  await db.transaction(async (tx) => {
    await lockOwner(tx, owner);
    if (active)
      await tx.query(
        "INSERT INTO feature_vote(user_id,feature_id) VALUES($1,$2) ON CONFLICT(user_id,feature_id) DO NOTHING",
        [owner, feature],
      );
    else
      await tx.query(
        "DELETE FROM feature_vote WHERE user_id=$1 AND feature_id=$2",
        [owner, feature],
      );
  });
}

/** Idempotency is retained with the row; hard deletion ends that request-key lifetime. */
export async function createProductFeedback(
  db: Database,
  userId: string,
  input: CreateProductFeedback,
): Promise<ProductFeedback> {
  const owner = ownerId(userId);
  inputFields(input, ["requestId", "kind", "title", "body", "featureId"]);
  const requestId = feedbackId(input.requestId);
  const normalized = {
    kind: kind(input.kind),
    title: plain(input.title, 3, 160),
    body: plain(input.body, 10, 4000, true),
    featureId: optionalFeature(input.featureId),
  };
  // Preserve the original creation payload hash through later edits, without duplicating private text.
  const requestHash = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
  return db.transaction(async (tx) => {
    await lockOwner(tx, owner);
    const prior = await tx.query<FeedbackRow & { request_hash: string }>(
      `SELECT ${feedbackColumns},request_hash FROM product_feedback WHERE user_id=$1 AND request_id=$2::uuid`,
      [owner, requestId],
    );
    if (prior.length) {
      if (prior[0].request_hash !== requestHash)
        throw new AppError(
          409,
          "This request was already used for different feedback",
        );
      return feedback(prior[0]);
    }
    const count = await tx.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM product_feedback WHERE user_id=$1",
      [owner],
    );
    if (count[0].count >= MAX_FEEDBACK)
      throw new AppError(
        409,
        "Your feedback list is full. Remove an item before adding another.",
      );
    const rows = await tx.query<FeedbackRow>(
      `INSERT INTO product_feedback(id,user_id,request_id,request_hash,kind,title,body,feature_id) VALUES($1,$2,$3::uuid,$4,$5,$6,$7,$8) RETURNING ${feedbackColumns}`,
      [
        randomUUID(),
        owner,
        requestId,
        requestHash,
        normalized.kind,
        normalized.title,
        normalized.body,
        normalized.featureId,
      ],
    );
    return feedback(rows[0]);
  });
}

function cursorInput(value: unknown): { timestamp: string; id: string } | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value))
    throw invalid();
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw invalid();
    const data: unknown = JSON.parse(decoded.toString("utf8"));
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.keys(data).sort().join(",") !== "id,t,v"
    )
      throw invalid();
    const record = data as { v: unknown; t: unknown; id: unknown };
    if (
      record.v !== 1 ||
      typeof record.t !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(record.t) ||
      new Date(record.t).toISOString() !== `${record.t.slice(0, 23)}Z`
    )
      throw invalid();
    return { timestamp: record.t, id: feedbackId(record.id) };
  } catch {
    throw invalid();
  }
}
function nextCursor(row: FeedbackRow): string {
  return Buffer.from(
    JSON.stringify({ v: 1, t: row.cursor_created_at, id: row.id }),
  ).toString("base64url");
}

export async function listProductFeedback(
  db: Database,
  userId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<ProductFeedbackPage> {
  const owner = ownerId(userId);
  inputFields(options, ["limit", "cursor"]);
  const limit = options.limit === undefined ? 20 : options.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid();
  const cursor = cursorInput(options.cursor);
  const rows = await db.query<FeedbackRow>(
    `SELECT ${feedbackColumns} FROM product_feedback WHERE user_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::text)) ORDER BY created_at DESC,id DESC LIMIT $4`,
    [owner, cursor?.timestamp ?? null, cursor?.id ?? "", limit + 1],
  );
  const selected = rows.slice(0, limit);
  return {
    items: selected.map(feedback),
    nextCursor:
      rows.length > limit ? nextCursor(selected[selected.length - 1]) : null,
  };
}

export async function updateProductFeedback(
  db: Database,
  userId: string,
  id: string,
  changes: ProductFeedbackChanges,
  expectedRevision: number,
): Promise<ProductFeedback> {
  const owner = ownerId(userId);
  const identifier = feedbackId(id);
  const expected = revision(expectedRevision);
  inputFields(changes, ["kind", "title", "body", "featureId"]);
  if (!Object.keys(changes).length) throw invalid();
  const fields = {
    ...(Object.hasOwn(changes, "kind") ? { kind: kind(changes.kind) } : {}),
    ...(Object.hasOwn(changes, "title")
      ? { title: plain(changes.title, 3, 160) }
      : {}),
    ...(Object.hasOwn(changes, "body")
      ? { body: plain(changes.body, 10, 4000, true) }
      : {}),
    ...(Object.hasOwn(changes, "featureId")
      ? { featureId: optionalFeature(changes.featureId) }
      : {}),
  };
  return db.transaction(async (tx) => {
    const current = await tx.query<FeedbackRow>(
      `SELECT ${feedbackColumns} FROM product_feedback WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [identifier, owner],
    );
    if (!current.length) throw missing();
    if (current[0].revision !== expected || expected >= MAX_REVISION)
      throw stale();
    const rows = await tx.query<FeedbackRow>(
      `UPDATE product_feedback SET kind=$1,title=$2,body=$3,feature_id=$4,revision=revision+1,updated_at=clock_timestamp() WHERE id=$5 AND user_id=$6 AND revision=$7 RETURNING ${feedbackColumns}`,
      [
        fields.kind ?? current[0].kind,
        fields.title ?? current[0].title,
        fields.body ?? current[0].body,
        Object.hasOwn(fields, "featureId")
          ? fields.featureId
          : current[0].feature_id,
        identifier,
        owner,
        expected,
      ],
    );
    if (!rows.length) throw stale();
    return feedback(rows[0]);
  });
}

export async function deleteProductFeedback(
  db: Database,
  userId: string,
  id: string,
  expectedRevision: number,
): Promise<void> {
  const owner = ownerId(userId);
  const identifier = feedbackId(id);
  const expected = revision(expectedRevision);
  await db.transaction(async (tx) => {
    const current = await tx.query<{ revision: number }>(
      "SELECT revision FROM product_feedback WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [identifier, owner],
    );
    if (!current.length) throw missing();
    if (current[0].revision !== expected) throw stale();
    await tx.query(
      "DELETE FROM product_feedback WHERE id=$1 AND user_id=$2 AND revision=$3",
      [identifier, owner, expected],
    );
  });
}
