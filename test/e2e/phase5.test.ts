/** Web chat in the dashboard: same conversation as Telegram, approvals, stop, pause. */
import { execFileSync } from "node:child_process";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, isApproval, lastToolResult, OWNER, type Harness } from "./harness.ts";

const DASH = "dash-token-0123456789abcdef01234567";
let h: Harness;
let base: string;

const reply = (t: string) => fauxAssistantMessage(t);
const get = (p: string) => fetch(`${base}${p}`, { headers: { authorization: `Bearer ${DASH}` } });
const post = (p: string, body: unknown = {}) =>
  fetch(`${base}${p}`, { method: "POST", headers: { authorization: `Bearer ${DASH}`, "content-type": "application/json", "x-firefly": "1" }, body: JSON.stringify(body) });

interface Chat {
  paused: boolean;
  active: { taskId: string; step: string | null } | null;
  messages: { id: string; channel: string; prompt: string; result: string | null; status: string; approvals: { id: string; summary: string }[] }[];
}
const chat = async () => (await (await get("/api/chat")).json()) as Chat;
async function waitFor<T>(fn: () => Promise<T | undefined | false>, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const finalMessage = (prompt: string) => waitFor(async () => (await chat()).messages.find((m) => m.prompt === prompt && ["done", "failed", "cancelled"].includes(m.status)), `reply to "${prompt}"`);

beforeAll(async () => {
  execFileSync("pnpm", ["-s", "build:dashboard"], { stdio: "ignore" });
  h = await createHarness({ DASHBOARD_TOKEN: DASH });
  base = `http://127.0.0.1:${h.app.httpPort}`;
});
afterAll(async () => h?.close());

describe("web chat", () => {
  it("rejects empty or oversized messages and needs the x-firefly header", async () => {
    expect((await post("/api/chat", { text: "  " })).status).toBe(400);
    expect((await post("/api/chat", { text: "x".repeat(8001) })).status).toBe(400);
    const noHeader = await fetch(`${base}/api/chat`, { method: "POST", headers: { authorization: `Bearer ${DASH}`, "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    expect(noHeader.status).toBe(403);
    expect((await fetch(`${base}/api/chat`)).status).toBe(401);
  });

  it("answers a message without sending anything to Telegram", async () => {
    h.faux.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo from-the-sandbox" }), { stopReason: "toolUse" }),
      (ctx) => reply(lastToolResult(ctx).includes("from-the-sandbox") ? "Ran **echo**: `from-the-sandbox`." : "?"),
    ]);
    const before = h.tg.sent.length;
    const r = await post("/api/chat", { text: "run echo" });
    expect(r.status).toBe(200);
    const m = await finalMessage("run echo");
    expect(m).toMatchObject({ channel: "web", status: "done", result: "Ran **echo**: `from-the-sandbox`." });
    expect(h.tg.sent.length).toBe(before); // no status message, no reply on Telegram
  });

  it("shares the conversation (and memory) with Telegram, and shows Telegram messages too", async () => {
    h.faux.faux.setResponses([reply("Noted: teal.")]);
    const from = h.say("My favourite colour is teal.");
    await h.tg.waitForMessage((m) => m.text === "Noted: teal.", 10_000, from);
    let history = "";
    h.faux.faux.setResponses([(ctx) => ((history = JSON.stringify(ctx.messages)), reply("Teal."))]);
    await post("/api/chat", { text: "What is my favourite colour?" });
    const m = await finalMessage("What is my favourite colour?");
    expect(m.result).toBe("Teal.");
    expect(history).toContain("My favourite colour is teal.");
    const all = (await chat()).messages;
    expect(all.find((x) => x.prompt === "My favourite colour is teal.")).toMatchObject({ channel: "telegram", result: "Noted: teal." });
  });

  it("shows progress while running, and approvals appear in the chat (not on Telegram)", async () => {
    h.faux.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "python3 -c 'print(6*7)'" }), { stopReason: "toolUse" }),
      (ctx) => reply(lastToolResult(ctx).includes("42") ? "It's 42." : "?"),
    ]);
    const before = h.tg.sent.length;
    await post("/api/chat", { text: "compute 6*7 in python" });
    const pending = await waitFor(async () => (await chat()).messages.find((x) => x.prompt === "compute 6*7 in python" && x.approvals.length > 0), "approval");
    expect(pending.status).toBe("waiting_approval");
    expect(pending.approvals[0]!.summary).toContain("python3 -c");
    expect(h.tg.sent.slice(before).some(isApproval)).toBe(false);
    expect((await post(`/api/approvals/${pending.approvals[0]!.id}`, { action: "approve" })).status).toBe(200);
    expect((await finalMessage("compute 6*7 in python")).result).toBe("It's 42.");
  });

  it("an unanswered approval expires and the agent is told", async () => {
    h.faux.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "python3 slow.py" }), { stopReason: "toolUse" }),
      (ctx) => reply(lastToolResult(ctx).includes("expired") ? "Approval expired." : "?"),
    ]);
    await post("/api/chat", { text: "run slow" });
    expect((await finalMessage("run slow")).result).toBe("Approval expired."); // APPROVAL_TIMEOUT_SECONDS=3 in the harness
  });

  it("Stop cancels a running command, and the chat shows it", async () => {
    h.faux.faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 300" }), { stopReason: "toolUse" }), reply("unreachable")]);
    await post("/api/chat", { text: "sleep a while" });
    const pending = await waitFor(async () => (await chat()).messages.find((x) => x.prompt === "sleep a while" && x.approvals.length > 0), "approval");
    await post(`/api/approvals/${pending.approvals[0]!.id}`, { action: "approve" });
    const running = await waitFor(async () => (await chat()).active?.step?.includes("sleep 300"), "progress step");
    expect(running).toBe(true);
    const t = Date.now();
    expect(((await (await post("/api/chat/stop")).json()) as { stopped: boolean }).stopped).toBe(true);
    const m = await finalMessage("sleep a while");
    expect(m).toMatchObject({ status: "cancelled", result: "⏹ Stopped." });
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it("refuses to send while paused", async () => {
    await post("/api/pause", { paused: true });
    expect((await chat()).paused).toBe(true);
    const r = await post("/api/chat", { text: "hello?" });
    expect(r.status).toBe(409);
    await post("/api/pause", { paused: false });
  });

  it("New chat starts a fresh session and clears the view", async () => {
    expect((await post("/api/chat/new")).status).toBe(200);
    expect((await chat()).messages).toEqual([]);
    let history = "";
    h.faux.faux.setResponses([(ctx) => ((history = JSON.stringify(ctx.messages)), reply("fresh start"))]);
    await post("/api/chat", { text: "Anything about teal?" });
    await finalMessage("Anything about teal?");
    expect(history).not.toContain("favourite colour");
    expect((await chat()).messages.map((m) => m.prompt)).toEqual(["Anything about teal?"]);
  });

  it("works in a real browser: type, send, see the reply, approve in the chat", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      await page.goto(`${base}/?token=${DASH}`);
      await page.getByRole("textbox", { name: "Message" }).waitFor({ timeout: 10_000 }); // Chat is the first tab

      h.faux.faux.setResponses([reply("Here is some code:\n\n```python\nprint('<b>hi</b>')\n```\n\nand a [link](https://example.com) and <img src=x onerror=alert(1)>")]);
      await page.getByRole("textbox", { name: "Message" }).fill("show code");
      await page.getByRole("textbox", { name: "Message" }).press("Enter");
      await page.getByText("Here is some code:").waitFor({ timeout: 10_000 });
      expect(await page.locator("pre.codeblock").innerText()).toBe("print('<b>hi</b>')");
      expect(await page.locator(".md a").getAttribute("href")).toBe("https://example.com");
      expect(await page.locator(".md img").count()).toBe(0); // HTML in agent output stays text
      expect(await page.getByText("<img src=x onerror=alert(1)>").count()).toBe(1);

      h.faux.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("bash", { command: "python3 -c 'print(1)'" }), { stopReason: "toolUse" }),
        (ctx) => reply(lastToolResult(ctx).includes("1") ? "Printed 1." : "?"),
      ]);
      await page.getByRole("textbox", { name: "Message" }).fill("print one");
      await page.getByRole("button", { name: "Send" }).click();
      await page.getByText("Approval needed").waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "Approve" }).click();
      await page.getByText("Printed 1.").waitFor({ timeout: 10_000 });
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it("deep-links to the chat from the menu bar app (#chat)", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${base}/?token=${DASH}#chat`);
      await page.getByRole("textbox", { name: "Message" }).waitFor({ timeout: 10_000 });
      expect(new URL(page.url()).hash).toBe("#chat");
      expect(OWNER).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });
});
