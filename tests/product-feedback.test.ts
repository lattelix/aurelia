import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  migrate,
  migrations,
  setVote,
  getFeatureVoteCounts,
  listOwnVotedFeatureIds,
  createProductFeedback,
  listProductFeedback,
  updateProductFeedback,
  deleteProductFeedback,
  type CreateProductFeedback,
  type ProductFeedbackChanges,
  type Database,
} from "@aurelia/database";
import { AppError } from "@aurelia/core";

let db: Database;
const owner = randomUUID(),
  other = randomUUID();
beforeAll(async () => {
  db = await createDatabase({ memory: true });
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.query("DELETE FROM app_user");
  for (const id of [owner, other])
    await db.query(
      "INSERT INTO app_user(id,name) VALUES($1,'Synthetic feedback account')",
      [id],
    );
});
function draft(
  changes: Partial<CreateProductFeedback> = {},
): CreateProductFeedback {
  return {
    requestId: randomUUID(),
    kind: "bug",
    title: "Synthetic problem",
    body: "Synthetic reproduction with no personal data.",
    featureId: "queue-editing",
    ...changes,
  };
}
async function expectError(
  promise: Promise<unknown>,
  status: number,
  message?: string,
) {
  try {
    await promise;
    throw new Error("Expected an application error");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(status);
    if (message) expect((error as AppError).message).toBe(message);
  }
}
async function seedFeedback(count: number, userId = owner) {
  const rows = Array.from({ length: count }, () => ({
    id: randomUUID(),
    request_id: randomUUID(),
  }));
  await db.query(
    `INSERT INTO product_feedback(id,user_id,request_id,request_hash,kind,title,body)
    SELECT seed.id,$1,seed.request_id::uuid,repeat('0',64),'idea','Synthetic seeded item','Synthetic existing private feedback.'
    FROM jsonb_to_recordset($2::jsonb) AS seed(id text,request_id text)`,
    [userId, JSON.stringify(rows)],
  );
}

