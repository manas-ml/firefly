/** Phase 4 acceptance (in-process parts): pause switch, dashboard, health report, Mac bridge. */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort } from "../helpers/sandbox.ts";
import { createHarness, isApproval, lastToolResult, OWNER, type Harness } from "./harness.ts";

const DASH = "dash-token-0123456789abcdef01234567";
const BRIDGE = "bridge-token-0123456789abcdef0123";
let h: Harness;
let bridge: ChildProcess;
let base: string;

const reply = (t: string) => fauxAssistantMessage(t);
const get = (p: string, headers: Record<string, string> = { authorization: `Bearer ${DASH}` }) => fetch(`${base}${p}`, { headers, redirect: "manual" });
const post = (p: string, body: unknown, extra: Record<string, string> = { "x-firefly": "1" }) =>
  fetch(`${base}${p}`, { method: "POST", headers: { authorization: `Bearer ${DASH}`, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

beforeAll(async () => {
  execFileSync("pnpm", ["-s", "build:dashboard"], { stdio: "ignore" });
  h = await createHarness(
    { DASHBOARD_TOKEN: DASH },
    {
      boss: { cronMonitorIntervalSeconds: 1, cronWorkerIntervalSeconds: 1 },
      setup: async (dataDir) => {
        // A Mac bridge with its shipped (empty) allowlist and a fake `shortcuts` CLI.
        const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-"));
        await writeFile(path.join(dir, "bridge.token"), BRIDGE);
        const fake = path.join(dir, "shortcuts");
        await writeFile(fake, "#!/bin/bash\n[ \"$1\" = list ] && echo 'Desk lamp' && exit 0\necho ran; exit 0\n");
        await chmod(fake, 0o755);
        const port = await freePort();
        bridge = spawn(process.execPath, ["bridge/server.ts"], {
          env: { ...process.env, FIREFLY_BRIDGE_DIR: dir, PORT: String(port), SHORTCUTS_BIN: fake, NODE_NO_WARNINGS: "1" },
          stdio: ["ignore", "pipe", "inherit"],
        });
        await new Promise<void>((r) => bridge.stdout?.on("data", (b: Buffer) => b.toString().includes("listening") && r()));
        const tokenFile = path.join(dataDir, "mac_bridge_token");
        await writeFile(tokenFile, BRIDGE);
        return { MAC_BRIDGE_URL: `http://127.0.0.1:${port}`, MAC_BRIDGE_TOKEN_FILE: tokenFile };
      },
    },
  );
  base = `http://127.0.0.1:${h.app.httpPort}`;
});
afterAll(async () => {
  await h?.close();
  bridge?.kill();
});

describe("Phase 4: pause", () => {
  it("/pause stops a scheduled routine from firing and stops new tasks; /resume restores", async () => {
    let from = h.say("/pause");
    await h.tg.waitForMessage((m) => m.text.startsWith("⏸ Paused"), 5000, from);

    const s = await h.app.scheduler.create({ chatId: OWNER, name: "every-minute", cron: "* * * * *", prompt: "tick" });
    // Wait past a minute boundary so the cron schedule definitely comes due.
    const msToBoundary = 60_000 - (Date.now() % 60_000);
    await new Promise((r) => setTimeout(r, msToBoundary + 8000));
    const tasks = await h.db.pool.query("SELECT count(*)::int AS n FROM tasks WHERE schedule_id = $1", [s.id]);
    expect(tasks.rows[0].n).toBe(0);
    expect(h.logs.some((l) => l.msg === "agent paused; routine skipped" && l.name === "every-minute")).toBe(true);

    from = h.say("/run every-minute");
    await h.tg.waitForMessage((m) => m.text.includes("paused"), 5000, from);
    from = h.say("do something");
    await h.tg.waitForMessage((m) => m.text.includes("I'm paused"), 5000, from);
    expect((await h.db.pool.query("SELECT count(*)::int AS n FROM tasks WHERE prompt = 'do something'")).rows[0].n).toBe(0);

    from = h.say("/resume");
    await h.tg.waitForMessage((m) => m.text === "▶️ Resumed.", 5000, from);
    await h.app.scheduler.delete(s.id);
    h.faux.faux.setResponses([reply("working again")]);
    from = h.say("do something");
    await h.tg.waitForMessage((m) => m.text === "working again", 10_000, from);
  }, 90_000);
});

describe("Phase 4: dashboard", () => {
  it("requires the token for everything except /health", async () => {
    expect((await get("/health", {})).status).toBe(200);
    expect((await get("/", {})).status).toBe(401);
    expect((await get("/api/status", {})).status).toBe(401);
    expect((await get("/api/tasks", { authorization: "Bearer wrong-token-wrong-token-wrong" })).status).toBe(401);
    expect((await get("/?token=nope", {})).status).toBe(401);
  });

  it("swaps ?token= for an HttpOnly cookie and sets strict security headers", async () => {
    const r = await get(`/?token=${DASH}`, {});
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/");
    expect(r.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict/);
    const page = await get("/", { cookie: r.headers.get("set-cookie")!.split(";")[0]! });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("serves tasks, audit log, usage, schedules and memory", async () => {
    const status = (await (await get("/api/status")).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ paused: false, pendingApprovals: 0 });
    const tasks = (await (await get("/api/tasks")).json()) as { prompt: string }[];
    expect(tasks.map((t) => t.prompt)).toContain("do something");
    expect(Array.isArray(await (await get("/api/tool-calls")).json())).toBe(true);
    const usage = (await (await get("/api/usage")).json()) as { daily: unknown[] };
    expect(usage.daily).toHaveLength(30);
    expect(Array.isArray(await (await get("/api/schedules")).json())).toBe(true);
    expect(Array.isArray(await (await get("/api/memory")).json())).toBe(true);
  });

  it("state changes need the x-firefly header; pause works from the dashboard", async () => {
    expect((await post("/api/pause", { paused: true }, {})).status).toBe(403);
    expect((await post("/api/pause", { paused: true })).status).toBe(200);
    expect(await h.app.settings.isPaused()).toBe(true);
    await post("/api/pause", { paused: false });
    expect(await h.app.settings.isPaused()).toBe(false);
  });

  it("approves a pending approval from the dashboard", async () => {
    h.faux.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "python3 -c 'print(41+1)'" }), { stopReason: "toolUse" }),
      (ctx) => reply(lastToolResult(ctx).includes("42") ? "It's 42." : "?"),
    ]);
    const from = h.say("compute 41+1 in python");
    await h.tg.waitForMessage(isApproval, 10_000, from);
    const approvals = (await (await get("/api/approvals")).json()) as { id: string; status: string }[];
    const pending = approvals.find((a) => a.status === "pending")!;
    const r = await post(`/api/approvals/${pending.id}`, { action: "approve" });
    expect(r.status).toBe(200);
    await h.tg.waitForMessage((m) => m.text === "It's 42.", 10_000, from);
    expect((await post(`/api/approvals/${pending.id}`, { action: "deny" })).status).toBe(409);
  });

  it("renders in a real browser", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      await page.goto(`${base}/?token=${DASH}`);
      expect(new URL(page.url()).search).toBe(""); // token gone from the address bar
      await page.getByText("Running", { exact: true }).waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "Tasks" }).click();
      await page.getByText("compute 41+1 in python").first().waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "Audit log" }).click();
      await page.getByText("python3 -c").first().waitFor({ timeout: 10_000 });
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});

