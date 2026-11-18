import type { Bot } from "grammy";
import type { Logger } from "../../logger.ts";
import { normalizeSecretName, SECRET_NAME, type Vault } from "../../vault/vault.ts";
import { escapeHtml } from "../format.ts";

const CAPTURE_MS = 2 * 60 * 1000;

/**
 * /vault add <name>: the value is sent in the next message, which the bot
 * deletes at once. That message never reaches the agent, the queue or the logs.
 */
export function registerVaultCommands(bot: Bot, deps: { vault: Vault; log: Logger }): void {
  const pending = new Map<number, { name: string; until: number }>();

  bot.command("vault", async (ctx) => {
    const [sub = "", rawName = ""] = ctx.match.trim().split(/\s+/);
    if (!deps.vault.enabled) {
      await ctx.reply("The vault isn't set up: there's no master key file. Run install.sh (it creates secrets/vault_master_key).");
      return;
    }
    const name = normalizeSecretName(rawName);
    switch (sub.toLowerCase()) {
      case "add": {
        if (!SECRET_NAME.test(name)) {
          await ctx.reply("Usage: /vault add <name> (lowercase letters, digits, - _ .), e.g. /vault add github");
          return;
        }
        pending.set(ctx.chat.id, { name, until: Date.now() + CAPTURE_MS });
        await ctx.reply(`🔐 Send the value for vault:${name} as your next message. I'll delete it immediately. (/vault cancel to abort)`);
        return;
      }
      case "cancel":
        pending.delete(ctx.chat.id);
        await ctx.reply("Cancelled.");
        return;
      case "list": {
        const rows = await deps.vault.list();
        await ctx.reply(rows.length ? `🔐 <b>Vault</b>\n${rows.map((r) => `• <code>vault:${escapeHtml(r.name)}</code>`).join("\n")}` : "The vault is empty.", {
          parse_mode: "HTML",
        });
        return;
      }
      case "rm":
      case "remove":
      case "delete": {
        const removed = await deps.vault.remove(name);
        await ctx.reply(removed ? `🗑 Removed vault:${name}.` : `No secret named ${name}.`);
        return;
      }
      default:
        await ctx.reply("Usage: /vault add <name> | /vault list | /vault rm <name>");
    }
  });

  bot.on("message:text", async (ctx, next) => {
    const p = pending.get(ctx.chat.id);
    if (!p || ctx.message.text.startsWith("/")) return next();
    pending.delete(ctx.chat.id);
    if (Date.now() > p.until) {
      await ctx.reply("The /vault add request timed out. I deleted that message to be safe; start again with /vault add.");
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }
    const deleted = await ctx.deleteMessage().then(
      () => true,
      () => false,
    );
    try {
      await deps.vault.set(p.name, ctx.message.text);
      deps.log.info({ secret: p.name }, "vault secret saved");
      await ctx.reply(
        `🔐 Saved vault:${p.name}.${deleted ? " Your message is deleted." : " I couldn't delete your message; please delete it yourself."} Ask me to use it by name, e.g. “log in with vault:${p.name}”.`,
      );
    } catch (err) {
      await ctx.reply(`Couldn't save: ${(err as Error).message}`);
    }
  });
}
