import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "./migrate.ts";
import { createPool } from "./pool.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const dir = process.env.MIGRATIONS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const pool = createPool(url);
try {
  const applied = await migrate(pool, dir, (m) => console.log(m));
  console.log(applied.length ? `applied ${applied.length} migration(s)` : "database is up to date");
} finally {
  await pool.end();
}
