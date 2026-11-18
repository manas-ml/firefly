import type { Bot } from "grammy";
import type { Settings } from "../../control/settings.ts";

export function registerControlCommands(bot: Bot, deps: { settings: Settings; report?: (chatId: number) => Promise<void> }): void {
  bot.command("pause", async (ctx) => {
    await deps.settings.setPaused(true);
    await ctx.reply("⏸ Paused. No new tasks or routines will start (a running task finishes; /stop cancels it). /resume to continue.");
  });

  bot.command("resume", async (ctx) => {
    await deps.settings.setPaused(false);
    await ctx.reply("▶️ Resumed.");
  });

  if (deps.report) {
    const report = deps.report;
    bot.command("health", async (ctx) => {
      await report(ctx.chat.id);
    });
  }

  // While paused, plain messages aren't queued.
  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/") || !(await deps.settings.isPaused())) return next();
    await ctx.reply("⏸ I'm paused, so I didn't start that. Send /resume first.");
  });
}
