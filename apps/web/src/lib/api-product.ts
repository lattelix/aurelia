import { z } from "zod";
import { AppError, canVote, productRegistryV1 } from "@aurelia/core";
import { rateLimit } from "@aurelia/auth";
import {
  getDatabase,
  getFeatureVoteCounts,
  listOwnVotedFeatureIds,
  setVote,
  createProductFeedback,
  listProductFeedback,
  updateProductFeedback,
  deleteProductFeedback,
  type Database,
  type ProductFeedback,
} from "@aurelia/database";
import {
  account,
  assertAccountOwner,
  ACCOUNT_HEADER,
  body,
  json,
} from "./http";

const maximumBodyBytes = 8192;
const featureIds = productRegistryV1.features.map((feature) => feature.id);
const knownFeatures = new Set(featureIds);
const featureId = z
  .string()
  .max(80)
  .refine((value) => knownFeatures.has(value), "Unknown feature");
const feedbackFields = {
  kind: z.enum(["bug", "idea", "feature"]),
  title: z
    .string()
    .trim()
    .min(3)
    .max(160)
    .refine((value) => !value.includes("\0"), "Invalid text"),
  body: z
    .string()
    .trim()
    .min(10)
    .max(4000)
    .refine((value) => !value.includes("\0"), "Invalid text"),
  featureId: featureId.nullable().optional(),
};
const createFeedback = z
  .object({ requestId: z.uuid(), ...feedbackFields })
  .strict();
const expectedRevision = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const changeFeedback = z
  .object({
    expectedRevision,
    kind: feedbackFields.kind.optional(),
    title: feedbackFields.title.optional(),
    body: feedbackFields.body.optional(),
    featureId: feedbackFields.featureId,
  })
  .strict()
  .refine(
    (input) => Object.keys(input).some((key) => key !== "expectedRevision"),
    "Provide a feedback change",
  );
const removeFeedback = z.object({ expectedRevision }).strict();
const emptyInput = z.object({}).strict();
const feedbackQuery = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9]\d?$/)
      .transform(Number)
      .pipe(z.number().max(50))
      .optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

function publicFeedback(item: ProductFeedback) {
  return {
    id: item.id,
    kind: item.kind,
    featureId: item.featureId,
    title: item.title,
    body: item.body,
    revision: item.revision,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
function noQuery(request: Request) {
  if (new URL(request.url).search)
    throw new AppError(400, "Query parameters are not supported");
}
async function budget(
  db: Database,
  family: string,
  owner: string,
  limit: number,
  globalLimit: number,
  seconds = 60,
) {
  await rateLimit(db, `product:${family}:${owner}`, limit, seconds);
  await rateLimit(db, `product:${family}:global`, globalLimit, seconds);
}
async function voteSnapshot(db: Database, userId?: string) {
  const [counts, voted] = await Promise.all([
    getFeatureVoteCounts(db, featureIds),
    userId
      ? listOwnVotedFeatureIds(db, userId)
      : Promise.resolve([] as string[]),
  ]);
  return {
    counts,
    votedFeatureIds: voted.filter((id) => knownFeatures.has(id)),
  };
}

// Only product participation lives here; authentication and Origin remain server guards.
export async function productApi(path: string[], request: Request) {
  const collection = path[0];
  if (!["votes", "feedback"].includes(collection) || path.length > 2)
    return null;
  const itemId = path[1];
  const allowed =
    collection === "votes"
      ? itemId === undefined
        ? ["GET"]
        : ["PUT", "DELETE"]
      : itemId === undefined
        ? ["GET", "POST"]
        : ["PATCH", "DELETE"];
  if (!allowed.includes(request.method))
    return json({ error: "Method not allowed" }, 405);

  if (collection === "votes") {
    noQuery(request);
    if (itemId === undefined) {
      const user = await account();
      if (user && request.headers.get(ACCOUNT_HEADER) !== user.id)
        throw new AppError(
          409,
          "Your account changed. Refresh before continuing.",
        );
      const db = await getDatabase();
      await budget(db, "votes-read", user?.id ?? "guest", 60, 600);
      return json(await voteSnapshot(db, user?.id));
    }
    const user = await assertAccountOwner(request);
    const id = featureId.parse(itemId);
    const db = await getDatabase();
    await budget(db, "votes-write", user.id, 30, 300);
    emptyInput.parse(await body(request, maximumBodyBytes));
    if (request.method === "PUT" && !canVote(productRegistryV1, id))
      throw new AppError(409, "This feature is not open for voting.");
    await setVote(db, user.id, id, request.method === "PUT");
    return json(await voteSnapshot(db, user.id));
  }

  const user = await assertAccountOwner(request);
  const db = await getDatabase();
  if (itemId === undefined && request.method === "GET") {
    const parameters = [...new URL(request.url).searchParams];
    if (new Set(parameters.map(([key]) => key)).size !== parameters.length)
      throw new AppError(400, "Duplicate query parameters are not supported");
    const input = feedbackQuery.parse(Object.fromEntries(parameters));
    await budget(db, "feedback-read", user.id, 60, 300);
    const page = await listProductFeedback(db, user.id, input);
    return json({
      feedback: page.items.map(publicFeedback),
      nextCursor: page.nextCursor,
    });
  }
  noQuery(request);
  if (itemId === undefined) {
    await budget(db, "feedback-create", user.id, 5, 100, 3600);
    const input = createFeedback.parse(await body(request, maximumBodyBytes));
    return json(
      {
        feedback: publicFeedback(
          await createProductFeedback(db, user.id, input),
        ),
      },
      201,
    );
  }
  const id = z.uuid().parse(itemId);
  await budget(db, "feedback-write", user.id, 30, 300);
  const input = await body(request, maximumBodyBytes);
  if (request.method === "PATCH") {
    const { expectedRevision: revision, ...changes } =
      changeFeedback.parse(input);
    return json({
      feedback: publicFeedback(
        await updateProductFeedback(db, user.id, id, changes, revision),
      ),
    });
  }
  const { expectedRevision: revision } = removeFeedback.parse(input);
  await deleteProductFeedback(db, user.id, id, revision);
  return json({ ok: true });
}
