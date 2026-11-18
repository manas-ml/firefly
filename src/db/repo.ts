import type { Pool } from "./pool.ts";

export type TaskStatus = "queued" | "running" | "waiting_approval" | "done" | "failed" | "cancelled";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";
export type ToolOutcome = "executed" | "denied_by_policy" | "denied_by_owner" | "expired" | "cancelled" | "error";

export interface ChatRow {
  id: number;
  model: string | null;
  session_file: string | null;
  session_started_at: Date | null;
  created_at: Date;
}

export interface TaskRow {
  id: string;
  chat_id: number;
  message_id: number | null;
  prompt: string;
  status: TaskStatus;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error: string | null;
  kind: "chat" | "routine";
  schedule_id: string | null;
  channel: "telegram" | "web";
  result: string | null;
}

export interface ApprovalRow {
  id: string;
  task_id: string;
  tool_call_id: string;
  chat_id: number;
  message_id: number | null;
  summary: string;
  status: ApprovalStatus;
  requested_at: Date;
  expires_at: Date;
  resolved_at: Date | null;
}

const FINAL: TaskStatus[] = ["done", "failed", "cancelled"];

export class Repo {
  constructor(private readonly pool: Pool) {}

  // ---------- chats ----------

  async ensureChat(chatId: number): Promise<ChatRow> {
    const r = await this.pool.query<ChatRow>(
      `INSERT INTO chats (id) VALUES ($1)
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
       RETURNING *`,
      [chatId],
    );
    return r.rows[0]!;
  }

  async getChat(chatId: number): Promise<ChatRow | undefined> {
    return (await this.pool.query<ChatRow>("SELECT * FROM chats WHERE id = $1", [chatId])).rows[0];
  }

  async setChatModel(chatId: number, model: string | null): Promise<void> {
    await this.ensureChat(chatId);
    await this.pool.query("UPDATE chats SET model = $2 WHERE id = $1", [chatId, model]);
  }

  async setChatSession(chatId: number, sessionFile: string | null, startedAt: Date | null): Promise<void> {
    await this.ensureChat(chatId);
    await this.pool.query("UPDATE chats SET session_file = $2, session_started_at = $3 WHERE id = $1", [
      chatId,
      sessionFile,
      startedAt,
    ]);
  }

  // ---------- tasks ----------

  async createTask(
    chatId: number,
    messageId: number | null,
    prompt: string,
    opts: { kind?: "chat" | "routine"; scheduleId?: string; channel?: "telegram" | "web" } = {},
  ): Promise<TaskRow> {
    await this.ensureChat(chatId);
    const r = await this.pool.query<TaskRow>(
      "INSERT INTO tasks (chat_id, message_id, prompt, kind, schedule_id, channel) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [chatId, messageId, prompt, opts.kind ?? "chat", opts.scheduleId ?? null, opts.channel ?? "telegram"],
    );
    return r.rows[0]!;
  }

  /** The text the owner saw for a task: the reply, or the notice that ended it. */
  async setTaskResult(id: string, text: string): Promise<void> {
    await this.pool.query("UPDATE tasks SET result = $2 WHERE id = $1", [id, text.slice(0, 100_000)]);
  }

  async listRecentTasks(chatId: number, limit = 10): Promise<(TaskRow & { cost: number; schedule_name: string | null })[]> {
    const r = await this.pool.query<TaskRow & { cost: number; schedule_name: string | null }>(
      `SELECT t.*, COALESCE((SELECT sum(cost_usd) FROM usage u WHERE u.task_id = t.id), 0)::float8 AS cost, s.name AS schedule_name
       FROM tasks t LEFT JOIN schedules s ON s.id = t.schedule_id
       WHERE t.chat_id = $1 ORDER BY t.created_at DESC LIMIT $2`,
      [chatId, limit],
    );
    return r.rows;
  }

