import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

const valid = {
  TELEGRAM_BOT_TOKEN: "123456:ABCdefGHIjklMNOpqrSTUvwxYZ012345678",
  TELEGRAM_ALLOWED_USER_IDS: "111, 222",
  OPENROUTER_API_KEY: "sk-or-v1-abcdefghijkl",
  DATABASE_URL: "postgres://u:p@postgres:5432/db",
  SANDBOX_URL: "http://sandbox:7070",
  SANDBOX_TOKEN: "x".repeat(32),
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(valid);
    expect(c.TELEGRAM_ALLOWED_USER_IDS).toEqual([111, 222]);
    expect(c.MODEL).toBe("deepseek/deepseek-v4.1-flash");
    expect(c.APPROVAL_TIMEOUT_SECONDS).toBe(600);
    expect(c.TOOL_TIMEOUT_SECONDS).toBe(120);
    expect(c.MAX_TOOL_OUTPUT_CHARS).toBe(20000);
    expect(c.TZ).toBe("America/Toronto");
  });

  it("fails fast with every problem listed", () => {
    const run = () => loadConfig({ ...valid, TELEGRAM_BOT_TOKEN: "", TELEGRAM_ALLOWED_USER_IDS: "me", SANDBOX_TOKEN: "short", APPROVAL_TIMEOUT_SECONDS: "-1" });
    expect(run).toThrow(ConfigError);
    try {
      run();
    } catch (err) {
      const msg = (err as Error).message;
      for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS", "SANDBOX_TOKEN", "APPROVAL_TIMEOUT_SECONDS"]) expect(msg).toContain(key);
    }
  });

  it("rejects missing required values and bad model ids", () => {
    const { OPENROUTER_API_KEY: _, ...missing } = valid;
    expect(() => loadConfig(missing)).toThrow(/OPENROUTER_API_KEY/);
    expect(() => loadConfig({ ...valid, MODEL: "no-slash" })).toThrow(/MODEL/);
  });
});
