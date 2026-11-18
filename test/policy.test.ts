import { describe, expect, it } from "vitest";
import { classify } from "../src/policy/engine.ts";
import { loadPolicyRules } from "../src/policy/rules.ts";

const rules = loadPolicyRules("config/policy.yaml");
const bash = (command: string, cwd?: string) => classify({ tool: "bash", args: { command }, cwd }, rules);
const decision = (command: string) => bash(command).decision;

describe("bash: allow", () => {
  it.each([
    "ls",
    "ls -la",
    "ls /workspace",
    "pwd",
    "cat notes.txt | grep todo | wc -l",
    "head -n 20 src/main.py && tail -5 log.txt",
    "find . -name '*.py'",
    "grep -rn TODO .",
    "rg foo src",
    "git status",
    "git log --oneline -n 5",
    "git diff HEAD~1",
    "echo hello",
    "echo /etc/passwd", // echo arguments are not paths
    "jq .name package.json",
    "which python3",
    "ls 2>/dev/null",
    "ls 2>&1 | head",
    "cd sub && ls",
    "ls *.txt",
    "cat $(echo notes.txt)".replace("$(echo notes.txt)", "notes.txt"),
  ])("%s", (cmd) => {
    expect(bash(cmd)).toEqual({ decision: "allow", reason: expect.any(String) });
  });
});

describe("bash: ask", () => {
  it.each([
    ["python3 hello.py", "runs python3"],
    ["npm install", "runs npm"],
    ["echo hi > out.txt", "writes to out.txt"],
    ["echo hi >> /workspace/log.txt", "writes"],
    ["rm notes.txt", "rm modifies files"],
    ["rm -rf /workspace", "rm modifies files"],
    ["mv a b", "mv modifies files"],
    ["cp /etc/hosts .", "cp modifies files"],
    ["find . -delete", "-delete"],
    ["find . -exec rm {} \;", "-exec"],
    ["rg --pre ./evil foo", "--pre"],
    ["git diff --output=x", "--output"],
    ["git -c core.pager=evil log", "global option"],
    ["git commit -m x", "git commit"],
    ["git push", "git push"],
    ["ls $(rm -rf x)", "computed"],
    ["ls `touch x`", "touch"],
    ["cat <(curl example.com)", "curl"],
    ["(cd sub && python3 x.py)", "python3"],
    ["$CMD foo", "computed"],
    ["FOO=1 ls", "environment"],
    ["./run.sh", "runs ./run.sh"],
    ["/bin/ls", "runs /bin/ls"],
    ["cat /etc/passwd", "outside the workspace"],
    ["ls ..", "outside the workspace"],
    ["cd /tmp && ls", "outside"],
    ["cat ~/.bashrc", "outside"],
    ["echo \"unterminated", "parse"],
    ["eval 'ls'", "runs eval"],
    ["bash -c 'ls'", "runs bash"],
    ["curl https://example.com", "runs curl"],
    ["sed -i s/a/b/ notes.txt", "sed modifies"],
    ["f() { ls; }; f", "function"],
    ["xargs rm < list.txt", "runs xargs"],
  ])("%s", (cmd, reasonPart) => {
    const r = bash(cmd);
    expect(r.decision).toBe("ask");
    expect(r.reason).toContain(reasonPart);
  });
});

