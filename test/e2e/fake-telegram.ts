import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A minimal stand-in for the Telegram Bot API, enough for grammY long polling.
 * Validates parse_mode=HTML like Telegram (allowed tags, balanced nesting) and
 * enforces the 4096-character limit, returning the same 400 errors.
 */

export interface SentMessage {
  chatId: number;
  messageId: number;
  text: string;
  parseMode?: string;
  replyMarkup?: { inline_keyboard?: { text: string; callback_data: string }[][] };
  /** Keyboard as first sent (kept after the bot removes it, to test stale presses). */
  originalMarkup?: { inline_keyboard?: { text: string; callback_data: string }[][] };
  replyTo?: number;
  edits: string[];
  deleted: boolean;
}

interface Update {
  update_id: number;
  [key: string]: unknown;
}

const ALLOWED_TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "code", "pre", "a", "tg-spoiler", "blockquote", "span"]);

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** Returns the visible text, or throws an error message like Telegram's. */
export function parseTelegramHtml(html: string): string {
  const stack: string[] = [];
  let visible = "";
  const re = /<\/?([a-zA-Z-]+)(\s[^>]*)?>|&(lt|gt|amp|quot);|&|<|[^<&]+/g;
  for (const m of html.matchAll(re)) {
    const tok = m[0];
    if (tok.startsWith("</")) {
      const name = m[1]!.toLowerCase();
      if (stack.pop() !== name) throw new Error(`Bad Request: can't parse entities: Unmatched end tag "${name}"`);
    } else if (tok.startsWith("<") && m[1]) {
      const name = m[1].toLowerCase();
      if (!ALLOWED_TAGS.has(name)) throw new Error(`Bad Request: can't parse entities: Unsupported start tag "${name}"`);
      stack.push(name);
    } else if (tok === "<" || tok === "&") {
      throw new Error("Bad Request: can't parse entities: unescaped character");
    } else {
      visible += decodeEntities(tok);
    }
  }
  if (stack.length > 0) throw new Error(`Bad Request: can't parse entities: Can't find end tag corresponding to start tag "${stack.at(-1)}"`);
  return visible;
}

export class FakeTelegram {
  readonly token = "123456:TEST-token-abcdefghijklmnopqrstuvwxyz";
  readonly sent: SentMessage[] = [];
  readonly callbackAnswers: { id: string; text?: string }[] = [];
  readonly chatActions: { chatId: number; action: string }[] = [];
  readonly photos: { chatId: number; caption: string; bytes: number }[] = [];
  private updates: Update[] = [];
  private nextUpdateId = 1;
  private nextMessageId = 1000;
  private waiters: (() => void)[] = [];
  private server = http.createServer((req, res) => void this.handle(req, res));
  url = "";

