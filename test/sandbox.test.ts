import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxClient, SandboxError } from "../src/agent/sandbox-client.ts";
import { startLocalSandbox, TEST_TOKEN } from "./helpers/sandbox.ts";

let sb: Awaited<ReturnType<typeof startLocalSandbox>>;
let client: SandboxClient;

beforeAll(async () => {
  sb = await startLocalSandbox();
  client = new SandboxClient(sb.url, TEST_TOKEN);
});
afterAll(async () => sb.stop());

describe("sandbox server", () => {
  it("requires the bearer token", async () => {
    const bad = new SandboxClient(sb.url, "wrong-token-wrong-token-wrong");
    await expect(bad.exec({ command: "ls", timeoutSec: 5 })).rejects.toMatchObject({ status: 401 });
    expect(await bad.health()).toBe(true); // health is unauthenticated
  });

  it("runs commands in the workspace and reports exit codes", async () => {
    const r = await client.exec({ command: "pwd; echo err >&2; exit 3", timeoutSec: 5 });
    expect(r.stdout.trim()).toBe(sb.workspace);
    expect(r.stderr.trim()).toBe("err");
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  it("does not leak its environment to commands", async () => {
    const r = await client.exec({ command: "env", timeoutSec: 5 });
    expect(r.stdout).not.toContain(TEST_TOKEN);
    expect(r.stdout).not.toContain("SANDBOX_TOKEN");
  });

  it("kills the whole process group on timeout", async () => {
    const started = Date.now();
    const r = await client.exec({ command: "sleep 30 & sleep 30; echo never", timeoutSec: 1 });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).not.toContain("never");
    expect(Date.now() - started).toBeLessThan(5000);
    const ps = await client.exec({ command: "pgrep -fx 'sleep 30' || true", timeoutSec: 5 });
    expect(ps.stdout.trim()).toBe("");
  });

  it("cancels a running command when the signal aborts", async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 300);
    const r = await client.exec({ command: "sleep 300", timeoutSec: 600, signal: ac.signal });
    expect(r.cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reads, writes and edits files inside the workspace", async () => {
    await client.write("dir/hello.py", 'print("hi")\n');
    expect(await readFile(path.join(sb.workspace, "dir/hello.py"), "utf8")).toBe('print("hi")\n');
    await client.edit("dir/hello.py", '"hi"', '"hello"');
    expect((await client.read("/" + path.relative("/", path.join(sb.workspace, "dir/hello.py")))).toString()).toBe('print("hello")\n');
    const st = await client.stat("dir/hello.py");
    expect(st).toMatchObject({ exists: true, isFile: true, readable: true, writable: true });
    expect((await client.stat("missing.txt")).exists).toBe(false);
  });

  it("rejects edits that don't match exactly once", async () => {
    await client.write("dup.txt", "a a");
    await expect(client.edit("dup.txt", "a", "b")).rejects.toThrow(/2 times/);
    await expect(client.edit("dup.txt", "zzz", "b")).rejects.toThrow(/not found/);
  });

  it("rejects paths outside the workspace", async () => {
    await expect(client.read("/etc/passwd")).rejects.toMatchObject({ status: 403 });
    await expect(client.read("../../etc/passwd")).rejects.toMatchObject({ status: 403 });
    await expect(client.write("/tmp/evil", "x")).rejects.toMatchObject({ status: 403 });
    await expect(client.exec({ command: "ls", cwd: "/etc", timeoutSec: 5 })).rejects.toBeInstanceOf(SandboxError);
  });

  it("rejects symlinks that escape the workspace", async () => {
    await symlink("/etc", path.join(sb.workspace, "etc-link"));
    await expect(client.read("etc-link/passwd")).rejects.toMatchObject({ status: 403 });
    await expect(client.write("etc-link/evil", "x")).rejects.toMatchObject({ status: 403 });
    await mkdir(path.join(sb.workspace, "real"), { recursive: true });
    await writeFile(path.join(sb.workspace, "real/f.txt"), "ok");
    await symlink(path.join(sb.workspace, "real"), path.join(sb.workspace, "inner-link"));
    expect((await client.read("inner-link/f.txt")).toString()).toBe("ok");
  });
});
