export interface UpdateSender {
  fromId: number | undefined;
  chatType: string | undefined;
}

/**
 * Only private chats with an allowlisted user get through. Groups, channels and
 * unknown senders are dropped (the caller logs them and sends nothing back).
 */
export function isAllowed(sender: UpdateSender, allowed: readonly number[]): boolean {
  if (sender.fromId === undefined) return false;
  if (sender.chatType !== undefined && sender.chatType !== "private") return false;
  return allowed.includes(sender.fromId);
}
