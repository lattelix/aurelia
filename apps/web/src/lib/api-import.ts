import { z } from "zod";
import { getDatabase } from "@aurelia/database";
import { rateLimit } from "@aurelia/auth";
import { parseLibraryImport, IMPORT_BYTE_LIMIT } from "@aurelia/integrations";
import { body, json, requireAccount } from "./http";
import {
  fixture,
  runImport,
  getImports,
  resolveImport,
} from "./import-service";
export async function importApi(path: string[], request: Request) {
  const user = await requireAccount();
  const db = await getDatabase();
  if (!path.length && request.method === "GET")
    return json(await getImports(db, user.id));
  if (path[0] === "fixture" && request.method === "GET") return json(fixture);
  if (["fixture", "file"].includes(path[0]) && request.method === "POST") {
    await rateLimit(db, `import:${user.id}`, 6, 3600);
    const snapshot =
      path[0] === "fixture"
        ? fixture
        : parseLibraryImport(await body(request, IMPORT_BYTE_LIMIT));
    const id = await runImport(db, user.id, snapshot);
    return json({ id, ...(await getImports(db, user.id)) });
  }
  if (path[0] === "resolve" && request.method === "POST") {
    const input = z
      .object({ itemId: z.uuid(), trackId: z.string().max(160) })
      .parse(await body(request));
    await resolveImport(db, user.id, input.itemId, input.trackId);
    return json(await getImports(db, user.id));
  }
  return null;
}
