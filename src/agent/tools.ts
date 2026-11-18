import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ApprovalService } from "../approvals/service.ts";
import { deniedToolMessage } from "../approvals/state.ts";
import type { Repo, ToolOutcome } from "../db/repo.ts";
import type { Logger } from "../logger.ts";
import { classify } from "../policy/engine.ts";
import type { PolicyRules } from "../policy/rules.ts";
import { truncateMiddle, wrapUntrusted } from "./output.ts";
import { SandboxError, type SandboxClient } from "./sandbox-client.ts";

export type RunTrigger = "user" | "routine";

/** Per-task state the tools need; set by the orchestrator for the duration of a run. */
export interface RunContext {
  taskId: string;
  chatId: number;
  /** What started this run: a direct message from the owner, or a scheduled routine. */
  trigger: RunTrigger;
  /** Set once the task has read untrusted content (files, command output, web pages, email). */
  tainted: boolean;
  signal: AbortSignal;
  /** How long approvals raised by this run wait for the owner. */
  approvalTimeoutSeconds: number;
  /** Text of the latest assistant message: the agent's stated reason for its next tool call. */
  lastAssistantText: string;
  onToolStart(description: string): void;
  onWaitingApproval(waiting: boolean): void | Promise<void>;
  /** Send an image to the owner (e.g. a browser screenshot). */
  sendImage?(image: Buffer, caption: string): Promise<void>;
}

export interface ApprovalAttachment {
  kind: "image";
  data: Buffer;
  caption: string;
}

export interface ToolMeta {
  /** Reading this tool's output exposes the task to untrusted content. Default: true. */
  taints?: boolean;
  /** Output is the owner's own data (memory, schedules): marked trust="owner", not untrusted. */
  ownerData?: boolean;
  /** Text shown in progress and approval messages. */
  describe?(args: Record<string, unknown>): string;
  /** Extra facts for the policy engine, e.g. what element a browser click targets. */
  preflight?(args: Record<string, unknown>, run: RunContext): Promise<Record<string, unknown>>;
  /** Files to attach to an approval request, e.g. a screenshot of the page about to be submitted. */
  approvalAttachments?(args: Record<string, unknown>, run: RunContext): Promise<ApprovalAttachment[]>;
}

export interface AgentTool {
  def: AnyTool;
  meta: ToolMeta;
}

export function agentTool(def: AnyTool, meta: ToolMeta = {}): AgentTool {
  return { def, meta };
}

export interface ToolDeps {
  sandbox: SandboxClient;
  rules: PolicyRules;
  approvals: ApprovalService;
  repo: Repo;
  log: Logger;
  workspace: string;
  toolTimeoutSeconds: number;
  maxOutputChars: number;
  /** Removes secret values from any text before it reaches the model or the logs. */
  redact?(text: string): string;
  getRun(): RunContext | undefined;
}

// ToolDefinition's generic parameters differ per tool; the registry only needs the erased shape.
type AnyTool = ToolDefinition<any, any, any>;

