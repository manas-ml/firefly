import path from "node:path";
import { classifyBash } from "./bash.ts";
import type { PolicyRules } from "./rules.ts";
import type { PolicyResult, ToolCall } from "./types.ts";

export type { Decision, PolicyResult, ToolCall } from "./types.ts";

function isUnder(p: string, roots: readonly string[]): boolean {
  return roots.some((root) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`));
}

/** Resolve a tool's path argument the way the file tools will: relative to cwd, `~` never inside. */
export function resolveToolPath(raw: string, cwd: string): string | undefined {
  let p = raw.trim();
  if (p.startsWith("@")) p = p.slice(1); // Pi strips a leading @ from file references
  if (p === "" || p.includes("\0")) return undefined;
  if (p === "~" || p.startsWith("~/")) return undefined;
  return path.posix.resolve(cwd, p);
}

/**
 * Pure policy decision for one tool call. No I/O; rules come from config/policy.yaml.
 * Safety lives here and in the sandbox, never in the system prompt.
 */
export function classify(call: ToolCall, rules: PolicyRules): PolicyResult {
  const base = classifyBase(call, rules);
  if (base.decision === "allow" && call.tainted && isTaintedWrite(call, rules)) {
    return { decision: "ask", reason: `${base.reason}, after reading untrusted content in this task` };
  }
  return base;
}

function isTaintedWrite(call: ToolCall, rules: PolicyRules): boolean {
  return rules.taint.write_tools.some((pattern) =>
    pattern.endsWith("*") ? call.tool.startsWith(pattern.slice(0, -1)) : pattern === call.tool,
  );
}

function classifyBase(call: ToolCall, rules: PolicyRules): PolicyResult {
  // A preflight check found the arguments invalid (e.g. a malformed cron): refuse before asking anyone.
  if (typeof call.context?.invalid === "string") return { decision: "deny", reason: call.context.invalid };
  const cwd = call.cwd ?? rules.workspace;
  const configured = rules.tools[call.tool];

  switch (call.tool) {
    case "bash": {
      const command = call.args.command;
      if (typeof command !== "string") return { decision: "deny", reason: "bash call without a command" };
      return classifyBash(command, rules, cwd);
    }
    case "read":
    case "write":
    case "edit": {
      const raw = call.args.path;
      if (typeof raw !== "string") return { decision: "deny", reason: `${call.tool} call without a path` };
      const abs = resolveToolPath(raw, cwd);
      const roots = call.tool === "read" ? rules.read_roots : rules.writable_roots;
      if (abs === undefined || !isUnder(abs, roots)) {
        return { decision: "deny", reason: `${call.tool} outside the workspace (${raw})` };
      }
      const decision = configured ?? "allow";
      return { decision, reason: decision === "allow" ? `${call.tool} inside the workspace` : `${call.tool} needs approval` };
    }
    default: {
      const decision = configured ?? rules.tools.default ?? "ask";
      return { decision, reason: `tool ${call.tool}` };
    }
  }
}
