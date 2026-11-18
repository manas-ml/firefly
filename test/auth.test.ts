import { describe, expect, it } from "vitest";
import { isAllowed } from "../src/telegram/auth.ts";

describe("isAllowed", () => {
  const allowed = [111, 222];
  it("accepts allowlisted users in private chats", () => {
    expect(isAllowed({ fromId: 111, chatType: "private" }, allowed)).toBe(true);
    expect(isAllowed({ fromId: 222, chatType: undefined }, allowed)).toBe(true);
  });
  it("rejects everyone else", () => {
    expect(isAllowed({ fromId: 333, chatType: "private" }, allowed)).toBe(false);
    expect(isAllowed({ fromId: undefined, chatType: "private" }, allowed)).toBe(false);
  });
  it("rejects group chats even for the owner", () => {
    expect(isAllowed({ fromId: 111, chatType: "group" }, allowed)).toBe(false);
    expect(isAllowed({ fromId: 111, chatType: "supergroup" }, allowed)).toBe(false);
    expect(isAllowed({ fromId: 111, chatType: "channel" }, allowed)).toBe(false);
  });
});
