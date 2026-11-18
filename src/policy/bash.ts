import path from "node:path";
import { forEachChild, parse, type SyntaxNode } from "unbash";
import type { PolicyRules } from "./rules.ts";
import { stricter, type PolicyResult } from "./types.ts";

// Narrow structural views of the unbash nodes we inspect. unbash's own node
// interfaces are not all re-exported from its entry point, so these mirror the
// fields we read (see node_modules/unbash/dist/types.d.ts).
interface WordNode {
  type: "Word";
  text: string;
  value: string;
}
interface RedirectNode {
  type: "Redirect" | "HereString" | "HereDoc";
  operator: string;
  target?: WordNode;
}
interface CommandNode {
  type: "Command";
  name: WordNode | undefined;
  prefix: readonly { type: string }[];
  args: readonly { type: string; text?: string }[];
  redirects: readonly RedirectNode[];
}
interface FunctionNode {
  type: "Function";
  pos: number;
  end: number;
  name: WordNode;
}

const ALLOW: PolicyResult = { decision: "allow", reason: "read-only command" };

/** Word part types whose value is fixed at parse time. Globs are allowed in arguments only. */
const LITERAL_PARTS = new Set(["Word", "Literal", "SingleQuoted", "DoubleQuoted", "AnsiCQuoted"]);
const ARG_LITERAL_PARTS = new Set([...LITERAL_PARTS, "Glob", "ExtendedGlob", "BraceExpansion"]);

/** Paths that output redirects may target without counting as a file write. */
const HARMLESS_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

function isLiteral(node: SyntaxNode, allowed: Set<string>): boolean {
  if (!allowed.has(node.type)) return false;
  let ok = true;
  forEachChild(node, (child) => {
    if (ok && !isLiteral(child, allowed)) ok = false;
  });
  return ok;
}

