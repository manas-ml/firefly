import type { PgBoss } from "pg-boss";
import type { AgentRuntime, RunResult } from "../agent/runtime.ts";
import type { BudgetService } from "../budget/budget.ts";
import type { ApprovalRow, Repo, TaskRow } from "../db/repo.ts";
import type { Logger } from "../logger.ts";
import type { ScheduleRow } from "../scheduler/service.ts";

export const RUN_QUEUE = "agent.run";
export const NO_REPORT = "NO_REPORT";

export interface RunJobData {
  taskId: string;
  chatId: number;
  kind?: "chat" | "routine";
  scheduleId?: string;
  scheduleName?: string;
}

/** What the orchestrator needs from the chat layer. */
export interface ProgressHandle {
  step(description: string): void;
  waitingApproval(waiting: boolean): void;
  done(): Promise<void>;
}

export interface TaskNotifier {
  startProgress(chatId: number, label?: string): ProgressHandle;
  sendReply(chatId: number, markdown: string, replyTo?: number): Promise<void>;
  sendNotice(chatId: number, text: string): Promise<void>;
  sendPhoto?(chatId: number, image: Buffer, caption: string): Promise<void>;
  showApprovalOutcome(approval: ApprovalRow, outcome: "expired"): Promise<void>;
}

export interface ActiveRun {
  taskId: string;
  chatId: number;
  kind: "chat" | "routine";
  name?: string;
  prompt: string;
  startedAt: Date;
  controller: AbortController;
  waitingApproval: boolean;
}

export interface OrchestratorOptions {
  concurrency: number;
  jobTimeoutSeconds: number;
  approvalTimeoutSeconds: number;
  routineApprovalTimeoutSeconds: number;
  maxTurnsPerTask: number;
  /** Global pause (Phase 4): no new tasks start while it returns true. */
  isPaused?: () => Promise<boolean>;
}

/** The instruction wrapped around a routine's prompt. */
export function routinePrompt(name: string, prompt: string): string {
  return [
    `This is your scheduled routine "${name}". The owner is not watching; your reply is sent to them as a notification.`,
    `If there is nothing worth reporting, reply with exactly ${NO_REPORT} and nothing else.`,
    "",
    prompt,
  ].join("\n");
}

/** A routine's reply means "nothing to report". */
export function isNoReport(text: string): boolean {
  // Allow formatting around the token (`NO_REPORT`, **NO_REPORT**.) but nothing else.
  return text.trim().replace(/^[`*_\s]+|[`*_.!\s]+$/g, "").toUpperCase() === NO_REPORT;
}

/**
 * Runs `agent.run` jobs from pg-boss. The queue uses `key_strict_fifo`: chat
 * messages share the key `chat:<id>` (one at a time, in order); each routine run
 * has its own key, so a routine waiting hours for approval never blocks the chat.
 *
 * In that policy a failed job blocks its key, so the handler never throws:
 * failures go to the tasks table and the job always completes.
 */
export class Orchestrator {
  private readonly active = new Map<string, ActiveRun>();
  private shuttingDown = false;

  constructor(
    private readonly boss: PgBoss,
    private readonly repo: Repo,
    private readonly runtime: AgentRuntime,
    private readonly notifier: TaskNotifier,
    private readonly log: Logger,
    private readonly options: OrchestratorOptions,
    private readonly budget?: BudgetService,
  ) {}