  async getTask(id: string): Promise<TaskRow | undefined> {
    return (await this.pool.query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [id])).rows[0];
  }

  /** Move a task to a new status. Final statuses are sticky: a finished task never changes again. */
  async setTaskStatus(id: string, status: TaskStatus, error?: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE tasks SET
         status = $2,
         started_at = CASE WHEN $2 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
         finished_at = CASE WHEN $2 = ANY($4::text[]) THEN now() ELSE finished_at END,
         error = COALESCE($3, error)
       WHERE id = $1 AND NOT (status = ANY($4::text[]))`,
      [id, status, error ?? null, FINAL],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async countQueued(chatId: number): Promise<number> {
    const r = await this.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM tasks WHERE chat_id = $1 AND status = 'queued' AND kind = 'chat'",
      [chatId],
    );
    return r.rows[0]?.n ?? 0;
  }

  /** On startup: tasks a previous process was running can't be resumed. */
  async failInterruptedTasks(): Promise<TaskRow[]> {
    const r = await this.pool.query<TaskRow>(
      `UPDATE tasks SET status = 'failed', error = 'interrupted', finished_at = now()
       WHERE status IN ('running', 'waiting_approval') RETURNING *`,
    );
    return r.rows;
  }

  // ---------- tool calls ----------

  async insertToolCall(input: { taskId: string; tool: string; args: unknown; decision: string; reason: string }): Promise<string> {
    const r = await this.pool.query<{ id: string }>(
      "INSERT INTO tool_calls (task_id, tool, args, decision, reason) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [input.taskId, input.tool, JSON.stringify(input.args ?? {}), input.decision, input.reason],
    );
    return r.rows[0]!.id;
  }

  async finishToolCall(
    id: string,
    input: { outcome: ToolOutcome; resultSummary: string; isError: boolean; durationMs: number },
  ): Promise<void> {
    await this.pool.query(
      "UPDATE tool_calls SET outcome = $2, result_summary = $3, is_error = $4, duration_ms = $5 WHERE id = $1",
      [id, input.outcome, input.resultSummary.slice(0, 2000), input.isError, input.durationMs],
    );
  }

  // ---------- approvals ----------

  async createApproval(input: {
    taskId: string;
    toolCallId: string;
    chatId: number;
    summary: string;
    expiresAt: Date;
  }): Promise<ApprovalRow> {
    const r = await this.pool.query<ApprovalRow>(
      `INSERT INTO approvals (task_id, tool_call_id, chat_id, summary, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.taskId, input.toolCallId, input.chatId, input.summary, input.expiresAt],
    );
    return r.rows[0]!;
  }

  async setApprovalMessage(id: string, messageId: number): Promise<void> {
    await this.pool.query("UPDATE approvals SET message_id = $2 WHERE id = $1", [id, messageId]);
  }

  async getApproval(id: string): Promise<ApprovalRow | undefined> {
    return (await this.pool.query<ApprovalRow>("SELECT * FROM approvals WHERE id = $1", [id])).rows[0];
  }

  /** Atomically move a pending approval to a final status. Returns undefined if it wasn't pending. */
  async resolveApproval(id: string, status: Exclude<ApprovalStatus, "pending">): Promise<ApprovalRow | undefined> {
    const r = await this.pool.query<ApprovalRow>(
      `UPDATE approvals SET status = $2, resolved_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, status],
    );
    return r.rows[0];
  }

  async listPendingApprovals(chatId: number): Promise<ApprovalRow[]> {
    return (
      await this.pool.query<ApprovalRow>(
        "SELECT * FROM approvals WHERE chat_id = $1 AND status = 'pending' ORDER BY requested_at",
        [chatId],
      )
    ).rows;
  }

  async expireAllPendingApprovals(): Promise<ApprovalRow[]> {
    const r = await this.pool.query<ApprovalRow>(
      "UPDATE approvals SET status = 'expired', resolved_at = now() WHERE status = 'pending' RETURNING *",
    );
    return r.rows;
  }

  // ---------- usage ----------

  async insertUsage(input: {
    taskId: string | null;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO usage (task_id, model, input_tokens, output_tokens, cache_read_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.taskId, input.model, input.inputTokens, input.outputTokens, input.cacheReadTokens, input.costUsd],
    );
  }
}
