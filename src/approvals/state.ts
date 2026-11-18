export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";
export type ApprovalAction = "approve" | "deny";

export interface ApprovalSnapshot {
  id: string;
  status: ApprovalStatus;
  chatId: number;
  expiresAt: Date;
}

export type ResolveCheck =
  | { ok: true; next: "approved" | "denied" }
  | { ok: false; error: "not_allowed" | "not_found" | "wrong_chat" | "already_resolved" | "expired"; message: string };

/** Pure validation of an Approve/Deny button press. */
export function checkResolve(
  approval: ApprovalSnapshot | undefined,
  input: { userAllowed: boolean; chatId: number | undefined; action: ApprovalAction; now: Date },
): ResolveCheck {
  if (!input.userAllowed) return { ok: false, error: "not_allowed", message: "Not allowed." };
  if (!approval) return { ok: false, error: "not_found", message: "This approval no longer exists." };
  if (input.chatId !== undefined && input.chatId !== approval.chatId) {
    return { ok: false, error: "wrong_chat", message: "This approval belongs to another chat." };
  }
  if (approval.status !== "pending") {
    return { ok: false, error: "already_resolved", message: `Already ${approval.status}.` };
  }
  if (isExpired(approval, input.now)) return { ok: false, error: "expired", message: "This approval has expired." };
  return { ok: true, next: input.action === "approve" ? "approved" : "denied" };
}

export function isExpired(approval: Pick<ApprovalSnapshot, "expiresAt">, now: Date): boolean {
  return now.getTime() >= approval.expiresAt.getTime();
}

/** What the agent is told when a call doesn't go ahead. */
export function deniedToolMessage(status: Exclude<ApprovalStatus, "pending" | "approved"> | "cancelled", timeoutSeconds: number): string {
  switch (status) {
    case "denied":
      return "Denied by owner. The owner rejected this action; do not retry it. Explain or choose another approach.";
    case "expired":
      return `Denied by owner: no answer within ${timeoutSeconds} seconds, so the approval expired. Do not retry it; tell the owner it needs their approval.`;
    case "cancelled":
      return "Cancelled: the task was stopped.";
  }
}

const CALLBACK_PREFIX = "ap";

export function encodeCallback(action: ApprovalAction, id: string): string {
  return `${CALLBACK_PREFIX}:${action === "approve" ? "y" : "n"}:${id}`;
}

export function decodeCallback(data: string): { action: ApprovalAction; id: string } | undefined {
  const m = data.match(/^ap:([yn]):([0-9a-f-]{36})$/);
  if (!m) return undefined;
  return { action: m[1] === "y" ? "approve" : "deny", id: m[2]! };
}