describe("Phase 4: health report", () => {
  it("/health sends uptime, spend, failed tasks and disk usage", async () => {
    const from = h.say("/health");
    const r = await h.tg.waitForMessage((m) => m.text.includes("Weekly health report"), 10_000, from);
    expect(r.text).toMatch(/Up \d+ h/);
    expect(r.text).toContain("Spend:");
    expect(r.text).toMatch(/Tasks: \d+ in the last 7 days, \d+ failed/);
    expect(r.text).toMatch(/Disk: .* free of .*; database .*; workspace .*free of/);
    const sched = await h.db.pool.query("SELECT cron FROM pgboss.schedule WHERE name = 'health.report'");
    expect(sched.rows[0].cron).toBe("17 9 * * 1");
  });
});

describe("Phase 4: Mac bridge", () => {
  it("is offered to the agent only when configured, always asks, and the bridge rejects while its allowlist is empty", async () => {
    h.faux.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("mac_shortcut", { name: "Desk lamp" }), { stopReason: "toolUse" }),
      (ctx) => reply(lastToolResult(ctx).includes("allowlist is empty") ? "The Mac bridge has no shortcuts enabled." : `? ${lastToolResult(ctx)}`),
    ]);
    const from = h.say("Turn on the desk lamp");
    const approval = await h.tg.waitForMessage(isApproval, 10_000, from);
    expect(approval.text).toContain("Run Mac Shortcut “Desk lamp”");
    h.tg.press(OWNER, approval, /Approve/);
    await h.tg.waitForMessage((m) => m.text === "The Mac bridge has no shortcuts enabled.", 10_000, from);
  });
});
