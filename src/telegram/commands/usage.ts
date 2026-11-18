import type { Bot } from "grammy";
import { formatUsd, type BudgetService } from "../../budget/budget.ts";
import type { Repo } from "../../db/repo.ts";
import { excerpt } from "../../orchestrator/orchestrator.ts";
import { escapeHtml } from "../format.ts";

const STATUS_ICON: Record<string, string> = {
  queued: "⏸",
  running: "▶️",
  waiting_approval: "🔐",
  done: "✅",
  failed: "⚠️",
  cancelled: "⏹",
};

export function registerUsageCommands(bot: Bot, deps: { budget: BudgetService; repo: Repo; timezone: string }): void {
  bot.command("usage", async (ctx) => {
    const r = await deps.budget.report();
    const pct = r.monthCapUsd > 0 ? Math.round((r.monthUsd / r.monthCapUsd) * 100) : 0;
    const lines = [
      "💰 <b>Usage</b>",
      `Today: ${formatUsd(r.todayUsd)}`,
      `This month: ${formatUsd(r.monthUsd)} of ${formatUsd(r.monthCapUsd)} (${pct}%)`,
      "",
      r.topTasks.length ? "<b>Most expensive this month</b>" : "No spending this month.",
      ...r.topTasks.map((t, i) => `${i + 1}. ${formatUsd(t.cost)} — ${escapeHtml(excerpt(t.prompt, 60))}`),
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("raise", async (ctx) => {
    const arg = ctx.match.trim().replace(/^\$/, "");
    const amount = arg ? Number(arg) : undefined;
    try {
      const cap = await deps.budget.raise(amount);
      await ctx.reply(`💰 This month's cap is now ${formatUsd(cap)}.`);
    } catch (err) {
      await ctx.reply(`${(err as Error).message}. Usage: /raise [dollars]`);
    }
  });

  bot.command("tasks", async (ctx) => {
    const tasks = await deps.repo.listRecentTasks(ctx.chat.id, 10);
    if (tasks.length === 0) {
      await ctx.reply("No tasks yet.");
      return;
    }
    const lines = tasks.map((t) => {
      const when = t.created_at.toLocaleString("en-CA", { timeZone: deps.timezone, dateStyle: "short", timeStyle: "short" });
      const what = t.kind === "routine" ? `🔁 ${t.schedule_name ?? "routine"}` : excerpt(t.prompt, 50);
      const err = t.status === "failed" && t.error ? ` — <i>${escapeHtml(excerpt(t.error, 60))}</i>` : "";
      return `${STATUS_ICON[t.status] ?? "•"} ${when} ${escapeHtml(what)} · ${formatUsd(t.cost)}${err}`;
    });
    await ctx.reply(["🗂 <b>Recent tasks</b>", ...lines].join("\n"), { parse_mode: "HTML" });
  });
}
