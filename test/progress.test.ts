import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Throttle } from "../src/telegram/progress.ts";

describe("Throttle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends the first update immediately and at most one per interval", () => {
    const sent: string[] = [];
    const t = new Throttle(2000, (s) => sent.push(s), () => Date.now());
    t.update("a");
    t.update("b");
    t.update("c");
    expect(sent).toEqual(["a"]);
    vi.advanceTimersByTime(1999);
    expect(sent).toEqual(["a"]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(["a", "c"]);
    vi.advanceTimersByTime(5000);
    t.update("d");
    expect(sent).toEqual(["a", "c", "d"]);
  });

  it("skips duplicates and stops after close", () => {
    const sent: string[] = [];
    const t = new Throttle(2000, (s) => sent.push(s), () => Date.now());
    t.update("a");
    vi.advanceTimersByTime(3000);
    t.update("a");
    t.update("b");
    t.update("c");
    t.close();
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual(["a", "b"]);
  });
});
