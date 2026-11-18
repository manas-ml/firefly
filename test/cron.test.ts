import { describe, expect, it } from "vitest";
import { describeCron, nextRun, validateCron } from "../src/scheduler/cron.ts";

describe("cron helpers", () => {
  it("describes cron in plain words", () => {
    expect(describeCron("0 8 * * 1-5")).toBe("At 08:00, Monday through Friday");
    expect(describeCron("30 18 * * *")).toBe("At 18:30");
  });
  it("validates expressions and time zones", () => {
    expect(validateCron("0 8 * * 1-5", "America/Toronto")).toBeUndefined();
    expect(validateCron("0 8 * *", "UTC")).toMatch(/5 fields/);
    expect(validateCron("61 8 * * *", "UTC")).toMatch(/invalid cron/);
    expect(validateCron("0 8 * * *", "Mars/Olympus")).toMatch(/time zone/);
  });
  it("computes the next run in the schedule's time zone", () => {
    // Monday 2026-11-16 13:00 UTC = 08:00 Toronto (EST, UTC-5)
    const next = nextRun("0 8 * * 1-5", "America/Toronto", new Date("2026-11-16T12:00:00Z"));
    expect(next?.toISOString()).toBe("2026-11-16T13:00:00.000Z");
    const afterFriday = nextRun("0 8 * * 1-5", "America/Toronto", new Date("2026-11-20T14:00:00Z"));
    expect(afterFriday?.toISOString()).toBe("2026-11-23T13:00:00.000Z");
  });
});
