import type { Pool } from "../db/pool.ts";

export interface BudgetLimits {
  monthlyUsd: number;
  taskUsd: number;
  timezone: string;
}

export interface UsageReport {
  todayUsd: number;
  monthUsd: number;
  monthCapUsd: number;
  topTasks: { id: string; prompt: string; cost: number; created_at: Date }[];
}

export type BudgetCheck = { ok: true; warnings: string[] } | { ok: false; reason: string; warnings: string[] };

/** Money comparisons with a little slack for float rounding (0.8 * 0.05 !== 0.04). */
const atLeast = (a: number, b: number) => a >= b - 1e-9;

const fmt = (usd: number) => `$${usd.toFixed(usd < 1 ? 4 : 2)}`;

/**
 * Spending limits, enforced from the `usage` table before every model call.
 * Warns once at 80%; stops at 100%. /raise lifts the monthly cap for the
 * current month only.
 */
export class BudgetService {
  private readonly warnedTasks = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly limits: BudgetLimits,
  ) {}

  /** First day of the current month in the configured time zone. */
  private async month(): Promise<string> {
    const r = await this.pool.query<{ m: string }>("SELECT to_char(date_trunc('month', now() AT TIME ZONE $1), 'YYYY-MM-DD') AS m", [
      this.limits.timezone,
    ]);
    return r.rows[0]!.m;
  }

  private async spend(): Promise<{ month: number; today: number }> {
    const r = await this.pool.query<{ month: number; today: number }>(
      `SELECT
         COALESCE(sum(cost_usd) FILTER (WHERE created_at >= (date_trunc('month', now() AT TIME ZONE $1) AT TIME ZONE $1)), 0)::float8 AS month,
         COALESCE(sum(cost_usd) FILTER (WHERE created_at >= (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)), 0)::float8 AS today
       FROM usage`,
      [this.limits.timezone],
    );
    return r.rows[0]!;
  }

  async monthCap(): Promise<number> {
    const month = await this.month();
    const r = await this.pool.query<{ raised: number }>("SELECT raised_usd::float8 AS raised FROM budget_months WHERE month = $1", [month]);
    return this.limits.monthlyUsd + (r.rows[0]?.raised ?? 0);
  }

  private async taskSpend(taskId: string): Promise<number> {
    const r = await this.pool.query<{ s: number }>("SELECT COALESCE(sum(cost_usd), 0)::float8 AS s FROM usage WHERE task_id = $1", [taskId]);
    return r.rows[0]!.s;
  }

  async check(taskId: string): Promise<BudgetCheck> {
    const warnings: string[] = [];
    const [{ month: monthSpend }, cap, taskSpend] = await Promise.all([this.spend(), this.monthCap(), this.taskSpend(taskId)]);

    if (atLeast(monthSpend, cap)) {
      return {
        ok: false,
        warnings,
        reason: `Monthly budget reached: ${fmt(monthSpend)} of ${fmt(cap)}. Send /raise to lift the cap for this month.`,
      };
    }
    if (atLeast(taskSpend, this.limits.taskUsd)) {
      return {
        ok: false,
        warnings,
        reason: `This task hit its budget of ${fmt(this.limits.taskUsd)} (spent ${fmt(taskSpend)}), so I stopped it. Try a narrower request, or raise TASK_BUDGET_USD.`,
      };
    }

    if (atLeast(monthSpend, 0.8 * cap)) {
      const month = await this.month();
      const r = await this.pool.query(
        `INSERT INTO budget_months (month, warned_at) VALUES ($1, now())
         ON CONFLICT (month) DO UPDATE SET warned_at = now() WHERE budget_months.warned_at IS NULL`,
        [month],
      );
      if ((r.rowCount ?? 0) > 0) warnings.push(`⚠️ 80% of this month's budget used: ${fmt(monthSpend)} of ${fmt(cap)}.`);
    }
    if (atLeast(taskSpend, 0.8 * this.limits.taskUsd) && !this.warnedTasks.has(taskId)) {
      this.warnedTasks.add(taskId);
      warnings.push(`⚠️ This task has used 80% of its budget (${fmt(taskSpend)} of ${fmt(this.limits.taskUsd)}).`);
    }
    return { ok: true, warnings };
  }

  /** Lift this month's cap by `amount` (default: one more monthly budget). Returns the new cap. */
  async raise(amount?: number): Promise<number> {
    const add = amount ?? this.limits.monthlyUsd;
    if (!Number.isFinite(add) || add <= 0 || add > 10_000) throw new Error("amount must be a positive number of dollars");
    const month = await this.month();
    await this.pool.query(
      `INSERT INTO budget_months (month, raised_usd) VALUES ($1, $2)
       ON CONFLICT (month) DO UPDATE SET raised_usd = budget_months.raised_usd + EXCLUDED.raised_usd, warned_at = NULL`,
      [month, add],
    );
    return this.monthCap();
  }

  async report(): Promise<UsageReport> {
    const [{ month, today }, cap] = await Promise.all([this.spend(), this.monthCap()]);
    const top = await this.pool.query<{ id: string; prompt: string; cost: number; created_at: Date }>(
      `SELECT t.id, t.prompt, sum(u.cost_usd)::float8 AS cost, t.created_at
       FROM usage u JOIN tasks t ON t.id = u.task_id
       WHERE u.created_at >= (date_trunc('month', now() AT TIME ZONE $1) AT TIME ZONE $1)
       GROUP BY t.id ORDER BY cost DESC LIMIT 5`,
      [this.limits.timezone],
    );
    return { todayUsd: today, monthUsd: month, monthCapUsd: cap, topTasks: top.rows };
  }
}

export { fmt as formatUsd };
