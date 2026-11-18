import { statfs } from "node:fs/promises";
import type { PgBoss } from "pg-boss";
import type { SandboxClient } from "../agent/sandbox-client.ts";
import { formatUsd } from "../budget/budget.ts";
import type { Pool } from "../db/pool.ts";
import type { Logger } from "../logger.ts";
import { excerpt } from "../orchestrator/orchestrator.ts";

export const HEALTH_QUEUE = "health.report";

export interface HealthReportDeps {
  pool: Pool;
  boss: PgBoss;
  sandbox: SandboxClient;
  log: Logger;
  send(chatId: number, markdown: string): Promise<void>;
  chatIds: readonly number[];
  dataDir: string;
  workspace: string;
  timezone: string;
  cron: string;
  startedAt: Date;
}

function duration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 48) return `${h} h ${Math.floor((ms % 3_600_000) / 60_000)} min`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Weekly Telegram report: uptime, spend, failed tasks, disk usage. Also /health on demand. */
export class HealthReporter {
  constructor(private readonly d: HealthReportDeps) {}

  async start(): Promise<void> {
    const { boss } = this.d;
    await this.recordBoot();
    if (!(await boss.getQueue(HEALTH_QUEUE))) await boss.createQueue(HEALTH_QUEUE, { retryLimit: 0 });
    await boss.schedule(HEALTH_QUEUE, this.d.cron, {}, { tz: this.d.timezone });
    await boss.work(HEALTH_QUEUE, async () => {
      for (const chatId of this.d.chatIds) await this.sendTo(chatId);
    });
  }

  private async recordBoot(): Promise<void> {
    await this.d.pool.query(
      `INSERT INTO settings (key, value) VALUES ('boots', jsonb_build_array(to_jsonb(now())))
       ON CONFLICT (key) DO UPDATE SET value = (
         SELECT COALESCE(jsonb_agg(b ORDER BY b DESC), '[]'::jsonb) FROM (
           SELECT b FROM jsonb_array_elements(settings.value || jsonb_build_array(to_jsonb(now()))) AS b
           ORDER BY b DESC LIMIT 50) t),
         updated_at = now()`,
    );
  }

  async sendTo(chatId: number): Promise<void> {
    try {
      await this.d.send(chatId, await this.build());
    } catch (err) {
      this.d.log.error({ err }, "health report failed");
    }
  }

  async build(): Promise<string> {
    const { pool, timezone } = this.d;
    const [spend, failed, errors, boots, db] = await Promise.all([
      pool.query<{ week: number; month: number }>(
        `SELECT COALESCE(sum(cost_usd) FILTER (WHERE created_at > now() - interval '7 days'), 0)::float8 AS week,
                COALESCE(sum(cost_usd) FILTER (WHERE created_at >= (date_trunc('month', now() AT TIME ZONE $1) AT TIME ZONE $1)), 0)::float8 AS month
         FROM usage`,
        [timezone],
      ),
      pool.query<{ failed: number; total: number }>(
        `SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*)::int AS total
         FROM tasks WHERE created_at > now() - interval '7 days'`,
      ),
      pool.query<{ prompt: string; error: string }>(
        `SELECT prompt, error FROM tasks WHERE status = 'failed' AND created_at > now() - interval '7 days'
         ORDER BY created_at DESC LIMIT 3`,
      ),
      pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM settings, jsonb_array_elements_text(value) AS b
         WHERE key = 'boots' AND b::timestamptz > now() - interval '7 days'`,
      ),
      pool.query<{ size: string }>("SELECT pg_database_size(current_database())::bigint AS size"),
    ]);

    const disk = await statfs(this.d.dataDir).catch(() => undefined);
    let workspace = "unknown";
    try {
      const ws = `'${this.d.workspace.replace(/'/g, "")}'`;
      const r = await this.d.sandbox.exec({
        command: `du -sh ${ws} 2>/dev/null | cut -f1; df -h ${ws} | tail -1 | awk '{print $4" free of "$2}'`,
        timeoutSec: 30,
      });
      workspace = r.stdout.trim().split("\n").join(", ");
    } catch {
      /* sandbox down: reported as unknown */
    }

    const s = spend.rows[0]!;
    const f = failed.rows[0]!;
    const lines = [
      "📋 **Weekly health report**",
      "",
      `⏱ Up ${duration(Date.now() - this.d.startedAt.getTime())}; ${Math.max(0, (boots.rows[0]?.n ?? 1) - 1)} restart(s) in the last 7 days`,
      `💰 Spend: ${formatUsd(s.week)} this week, ${formatUsd(s.month)} this month`,
      `🗂 Tasks: ${f.total} in the last 7 days, ${f.failed} failed`,
      ...errors.rows.map((e) => `  • ${excerpt(e.prompt, 40)}: ${excerpt(e.error ?? "", 80)}`),
      `💾 Disk: ${disk ? `${bytes(Number(disk.bavail) * Number(disk.bsize))} free of ${bytes(Number(disk.blocks) * Number(disk.bsize))}` : "unknown"}; database ${bytes(Number(db.rows[0]?.size ?? 0))}; workspace ${workspace}`,
    ];
    return lines.join("\n");
  }
}
