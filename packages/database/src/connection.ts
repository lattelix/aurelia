import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";
import { mkdir } from "node:fs/promises";
import { resolve, basename, dirname } from "node:path";
import { migrations } from "./migrations";

export interface Database {
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
function wrapPg(pool: Pool, client?: PoolClient): Database {
  return {
    async query<T extends Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ) {
      return (await (client ?? pool).query<T>(sql, params)).rows;
    },
    async transaction<T>(fn: (tx: Database) => Promise<T>) {
      if (client) return fn(wrapPg(pool, client));
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const value = await fn(wrapPg(pool, c));
        await c.query("COMMIT");
        return value;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
    async close() {
      if (!client) await pool.end();
    },
  };
}
function wrapLite(lite: PGlite): Database {
  return {
    async query<T extends Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ) {
      return (await lite.query<T>(sql, params)).rows;
    },
    async transaction<T>(fn: (tx: Database) => Promise<T>) {
      return lite.transaction(async (tx) => {
        const adapter: Database = {
          query: async <T extends Record<string, unknown>>(
            sql: string,
            params: unknown[] = [],
          ) => (await tx.query<T>(sql, params)).rows,
          transaction: async (nested) => nested(adapter),
          close: async () => {},
        };
        return fn(adapter);
      });
    },
    async close() {
      await lite.close();
    },
  };
}
export async function migrate(db: Database) {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migration (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  // DDL is serialized in PostgreSQL so concurrent cold starts cannot interleave migrations.
  await db.transaction(async (tx) => {
    await tx.query("LOCK TABLE schema_migration IN EXCLUSIVE MODE");
    const applied = await tx.query<{ version: number }>(
      "SELECT version FROM schema_migration",
    );
    for (const m of migrations)
      if (!applied.some((x) => x.version === m.version)) {
        // Split our fixed migration file; user data never reaches this path.
        for (const statement of m.sql
          .split(";")
          .map((x) => x.trim())
          .filter(Boolean))
          await tx.query(statement);
        await tx.query("INSERT INTO schema_migration(version) VALUES($1)", [
          m.version,
        ]);
      }
  });
}
const defaultDirectory = () =>
  resolve(
    process.cwd(),
    basename(process.cwd()) === "web" &&
      basename(dirname(process.cwd())) === "apps"
      ? "../../.data"
      : ".data",
  );
export async function createDatabase(
  options: { url?: string; directory?: string; memory?: boolean } = {},
): Promise<Database> {
  let db: Database;
  if (options.url) {
    db = wrapPg(
      new Pool({
        connectionString: options.url,
        max: 5,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
      }),
    );
  } else {
    const dir = options.memory
      ? undefined
      : (options.directory ?? defaultDirectory());
    if (dir) await mkdir(dir, { recursive: true });
    db = wrapLite(new PGlite(dir));
  }
  await migrate(db);
  return db;
}
const globalDb = globalThis as typeof globalThis & {
  aureliaDb?: Promise<Database>;
};
export function getDatabase() {
  if (!globalDb.aureliaDb) {
    if (process.env.VERCEL && !process.env.DATABASE_URL)
      throw new Error(
        "DATABASE_URL is required on serverless hosts. Disk storage is for local development.",
      );
    globalDb.aureliaDb = createDatabase({
      url: process.env.DATABASE_URL,
      directory: process.env.DATA_DIR ?? defaultDirectory(),
    }).catch((e) => {
      delete globalDb.aureliaDb;
      throw e;
    });
  }
  return globalDb.aureliaDb;
}
