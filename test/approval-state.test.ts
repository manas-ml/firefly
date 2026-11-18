import { describe, expect, it } from "vitest";
import { checkResolve, decodeCallback, encodeCallback, isExpired, type ApprovalSnapshot } from "../src/approvals/state.ts";

const now = new Date("2026-11-18T12:00:00Z");
const pending: ApprovalSnapshot = {
  id: "0b6a3f1e-1111-4222-8333-944455556666",
  status: "pending",
  chatId: 42,
  expiresAt: new Date(now.getTime() + 60_000),
};
const base = { userAllowed: true, chatId: 42, action: "approve" as const, now };

describe("checkResolve", () => {
  it("approves and denies a pending approval", () => {
    expect(checkResolve(pending, base)).toEqual({ ok: true, next: "approved" });
    expect(checkResolve(pending, { ...base, action: "deny" })).toEqual({ ok: true, next: "denied" });
  });
  it("rejects users not on the allowlist before anything else", () => {
    expect(checkResolve(undefined, { ...base, userAllowed: false })).toMatchObject({ ok: false, error: "not_allowed" });
  });
  it("rejects unknown approvals", () => {
    expect(checkResolve(undefined, base)).toMatchObject({ ok: false, error: "not_found" });
  });
  it("rejects presses from another chat", () => {
    expect(checkResolve(pending, { ...base, chatId: 7 })).toMatchObject({ ok: false, error: "wrong_chat" });
  });
  it("rejects resolving twice", () => {
    for (const status of ["approved", "denied", "expired"] as const) {
      expect(checkResolve({ ...pending, status }, base)).toMatchObject({ ok: false, error: "already_resolved" });
    }
  });
  it("rejects expired approvals", () => {
    const old = { ...pending, expiresAt: new Date(now.getTime() - 1) };
    expect(checkResolve(old, base)).toMatchObject({ ok: false, error: "expired" });
    expect(isExpired(old, now)).toBe(true);
    expect(isExpired(pending, now)).toBe(false);
  });
});

describe("callback data", () => {
  it("round-trips and stays under Telegram's 64-byte limit", () => {
    const data = encodeCallback("deny", pending.id);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(decodeCallback(data)).toEqual({ action: "deny", id: pending.id });
  });
  it("rejects anything else", () => {
    expect(decodeCallback("ap:y:not-a-uuid")).toBeUndefined();
    expect(decodeCallback(`xx:y:${pending.id}`)).toBeUndefined();
    expect(decodeCallback(`ap:y:${pending.id};drop`)).toBeUndefined();
  });
});
