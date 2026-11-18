import { describe, expect, it } from "vitest";
import { classify } from "../src/policy/engine.ts";
import { parsePolicyRules } from "../src/policy/rules.ts";
import { loadPolicyRules } from "../src/policy/rules.ts";
import { mcpDecision, mcpToolName, parseMcpConfig } from "../src/mcp/config.ts";

const rules = loadPolicyRules("config/policy.yaml");
const click = (element: Record<string, unknown> | undefined, context: Record<string, unknown> = {}) =>
  classify({ tool: "browser_click", args: { ref: "e1" }, context: { element, ...context } }, rules);

describe("browser policy", () => {
  it("allows opening and reading pages", () => {
    expect(classify({ tool: "browser_open", args: { url: "https://example.com/x" } }, rules).decision).toBe("allow");
    expect(classify({ tool: "browser_snapshot", args: {} }, rules).decision).toBe("allow");
    expect(classify({ tool: "browser_screenshot", args: {} }, rules).decision).toBe("allow");
  });
  it("denies non-http URLs and blocklisted or non-allowlisted domains", () => {
    expect(classify({ tool: "browser_open", args: { url: "file:///etc/passwd" } }, rules).decision).toBe("deny");
    const strict = parsePolicyRules({
      workspace: "/workspace",
      read_roots: ["/workspace"],
      writable_roots: ["/workspace"],
      bash: {},
      browser: { blocked_domains: ["evil.test"], allowed_domains: ["example.com", "evil.test"] },
    });
    expect(classify({ tool: "browser_open", args: { url: "https://shop.evil.test/" } }, strict).decision).toBe("deny");
    expect(classify({ tool: "browser_open", args: { url: "https://other.org/" } }, strict).reason).toContain("allowlist");
    expect(classify({ tool: "browser_open", args: { url: "https://www.example.com/" } }, strict).decision).toBe("allow");
  });
  it("allows navigation clicks", () => {
    expect(click({ tag: "a", name: "Opening hours", href: "https://x.org/hours" }).decision).toBe("allow");
    expect(click({ tag: "button", type: "button", name: "Next page", inForm: false }).decision).toBe("allow");
  });
  it("asks for submit, buy, send, post and similar", () => {
    expect(click({ tag: "button", type: "submit", name: "Go", inForm: true }).reason).toContain("submits a form");
    expect(click({ tag: "button", type: "", name: "Search", inForm: true }).decision).toBe("ask");
    for (const name of ["Buy now", "Place order", "Send", "Post", "Reply", "Delete account", "Sign in"]) {
      expect(click({ tag: "div", role: "button", name }).decision).toBe("ask");
    }
    expect(click({ tag: "a", name: "Bypass" }).decision).toBe("allow"); // "pass" isn't "pay"
  });
  it("asks when the element couldn't be inspected", () => {
    expect(click(undefined, { preflightError: "boom" }).decision).toBe("ask");
  });
  it("typing is allowed, typing with submit asks, and after taint typing asks", () => {
    expect(classify({ tool: "browser_type", args: { text: "x" } }, rules).decision).toBe("allow");
    expect(classify({ tool: "browser_type", args: { text: "x", submit: true } }, rules).decision).toBe("ask");
    expect(classify({ tool: "browser_type", args: { text: "x" }, tainted: true }, rules).decision).toBe("ask");
  });
  it("vault_fill always asks", () => {
    expect(classify({ tool: "vault_fill", args: {} }, rules).decision).toBe("ask");
  });
});

describe("mcp config", () => {
  const cfg = parseMcpConfig({ servers: { mail: { url: "https://x.test/mcp", tools: { FETCH: "read", SEND: "write" } } } });
  it("maps tags to decisions; untagged tools use the server default (ask)", () => {
    const mail = cfg.servers.mail!;
    expect(mcpDecision(mail, "FETCH")).toBe("allow");
    expect(mcpDecision(mail, "SEND")).toBe("ask");
    expect(mcpDecision(mail, "FORWARD_ALL")).toBe("ask");
  });
  it("names tools mcp__server__tool", () => {
    expect(mcpToolName("mail", "GMAIL.SEND")).toBe("mcp__mail__GMAIL_SEND");
  });
  it("rejects servers with both or neither url and command", () => {
    expect(() => parseMcpConfig({ servers: { x: {} } })).toThrow(/exactly one/);
    expect(() => parseMcpConfig({ servers: { x: { url: "https://a.b", command: "y" } } })).toThrow(/exactly one/);
    expect(parseMcpConfig({ servers: null }).servers).toEqual({});
  });
});
