import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "../../src/db/migrate.ts";
import { createPool, type Pool } from "../../src/db/pool.ts";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:test@127.0.0.1:55432/firefly";

/** Create a throwaway database with migrations applied. */
export async function createTestDb(): Promise<{ url: string; pool: Pool; drop: () => Promise<void> }> {
  const name = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  await migrate(pool, "migrations");
  return {
    url: url.toString(),
    pool,
    drop: async () => {
      await pool.end();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
