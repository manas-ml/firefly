import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bot } from "grammy";
import { PgBoss } from "pg-boss";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { AgentRuntime, createOpenRouterRuntime, loadSystemPrompt } from "./agent/runtime.ts";
import { SandboxClient } from "./agent/sandbox-client.ts";
import { ApprovalService } from "./approvals/service.ts";
import type { Config } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";
import { Repo } from "./db/repo.ts";
import { createHttpServer } from "./http/server.ts";
import type { Logger } from "./logger.ts";
import { Orchestrator } from "./orchestrator/orchestrator.ts";
import { loadPolicyRules } from "./policy/rules.ts";
import { COMMANDS, registerHandlers } from "./telegram/bot.ts";
import { TelegramUi } from "./telegram/ui.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface AppOverrides {
  /** Replace OpenRouter (tests use Pi's faux provider). */
  models?: { modelRuntime: ModelRuntime; resolveModel: (id: string) => Model<any> | undefined }; // Pi's Model generic is per-API
  migrationsDir?: string;
  /** Telegram timing (tests shorten these). */
  ui?: { editIntervalMs: number; typingIntervalMs: number };
}

export interface App {
  stop(): Promise<void>;
  orchestrator: Orchestrator;
  runtime: AgentRuntime;
  httpPort: number;
}

async function waitFor(check: () => Promise<boolean>, what: string, log: Logger, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`${what} did not become ready within ${timeoutMs / 1000} s`);
    if (attempt === 1 || attempt % 10 === 0) log.info(`waiting for ${what}…`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function startApp(config: Config, log: Logger, overrides: AppOverrides = {}): Promise<App> {
  const rules = loadPolicyRules(path.isAbsolute(config.POLICY_FILE) ? config.POLICY_FILE : path.join(ROOT, config.POLICY_FILE));
  log.info({ workspace: rules.workspace }, "policy loaded");

  const pool = createPool(config.DATABASE_URL);
  await waitFor(async () => (await pool.query("SELECT 1")).rowCount === 1, "postgres", log);
  await migrate(pool, overrides.migrationsDir ?? path.join(ROOT, "migrations"), (m) => log.info(m));
  const repo = new Repo(pool);

  const sandbox = new SandboxClient(config.SANDBOX_URL, config.SANDBOX_TOKEN);
  await waitFor(() => sandbox.health(), "sandbox", log);

  const models = overrides.models ?? (await createOpenRouterRuntime(config.DATA_DIR, config.OPENROUTER_API_KEY));
  if (!models.resolveModel(config.MODEL)) throw new Error(`MODEL ${config.MODEL} is not a known OpenRouter model`);

  const boss = new PgBoss({ connectionString: config.DATABASE_URL });
  boss.on("error", (err) => log.error({ err }, "pg-boss error"));
  await boss.start();

  const bot = new Bot(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_API_ROOT ? { client: { apiRoot: config.TELEGRAM_API_ROOT } } : {});
  const ui = new TelegramUi(bot.api, log, overrides.ui);
  const approvals = new ApprovalService(repo, ui, config.APPROVAL_TIMEOUT_SECONDS, log);
  const runtime = new AgentRuntime({
    repo,
    log,
    rules,
    sandbox,
    approvals,
    modelRuntime: models.modelRuntime,
    resolveModel: models.resolveModel,
    defaultModel: config.MODEL,
    dataDir: config.DATA_DIR,
    workspace: rules.workspace,
    toolTimeoutSeconds: config.TOOL_TIMEOUT_SECONDS,
    approvalTimeoutSeconds: config.APPROVAL_TIMEOUT_SECONDS,
    maxOutputChars: config.MAX_TOOL_OUTPUT_CHARS,
    systemPrompt: await loadSystemPrompt(),
  });
  await runtime.init();
  const orchestrator = new Orchestrator(boss, repo, runtime, ui, log);

  registerHandlers(bot, {
    allowedUserIds: config.TELEGRAM_ALLOWED_USER_IDS,
    orchestrator,
    runtime,
    approvals,
    repo,
    ui,
    log,
    approvalTimeoutSeconds: config.APPROVAL_TIMEOUT_SECONDS,
  });

  let polling = false;
  const http = createHttpServer({
    db: async () => (await pool.query("SELECT 1")).rowCount === 1,
    sandbox: () => sandbox.health(),
    telegram: () => polling,
  });
  await http.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
  const address = http.server.address();
  const httpPort = typeof address === "object" && address ? address.port : config.HTTP_PORT;

  await bot.init();
  await bot.api.setMyCommands(COMMANDS).catch((err: unknown) => log.warn({ err }, "could not set bot commands"));
  await orchestrator.start();

  const pollingDone = bot
    .start({
      allowed_updates: ["message", "callback_query"],
      onStart: (me) => {
        polling = true;
        log.info({ bot: me.username }, "telegram long polling started");
      },
    })
    .catch((err: unknown) => {
      polling = false;
      log.fatal({ err }, "telegram polling stopped");
    });

  return {
    orchestrator,
    runtime,
    httpPort,
    stop: async () => {
      log.info("shutting down");
      polling = false;
      await bot.stop().catch(() => undefined);
      await pollingDone;
      await orchestrator.stopAll();
      await boss.stop({ graceful: true, timeout: 10_000 }).catch(() => undefined);
      runtime.dispose();
      await http.close();
      await pool.end();
    },
  };
}
