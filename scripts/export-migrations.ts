import { writeFile, mkdir } from "node:fs/promises";
import { migrations } from "../packages/database/src/migrations";
await mkdir("packages/database/migrations", { recursive: true });
for (const migration of migrations) {
  await writeFile(
    `packages/database/migrations/${String(migration.version).padStart(3, "0")}_initial.sql`,
    `-- Generated from src/migrations.ts; do not edit independently.\n${migration.sql.trim()}\n`,
  );
}
