import { GrammyError, InlineKeyboard, type Api } from "grammy";
import type { ApprovalNotifier, ApprovalOutcome } from "../approvals/service.ts";
import { encodeCallback } from "../approvals/state.ts";
import type { ApprovalRow } from "../db/repo.ts";
import type { Logger } from "../logger.ts";
import type { ProgressHandle, TaskNotifier } from "../orchestrator/orchestrator.ts";
import { chunkMessage } from "./chunk.ts";
import { escapeHtml, markdownToTelegramHtml } from "./format.ts";
import { Throttle } from "./progress.ts";

const OUTCOME_LABEL: Record<ApprovalOutcome, string> = {
  approved: "✅ Approved",
  denied: "❌ Denied",
  expired: "⌛ Expired: no answer in time",
  cancelled: "⏹ Cancelled: the task was stopped",
};

function isParseError(err: unknown): boolean {
  return err instanceof GrammyError && /can't parse entities|unsupported start tag|can't find end/i.test(err.description);
}

function isNotModified(err: unknown): boolean {
  return err instanceof GrammyError && /message is not modified/i.test(err.description);
}

function formatDuration(seconds: number): string {
  if (seconds < 120) return `${seconds} s`;
  const m = Math.round(seconds / 60);
  return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
}

export function approvalText(command: string, reason: string, timeoutSeconds: number): string {
  return [
    "🔐 <b>Approval needed</b>",
    `<pre>${escapeHtml(command.length > 3000 ? `${command.slice(0, 3000)}…` : command)}</pre>`,
    `<i>${escapeHtml(reason.length > 500 ? `${reason.slice(0, 500)}…` : reason)}</i>`,
    `Expires in ${formatDuration(timeoutSeconds)}.`,
  ].join("\n");
}

export function approvalKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard().text("✅ Approve", encodeCallback("approve", id)).text("❌ Deny", encodeCallback("deny", id));
}

/** Everything the agent sends to Telegram. */
export class TelegramUi implements TaskNotifier, ApprovalNotifier {
  constructor(
    private readonly api: Api,
    private readonly log: Logger,
    private readonly opts: { editIntervalMs: number; typingIntervalMs: number } = { editIntervalMs: 2000, typingIntervalMs: 4000 },
  ) {}

  /** Send Markdown as HTML, falling back to plain text if Telegram rejects the formatting. */
  async sendMarkdown(chatId: number, markdown: string, replyTo?: number): Promise<void> {
    const chunks = chunkMessage(markdown);
    for (const [i, chunk] of chunks.entries()) {
      const reply = i === 0 && replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};
      try {
        await this.api.sendMessage(chatId, markdownToTelegramHtml(chunk), { parse_mode: "HTML", ...reply });
      } catch (err) {
        if (!isParseError(err)) throw err;
        this.log.warn({ chatId }, "Telegram rejected HTML; resending as plain text");
        await this.api.sendMessage(chatId, chunk, reply);
      }
    }
  }

  sendReply(chatId: number, markdown: string, replyTo?: number): Promise<void> {
    return this.sendMarkdown(chatId, markdown, replyTo);
  }

  async sendNotice(chatId: number, text: string): Promise<void> {
    await this.api.sendMessage(chatId, text);
  }

  startProgress(chatId: number): ProgressHandle {
    let statusId: number | undefined;
    let current = "⏳ Working…";
    let closed = false;
    const sendTyping = () => void this.api.sendChatAction(chatId, "typing").catch(() => undefined);
    sendTyping();
    const typing = setInterval(sendTyping, this.opts.typingIntervalMs);

    const created = this.api
      .sendMessage(chatId, current)
      .then((m) => {
        statusId = m.message_id;
      })
      .catch((err: unknown) => this.log.warn({ err }, "could not send status message"));

    const throttle = new Throttle(this.opts.editIntervalMs, (text) => {
      void created.then(async () => {
        if (closed || statusId === undefined) return;
        await this.api.editMessageText(chatId, statusId, text).catch((err: unknown) => {
          if (!isNotModified(err)) this.log.debug({ err }, "status edit failed");
        });
      });
    });

    return {
      step: (description) => {
        const line = description.split("\n")[0] ?? description;
        current = `⏳ Running: ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`;
        throttle.update(current);
      },
      waitingApproval: (waiting) => {
        throttle.update(waiting ? "🔐 Waiting for your approval…" : current);
      },
      done: async () => {
        if (closed) return;
        closed = true;
        clearInterval(typing);
        throttle.close();
        await created;
        if (statusId !== undefined) await this.api.deleteMessage(chatId, statusId).catch(() => undefined);
      },
    };
  }

  async sendApprovalRequest(approval: ApprovalRow, details: { command: string; reason: string; timeoutSeconds: number }) {
    const msg = await this.api.sendMessage(approval.chat_id, approvalText(details.command, details.reason, details.timeoutSeconds), {
      parse_mode: "HTML",
      reply_markup: approvalKeyboard(approval.id),
    });
    return msg.message_id;
  }

  async showApprovalOutcome(approval: ApprovalRow, outcome: ApprovalOutcome): Promise<void> {
    if (approval.message_id === null) return;
    const text = [`🔐 <b>Approval</b>`, `<pre>${escapeHtml(approval.summary)}</pre>`, OUTCOME_LABEL[outcome]].join("\n");
    await this.api
      .editMessageText(approval.chat_id, approval.message_id, text, { parse_mode: "HTML", reply_markup: new InlineKeyboard() })
      .catch((err: unknown) => {
        if (!isNotModified(err)) throw err;
      });
  }
}