describe("bash: deny", () => {
  it.each([
    ["rm -rf /", "recursive delete"],
    ["rm -rf / --no-preserve-root", "recursive delete"],
    ["rm -fr ~", "recursive delete"],
    ["sudo rm -rf /*", "recursive delete"],
    ["bash -c 'rm -rf /'", "recursive delete"],
    [":(){ :|:& };:", "fork bomb"],
    ["bomb() { bomb | bomb & }; bomb", "fork bomb"],
    ["cat /proc/1/environ", "environment"],
    ["cat /proc/self/environ", "environment"],
    ["tr '\\0' '\\n' < /proc/$$/environ", "environment"],
    ["curl http://agent:8080/health", "agent"],
    ["psql -h postgres", "postgres"],
    ["echo > /dev/tcp/postgres/5432", "postgres"],
    ["touch /etc/cron.d/x", "outside the workspace"],
    ["echo hi > /tmp/x", "outside the workspace"],
    ["cp notes.txt /usr/local/bin/", "outside the workspace"],
    ["mkdir ~/x", "outside the workspace"],
    ["cd /etc && touch x", "outside the workspace"],
    ["ls; rm -r /usr", "outside the workspace"],
    ["dd if=/dev/zero of=/dev/sda", "outside the workspace"],
    ["ls $(echo hi > /etc/motd)", "outside the workspace"],
  ])("%s", (cmd, reasonPart) => {
    const r = bash(cmd);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain(reasonPart);
  });

  it("is the strictest across all parts", () => {
    expect(decision("ls && python3 x.py && rm -rf /")).toBe("deny");
    expect(decision("ls; python3 x.py")).toBe("ask");
    expect(decision("empty".slice(0, 0))).toBe("deny");
  });
});

describe("file tools", () => {
  const file = (tool: string, p: string) => classify({ tool, args: { path: p } }, rules);

  it("allows reads and writes inside the workspace", () => {
    expect(file("read", "notes.txt").decision).toBe("allow");
    expect(file("read", "/workspace/a/b.txt").decision).toBe("allow");
    expect(file("write", "hello.py").decision).toBe("allow");
    expect(file("edit", "/workspace/hello.py").decision).toBe("allow");
  });

  it("denies paths outside the workspace", () => {
    expect(file("read", "/etc/passwd").decision).toBe("deny");
    expect(file("read", "../etc/passwd").decision).toBe("deny");
    expect(file("read", "/workspace/../etc/passwd").decision).toBe("deny");
    expect(file("read", "/workspacex/file").decision).toBe("deny");
    expect(file("read", "~/.ssh/id_rsa").decision).toBe("deny");
    expect(file("write", "/tmp/x").decision).toBe("deny");
    expect(file("edit", "/etc/hosts").decision).toBe("deny");
  });

  it("denies malformed calls and asks for unknown tools", () => {
    expect(classify({ tool: "read", args: {} }, rules).decision).toBe("deny");
    expect(classify({ tool: "bash", args: {} }, rules).decision).toBe("deny");
    expect(classify({ tool: "mystery", args: {} }, rules).decision).toBe("ask");
  });
});

describe("taint rule and Phase 2 tools", () => {
  it("writes ask once the task has read untrusted content", () => {
    expect(classify({ tool: "write", args: { path: "a.txt" }, tainted: false }, rules).decision).toBe("allow");
    const r = classify({ tool: "write", args: { path: "a.txt" }, tainted: true }, rules);
    expect(r.decision).toBe("ask");
    expect(r.reason).toContain("untrusted content");
    expect(classify({ tool: "edit", args: { path: "a.txt" }, tainted: true }, rules).decision).toBe("ask");
  });
  it("reads stay allowed and denies stay denied when tainted", () => {
    expect(classify({ tool: "read", args: { path: "a.txt" }, tainted: true }, rules).decision).toBe("allow");
    expect(classify({ tool: "bash", args: { command: "ls" }, tainted: true }, rules).decision).toBe("allow");
    expect(classify({ tool: "write", args: { path: "/etc/x" }, tainted: true }, rules).decision).toBe("deny");
  });
  it("routine changes ask, listing and memory are allowed", () => {
    expect(classify({ tool: "create_schedule", args: {} }, rules).decision).toBe("ask");
    expect(classify({ tool: "delete_schedule", args: {} }, rules).decision).toBe("ask");
    expect(classify({ tool: "list_schedules", args: {} }, rules).decision).toBe("allow");
    expect(classify({ tool: "remember", args: {} }, rules).decision).toBe("allow");
  });
  it("invalid preflight arguments are denied without asking", () => {
    expect(classify({ tool: "create_schedule", args: {}, context: { invalid: "bad cron" } }, rules)).toEqual({ decision: "deny", reason: "bad cron" });
  });
});
