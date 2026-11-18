import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort } from "./helpers/sandbox.ts";

const TOKEN = "bridge-token-0123456789abcdef0123";
let dir: string;
let url: string;
let child: ChildProcess;
const pwned = path.join(os.tmpdir(), `pwned-${process.pid}`);

async function post(body: unknown, token = TOKEN) {
  const res = await fetch(`${url}/shortcut`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const setAllowlist = (allowlist: string[]) => writeFile(path.join(dir, "config.json"), JSON.stringify({ allowlist }));

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "bridge-"));
  await writeFile(path.join(dir, "bridge.token"), TOKEN);
  // A fake `shortcuts` CLI: lists two shortcuts in "Agent" and records runs.
  const fake = path.join(dir, "shortcuts");
  await writeFile(
    fake,
    `#!/bin/bash\nif [ "$1" = list ] && [ "$3" = Agent ]; then printf 'Desk lamp\\nx; touch ${pwned}\\n'; exit 0; fi\nif [ "$1" = run ]; then echo "ran:$2" >> "${dir}/runs.log"; echo "done $2"; exit 0; fi\nexit 2\n`,
  );
  await chmod(fake, 0o755);
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["bridge/server.ts"], {
    env: { ...process.env, FIREFLY_BRIDGE_DIR: dir, PORT: String(port), SHORTCUTS_BIN: fake, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve) => child.stdout?.on("data", (b: Buffer) => b.toString().includes("bridge listening") && resolve()));
});
afterAll(() => {
  child?.kill();
});

describe("Mac bridge", () => {
  it("rejects every call while the allowlist is empty (it ships that way)", async () => {
    expect(existsSync(path.join(dir, "config.json"))).toBe(false);
    for (const name of ["Desk lamp", "anything", ""]) {
      const r = await post({ name });
      expect(r.status).toBe(403);
      expect(r.json.error).toMatch(/allowlist is empty/);
    }
    await setAllowlist([]);
    expect((await post({ name: "Desk lamp" })).status).toBe(403);
  });

  it("requires the token and offers no other action", async () => {
    expect((await post({ name: "Desk lamp" }, "x".repeat(32))).status).toBe(401);
    const other = await fetch(`${url}/applescript`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{}" });
    expect(other.status).toBe(404);
  });

  it("runs only allowlisted shortcuts that are in the Agent folder", async () => {
    await setAllowlist(["Desk lamp", "Not in folder"]);
    expect((await post({ name: "Other" })).json.error).toMatch(/not on the bridge allowlist/);
    expect((await post({ name: "Not in folder" })).json.error).toMatch(/not in the "Agent" Shortcuts folder/);
    const ok = await post({ name: "Desk lamp" });
    expect(ok.status).toBe(200);
    expect(ok.json.output).toContain("done Desk lamp");
  });

  it("passes names as a single argument, never through a shell", async () => {
    const evil = `x; touch ${pwned}`;
    await setAllowlist([evil]);
    const r = await post({ name: evil });
    expect(r.status).toBe(200);
    expect(existsSync(pwned)).toBe(false);
    expect(await readFile(path.join(dir, "runs.log"), "utf8")).toContain(`ran:${evil}`);
  });
});
