import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApprovalService } from "../approvals/service.ts";
import type { BudgetService } from "../budget/budget.ts";
import type { Settings } from "../control/settings.ts";
import type { Pool } from "../db/pool.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import { describeSchedule, type SchedulerService } from "../scheduler/service.ts";

export interface DashboardDeps {
  token: string;
  staticDir: string;
  pool: Pool;
  orchestrator: Orchestrator;
  approvals: ApprovalService;
  scheduler: SchedulerService;
  memory: MemoryStore;
  budget: BudgetService;
  settings: Settings;
  startedAt: Date;
  redact: (text: string) => string;
}

const COOKIE = "ff_dash";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieToken(req: FastifyRequest): string | undefined {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};

/**
 * Local dashboard and its JSON API, on the agent's HTTP server (published on
 * 127.0.0.1 only). The sandbox can reach that port on the internal network, so
 * everything except /health requires DASHBOARD_TOKEN: open
 * http://127.0.0.1:8080/?token=... once and a cookie takes over. State-changing
 * calls also need an `x-firefly` header, which a cross-site form can't send.
 */
export function registerDashboard(app: FastifyInstance, d: DashboardDeps): void {
  const authed = (req: FastifyRequest): boolean => {
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
    const t = bearer ?? cookieToken(req);
    return t !== undefined && safeEqual(t, d.token);
  };
  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    void reply.headers(SECURITY_HEADERS);
    if (!authed(req)) return reply.code(401).send({ error: "unauthorized" });
    if (req.method !== "GET" && req.headers["x-firefly"] !== "1") return reply.code(403).send({ error: "missing x-firefly header" });
  };
  /** Everything the API returns passes through the vault redactor. */
  const json = (reply: FastifyReply, data: unknown) => reply.type("application/json").send(d.redact(JSON.stringify(data)));

  // ---------- page ----------

  const assets: Record<string, string> = { "/app.js": "application/javascript", "/style.css": "text/css" };
  app.get("/", async (req, reply) => {
    void reply.headers(SECURITY_HEADERS);
    const q = (req.query as { token?: string }).token;
    if (q !== undefined) {
      if (!safeEqual(q, d.token)) return reply.code(401).type("text/plain").send("Wrong token.");
      // Swap the token in the URL for a cookie, then drop it from the address bar.
      return reply
        .header("set-cookie", `${COOKIE}=${encodeURIComponent(d.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`)
        .redirect("/");
    }
    if (!authed(req)) {
      return reply.code(401).type("text/html").send("<!doctype html><title>Firefly</title><p>Open the dashboard link printed by <code>make dashboard</code>.</p>");
    }
    return reply.type("text/html").send(await readFile(path.join(d.staticDir, "index.html")));
  });
  for (const [file, type] of Object.entries(assets)) {
    app.get(file, async (req, reply) => {
      void reply.headers(SECURITY_HEADERS);
      if (!authed(req)) return reply.code(401).send();
      return reply.type(type).send(await readFile(path.join(d.staticDir, file.slice(1))));
    });
  }

  // ---------- API ----------

  app.register(async (api) => {
    api.addHook("onRequest", guard);

    api.get("/api/status", async (_req, reply) => {
      const [paused, pending, report] = await Promise.all([
        d.settings.isPaused(),
        d.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM approvals WHERE status = 'pending'"),
        d.budget.report(),
      ]);
      return json(reply, {
        paused,
        uptimeSeconds: Math.round((Date.now() - d.startedAt.getTime()) / 1000),
        pendingApprovals: pending.rows[0]?.n ?? 0,
        running: d.orchestrator.listActive().map((r) => ({
          taskId: r.taskId,
          kind: r.kind,
          name: r.name,
          prompt: r.prompt,
          startedAt: r.startedAt,
          waitingApproval: r.waitingApproval,
        })),
        spend: { today: report.todayUsd, month: report.monthUsd, cap: report.monthCapUsd },
      });
    });

    api.post("/api/pause", async (req, reply) => {
      const { paused } = (req.body ?? {}) as { paused?: unknown };
      if (typeof paused !== "boolean") return reply.code(400).send({ error: "paused must be true or false" });
      await d.settings.setPaused(paused);
      return json(reply, { paused });
    });

    api.get("/api/tasks", async (req, reply) => {
      const limit = Math.min(Number((req.query as { limit?: string }).limit) || 50, 500);
      const r = await d.pool.query(
        `SELECT t.id, t.chat_id, t.kind, s.name AS schedule_name, t.prompt, t.status, t.error, t.created_at, t.started_at, t.finished_at,
                COALESCE((SELECT sum(cost_usd) FROM usage u WHERE u.task_id = t.id), 0)::float8 AS cost,
                (SELECT count(*)::int FROM tool_calls c WHERE c.task_id = t.id) AS tool_calls
         FROM tasks t LEFT JOIN schedules s ON s.id = t.schedule_id ORDER BY t.created_at DESC LIMIT $1`,
        [limit],
      );
      return json(reply, r.rows);
    });

    api.get("/api/tool-calls", async (req, reply) => {
      const q = req.query as { limit?: string; taskId?: string };
      const limit = Math.min(Number(q.limit) || 100, 1000);
      const r = await d.pool.query(
        `SELECT c.id, c.task_id, c.tool, c.args, c.decision, c.reason, c.outcome, c.result_summary, c.is_error, c.duration_ms, c.created_at
         FROM tool_calls c WHERE ($2::uuid IS NULL OR c.task_id = $2) ORDER BY c.created_at DESC LIMIT $1`,
        [limit, q.taskId && /^[0-9a-f-]{36}$/.test(q.taskId) ? q.taskId : null],
      );
      return json(reply, r.rows);
    });

    api.get("/api/approvals", async (_req, reply) => {
      const r = await d.pool.query(
        `SELECT a.id, a.task_id, a.summary, a.status, a.requested_at, a.expires_at, a.resolved_at, t.prompt
         FROM approvals a JOIN tasks t ON t.id = a.task_id
         ORDER BY (a.status = 'pending') DESC, a.requested_at DESC LIMIT 100`,
      );
      return json(reply, r.rows);
    });

    api.post("/api/approvals/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const { action } = (req.body ?? {}) as { action?: unknown };
      if (!/^[0-9a-f-]{36}$/.test(id) || (action !== "approve" && action !== "deny")) {
        return reply.code(400).send({ error: "need an approval id and action approve|deny" });
      }
      const { check } = await d.approvals.resolveFromButton({ id, action, userAllowed: true, chatId: undefined });
      if (!check.ok) return reply.code(409).send({ error: check.message });
      return json(reply, { status: check.next });
    });

    api.get("/api/usage", async (_req, reply) => {
      const [report, daily] = await Promise.all([
        d.budget.report(),
        d.pool.query(
          `SELECT to_char(day, 'YYYY-MM-DD') AS day, COALESCE(sum(u.cost_usd), 0)::float8 AS cost,
                  COALESCE(sum(u.input_tokens + u.output_tokens), 0)::int AS tokens
           FROM generate_series((now() - interval '29 days')::date, now()::date, interval '1 day') AS day
           LEFT JOIN usage u ON u.created_at::date = day::date
           GROUP BY day ORDER BY day`,
        ),
      ]);
      return json(reply, { ...report, daily: daily.rows });
    });

    api.get("/api/schedules", async (_req, reply) => {
      const r = await d.pool.query("SELECT * FROM schedules ORDER BY name");
      return json(
        reply,
        r.rows.map((s: Parameters<typeof describeSchedule>[0] & Record<string, unknown>) => ({ ...s, description: describeSchedule(s) })),
      );
    });

    api.post("/api/schedules/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const { enabled } = (req.body ?? {}) as { enabled?: unknown };
      if (!/^[0-9a-f-]{36}$/.test(id) || typeof enabled !== "boolean") return reply.code(400).send({ error: "need id and enabled" });
      const row = await d.scheduler.setEnabled(id, enabled);
      if (!row) return reply.code(404).send({ error: "not found" });
      return json(reply, row);
    });

    api.get("/api/memory", async (_req, reply) => {
      const topics = await d.memory.listTopics();
      const out = [];
      for (const t of topics) out.push({ ...t, content: (await d.memory.readTopic(t.topic)) ?? "" });
      return json(reply, out);
    });
  });
}
