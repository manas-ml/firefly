import { InlineKeyboard, type Bot } from "grammy";
import type { Orchestrator } from "../../orchestrator/orchestrator.ts";
import { describeSchedule, type ScheduleRow, type SchedulerService } from "../../scheduler/service.ts";
import { escapeHtml } from "../format.ts";

function listText(rows: ScheduleRow[]): string {
  if (rows.length === 0) return "No routines yet. Ask me, e.g. “every weekday at 8am, summarise what changed in /workspace”.";
  return [
    "🔁 <b>Routines</b>",
    ...rows.map(
      (r) =>
        `\n${r.enabled ? "🟢" : "⚪"} <b>${escapeHtml(r.name)}</b> — ${escapeHtml(describeSchedule(r))}\n` +
        `<i>${escapeHtml(r.prompt.length > 160 ? `${r.prompt.slice(0, 160)}…` : r.prompt)}</i>` +
        (r.enabled && r.next_run_at ? `\nNext: ${r.next_run_at.toLocaleString("en-CA", { timeZone: r.timezone, dateStyle: "medium", timeStyle: "short" })}` : ""),
    ),
  ].join("\n");
}

function keyboard(rows: ScheduleRow[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const r of rows) {
    kb.text(`${r.enabled ? "Turn off" : "Turn on"} ${r.name}`.slice(0, 60), `sc:${r.enabled ? "off" : "on"}:${r.id}`)
      .text("▶️ Run now", `sc:run:${r.id}`)
      .row();
  }
  return kb;
}

export function registerRoutineCommands(bot: Bot, deps: { scheduler: SchedulerService; orchestrator: Orchestrator }): void {
  const { scheduler } = deps;

  bot.command("schedules", async (ctx) => {
    const rows = await scheduler.list(ctx.chat.id);
    await ctx.reply(listText(rows), { parse_mode: "HTML", reply_markup: rows.length ? keyboard(rows) : undefined });
  });

  bot.command("run", async (ctx) => {
    const name = ctx.match.trim();
    if (!name) {
      await ctx.reply("Usage: /run <routine name>. See /schedules.");
      return;
    }
    const row = await scheduler.findByName(ctx.chat.id, name);
    if (!row) {
      await ctx.reply(`No routine named “${name}”. See /schedules.`);
      return;
    }
    const fired = await scheduler.fire(row.id, true);
    await ctx.reply(fired ? `▶️ Running “${row.name}” now.` : "The agent is paused; /resume first.");
  });

  bot.callbackQuery(/^sc:(on|off|run):([0-9a-f-]{36})$/, async (ctx) => {
    const [, action, id] = ctx.match;
    const row = await scheduler.get(id!);
    if (!row || row.chat_id !== ctx.chat?.id) {
      await ctx.answerCallbackQuery({ text: "That routine no longer exists." });
      return;
    }
    if (action === "run") {
      const fired = await scheduler.fire(row.id, true);
      await ctx.answerCallbackQuery({ text: fired ? `Running ${row.name}` : "Paused" });
      return;
    }
    await scheduler.setEnabled(row.id, action === "on");
    await ctx.answerCallbackQuery({ text: action === "on" ? "Turned on" : "Turned off" });
    const rows = await scheduler.list(row.chat_id);
    await ctx.editMessageText(listText(rows), { parse_mode: "HTML", reply_markup: keyboard(rows) }).catch(() => undefined);
  });
}
