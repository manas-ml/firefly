import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRuntime, loadSystemPrompt } from "../src/agent/runtime.ts";
import { SandboxClient } from "../src/agent/sandbox-client.ts";
import { ApprovalService, type ApprovalNotifier } from "../src/approvals/service.ts";
import { Repo, type ApprovalRow } from "../src/db/repo.ts";
import { createLogger } from "../src/logger.ts";
import { loadPolicyRules } from "../src/policy/rules.ts";
import { createTestDb } from "./helpers/db.ts";
import { createFauxRuntime } from "./helpers/faux.ts";
import { startLocalSandbox, TEST_TOKEN } from "./helpers/sandbox.ts";

const log = createLogger("silent");
let db: Awaited<ReturnType<typeof createTestDb>>;
let sb: Awaited<ReturnType<typeof startLocalSandbox>>;
let repo: Repo;
let fauxRt: Awaited<ReturnType<typeof createFauxRuntime>>;
let runtime: AgentRuntime;
let approvals: ApprovalService;
const requests: { approval: ApprovalRow; command: string; reason: string }[] = [];
let autoAnswer: "approve" | "deny" | "none" = "none";

const notifier: ApprovalNotifier = {
  async sendApprovalRequest(approval, details) {
    requests.push({ approval, ...details });
    if (autoAnswer !== "none") {
      setTimeout(() => void approvals.resolveFromButton({ id: approval.id, action: autoAnswer as "approve" | "deny", userAllowed: true, chatId: approval.chat_id }), 20);
    }
    return 1000 + requests.length;
  },
  async showApprovalOutcome() {},
};

async function makeRuntime(dataDir: string, approvalTimeout = 600) {
  approvals = new ApprovalService(repo, notifier, approvalTimeout, log);
  const rt = new AgentRuntime({
    repo,
    log,
    rules: { ...loadPolicyRules("config/policy.yaml"), workspace: sb.workspace, read_roots: [sb.workspace], writable_roots: [sb.workspace] },
    sandbox: new SandboxClient(sb.url, TEST_TOKEN),
    approvals,
    modelRuntime: fauxRt.modelRuntime,
    resolveModel: fauxRt.resolveModel,
    defaultModel: "deepseek/deepseek-v4.1-flash",
    dataDir,
    workspace: sb.workspace,
    toolTimeoutSeconds: 30,
    maxOutputChars: 20000,
    systemPrompt: await loadSystemPrompt(),
  });
  await rt.init();
  return rt;
}

const hooks = { onToolStart: () => {}, onWaitingApproval: () => {} };

async function runPrompt(chatId: number, prompt: string, signal = new AbortController().signal) {
  const task = await repo.createTask(chatId, 1, prompt);
  const result = await runtime.run({
    chatId,
    taskId: task.id,
    prompt,
    signal,
    hooks,
    session: "chat",
    trigger: "user",
    channel: "telegram",
    approvalTimeoutSeconds: 600,
    maxTurns: 40,
  });
  return { task, result };
}

beforeAll(async () => {
  db = await createTestDb();
  repo = new Repo(db.pool);
  sb = await startLocalSandbox();
  fauxRt = await createFauxRuntime();
  runtime = await makeRuntime(await mkdtemp(path.join(os.tmpdir(), "data-")));
});
afterAll(async () => {
  runtime?.dispose();
  await sb?.stop();
  await db?.drop();
});

