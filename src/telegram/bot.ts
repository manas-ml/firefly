import { Bot, type Context } from "grammy";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { ApprovalService } from "../approvals/service.ts";
import { decodeCallback } from "../approvals/state.ts";
import { MODEL_ID_PATTERN } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import type { Logger } from "../logger.ts";
import { excerpt, type Orchestrator } from "../orchestrator/orchestrator.ts";
import { isAllowed } from "./auth.ts";
import { escapeHtml } from "./format.ts";
import { approvalKeyboard, approvalText, type TelegramUi } from "./ui.ts";

export interface BotDeps {
  allowedUserIds: readonly number[];
  orchestrator: Orchestrator;
  runtime: AgentRuntime;
  approvals: ApprovalService;
  repo: Repo;
  ui: TelegramUi;
  log: Logger;
  approvalTimeoutSeconds: number;
}

export const COMMANDS = [
  { command: "start", description: "Help" },
  { command: "new", description: "Start a fresh conversation" },
  { command: "stop", description: "Cancel the running task" },
  { command: "status", description: "Running task, model, session age" },
  { command: "model", description: "Show or switch the model" },
  { command: "approvals", description: "List pending approvals" },
];

const HELP = [
  "👋 I'm your agent. Send me a task in plain words, for example:",
  "• What files are in my workspace?",
  "• Create hello.py that prints hi and run it",
  "",
  "I work in a sandbox at /workspace and ask before anything risky.",
  "",
  "/new — fresh conversation",
  "/stop — cancel the running task",
  "/status — what I'm doing",
  "/model <id> — switch model (e.g. deepseek/deepseek-v4.1-flash)",
  "/approvals — pending approvals",
].join("\n");

function ago(date: Date | null | undefined): string {
  if (!date) return "new";
  const s = Math.round((Date.now() - date.getTime()) / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

export function registerHandlers(bot: Bot, deps: BotDeps): void {
  const { log } = deps;

  // Gate: drop everything from anyone but the owner, and all group chats. No reply.
  bot.use(async (ctx, next) => {
    const sender = { fromId: ctx.from?.id, chatType: ctx.chat?.type };
    if (!isAllowed(sender, deps.allowedUserIds)) {
      log.warn(
        { fromId: sender.fromId, chatType: sender.chatType, chatId: ctx.chat?.id, updateId: ctx.update.update_id },
        "dropped update from unauthorized sender",
      );
      return;
    }
    await next();
  });

  const chatIdOf = (ctx: Context) => ctx.chat!.id;

  bot.command(["start", "help"], (ctx) => ctx.reply(HELP));

  bot.command("new", async (ctx) => {
    try {
      await deps.runtime.newSession(chatIdOf(ctx));
      await ctx.reply("🆕 Started a fresh conversation. The previous one is archived.");
    } catch (err) {
      await ctx.reply((err as Error).message);
    }
  });

  bot.command("stop", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (deps.orchestrator.stop(chatId)) await ctx.reply("Stopping…");
    else await ctx.reply("Nothing is running.");
  });

  bot.command("status", async (ctx) => {
    const chatId = chatIdOf(ctx);
    const chat = await deps.repo.ensureChat(chatId);
    const run = deps.orchestrator.getActive(chatId);
    const queued = await deps.repo.countQueued(chatId);
    const lines = [
      run
        ? `▶️ Running for ${ago(run.startedAt)}${run.waitingApproval ? " (waiting for approval)" : ""}: “${escapeHtml(excerpt(run.prompt))}”`
        : "💤 Idle",
      queued > 0 ? `⏸ ${queued} queued` : undefined,
      `🧠 Model: <code>${escapeHtml(deps.runtime.modelIdFor(chat.model))}</code>`,
      `🗂 Session age: ${ago(chat.session_started_at)}`,
    ].filter(Boolean);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("model", async (ctx) => {
    const chatId = chatIdOf(ctx);
    const id = ctx.match.trim();
    if (!id) {
      const chat = await deps.repo.ensureChat(chatId);
      await ctx.reply(`Current model: <code>${escapeHtml(deps.runtime.modelIdFor(chat.model))}</code>\nUse /model provider/model-id to switch.`, {
        parse_mode: "HTML",
      });
      return;
    }
    if (!MODEL_ID_PATTERN.test(id) || id.length > 120) {
      await ctx.reply("That doesn't look like a model id. Use the form provider/model, e.g. deepseek/deepseek-v4.1-flash");
      return;
    }
    if (!deps.runtime.hasModel(id)) {
      await ctx.reply(`Unknown model: ${id}. Use an OpenRouter model id, e.g. deepseek/deepseek-v4.1-flash`);
      return;
    }
    await deps.runtime.setModel(chatId, id);
    await ctx.reply(`🧠 Model switched to <code>${escapeHtml(id)}</code>.`, { parse_mode: "HTML" });
  });

  bot.command("approvals", async (ctx) => {
    const pending = await deps.repo.listPendingApprovals(chatIdOf(ctx));
    if (pending.length === 0) {
      await ctx.reply("No pending approvals.");
      return;
    }
    for (const a of pending) {
      const remaining = Math.max(0, Math.round((a.expires_at.getTime() - Date.now()) / 1000));
      await ctx.reply(approvalText(a.summary, "Pending approval", remaining), {
        parse_mode: "HTML",
        reply_markup: approvalKeyboard(a.id),
      });
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    const decoded = decodeCallback(ctx.callbackQuery.data);
    if (!decoded) {
      await ctx.answerCallbackQuery({ text: "Unknown button." });
      return;
    }
    const { check } = await deps.approvals.resolveFromButton({
      id: decoded.id,
      action: decoded.action,
      userAllowed: isAllowed({ fromId: ctx.from.id, chatType: ctx.chat?.type }, deps.allowedUserIds),
      chatId: ctx.chat?.id,
    });
    await ctx.answerCallbackQuery({ text: check.ok ? (check.next === "approved" ? "Approved" : "Denied") : check.message });
    if (!check.ok && ctx.callbackQuery.message) {
      // Stale button (already resolved/expired): remove it so it can't be pressed again.
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    }
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) {
      await ctx.reply("Unknown command. Send /start for help.");
      return;
    }
    const chatId = chatIdOf(ctx);
    const { ahead } = await deps.orchestrator.enqueue(chatId, ctx.message.message_id, text);
    if (ahead > 0) await ctx.reply(`⏸ Queued — ${ahead} task${ahead === 1 ? "" : "s"} ahead. /stop cancels the current one.`);
  });

  bot.on("message", (ctx) => ctx.reply("I can only handle text messages for now."));

  bot.catch((err) => {
    log.error({ err: err.error, updateId: err.ctx.update.update_id }, "telegram handler error");
  });
}
