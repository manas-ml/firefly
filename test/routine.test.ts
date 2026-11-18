import { describe, expect, it } from "vitest";
import { isNoReport, routinePrompt } from "../src/orchestrator/orchestrator.ts";

describe("routines", () => {
  it("recognises NO_REPORT with formatting around it", () => {
    for (const t of ["NO_REPORT", " no_report\n", "`NO_REPORT`", "**NO_REPORT**.", "_NO_REPORT_"]) expect(isNoReport(t)).toBe(true);
  });
  it("does not drop real reports", () => {
    for (const t of ["NO_REPORT: but 3 files changed", "Nothing to report", "NOREPORT x", ""]) expect(isNoReport(t)).toBe(false);
  });
  it("tells the routine how to stay silent", () => {
    expect(routinePrompt("daily", "do it")).toMatch(/reply with exactly NO_REPORT/);
  });
});
