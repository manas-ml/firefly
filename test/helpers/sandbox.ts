import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const TEST_TOKEN = "test-token-0123456789abcdef0123456789";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port"))));
    });
  });
}

/** Start sandbox/server.ts as a local process against a temp workspace. */
export async function startLocalSandbox(): Promise<{ url: string; workspace: string; stop: () => Promise<void> }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ws-"));
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ["sandbox/server.ts"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", SANDBOX_TOKEN: TEST_TOKEN, WORKSPACE_DIR: workspace },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (b: Buffer) => {
      if (b.toString().includes("sandbox listening")) resolve();
    });
    child.on("exit", (code) => reject(new Error(`sandbox exited with ${code}`)));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    workspace,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    },
  };
}
