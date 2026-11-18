import type { PgBoss } from "pg-boss";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { ApprovalRow, Repo, TaskRow } from "../db/repo.ts";
import type { Logger } from "../logger.ts";

export const RUN_QUEUE = "agent.run";

export interface RunJobData {
  taskId: string;
  chatId: number;
}

/** What the orchestrator needs from the chat layer. */
export interface ProgressHandle {
  step(description: string): void;
  waitingApproval(waiting: boolean): void;
  done(): Promise<void>;
}

export interface TaskNotifier {
  startProgress(chatId: number): ProgressHandle;
  sendReply(chatId: number, markdown: string, replyTo?: number): Promise<void>;
  sendNotice(chatId: number, text: string): Promise<void>;
  showApprovalOutcome(approval: ApprovalRow, outcome: "expired"): Promise<void>;
}

export interface ActiveRun {
  taskId: string;
  chatId: number;
  prompt: string;
  startedAt: Date;
  controller: AbortController;
  waitingApproval: boolean;
}

/**
 * Runs `agent.run` jobs from pg-boss. The queue uses `key_strict_fifo` with one
 * key per chat: one active job per chat, later messages wait in order, other
 * chats run in parallel.
 *
 * In that policy a failed job blocks its key, so the handler never throws:
 * failures go to the tasks table and the job always completes.
 */
export class Orchestrator {
  private readonly active = new Map<number, ActiveRun>();
  private shuttingDown = false;

  constructor(
    private readonly boss: PgBoss,
    private readonly repo: Repo,
    private readonly runtime: AgentRuntime,
    private readonly notifier: TaskNotifier,
    private readonly log: Logger,
    private readonly options: { concurrency: number; jobTimeoutSeconds: number } = { concurrency: 4, jobTimeoutSeconds: 6 * 3600 },
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
    // Jobs a dead process was holding would block their chat's queue.
    const stale = (await this.boss.findJobs<RunJobData>(RUN_QUEUE, { queued: false })).filter((j) =>
      ["active", "retry", "failed"].includes(j.state),
    );
    if (stale.length > 0) {
      await this.boss.deleteJob(RUN_QUEUE, stale.map((j) => j.id));
      this.log.warn({ count: stale.length }, "removed stale jobs");
    }
  }

  async enqueue(chatId: number, messageId: number | null, prompt: string): Promise<{ task: TaskRow; ahead: number }> {
    const ahead = (await this.repo.countQueued(chatId)) + (this.active.has(chatId) ? 1 : 0);
    const task = await this.repo.createTask(chatId, messageId, prompt);
    await this.boss.send(RUN_QUEUE, { taskId: task.id, chatId } satisfies RunJobData, { singletonKey: `chat:${chatId}` });
    return { task, ahead };
  }

  /** Cancel the chat's running task. Returns false if nothing was running. */
  stop(chatId: number): boolean {
    const run = this.active.get(chatId);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  getActive(chatId: number): ActiveRun | undefined {
    return this.active.get(chatId);
  }

  /** On shutdown: abort running tasks; they are recorded as interrupted, not cancelled. */
  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    for (const run of this.active.values()) run.controller.abort();
  }

  private async handle(data: RunJobData, jobSignal: AbortSignal): Promise<void> {
    const { taskId, chatId } = data;
    let progress: ProgressHandle | undefined;
    const controller = new AbortController();
    const onJobAbort = () => controller.abort();
    jobSignal.addEventListener("abort", onJobAbort, { once: true });
    try {
      const task = await this.repo.getTask(taskId);
      if (!task || task.status !== "queued") return;
      const run: ActiveRun = { taskId, chatId, prompt: task.prompt, startedAt: new Date(), controller, waitingApproval: false };
      this.active.set(chatId, run);
      await this.repo.setTaskStatus(taskId, "running");
      progress = this.notifier.startProgress(chatId);
      const p = progress;

      const result = await this.runtime.run({
        chatId,
        taskId,
        prompt: task.prompt,
        signal: controller.signal,
        hooks: {
          onToolStart: (description) => p.step(description),
          onWaitingApproval: async (waiting) => {
            run.waitingApproval = waiting;
            p.waitingApproval(waiting);
            await this.repo.setTaskStatus(taskId, waiting ? "waiting_approval" : "running");
          },
        },
      });
      await p.done();
      progress = undefined;

      if (result.aborted && this.shuttingDown) {
        await this.repo.setTaskStatus(taskId, "failed", "interrupted");
        await this.notifier.sendNotice(chatId, interruptedNotice(task.prompt));
      } else if (result.aborted) {
        await this.repo.setTaskStatus(taskId, "cancelled");
        await this.notifier.sendNotice(chatId, "⏹ Stopped.");
      } else if (result.error) {
        await this.repo.setTaskStatus(taskId, "failed", result.error);
        await this.notifier.sendNotice(chatId, `⚠️ Something went wrong: ${excerpt(result.error, 300)}`);
      } else {
        await this.repo.setTaskStatus(taskId, "done");
        await this.notifier.sendReply(chatId, result.text || "(no reply)", task.message_id ?? undefined);
      }
    } catch (err) {
      this.log.error({ err, taskId }, "task failed");
      await this.repo.setTaskStatus(taskId, "failed", (err as Error).message).catch(() => undefined);
      await this.notifier.sendNotice(chatId, `⚠️ Something went wrong: ${excerpt((err as Error).message, 300)}`).catch(() => undefined);
    } finally {
      jobSignal.removeEventListener("abort", onJobAbort);
      if (progress) await progress.done().catch(() => undefined);
      if (this.active.get(chatId)?.taskId === taskId) this.active.delete(chatId);
    }
  }
}

function interruptedNotice(prompt: string): string {
  return `⚠️ The agent restarted while working on: “${excerpt(prompt)}”. That task was stopped; send it again if you still need it.`;
}

export function excerpt(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