function notFound(p: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, access '${p}'`), { code: "ENOENT" });
}

/** Pi's built-in tools with their operations pointed at the sandbox container. */
export function createSandboxBackedTools(deps: Pick<ToolDeps, "sandbox" | "workspace" | "toolTimeoutSeconds" | "maxOutputChars">): AgentTool[] {
  const { sandbox, workspace } = deps;

  const bash = createBashToolDefinition(workspace, {
    exposeSessionEnvironment: false,
    operations: {
      exec: async (command, cwd, { onData, signal, timeout }) => {
        if (signal?.aborted) throw new Error("aborted");
        const timeoutSec = Math.min(timeout ?? deps.toolTimeoutSeconds, deps.toolTimeoutSeconds);
        const r = await sandbox.exec({ command, cwd, timeoutSec, signal });
        if (r.cancelled || signal?.aborted) throw new Error("aborted");
        const combined = [r.stdout, r.stderr].filter((s) => s.length > 0).join(r.stdout.endsWith("\n") ? "" : "\n");
        if (combined) onData(Buffer.from(truncateMiddle(combined, deps.maxOutputChars)));
        if (r.timedOut) throw new Error(`timeout:${timeoutSec}`);
        return { exitCode: r.exitCode };
      },
    },
  });

  const access = async (p: string, needWrite: boolean) => {
    const st = await sandbox.stat(p);
    if (!st.exists) throw notFound(p);
    if (!st.readable || (needWrite && !st.writable)) {
      throw Object.assign(new Error(`EACCES: permission denied, access '${p}'`), { code: "EACCES" });
    }
  };

  const read = createReadToolDefinition(workspace, {
    operations: {
      readFile: (p) => sandbox.read(p),
      access: (p) => access(p, false),
    },
  });
  const write = createWriteToolDefinition(workspace, {
    operations: {
      writeFile: (p, content) => sandbox.write(p, content),
      mkdir: (dir) => sandbox.mkdir(dir),
    },
  });
  const edit = createEditToolDefinition(workspace, {
    operations: {
      readFile: (p) => sandbox.read(p),
      writeFile: (p, content) => sandbox.write(p, content),
      access: (p) => access(p, true),
    },
  });
  return [agentTool(bash), agentTool(read), agentTool(write, { taints: false }), agentTool(edit)];
}

/** Short human description for progress messages and approvals. */
export function describeCall(tool: string, args: Record<string, unknown>): string {
  if (tool === "bash" && typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return `${tool} ${args.path}`;
  return tool;
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { type?: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
    .join("\n");
}

export function wrapOutput(text: string, ownerData: boolean): string {
  if (!ownerData) return wrapUntrusted(text);
  return `<tool_output trust="owner">\n${text.replace(/<\/?\s*tool_output/gi, (m) => m.replace("<", "&lt;"))}\n</tool_output>`;
}

/**
 * Wrap a tool so every call goes through the policy engine (and owner approval
 * when the policy says ask) before it runs, is logged to tool_calls, and returns
 * its output marked as untrusted.
 */
export function guardTool(tool: AgentTool, deps: ToolDeps): AnyTool {
  const { def, meta } = tool;
  const redact = deps.redact ?? ((t: string) => t);
  const describe = (args: Record<string, unknown>) => (meta.describe ? meta.describe(args) : describeCall(def.name, args));
  return {
    ...def,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const run = deps.getRun();
      if (!run) throw new Error("Tool called outside of a task");
      const args = (params ?? {}) as Record<string, unknown>;
      const started = Date.now();
      let context: Record<string, unknown> = {};
      if (meta.preflight) {
        try {
          context = await meta.preflight(args, run);
        } catch (err) {
          context = { preflightError: (err as Error).message };
        }
      }
      const policy = classify({ tool: def.name, args, cwd: deps.workspace, tainted: run.tainted, context }, deps.rules);
      const callId = await deps.repo.insertToolCall({
        taskId: run.taskId,
        tool: def.name,
        args: JSON.parse(redact(JSON.stringify(args))) as unknown,
        decision: policy.decision,
        reason: policy.reason,
      });
      const finish = async (outcome: ToolOutcome, summary: string, isError: boolean) => {
        await deps.repo
          .finishToolCall(callId, { outcome, resultSummary: redact(summary), isError, durationMs: Date.now() - started })
          .catch((err: unknown) => deps.log.error({ err, callId }, "could not record tool call result"));
      };
      deps.log.info({ taskId: run.taskId, tool: def.name, decision: policy.decision, reason: policy.reason }, "tool call");

      if (policy.decision === "deny") {
        await finish("denied_by_policy", policy.reason, true);
        throw new Error(`Blocked by policy: ${policy.reason}. This action is not permitted; do not retry it.`);
      }

      if (policy.decision === "ask") {
        const attachments = meta.approvalAttachments ? await meta.approvalAttachments(args, run).catch(() => []) : [];
        await run.onWaitingApproval(true);
        const outcome = await deps.approvals.request({
          taskId: run.taskId,
          toolCallId: callId,
          chatId: run.chatId,
          command: redact(describe(args)),
          reason: redact(run.lastAssistantText.trim() || "(no reason given)"),
          policyReason: policy.reason,
          timeoutSeconds: run.approvalTimeoutSeconds,
          attachments,
          signal: run.signal,
        });
        await run.onWaitingApproval(false);
        if (outcome !== "approved") {
          const recorded: ToolOutcome = outcome === "denied" ? "denied_by_owner" : outcome;
          await finish(recorded, outcome, true);
          throw new Error(deniedToolMessage(outcome, run.approvalTimeoutSeconds));
        }
      }

      run.onToolStart(redact(describe(args)));
      if (meta.taints !== false) run.tainted = true; // the output is about to enter the context
      try {
        const result = await def.execute(toolCallId, params, signal, onUpdate, ctx);
        const text = redact(resultText(result.content));
        await finish("executed", text.slice(0, 500), Boolean(result.isError));
        return {
          ...result,
          content: result.content.map((c) =>
            c.type === "text" ? { ...c, text: wrapOutput(truncateMiddle(redact(c.text), deps.maxOutputChars), Boolean(meta.ownerData)) } : c,
          ),
        };
      } catch (err) {
        const raw = err instanceof SandboxError ? `Sandbox error: ${err.message}` : (err as Error).message;
        const message = redact(raw);
        const aborted = run.signal.aborted;
        await finish(aborted ? "cancelled" : "error", message.slice(0, 500), true);
        // Error text from a failed command contains its output, so it is untrusted too.
        throw new Error(wrapOutput(truncateMiddle(message, deps.maxOutputChars), Boolean(meta.ownerData)));
      }
    },
  };
}

export function guardTools(tools: AgentTool[], deps: ToolDeps): AnyTool[] {
  return tools.map((t) => guardTool(t, deps));
}
