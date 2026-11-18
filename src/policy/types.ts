export type Decision = "allow" | "ask" | "deny";

export interface PolicyResult {
  decision: Decision;
  reason: string;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  /** Working directory the tool resolves relative paths against. */
  cwd?: string;
}

const RANK: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };

/** The stricter of two results; on a tie the first one wins (keeps the earliest reason). */
export function stricter(a: PolicyResult, b: PolicyResult): PolicyResult {
  return RANK[b.decision] > RANK[a.decision] ? b : a;
}