describe("private product participation database", () => {
  it("upgrades an existing v3 schema additively and remains migration-idempotent", async () => {
    await db.query("DROP TABLE product_feedback");
    await db.query("DROP TABLE feature_vote");
    await db.query("DELETE FROM schema_migration WHERE version=4");
    await migrate(db);
    await migrate(db);
    expect(migrations.map((entry) => entry.version)).toEqual([1, 2, 3, 4]);
    expect(
      await db.query("SELECT version FROM schema_migration ORDER BY version"),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    expect(
      await db.query("SELECT id FROM app_user WHERE id=$1", [owner]),
    ).toHaveLength(1);
    expect((await listProductFeedback(db, owner)).items).toEqual([]);
  });

  it("sets one vote per account and feature, with idempotent concurrent set/unset", async () => {
    await Promise.all([
      setVote(db, owner, "queue-editing", true),
      setVote(db, owner, "queue-editing", true),
    ]);
    await setVote(db, other, "queue-editing", true);
    expect(
      await getFeatureVoteCounts(db, ["queue-editing", "sleep-timer"]),
    ).toEqual({ "queue-editing": 2, "sleep-timer": 0 });
    expect(await listOwnVotedFeatureIds(db, owner)).toEqual(["queue-editing"]);
    await Promise.all([
      setVote(db, owner, "queue-editing", false),
      setVote(db, owner, "queue-editing", false),
    ]);
    expect(await getFeatureVoteCounts(db, ["queue-editing"])).toEqual({
      "queue-editing": 1,
    });
    expect(await listOwnVotedFeatureIds(db, owner)).toEqual([]);
    expect(await listOwnVotedFeatureIds(db, other)).toEqual(["queue-editing"]);
    expect(await db.query("SELECT * FROM feature_vote")).toHaveLength(1);
  });

  it("returns only aggregate counts for explicitly requested stable IDs", async () => {
    await setVote(db, owner, "queue-editing", true);
    await setVote(db, owner, "sleep-timer", true);
    const counts = await getFeatureVoteCounts(db, ["sleep-timer"]);
    expect(counts).toEqual({ "sleep-timer": 1 });
    expect(JSON.stringify(counts)).not.toContain(owner);
    expect(await getFeatureVoteCounts(db, [])).toEqual({});
    expect(await listOwnVotedFeatureIds(db, other)).toEqual([]);
  });

  it("bounds vote IDs, requested totals and active input without database side effects", async () => {
    for (const id of [
      "",
      "Queue",
      "queue/editing",
      "x".repeat(81),
      "queue'; DROP TABLE app_user;--",
    ])
      await expectError(setVote(db, owner, id, true), 400);
    await expectError(
      setVote(db, owner, "queue-editing", 1 as unknown as boolean),
      400,
    );
    await expectError(
      getFeatureVoteCounts(db, ["queue-editing", "queue-editing"]),
      400,
    );
    await expectError(
      getFeatureVoteCounts(
        db,
        Array.from({ length: 101 }, (_, i) => `feature-${i}`),
      ),
      400,
    );
    expect(await db.query("SELECT * FROM feature_vote")).toEqual([]);
    expect(await db.query("SELECT id FROM app_user")).toHaveLength(2);
  });

  it("creates normalized private feedback without account or idempotency fields in its DTO", async () => {
    const item = await createProductFeedback(
      db,
      owner,
      draft({
        title: "  Synthetic problem  ",
        body: "  A precise reproduction.\nSecond line.  ",
      }),
    );
    expect(item).toMatchObject({
      kind: "bug",
      title: "Synthetic problem",
      body: "A precise reproduction.\nSecond line.",
      featureId: "queue-editing",
      revision: 1,
    });
    expect(Object.keys(item).sort()).toEqual([
      "body",
      "createdAt",
      "featureId",
      "id",
      "kind",
      "revision",
      "title",
      "updatedAt",
    ]);
    expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(item.updatedAt).toBe(item.createdAt);
    expect((await listProductFeedback(db, owner)).items).toEqual([item]);
    expect((await listProductFeedback(db, other)).items).toEqual([]);
  });

  it("deduplicates matching create retries, including concurrent requests", async () => {
    const input = draft();
    const [first, second] = await Promise.all([
      createProductFeedback(db, owner, input),
      createProductFeedback(db, owner, input),
    ]);
    expect(second).toEqual(first);
    expect((await listProductFeedback(db, owner)).items).toHaveLength(1);
    const otherItem = await createProductFeedback(db, other, input);
    expect(otherItem.id).not.toBe(first.id);
  });

  it("rejects reusing a request ID for different original content", async () => {
    const input = draft();
    const item = await createProductFeedback(db, owner, input);
    await expectError(
      createProductFeedback(db, owner, {
        ...input,
        body: "Different synthetic reproduction.",
      }),
      409,
    );
    expect((await listProductFeedback(db, owner)).items).toEqual([item]);
  });

  it("keeps original create idempotency through later owned updates", async () => {
    const input = draft();
    const item = await createProductFeedback(db, owner, input);
    const updated = await updateProductFeedback(
      db,
      owner,
      item.id,
      { title: "Later edited title" },
      item.revision,
    );
    expect(updated.revision).toBe(2);
    expect(await createProductFeedback(db, owner, input)).toEqual(updated);
    await expectError(
      createProductFeedback(db, owner, { ...input, title: updated.title }),
      409,
    );
  });

  it("enforces the 100-item cap under concurrent creation and allows matching retries at the cap", async () => {
    await seedFeedback(99);
    const a = draft(),
      b = draft();
    const results = await Promise.allSettled([
      createProductFeedback(db, owner, a),
      createProductFeedback(db, owner, b),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
      status: 409,
    });
    expect(
      await db.query(
        "SELECT count(*)::int AS count FROM product_feedback WHERE user_id=$1",
        [owner],
      ),
    ).toEqual([{ count: 100 }]);
    const winnerIndex = results.findIndex(
      (result) => result.status === "fulfilled",
    );
    const winner = results[winnerIndex];
    if (winner.status !== "fulfilled")
      throw new Error("Expected a successful fixture");
    expect(
      await createProductFeedback(db, owner, winnerIndex === 0 ? a : b),
    ).toEqual(winner.value);
    await expectError(createProductFeedback(db, owner, draft()), 409);
    expect(await createProductFeedback(db, other, draft())).toMatchObject({
      revision: 1,
    });
  });

  it("hard deletion frees backlog space and ends that row's request-key lifetime", async () => {
    await seedFeedback(99);
    const input = draft();
    const original = await createProductFeedback(db, owner, input);
    await deleteProductFeedback(db, owner, original.id, original.revision);
    const recreated = await createProductFeedback(db, owner, input);
    expect(recreated.id).not.toBe(original.id);
    expect(
      await db.query(
        "SELECT count(*)::int AS count FROM product_feedback WHERE user_id=$1",
        [owner],
      ),
    ).toEqual([{ count: 100 }]);
  });

  it("updates only supplied owned fields and uses a fresh revision", async () => {
    const item = await createProductFeedback(db, owner, draft());
    const updated = await updateProductFeedback(
      db,
      owner,
      item.id,
      { title: "Updated title" },
      1,
    );
    expect(updated).toMatchObject({
      title: "Updated title",
      body: item.body,
      kind: item.kind,
      featureId: item.featureId,
      revision: 2,
      createdAt: item.createdAt,
    });
    const cleared = await updateProductFeedback(
      db,
      owner,
      item.id,
      { featureId: null, kind: "feature" },
      2,
    );
    expect(cleared).toMatchObject({
      featureId: null,
      kind: "feature",
      revision: 3,
    });
    await expectError(
      updateProductFeedback(
        db,
        owner,
        item.id,
        { title: "Stale overwrite" },
        1,
      ),
      409,
    );
    expect((await listProductFeedback(db, owner)).items[0]).toEqual(cleared);
  });

  it("does not reveal whether an unknown or other owner's feedback exists", async () => {
    const item = await createProductFeedback(db, owner, draft());
    await expectError(
      updateProductFeedback(
        db,
        other,
        item.id,
        { title: "Other account edit" },
        99,
      ),
      404,
      "Feedback not found",
    );
    await expectError(
      updateProductFeedback(
        db,
        other,
        randomUUID(),
        { title: "Missing item edit" },
        99,
      ),
      404,
      "Feedback not found",
    );
    await expectError(
      deleteProductFeedback(db, other, item.id, 99),
      404,
      "Feedback not found",
    );
    await expectError(
      deleteProductFeedback(db, other, randomUUID(), 99),
      404,
      "Feedback not found",
    );
    expect((await listProductFeedback(db, owner)).items).toEqual([item]);
  });

  it("guards delete with expectedRevision and does not delete after a stale edit", async () => {
    const item = await createProductFeedback(db, owner, draft());
    const updated = await updateProductFeedback(
      db,
      owner,
      item.id,
      { body: "Updated synthetic reproduction." },
      1,
    );
    await expectError(deleteProductFeedback(db, owner, item.id, 1), 409);
    expect((await listProductFeedback(db, owner)).items).toEqual([updated]);
    await deleteProductFeedback(db, owner, item.id, 2);
    expect((await listProductFeedback(db, owner)).items).toEqual([]);
    await expectError(deleteProductFeedback(db, owner, item.id, 2), 404);
  });

  it("keyset-paginates microsecond timestamps even after the cursor row is deleted", async () => {
    const items = [];
    for (let i = 1; i <= 5; i++) {
      const item = await createProductFeedback(db, owner, draft());
      items.push(item);
      await db.query(
        "UPDATE product_feedback SET created_at=$1::timestamptz WHERE id=$2",
        [`2026-11-10T12:00:00.12345${i}Z`, item.id],
      );
    }
    await createProductFeedback(db, other, draft());
    const first = await listProductFeedback(db, owner, { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([
      items[4].id,
      items[3].id,
    ]);
    expect(first.nextCursor).toBeTypeOf("string");
    expect(first.nextCursor).not.toContain(owner);
    await deleteProductFeedback(db, owner, first.items[1].id, 1);
    const second = await listProductFeedback(db, owner, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.id)).toEqual([
      items[2].id,
      items[1].id,
    ]);
    const third = await listProductFeedback(db, owner, {
      limit: 2,
      cursor: second.nextCursor!,
    });
    expect(third.items.map((item) => item.id)).toEqual([items[0].id]);
    expect(third.nextCursor).toBeNull();
  });

  it("bounds pages and rejects malformed cursors", async () => {
    await seedFeedback(51);
    const page = await listProductFeedback(db, owner, { limit: 50 });
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBeTypeOf("string");
    for (const limit of [0, -1, 51, 1.5, NaN])
      await expectError(listProductFeedback(db, owner, { limit }), 400);
    for (const cursor of [
      "",
      "a".repeat(257),
      "not-canonical=",
      Buffer.from(
        '{"v":2,"t":"2026-11-10T12:00:00.000000Z","id":"' + randomUUID() + '"}',
      ).toString("base64url"),
      Buffer.from(
        '{"v":1,"t":"not a timestamp","id":"' + randomUUID() + '"}',
      ).toString("base64url"),
    ])
      await expectError(listProductFeedback(db, owner, { cursor }), 400);
  });

  it("validates normalized plain text using PostgreSQL-compatible Unicode character bounds", async () => {
    const unicode = await createProductFeedback(
      db,
      owner,
      draft({
        title: "🎵".repeat(160),
        body: "🎶".repeat(4000),
        featureId: null,
      }),
    );
    expect(unicode.title).toBe("🎵".repeat(160));
    expect(unicode.body).toBe("🎶".repeat(4000));
    for (const change of [
      { title: "ab" },
      { title: "a".repeat(161) },
      { title: "Title\nnew line" },
      { body: "too short" },
      { body: "a".repeat(4001) },
      { body: "Text with \u0000 hidden data" },
      { kind: "question" },
      { featureId: "not/a/stable-id" },
      { requestId: "not-a-uuid" },
    ])
      await expectError(
        createProductFeedback(db, owner, {
          ...draft(),
          ...change,
        } as CreateProductFeedback),
        400,
      );
    expect((await listProductFeedback(db, owner)).items).toHaveLength(1);
  });

  it("parameterizes literal report text and rejects ownership or revision injection fields", async () => {
    const text =
      "Literal text: '); DROP TABLE app_user; -- <script>plain text</script>";
    const item = await createProductFeedback(db, owner, draft({ body: text }));
    expect(item.body).toBe(text);
    expect(await db.query("SELECT id FROM app_user")).toHaveLength(2);
    await expectError(
      createProductFeedback(db, owner, {
        ...draft(),
        userId: other,
      } as unknown as CreateProductFeedback),
      400,
    );
    await expectError(
      updateProductFeedback(
        db,
        owner,
        item.id,
        { userId: other } as unknown as ProductFeedbackChanges,
        1,
      ),
      400,
    );
    await expectError(updateProductFeedback(db, owner, item.id, {}, 1), 400);
    for (const expected of [0, -1, 1.5, 2_147_483_648]) {
      await expectError(
        updateProductFeedback(
          db,
          owner,
          item.id,
          { title: "Valid title" },
          expected,
        ),
        400,
      );
      await expectError(
        deleteProductFeedback(db, owner, item.id, expected),
        400,
      );
    }
  });

  it("cascades account deletion across votes and private feedback without orphan totals", async () => {
    await setVote(db, owner, "queue-editing", true);
    await setVote(db, other, "queue-editing", true);
    await createProductFeedback(db, owner, draft());
    await createProductFeedback(db, other, draft());
    await db.query("DELETE FROM app_user WHERE id=$1", [owner]);
    expect(await getFeatureVoteCounts(db, ["queue-editing"])).toEqual({
      "queue-editing": 1,
    });
    expect((await listProductFeedback(db, owner)).items).toEqual([]);
    expect((await listProductFeedback(db, other)).items).toHaveLength(1);
    await expectError(createProductFeedback(db, owner, draft()), 401);
    await expectError(setVote(db, owner, "queue-editing", true), 401);
  });
});
