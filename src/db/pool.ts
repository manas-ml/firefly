import pg from "pg";

// Return BIGINT columns (chat and message ids) as numbers. Telegram ids fit in 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

export type Pool = pg.Pool;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}
