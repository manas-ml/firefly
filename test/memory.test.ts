import { describe, expect, it } from "vitest";
import { normalizeTopic } from "../src/memory/store.ts";
import { rememberRefusal } from "../src/memory/tools.ts";

describe("memory rules", () => {
  it("only accepts facts from an untainted owner-triggered task", () => {
    expect(rememberRefusal({ trigger: "user", tainted: false })).toBeUndefined();
    expect(rememberRefusal({ trigger: "user", tainted: true })).toMatch(/owner's own message/);
    expect(rememberRefusal({ trigger: "routine", tainted: false })).toMatch(/routine/);
  });
  it("normalizes topics to safe file names", () => {
    expect(normalizeTopic(undefined)).toBe("profile");
    expect(normalizeTopic("My Garden!")).toBe("my-garden");
    expect(normalizeTopic("../../etc/passwd")).toBe("etc-passwd");
    expect(normalizeTopic("???")).toBe("profile");
  });
});
