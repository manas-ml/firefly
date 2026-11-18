/**
 * Shared end-to-end harness: the real app wiring (grammY long polling against a
 * fake Bot API, pg-boss on Postgres, the Pi agent loop with Pi's scripted faux
 * model, the policy engine, approvals, the real sandbox server).
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { startApp, type App, type AppOverrides } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { createLogger } from "../../src/logger.ts";
import { createTestDb } from "../helpers/db.ts";
import { createFauxRuntime } from "../helpers/faux.ts";
import { startLocalSandbox, TEST_TOKEN } from "../helpers/sandbox.ts";
import { FakeTelegram, type SentMessage } from "./fake-telegram.ts";

export const OWNER = 4242;
export const STRANGER = 6666;

export interface Harness {
  tg: FakeTelegram;
  db: Awaited<ReturnType<typeof createTestDb>>;
  sb: Awaited<ReturnType<typeof startLocalSandbox>>;
  faux: Awaited<ReturnType<typeof createFauxRuntime>>;
  app: App;
  dataDir: string;
  memoryDir: string;
  logs: Record<string, unknown>[];
  /** Restart the app (same DB, data and memory dirs), optionally with different env. */
  reboot(env?: Record<string, string>): Promise<void>;
  say(text: string): number;
  close(): Promise<void>;
}

export const isApproval = (m: SentMessage) => m.text.includes("Approval needed");

export function lastToolResult(ctx: { messages: unknown[] }): string {
  return JSON.stringify(ctx.messages[ctx.messages.length - 1]);
}

export async function createHarness(
  env: Record<string, string> = {},
  overrides: Omit<AppOverrides, "models"> & { policy?: (yaml: string, workspace: string) => string } = {},
): Promise<Harness> {
  const tg = new FakeTelegram();
  await tg.start();
  const db = await createTestDb();
  const sb = await startLocalSandbox();
  const faux = await createFauxRuntime();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "e2e-data-"));
  const memoryDir = path.join(dataDir, "memory");
  const policyFile = path.join(dataDir, "policy.yaml");
  let policy = (await readFile("config/policy.yaml", "utf8")).replaceAll("/workspace", sb.workspace);
  if (overrides.policy) policy = overrides.policy(policy, sb.workspace);
  await writeFile(policyFile, policy);
  const logs: Record<string, unknown>[] = [];

  const boot = async (extra: Record<string, string> = {}) => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: tg.token,
      TELEGRAM_ALLOWED_USER_IDS: String(OWNER),
      TELEGRAM_API_ROOT: tg.url,
      OPENROUTER_API_KEY: "sk-or-test-not-used",
      MODEL: "deepseek/deepseek-v4.1-flash",
      DATABASE_URL: db.url,
      SANDBOX_URL: sb.url,
      SANDBOX_TOKEN: TEST_TOKEN,
      APPROVAL_TIMEOUT_SECONDS: "3",
      TOOL_TIMEOUT_SECONDS: "600",
      HTTP_HOST: "127.0.0.1",
      HTTP_PORT: "0",
      DATA_DIR: dataDir,
      MEMORY_DIR: memoryDir,
      POLICY_FILE: policyFile,
      LOG_LEVEL: "info",
      ...env,
      ...extra,
    });
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        for (const line of chunk.toString().split("\n").filter(Boolean)) logs.push(JSON.parse(line) as Record<string, unknown>);
        cb();
      },
    });
    return startApp(config, createLogger("info", sink), {
      models: faux,
      ui: { editIntervalMs: 200, typingIntervalMs: 500 },
      ...overrides,
    });
  };

  const h: Harness = {
    tg,
    db,
    sb,
    faux,
    app: await boot(),
    dataDir,
    memoryDir,
    logs,
    async reboot(extra) {
      await h.app.stop();
      h.app = await boot(extra);
    },
    say(text) {
      const from = tg.sent.length;
      tg.sendText(OWNER, text);
      return from;
    },
    async close() {
      await h.app?.stop();
      await sb.stop();
      await db.drop();
      await tg.stop();
    },
  };
  return h;
}
