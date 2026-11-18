import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { freePort } from "./sandbox.ts";

export const BROWSER_TEST_TOKEN = "browser-token-0123456789abcdef0123";

/** Start browser/server.ts locally with a temp profile. */
export async function startLocalBrowser(): Promise<{ url: string; stop: () => Promise<void> }> {
  const profile = await mkdtemp(path.join(os.tmpdir(), "profile-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["browser/server.ts"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", BROWSER_TOKEN: BROWSER_TEST_TOKEN, PROFILE_DIR: profile, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (b: Buffer) => {
      if (b.toString().includes("browser listening")) resolve();
    });
    child.on("exit", (code) => reject(new Error(`browser exited with ${code}`)));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    },
  };
}
