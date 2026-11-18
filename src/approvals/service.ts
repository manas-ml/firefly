import type { ApprovalRow, Repo } from "../db/repo.ts";
import type { Logger } from "../logger.ts";
import { checkResolve, type ApprovalAction, type ResolveCheck } from "./state.ts";

export type ApprovalOutcome = "approved" | "denied" | "expired" | "cancelled";

/** Implemented by the Telegram layer. */
export interface ApprovalNotifier {
  /** Send the Approve/Deny message; returns its Telegram message id. */
  sendApprovalRequest(approval: ApprovalRow, details: { command: string; reason: string; timeoutSeconds: number }): Promise<number | undefined>;
  /** Edit the approval message to show how it ended. */
  showApprovalOutcome(approval: ApprovalRow, outcome: ApprovalOutcome): Promise<void>;
}

export interface ApprovalRequest {
  taskId: string;
  toolCallId: string;
  chatId: number;
  /** Exact action shown to the owner (the command, or tool + path). */
  command: string;
  /** What the agent said it was doing. */
  reason: string;
  signal?: AbortSignal;
}

/**
 * Creates approvals, waits for the owner, and resolves them from button presses.
 * The DB row is the source of truth (resolution is an atomic pending -> X update);
 * in-memory waiters only wake the waiting tool call.
 */
export class ApprovalService {
  private readonly waiters = new Map<string, (outcome: ApprovalOutcome) => void>();

  constructor(
    private readonly repo: Repo,
    private readonly notifier: ApprovalNotifier,
    private readonly timeoutSeconds: number,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const expiresAt = new Date(this.now().getTime() + this.timeoutSeconds * 1000);
    const summary = req.command.slice(0, 3000);
    const approval = await this.repo.createApproval({
      taskId: req.taskId,
      toolCallId: req.toolCallId,
      chatId: req.chatId,
      summary,
      expiresAt,
    });

    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      this.waiters.set(approval.id, resolve);
    });

    if (req.signal?.aborted) {
      await this.finish(approval.id, "cancelled");
    } else {
      try {
        const messageId = await this.notifier.sendApprovalRequest(approval, {
          command: req.command,
          reason: req.reason,
          timeoutSeconds: this.timeoutSeconds,
        });
        if (messageId !== undefined) await this.repo.setApprovalMessage(approval.id, messageId);
      } catch (err) {
        this.log.error({ err, approvalId: approval.id }, "could not send approval request");
        await this.finish(approval.id, "cancelled");
      }
    }

    const timer = setTimeout(() => void this.finish(approval.id, "expired"), Math.max(0, expiresAt.getTime() - this.now().getTime()));
    const onAbort = () => void this.finish(approval.id, "cancelled");
    req.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await outcome;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      this.waiters.delete(approval.id);
    }
  }

  /** Expire or cancel from the agent side (timer, /stop). */
  private async finish(id: string, outcome: "expired" | "cancelled"): Promise<void> {
    try {
      const row = await this.repo.resolveApproval(id, "expired");
      if (row) {
        await this.notifier.showApprovalOutcome(row, outcome).catch((err: unknown) => {
          this.log.warn({ err, approvalId: id }, "could not update approval message");
        });
        this.waiters.get(id)?.(outcome);
        return;
      }
      // Someone resolved it first; wake the waiter with whatever won.
      const current = await this.repo.getApproval(id);
      if (current && current.status !== "pending") {
        this.waiters.get(id)?.(current.status === "expired" ? outcome : current.status);
      }
    } catch (err) {
      this.log.error({ err, approvalId: id }, "failed to finish approval");
      this.waiters.get(id)?.(outcome);
    }
  }

  /** Handle an Approve/Deny button press. */
  async resolveFromButton(input: {
    id: string;
    action: ApprovalAction;
    userAllowed: boolean;
    chatId: number | undefined;
  }): Promise<{ check: ResolveCheck; approval?: ApprovalRow }> {
    const row = input.userAllowed ? await this.repo.getApproval(input.id) : undefined;
    const check = checkResolve(
      row && { id: row.id, status: row.status, chatId: row.chat_id, expiresAt: row.expires_at },
      { userAllowed: input.userAllowed, chatId: input.chatId, action: input.action, now: this.now() },
    );
    if (!check.ok) {
      if (check.error === "expired" && row) await this.finish(row.id, "expired");
      return { check };
    }
    const updated = await this.repo.resolveApproval(input.id, check.next);
    if (!updated) {
      const current = await this.repo.getApproval(input.id);
      return { check: { ok: false, error: "already_resolved", message: `Already ${current?.status ?? "resolved"}.` } };
    }
    this.waiters.get(updated.id)?.(check.next);
    await this.notifier.showApprovalOutcome(updated, check.next).catch((err: unknown) => {
      this.log.warn({ err, approvalId: updated.id }, "could not update approval message");
    });
    return { check, approval: updated };
  }

  /** Whether a process-local waiter exists (false after a restart). */
  isWaiting(id: string): boolean {
    return this.waiters.has(id);
  }
}
