import type { Bot } from "grammy";
import { normalizeTopic, PROFILE_TOPIC, type MemoryStore } from "../../memory/store.ts";

export function registerMemoryCommands(bot: Bot, deps: { memory: MemoryStore; sendMarkdown: (chatId: number, md: string) => Promise<void> }): void {
  const { memory } = deps;

  bot.command("memory", async (ctx) => {
    const topic = ctx.match.trim();
    if (topic) {
      const text = await memory.readTopic(normalizeTopic(topic));
      await deps.sendMarkdown(ctx.chat.id, text ?? `Nothing remembered under “${topic}”.`);
      return;
    }
    const profile = (await memory.readTopic(PROFILE_TOPIC)) ?? "# Profile\n\n(empty — tell me “remember that …”)";
    const topics = (await memory.listTopics()).filter((t) => t.topic !== PROFILE_TOPIC);
    const others = topics.length ? `\n\n**Other topics:** ${topics.map((t) => `\`${t.topic}\` (${t.count})`).join(", ")}\nSee one with /memory <topic>.` : "";
    await deps.sendMarkdown(ctx.chat.id, `${profile.trim()}${others}\n\n/forget <topic> deletes a topic.`);
  });

  bot.command("forget", async (ctx) => {
    const topic = ctx.match.trim();
    if (!topic) {
      await ctx.reply("Usage: /forget <topic> (e.g. /forget profile). See /memory.");
      return;
    }
    const n = await memory.forget(topic);
    await ctx.reply(n > 0 ? `🗑 Forgot “${normalizeTopic(topic)}” (${n} fact${n === 1 ? "" : "s"}).` : `Nothing remembered under “${topic}”.`);
  });
}