  async start(host = "127.0.0.1", port = 0): Promise<void> {
    await new Promise<void>((r) => this.server.listen(port, host, r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const w of this.waiters) w();
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  private push(update: Omit<Update, "update_id">): void {
    this.updates.push({ update_id: this.nextUpdateId++, ...update });
    for (const w of this.waiters.splice(0)) w();
  }

  /** Simulate the user sending a text message. */
  sendText(fromId: number, text: string, chatType: "private" | "group" = "private"): number {
    const messageId = this.nextMessageId++;
    const command = text.match(/^\/[a-z_]+/);
    this.push({
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        from: { id: fromId, is_bot: false, first_name: "User" },
        chat: chatType === "private" ? { id: fromId, type: "private", first_name: "User" } : { id: -100, type: "group", title: "G" },
        text,
        ...(command ? { entities: [{ type: "bot_command", offset: 0, length: command[0].length }] } : {}),
      },
    });
    return messageId;
  }

  /** Simulate pressing an inline button on a message the bot sent. */
  press(fromId: number, message: SentMessage, label: RegExp, opts: { stale?: boolean } = {}): void {
    const markup = opts.stale ? message.originalMarkup : message.replyMarkup;
    const button = markup?.inline_keyboard?.flat().find((b) => label.test(b.text));
    if (!button) throw new Error(`no button matching ${label} on message ${message.messageId}`);
    this.push({
      callback_query: {
        id: String(this.nextUpdateId),
        from: { id: fromId, is_bot: false, first_name: "User" },
        chat_instance: "ci",
        data: button.callback_data,
        message: { message_id: message.messageId, date: 0, chat: { id: message.chatId, type: "private" }, text: message.text },
      },
    });
  }

  /** Wait until a sent message matches. */
  async waitForMessage(pred: (m: SentMessage) => boolean, timeoutMs = 10_000, from = 0): Promise<SentMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.sent.slice(from).find(pred);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for message; sent so far:\n${this.sent.map((m) => `  [${m.messageId}] ${m.text.slice(0, 120)}`).join("\n")}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const m = req.url?.match(/^\/bot([^/]+)\/(\w+)/);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBuf = Buffer.concat(chunks);
    const contentType = req.headers["content-type"] ?? "";
    let body: Record<string, unknown> = {};
    if (contentType.startsWith("multipart/form-data")) {
      // grammY uploads files (sendPhoto) as multipart.
      body = parseMultipart(rawBuf, contentType);
    } else {
      const raw = rawBuf.toString("utf8");
      body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
    }
    const reply = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const ok = (result: unknown) => reply(200, { ok: true, result });
    const fail = (description: string) => reply(400, { ok: false, error_code: 400, description });
    if (!m || m[1] !== this.token) return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });

    const method = m[2]!;
    const validate = (text: string, parseMode: unknown): string | undefined => {
      let visible = text;
      if (parseMode === "HTML") {
        try {
          visible = parseTelegramHtml(text);
        } catch (err) {
          return (err as Error).message;
        }
      }
      if (visible.length === 0) return "Bad Request: message text is empty";
      if (visible.length > 4096) return "Bad Request: message is too long";
      return undefined;
    };

    switch (method) {
      case "getMe":
        return ok({ id: 999, is_bot: true, first_name: "Firefly", username: "firefly_test_bot" });
      case "deleteWebhook":
      case "setMyCommands":
        return ok(true);
      case "getUpdates": {
        const offset = Number(body.offset ?? 0);
        const timeout = Math.min(Number(body.timeout ?? 0), 2);
        this.updates = this.updates.filter((u) => u.update_id >= offset);
        if (this.updates.length === 0 && timeout > 0) {
          await new Promise<void>((r) => {
            const t = setTimeout(r, timeout * 1000);
            this.waiters.push(() => {
              clearTimeout(t);
              r();
            });
          });
        }
        return ok(this.updates.filter((u) => u.update_id >= offset));
      }
      case "sendMessage": {
        const text = String(body.text ?? "");
        const err = validate(text, body.parse_mode);
        if (err) return fail(err);
        const msg: SentMessage = {
          chatId: Number(body.chat_id),
          messageId: this.nextMessageId++,
          text,
          parseMode: body.parse_mode as string | undefined,
          replyMarkup: body.reply_markup as SentMessage["replyMarkup"],
          originalMarkup: body.reply_markup as SentMessage["replyMarkup"],
          replyTo: (body.reply_parameters as { message_id?: number } | undefined)?.message_id,
          edits: [],
          deleted: false,
        };
        this.sent.push(msg);
        return ok({ message_id: msg.messageId, date: 0, chat: { id: msg.chatId, type: "private" }, text });
      }
      case "editMessageText": {
        const target = this.sent.find((s) => s.messageId === Number(body.message_id));
        if (!target) return fail("Bad Request: message to edit not found");
        const text = String(body.text ?? "");
        const err = validate(text, body.parse_mode);
        if (err) return fail(err);
        if (text === target.text && !body.reply_markup) return fail("Bad Request: message is not modified");
        target.edits.push(text);
        target.text = text;
        if (body.reply_markup !== undefined) target.replyMarkup = body.reply_markup as SentMessage["replyMarkup"];
        return ok({ message_id: target.messageId, date: 0, chat: { id: target.chatId, type: "private" }, text });
      }
      case "editMessageReplyMarkup": {
        const target = this.sent.find((s) => s.messageId === Number(body.message_id));
        if (target) target.replyMarkup = body.reply_markup as SentMessage["replyMarkup"];
        return ok(true);
      }
      case "deleteMessage": {
        const target = this.sent.find((s) => s.messageId === Number(body.message_id));
        if (target) target.deleted = true;
        return ok(true);
      }
      case "sendPhoto": {
        let photo = body.photo as { size?: number } | string | undefined;
        if (typeof photo === "string" && photo.startsWith("attach://")) photo = body[photo.slice(9)] as { size?: number } | undefined;
        this.photos.push({ chatId: Number(body.chat_id), caption: String(body.caption ?? ""), bytes: typeof photo === "object" ? (photo.size ?? 0) : 0 });
        const messageId = this.nextMessageId++;
        return ok({ message_id: messageId, date: 0, chat: { id: Number(body.chat_id), type: "private" }, photo: [] });
      }
      case "sendChatAction":
        this.chatActions.push({ chatId: Number(body.chat_id), action: String(body.action) });
        return ok(true);
      case "answerCallbackQuery":
        this.callbackAnswers.push({ id: String(body.callback_query_id), text: body.text as string | undefined });
        return ok(true);
      default:
        return fail(`Bad Request: method ${method} not implemented in fake`);
    }
  }
}

/** Minimal multipart/form-data parser: text fields as strings, files as { size }. */
function parseMultipart(buf: Buffer, contentType: string): Record<string, unknown> {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const b = boundary?.[1] ?? boundary?.[2];
  if (!b) return {};
  const out: Record<string, unknown> = {};
  const delim = Buffer.from(`--${b}`);
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    const next = buf.indexOf(delim, start);
    if (next === -1) break;
    const part = buf.subarray(start, next);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString();
      const content = part.subarray(headerEnd + 4, part.length - 2); // trailing CRLF
      const name = headers.match(/name="([^"]+)"/)?.[1];
      if (name) out[name] = /filename=/.test(headers) ? { size: content.length } : content.toString();
    }
    pos = next;
  }
  return out;
}