  async start(): Promise<void> {
    if (!(await this.boss.getQueue(RUN_QUEUE))) {
      await this.boss.createQueue(RUN_QUEUE, {
        policy: "key_strict_fifo",
        retryLimit: 0,
        expireInSeconds: this.options.jobTimeoutSeconds,
      });
    }
    await this.recover();
    await this.boss.work<RunJobData>(
      RUN_QUEUE,
      { localConcurrency: this.options.concurrency, pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) await this.handle(job.data, job.signal);
      },
    );
  }

  /** Clean up after a crash or restart. */
  async recover(): Promise<void> {
    const interrupted = await this.repo.failInterruptedTasks();
    for (const task of interrupted) {
      this.log.warn({ taskId: task.id, chatId: task.chat_id }, "task interrupted by restart");
      await this.notifier
        .sendNotice(task.chat_id, interruptedNotice(task.prompt))
        .catch((err: unknown) => this.log.warn({ err }, "could not notify about interrupted task"));
    }
    for (const approval of await this.repo.expireAllPendingApprovals()) {
      await this.notifier.showApprovalOutcome(approval, "expired").catch(() => undefined);
    }
    // Jobs a dead process was holding would block their key.
    const stale = (await this.boss.findJobs<RunJobData>(RUN_QUEUE, { queued: false })).filter((j) =>
      ["active", "retry", "failed"].includes(j.state),
    );
    if (stale.length > 0) {
      await this.boss.deleteJob(RUN_QUEUE, stale.map((j) => j.id));
      this.log.warn({ count: stale.length }, "removed stale jobs");
    }
  }

  async enqueue(chatId: number, messageId: number | null, prompt: string): Promise<{ task: TaskRow; ahead: number }> {
    const ahead = (await this.repo.countQueued(chatId)) + (this.active.has(`chat:${chatId}`) ? 1 : 0);
    const task = await this.repo.createTask(chatId, messageId, prompt);
    await this.boss.send(RUN_QUEUE, { taskId: task.id, chatId, kind: "chat" } satisfies RunJobData, { singletonKey: `chat:${chatId}` });
    return { task, ahead };
  }

  /** Called when a schedule fires (or /run). */
  async enqueueRoutine(schedule: ScheduleRow): Promise<TaskRow> {
    const task = await this.repo.createTask(schedule.chat_id, null, schedule.prompt, { kind: "routine", scheduleId: schedule.id });
    await this.boss.send(
      RUN_QUEUE,
      { taskId: task.id, chatId: schedule.chat_id, kind: "routine", scheduleId: schedule.id, scheduleName: schedule.name } satisfies RunJobData,
      { singletonKey: `routine:${task.id}` },
    );
    return task;
  }

  /** Cancel the chat's running task, or else its most recent running routine. */
  stop(chatId: number): ActiveRun | undefined {
    const run = this.active.get(`chat:${chatId}`) ?? this.listActive(chatId).filter((r) => r.kind === "routine").at(-1);
    run?.controller.abort();
    return run;
  }

  getActive(chatId: number): ActiveRun | undefined {
    return this.active.get(`chat:${chatId}`);
  }

  listActive(chatId?: number): ActiveRun[] {
    return [...this.active.values()].filter((r) => chatId === undefined || r.chatId === chatId);
  }

  /** On shutdown: abort running tasks; they are recorded as interrupted, not cancelled. */
  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    for (const run of this.active.values()) run.controller.abort();
  }

  private async handle(data: RunJobData, jobSignal: AbortSignal): Promise<void> {
    const { taskId, chatId } = data;
    const kind = data.kind ?? "chat";
    const key = kind === "chat" ? `chat:${chatId}` : `routine:${taskId}`;
    const label = kind === "routine" ? `🔁 ${data.scheduleName ?? "routine"}` : undefined;
    let progress: ProgressHandle | undefined;
    const controller = new AbortController();
    const onJobAbort = () => controller.abort();
    jobSignal.addEventListener("abort", onJobAbort, { once: true });
    try {
      const task = await this.repo.getTask(taskId);
      if (!task || task.status !== "queued") return;
      if (await this.options.isPaused?.()) {
        await this.repo.setTaskStatus(taskId, "cancelled", "paused");
        if (kind === "chat") await this.notifier.sendNotice(chatId, "⏸ The agent is paused, so I didn't start that. Send /resume first.");
        return;
      }
      const run: ActiveRun = {
        taskId,
        chatId,
        kind,
        name: data.scheduleName,
        prompt: task.prompt,
        startedAt: new Date(),
        controller,
        waitingApproval: false,
      };
      this.active.set(key, run);
      await this.repo.setTaskStatus(taskId, "running");
      progress = kind === "chat" ? this.notifier.startProgress(chatId) : silentProgress();
      const p = progress;

      const result = await this.runtime.run({
        chatId,
        taskId,
        prompt: kind === "routine" ? routinePrompt(data.scheduleName ?? "routine", task.prompt) : task.prompt,
        signal: controller.signal,
        session: kind,
        trigger: kind === "routine" ? "routine" : "user",
        approvalTimeoutSeconds: kind === "routine" ? this.options.routineApprovalTimeoutSeconds : this.options.approvalTimeoutSeconds,
        maxTurns: this.options.maxTurnsPerTask,
        hooks: {
          onToolStart: (description) => p.step(description),
          onWaitingApproval: async (waiting) => {
            run.waitingApproval = waiting;
            p.waitingApproval(waiting);
            await this.repo.setTaskStatus(taskId, waiting ? "waiting_approval" : "running");
          },
          sendImage: this.notifier.sendPhoto ? (image, caption) => this.notifier.sendPhoto!(chatId, image, caption) : undefined,
          beforeModelCall: this.budget ? () => this.checkBudget(taskId, chatId) : undefined,
        },
      });
      await p.done();
      progress = undefined;
      await this.finish(task, kind, label, result);
    } catch (err) {
      this.log.error({ err, taskId }, "task failed");
      await this.repo.setTaskStatus(taskId, "failed", (err as Error).message).catch(() => undefined);
      await this.notifier
        .sendNotice(chatId, `${label ? `${label}: ` : ""}⚠️ Something went wrong: ${excerpt((err as Error).message, 300)}`)
        .catch(() => undefined);
    } finally {
      jobSignal.removeEventListener("abort", onJobAbort);
      if (progress) await progress.done().catch(() => undefined);
      if (this.active.get(key)?.taskId === taskId) this.active.delete(key);
    }
  }

  private async finish(task: TaskRow, kind: "chat" | "routine", label: string | undefined, result: RunResult): Promise<void> {
    const chatId = task.chat_id;
    const prefix = label ? `${label}: ` : "";
    if (result.aborted && this.shuttingDown) {
      await this.repo.setTaskStatus(task.id, "failed", "interrupted");
      await this.notifier.sendNotice(chatId, interruptedNotice(task.prompt));
    } else if (result.aborted && result.stopReason === "limit") {
      await this.repo.setTaskStatus(task.id, "failed", result.stopMessage ?? "limit");
      await this.notifier.sendNotice(chatId, `${prefix}🛑 ${result.stopMessage ?? "Stopped by a limit."}`);
    } else if (result.aborted) {
      await this.repo.setTaskStatus(task.id, "cancelled");
      await this.notifier.sendNotice(chatId, `${prefix}⏹ Stopped.`);
    } else if (result.error) {
      await this.repo.setTaskStatus(task.id, "failed", result.error);
      await this.notifier.sendNotice(chatId, `${prefix}⚠️ Something went wrong: ${excerpt(result.error, 300)}`);
    } else {
      await this.repo.setTaskStatus(task.id, "done");
      if (kind === "routine") {
        if (isNoReport(result.text) || !result.text.trim()) {
          this.log.info({ taskId: task.id }, "routine had nothing to report");
          return;
        }
        await this.notifier.sendReply(chatId, `**${label}**\n\n${result.text}`);
      } else {
        await this.notifier.sendReply(chatId, result.text || "(no reply)", task.message_id ?? undefined);
      }
    }
  }

  private async checkBudget(taskId: string, chatId: number): Promise<string | undefined> {
    if (!this.budget) return undefined;
    const r = await this.budget.check(taskId);
    for (const w of r.warnings) await this.notifier.sendNotice(chatId, w).catch(() => undefined);
    return r.ok ? undefined : r.reason;
  }
}

function silentProgress(): ProgressHandle {
  return { step: () => {}, waitingApproval: () => {}, done: async () => {} };
}

function interruptedNotice(prompt: string): string {
  return `⚠️ The agent restarted while working on: “${excerpt(prompt)}”. That task was stopped; send it again if you still need it.`;
}

export function excerpt(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
