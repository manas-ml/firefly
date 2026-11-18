import type { Pool } from "../db/pool.ts";

/** Global switches stored in the `settings` table (shared by Telegram, the dashboard and routines). */
export class Settings {
  private pausedCache: { value: boolean; at: number } | undefined;

  constructor(private readonly pool: Pool) {}

  async isPaused(): Promise<boolean> {
    if (this.pausedCache && Date.now() - this.pausedCache.at < 2000) return this.pausedCache.value;
    const r = await this.pool.query<{ value: boolean }>("SELECT value FROM settings WHERE key = 'paused'");
    const value = r.rows[0]?.value === true;
    this.pausedCache = { value, at: Date.now() };
    return value;
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('paused', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(paused)],
    );
    this.pausedCache = { value: paused, at: Date.now() };
  }
}
