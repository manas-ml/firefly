import { describe, expect, it } from "vitest";
import { normalizeSecretName, parseMasterKey, redactSecrets } from "../src/vault/vault.ts";

describe("vault helpers", () => {
  it("parses hex and base64 master keys of exactly 32 bytes", () => {
    expect(parseMasterKey("ab".repeat(32))).toHaveLength(32);
    expect(parseMasterKey(Buffer.alloc(32, 7).toString("base64") + "\n")).toHaveLength(32);
    expect(() => parseMasterKey("abcd")).toThrow(/32 bytes/);
  });
  it("normalizes names", () => {
    expect(normalizeSecretName("vault:GitHub")).toBe("github");
  });
  it("redacts values and their encodings", () => {
    const secrets = new Map([["github", "ghp_s3cr3t/value+x"], ["pin", "12"]]);
    const text = `token=ghp_s3cr3t/value+x url=${encodeURIComponent("ghp_s3cr3t/value+x")} b64=${Buffer.from("ghp_s3cr3t/value+x").toString("base64")} pin 12`;
    const out = redactSecrets(text, secrets);
    expect(out).not.toContain("s3cr3t");
    expect(out).toContain("token=[vault:github]");
    expect(out).toContain("pin 12"); // too short to redact safely
  });
});
