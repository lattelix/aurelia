import { getDatabase } from "../packages/database/src/connection";
import { existsSync } from "node:fs";
if (existsSync("apps/web/.env.local"))
  process.loadEnvFile("apps/web/.env.local");
const db = await getDatabase();
const tables = await db.query<{ count: string }>(
  "SELECT count(*) FROM information_schema.tables WHERE table_schema=$1",
  ["public"],
);
console.log(`Migrations applied. ${tables[0].count} tables ready.`);
await db.close();