describe("agent runtime", () => {
  it("runs an allowed command in the sandbox without asking and wraps output as untrusted", async () => {
    await writeFile(path.join(sb.workspace, "notes.txt"), "hello");
    let seenToolResult = "";
    fauxRt.faux.setResponses([
      fauxAssistantMessage([fauxText("Listing files."), fauxToolCall("bash", { command: "ls" })], { stopReason: "toolUse" }),
      (ctx) => {
        const last = ctx.messages[ctx.messages.length - 1] as { content: { type: string; text?: string }[] };
        seenToolResult = last.content.map((c) => c.text ?? "").join("");
        return fauxAssistantMessage("You have notes.txt.");
      },
    ]);
    const before = requests.length;
    const { task, result } = await runPrompt(1, "What files are in my workspace?");
    expect(result).toEqual({ text: "You have notes.txt.", aborted: false });
    expect(requests.length).toBe(before);
    expect(seenToolResult).toContain('<tool_output trust="untrusted">');
    expect(seenToolResult).toContain("notes.txt");
    const calls = await db.pool.query("SELECT tool, decision, outcome FROM tool_calls WHERE task_id = $1", [task.id]);
    expect(calls.rows).toEqual([{ tool: "bash", decision: "allow", outcome: "executed" }]);
    const usage = await db.pool.query("SELECT count(*)::int AS n FROM usage WHERE task_id = $1", [task.id]);
    expect(usage.rows[0].n).toBeGreaterThan(0);
  });

  it("executes bash inside the sandbox, not in the agent process", async () => {
    let out = "";
    fauxRt.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo term=$TERM token=${SANDBOX_TOKEN:-none} pi=${PI_SESSION_ID:-none}" }), { stopReason: "toolUse" }),
      (ctx) => {
        out = JSON.stringify(ctx.messages[ctx.messages.length - 1]);
        return fauxAssistantMessage("ok");
      },
    ]);
    process.env.TERM = "xterm-agent-side";
    await runPrompt(6, "check env");
    expect(out).toContain("term=dumb token=none pi=none");
  });

  it("writes without asking, then asks before running python; approve runs it", async () => {
    autoAnswer = "approve";
    fauxRt.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "hello.py", content: 'print("hi")\n' }), { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Running the script."), fauxToolCall("bash", { command: "python3 hello.py" })], { stopReason: "toolUse" }),
      (ctx) => {
        const last = JSON.stringify(ctx.messages[ctx.messages.length - 1]);
        return fauxAssistantMessage(last.includes("hi") ? "It printed hi." : `unexpected: ${last}`);
      },
    ]);
    const before = requests.length;
    const { result } = await runPrompt(2, "Create hello.py that prints hi and run it");
    expect(result.text).toBe("It printed hi.");
    expect(await readFile(path.join(sb.workspace, "hello.py"), "utf8")).toBe('print("hi")\n');
    expect(requests.length).toBe(before + 1);
    expect(requests.at(-1)).toMatchObject({ command: "python3 hello.py", reason: "Running the script." });
  });

  it("deny returns 'Denied by owner' to the agent", async () => {
    autoAnswer = "deny";
    let toolError = "";
    fauxRt.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "python3 hello.py" }), { stopReason: "toolUse" }),
      (ctx) => {
        toolError = JSON.stringify(ctx.messages[ctx.messages.length - 1]);
        return fauxAssistantMessage("The owner denied running it.");
      },
    ]);
    const { task, result } = await runPrompt(2, "run it again");
    expect(result.text).toBe("The owner denied running it.");
    expect(toolError).toContain("Denied by owner");
    expect(toolError).toContain('"isError":true');
    const calls = await db.pool.query("SELECT outcome FROM tool_calls WHERE task_id = $1", [task.id]);
    expect(calls.rows).toEqual([{ outcome: "denied_by_owner" }]);
  });

  it("rejects reading outside the workspace by policy", async () => {
    let toolError = "";
    fauxRt.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "/etc/passwd" }), { stopReason: "toolUse" }),
      (ctx) => {
        toolError = JSON.stringify(ctx.messages[ctx.messages.length - 1]);
        return fauxAssistantMessage("Not allowed.");
      },
    ]);
    const { task } = await runPrompt(3, "cat /etc/passwd with the read tool");
    expect(toolError).toContain("Blocked by policy");
    const calls = await db.pool.query("SELECT decision, outcome FROM tool_calls WHERE task_id = $1", [task.id]);
    expect(calls.rows).toEqual([{ decision: "deny", outcome: "denied_by_policy" }]);
  });

  it("stop during a long command kills it quickly", async () => {
    autoAnswer = "approve";
    fauxRt.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 300" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("should not get here"),
    ]);
    const ac = new AbortController();
    const started = Date.now();
    const p = runPrompt(4, "sleep for a while", ac.signal);
    await new Promise((r) => setTimeout(r, 1000));
    ac.abort();
    const { result } = await p;
    expect(result.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(6000);
    const ps = await new SandboxClient(sb.url, TEST_TOKEN).exec({ command: "pgrep -fx 'sleep 300' || true", timeoutSec: 5 });
    expect(ps.stdout.trim()).toBe("");
  });

  it("persists the conversation across a runtime restart", async () => {
    autoAnswer = "none";
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "data-"));
    let rt = await makeRuntime(dataDir);
    runtime = rt;
    fauxRt.faux.setResponses([fauxAssistantMessage("Noted: your favourite colour is teal.")]);
    await runPrompt(5, "My favourite colour is teal.");
    rt.dispose();

    rt = await makeRuntime(dataDir);
    runtime = rt;
    let history = "";
    fauxRt.faux.setResponses([
      (ctx) => {
        history = JSON.stringify(ctx.messages);
        return fauxAssistantMessage("Teal.");
      },
    ]);
    await runPrompt(5, "What is my favourite colour?");
    expect(history).toContain("My favourite colour is teal.");

    await rt.newSession(5);
    fauxRt.faux.setResponses([
      (ctx) => {
        history = JSON.stringify(ctx.messages);
        return fauxAssistantMessage("I don't know.");
      },
    ]);
    await runPrompt(5, "What is my favourite colour?");
    expect(history).not.toContain("teal");
  });
});