function isUnder(p: string, roots: readonly string[]): boolean {
  return roots.some((root) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`));
}

type PathInfo = { kind: "known"; abs: string } | { kind: "outside"; shown: string } | { kind: "unknown" };

/**
 * Resolve a literal path argument against the tracked cwd.
 * `~` and `$HOME` are always outside the workspace (they are the sandbox user's home).
 */
function resolvePath(text: string, literal: boolean, cwd: string | undefined): PathInfo {
  if (text.startsWith("~") || text.startsWith("$HOME") || text.startsWith("${HOME}")) {
    return { kind: "outside", shown: text };
  }
  if (!literal) return { kind: "unknown" };
  const unquoted = text.replace(/^['"]|['"]$/g, "");
  if (path.posix.isAbsolute(unquoted)) return { kind: "known", abs: path.posix.normalize(unquoted) };
  if (cwd === undefined) return { kind: "unknown" };
  return { kind: "known", abs: path.posix.resolve(cwd, unquoted) };
}

interface WalkState {
  cwd: string | undefined;
  result: PolicyResult;
  /** Names of functions defined in the script (fork-bomb detection). */
  functions: Set<string>;
  source: string;
}

export function classifyBash(command: string, rules: PolicyRules, cwd = rules.workspace): PolicyResult {
  const trimmed = command.trim();
  if (trimmed === "") return { decision: "deny", reason: "empty command" };

  // Raw-text deny patterns first: they also see inside quoted strings (bash -c "...").
  for (const { regex, reason } of rules.bash.deny_patterns) {
    if (regex.test(command)) return { decision: "deny", reason };
  }

  let ast: SyntaxNode & { errors?: readonly unknown[] };
  try {
    ast = parse(command);
  } catch {
    return { decision: "ask", reason: "could not parse command" };
  }
  if (ast.errors && ast.errors.length > 0) return { decision: "ask", reason: "could not parse command" };

  const state: WalkState = { cwd, result: ALLOW, functions: new Set(), source: command };
  walk(ast, rules, state);
  return state.result;
}

function walk(node: SyntaxNode, rules: PolicyRules, state: WalkState): void {
  if (state.result.decision === "deny") return;

  // Nested scripts ($(...), `...`, <(...)) carry their own parse errors.
  const errors = (node as { errors?: readonly unknown[] }).errors;
  if (node.type === "Script" && errors && errors.length > 0) {
    state.result = stricter(state.result, { decision: "ask", reason: "could not parse part of the command" });
  }

  switch (node.type) {
    case "Command":
      state.result = stricter(state.result, classifyCommand(node as unknown as CommandNode, rules, state));
      break;
    case "Function": {
      const fn = node as unknown as FunctionNode;
      state.functions.add(fn.name.value);
      if (isForkBomb(fn, state.source)) {
        state.result = { decision: "deny", reason: "fork bomb" };
        return;
      }
      state.result = stricter(state.result, { decision: "ask", reason: "defines a shell function" });
      break;
    }
    case "Coproc":
      state.result = stricter(state.result, { decision: "ask", reason: "starts a coprocess" });
      break;
    default:
      break;
  }

  forEachChild(node, (child) => walk(child, rules, state));
}

function classifyCommand(cmd: CommandNode, rules: PolicyRules, state: WalkState): PolicyResult {
  let result: PolicyResult = ALLOW;
  const bash = rules.bash;

  // Redirections apply whatever the program is.
  for (const r of cmd.redirects) {
    result = stricter(result, classifyRedirect(r, rules, state));
  }

  if (cmd.prefix.some((p) => p.type === "Assignment")) {
    result = stricter(result, { decision: "ask", reason: "sets environment variables for the command" });
  }

  if (!cmd.name) {
    return stricter(result, { decision: "ask", reason: "variable assignment" });
  }
  if (!isLiteral(cmd.name as unknown as SyntaxNode, LITERAL_PARTS)) {
    return stricter(result, { decision: "ask", reason: "command name is computed at run time" });
  }
  const name = cmd.name.value;

  if (state.functions.has(name)) {
    // A function calling itself through a pipe is the classic fork bomb.
    return stricter(result, { decision: "ask", reason: `calls shell function ${name}` });
  }
  if (name.includes("/")) {
    return stricter(result, { decision: "ask", reason: `runs ${name}` });
  }

  const words = cmd.args.filter((a): a is WordNode => a.type === "Word");
  const argTexts = words.map((w) => w.value);
  const argLiteral = words.map((w) => isLiteral(w as unknown as SyntaxNode, ARG_LITERAL_PARTS));

  // cd changes how later relative paths resolve.
  if (name === "cd") {
    const target = argTexts.find((a) => !a.startsWith("-"));
    const idx = target === undefined ? -1 : argTexts.indexOf(target);
    if (target === undefined) state.cwd = undefined; // cd with no args goes to $HOME
    else {
      const info = resolvePath(target, argLiteral[idx] ?? false, state.cwd);
      state.cwd = info.kind === "known" ? info.abs : undefined;
    }
    return result;
  }

  if (name === "git") return stricter(result, classifyGit(argTexts, rules));

  // Write commands: deny outside writable roots, otherwise ask.
  const isWrite = bash.write_commands.includes(name);
  const isDest = bash.destination_commands.includes(name);
  const isSedInPlace = name === "sed" && argTexts.some((a) => a === "-i" || a.startsWith("-i") || a.startsWith("--in-place"));
  const isDd = name === "dd";
  if (isWrite || isDest || isSedInPlace || isDd) {
    const targets = writeTargets(name, words, argLiteral, { isDest, isDd });
    for (const t of targets) {
      const info = resolvePath(t.text, t.literal, state.cwd);
      if (info.kind === "outside") return { decision: "deny", reason: `${name} writes outside the workspace (${info.shown})` };
      if (info.kind === "known" && !isUnder(info.abs, rules.writable_roots) && !HARMLESS_SINKS.has(info.abs)) {
        return { decision: "deny", reason: `${name} writes outside the workspace (${info.abs})` };
      }
    }
    return stricter(result, { decision: "ask", reason: `${name} modifies files` });
  }

  if (!bash.read_only_commands.includes(name)) {
    return stricter(result, { decision: "ask", reason: `runs ${name}` });
  }

  const unsafe = bash.unsafe_flags[name] ?? [];
  const badFlag = argTexts.find((a) => unsafe.some((f) => a === f || a.startsWith(`${f}=`)));
  if (badFlag) return stricter(result, { decision: "ask", reason: `${name} ${badFlag} can write files or run programs` });

  if (!bash.non_path_commands.includes(name)) {
    for (let i = 0; i < argTexts.length; i++) {
      const a = argTexts[i] ?? "";
      if (a.startsWith("-")) continue;
      // Only arguments that look like paths escaping the cwd matter for reads.
      if (!(a.startsWith("/") || a.startsWith("~") || a.startsWith("$") || a.includes(".."))) continue;
      const info = resolvePath(a, argLiteral[i] ?? false, state.cwd);
      if (info.kind === "unknown") return stricter(result, { decision: "ask", reason: `${name} reads a path computed at run time` });
      if (info.kind === "outside") return stricter(result, { decision: "ask", reason: `${name} reads outside the workspace (${info.shown})` });
      if (!isUnder(info.abs, rules.read_roots)) {
        return stricter(result, { decision: "ask", reason: `${name} reads outside the workspace (${info.abs})` });
      }
    }
  }
  if (state.cwd === undefined || !isUnder(state.cwd, rules.read_roots)) {
    return stricter(result, { decision: "ask", reason: `${name} runs outside the workspace` });
  }
  return result;
}

function writeTargets(
  name: string,
  words: WordNode[],
  literal: boolean[],
  opts: { isDest: boolean; isDd: boolean },
): { text: string; literal: boolean }[] {
  const items = words.map((w, i) => ({ text: w.value, literal: literal[i] ?? false }));
  if (opts.isDd) {
    return items.filter((w) => w.text.startsWith("of=")).map((w) => ({ ...w, text: w.text.slice(3) }));
  }
  if (name === "sed") {
    // sed -i 's/a/b/' FILE...: the first non-flag argument is the script.
    const nonFlags = items.filter((w) => !w.text.startsWith("-"));
    return nonFlags.slice(1);
  }
  if (opts.isDest) {
    const tIdx = items.findIndex((w) => w.text === "-t" || w.text.startsWith("--target-directory"));
    if (tIdx >= 0) {
      const t = items[tIdx]!;
      if (t.text.includes("=")) return [{ ...t, text: t.text.split("=").slice(1).join("=") }];
      const next = items[tIdx + 1];
      return next ? [next] : [];
    }
    const nonFlags = items.filter((w) => !w.text.startsWith("-"));
    const last = nonFlags[nonFlags.length - 1];
    return last ? [last] : [];
  }
  return items.filter((w) => !w.text.startsWith("-"));
}

function classifyRedirect(r: RedirectNode, rules: PolicyRules, state: WalkState): PolicyResult {
  if (r.type !== "Redirect") return ALLOW; // here-docs and here-strings feed stdin
  const op = r.operator;
  const target = r.target;
  if (!target) return { decision: "ask", reason: "redirect without a target" };
  // fd duplication like 2>&1 or <&0
  if ((op === ">&" || op === "<&") && /^(\d+|-)$/.test(target.value)) return ALLOW;

  const literal = isLiteral(target as unknown as SyntaxNode, LITERAL_PARTS);
  const info = resolvePath(target.value, literal, state.cwd);
  const isOutput = op !== "<";

  if (isOutput) {
    if (info.kind === "known" && HARMLESS_SINKS.has(info.abs)) return ALLOW;
    if (info.kind === "outside") return { decision: "deny", reason: `writes outside the workspace (${info.shown})` };
    if (info.kind === "known" && !isUnder(info.abs, rules.writable_roots)) {
      return { decision: "deny", reason: `writes outside the workspace (${info.abs})` };
    }
    return { decision: "ask", reason: `writes to ${target.value}` };
  }
  if (info.kind === "unknown") return { decision: "ask", reason: "reads from a path computed at run time" };
  if (info.kind === "outside") return { decision: "ask", reason: `reads outside the workspace (${info.shown})` };
  if (!isUnder(info.abs, rules.read_roots)) return { decision: "ask", reason: `reads outside the workspace (${info.abs})` };
  return ALLOW;
}

function classifyGit(args: string[], rules: PolicyRules): PolicyResult {
  const git = rules.bash.git;
  const sub = args[0];
  if (sub === undefined) return ALLOW; // bare `git` prints help
  if (sub.startsWith("-")) return { decision: "ask", reason: `git with global option ${sub}` };
  if (!git.read_only_subcommands.includes(sub)) return { decision: "ask", reason: `git ${sub}` };
  const bad = args.slice(1).find((a) => git.unsafe_flags.some((f) => a === f || a.startsWith(`${f}=`)));
  if (bad) return { decision: "ask", reason: `git ${sub} ${bad} can write files or run programs` };
  return ALLOW;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A function whose body calls itself through a pipe or in the background. */
function isForkBomb(fn: FunctionNode, source: string): boolean {
  const name = escapeRegex(fn.name.value);
  const text = source.slice(fn.pos, fn.end);
  const header = new RegExp(`^\\s*(function\\s+)?${name}\\s*(\\(\\s*\\))?`);
  const body = text.replace(header, "");
  const selfCall = new RegExp(`(^|[\\s;|&{(])${name}(?=[\\s;|&})]|$)`);
  if (!selfCall.test(body)) return false;
  return new RegExp(`${name}\\s*\\|`).test(body) || new RegExp(`\\|\\s*${name}`).test(body) || new RegExp(`${name}\\s*&(?!&)`).test(body);
}
