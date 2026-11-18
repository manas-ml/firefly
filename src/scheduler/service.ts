import type { PgBoss } from "pg-boss";
import type { Pool } from "../db/pool.ts";
import type { Logger } from "../logger.ts";
import { describeCron, nextRun, validateCron } from "./cron.ts";

export const FIRE_QUEUE = "schedule.fire";

export interface ScheduleRow {
  id: string;
  chat_id: number;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  last_run_at: Date | null;
  next_run_at: Date | null;
  created_at: Date;
}

export interface FireJobData {
  scheduleId: string;
}

/** What happens when a schedule fires (the orchestrator enqueues a routine run). */
export type FireHandler = (schedule: ScheduleRow, manual: boolean) => Promise<void>;

/**
 * Routines: rows in `schedules`, each registered as a pg-boss cron schedule
 * (queue `schedule.fire`, keyed by schedule id) evaluated in its own time zone.
 */
export class SchedulerService {
  private onFire: FireHandler | undefined;

  constructor(
    private readonly boss: PgBoss,
    private readonly pool: Pool,
    private readonly log: Logger,
    readonly defaultTimezone: string,
    /** Return true to skip firing (global pause). */
    private readonly isPaused: () => Promise<boolean> = async () => false,
  ) {}

  setFireHandler(handler: FireHandler): void {
    this.onFire = handler;
  }

  async start(): Promise<void> {
    if (!(await this.boss.getQueue(FIRE_QUEUE))) await this.boss.createQueue(FIRE_QUEUE, { retryLimit: 0 });
    await this.sync();
    await this.boss.work<FireJobData>(FIRE_QUEUE, { pollingIntervalSeconds: 1 }, async (jobs) => {
      for (const job of jobs) await this.fire(job.data.scheduleId, false);
    });
  }

  /** Make pg-boss's schedules match the table (after restore, crash, or manual DB edits). */
  async sync(): Promise<void> {
    const rows = (await this.pool.query<ScheduleRow>("SELECT * FROM schedules")).rows;
    const wanted = new Map(rows.filter((r) => r.enabled).map((r) => [r.id, r]));
    for (const s of await this.boss.getSchedules(FIRE_QUEUE)) {
      if (!s.key || !wanted.has(s.key)) await this.boss.unschedule(FIRE_QUEUE, s.key);
    }
    for (const row of wanted.values()) await this.register(row);
  }

  private async register(row: ScheduleRow): Promise<void> {
    await this.boss.schedule(FIRE_QUEUE, row.cron, { scheduleId: row.id } satisfies FireJobData, { tz: row.timezone, key: row.id });
    await this.pool.query("UPDATE schedules SET next_run_at = $2 WHERE id = $1", [row.id, nextRun(row.cron, row.timezone) ?? null]);
  }

  async create(input: { chatId: number; name: string; cron: string; timezone?: string; prompt: string }): Promise<ScheduleRow> {
    const timezone = input.timezone || this.defaultTimezone;
    const name = input.name.trim();
    if (!/^[\w][\w .:-]{0,59}$/.test(name)) throw new Error("name must be 1-60 letters, digits, spaces or - _ . :");
    const invalid = validateCron(input.cron, timezone);
    if (invalid) throw new Error(invalid);
    if (!input.prompt.trim()) throw new Error("prompt is required");
    await this.pool.query("INSERT INTO chats (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [input.chatId]);
    const r = await this.pool.query<ScheduleRow>(
      `INSERT INTO schedules (chat_id, name, cron, timezone, prompt) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (chat_id, name) DO UPDATE SET cron = EXCLUDED.cron, timezone = EXCLUDED.timezone,
         prompt = EXCLUDED.prompt, enabled = true
       RETURNING *`,
      [input.chatId, name, input.cron.trim(), timezone, input.prompt.trim()],
    );
    const row = r.rows[0]!;
    await this.register(row);
    return (await this.get(row.id))!;
  }

  async get(id: string): Promise<ScheduleRow | undefined> {
    return (await this.pool.query<ScheduleRow>("SELECT * FROM schedules WHERE id = $1", [id])).rows[0];
  }

  async findByName(chatId: number, name: string): Promise<ScheduleRow | undefined> {
    return (
      await this.pool.query<ScheduleRow>("SELECT * FROM schedules WHERE chat_id = $1 AND lower(name) = lower($2)", [chatId, name.trim()])
    ).rows[0];
  }

  async list(chatId: number): Promise<ScheduleRow[]> {
    return (await this.pool.query<ScheduleRow>("SELECT * FROM schedules WHERE chat_id = $1 ORDER BY name", [chatId])).rows;
  }

  async setEnabled(id: string, enabled: boolean): Promise<ScheduleRow | undefined> {
    const r = await this.pool.query<ScheduleRow>("UPDATE schedules SET enabled = $2 WHERE id = $1 RETURNING *", [id, enabled]);
    const row = r.rows[0];
    if (!row) return undefined;
    if (enabled) await this.register(row);
    else {
      await this.boss.unschedule(FIRE_QUEUE, id);
      await this.pool.query("UPDATE schedules SET next_run_at = NULL WHERE id = $1", [id]);
    }
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    await this.boss.unschedule(FIRE_QUEUE, id);
    const r = await this.pool.query("DELETE FROM schedules WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Fire a schedule now (cron tick, or /run). */
  async fire(id: string, manual: boolean): Promise<boolean> {
    const row = await this.get(id);
    if (!row) return false;
    if (!manual && !row.enabled) return false;
    if (await this.isPaused()) {
      this.log.info({ scheduleId: id, name: row.name }, "agent paused; routine skipped");
      return false;
    }
    await this.pool.query("UPDATE schedules SET last_run_at = now(), next_run_at = $2 WHERE id = $1", [
      id,
      row.enabled ? (nextRun(row.cron, row.timezone) ?? null) : null,
    ]);
    if (!this.onFire) throw new Error("scheduler has no fire handler");
    await this.onFire(row, manual);
    return true;
  }
}

export function describeSchedule(s: Pick<ScheduleRow, "name" | "cron" | "timezone">): string {
  return `${describeCron(s.cron)} (${s.timezone})`;
}
