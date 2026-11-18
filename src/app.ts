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
import { BudgetService } from "./budget/budget.ts";
import { MemoryStore } from "./memory/store.ts";
import { createMemoryTools } from "./memory/tools.ts";
import { SchedulerService } from "./scheduler/service.ts";
import { createScheduleTools } from "./scheduler/tools.ts";
import { BrowserClient } from "./browser/client.ts";
import { createBrowserTools, createVaultTool } from "./browser/tools.ts";
import { loadMcpConfig } from "./mcp/config.ts";
import { McpManager } from "./mcp/manager.ts";
import { registerVaultCommands } from "./telegram/commands/vault.ts";
import { Vault } from "./vault/vault.ts";
import { setLogRedactor } from "./logger.ts";
import { HealthReporter } from "./control/health-report.ts";
import { Settings } from "./control/settings.ts";
import { registerDashboard } from "./http/dashboard.ts";
import { registerControlCommands } from "./telegram/commands/control.ts";
import { createMacShortcutTool, readBridgeToken } from "./mac/tools.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface AppOverrides {
  /** Replace OpenRouter (tests use Pi's faux provider). */
  models?: { modelRuntime: ModelRuntime; resolveModel: (id: string) => Model<any> | undefined }; // Pi's Model generic is per-API
  migrationsDir?: string;
  /** Telegram timing (tests shorten these). */
  ui?: { editIntervalMs: number; typingIntervalMs: number };
  /** pg-boss timing (tests make cron checks frequent). */
  boss?: { cronMonitorIntervalSeconds?: number; cronWorkerIntervalSeconds?: number };
}

export interface App {
  stop(): Promise<void>;
  orchestrator: Orchestrator;
  runtime: AgentRuntime;
  scheduler: SchedulerService;
  memory: MemoryStore;
  settings: Settings;
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
  const fromRoot = (p: string) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
  const rules = loadPolicyRules(fromRoot(config.POLICY_FILE));
  log.info({ workspace: rules.workspace }, "policy loaded");

  const startedAt = new Date();
  const pool = createPool(config.DATABASE_URL);
  await waitFor(async () => (await pool.query("SELECT 1")).rowCount === 1, "postgres", log);
  await migrate(pool, overrides.migrationsDir ?? path.join(ROOT, "migrations"), (m) => log.info(m));
  const repo = new Repo(pool);

  const sandbox = new SandboxClient(config.SANDBOX_URL, config.SANDBOX_TOKEN);
  await waitFor(() => sandbox.health(), "sandbox", log);

  const vault = new Vault(pool);
  if (await vault.init(config.VAULT_KEY_FILE)) log.info("vault unlocked");
  else log.warn({ file: config.VAULT_KEY_FILE }, "no vault master key; the vault is disabled");
  const redact = (text: string) => vault.redact(text);
  setLogRedactor(redact);

  const browser = config.BROWSER_URL && config.BROWSER_TOKEN ? new BrowserClient(config.BROWSER_URL, config.BROWSER_TOKEN, rules) : undefined;
  if (browser) await waitFor(() => browser.health(), "browser", log);
  else log.info("no BROWSER_URL; browser tools disabled");

  // The Mac bridge is off unless MAC_BRIDGE_URL is set and its token file has a token.
  const macToken = config.MAC_BRIDGE_URL ? readBridgeToken(config.MAC_BRIDGE_TOKEN_FILE) : undefined;
  const macBridge = config.MAC_BRIDGE_URL && macToken ? { url: config.MAC_BRIDGE_URL, token: macToken } : undefined;
  if (config.MAC_BRIDGE_URL && !macToken) log.warn("MAC_BRIDGE_URL is set but there is no bridge token; Mac bridge disabled");

  const resolveSecret = (v: string) => (v.startsWith("vault:") ? vault.reveal(v) : v);
  const mcp = new McpManager(loadMcpConfig(fromRoot(config.MCP_CONFIG)), log, resolveSecret);
  await mcp.connect();
  mcp.applyPolicy(rules);

  const models = overrides.models ?? (await createOpenRouterRuntime(config.DATA_DIR, config.OPENROUTER_API_KEY));
  if (!models.resolveModel(config.MODEL)) throw new Error(`MODEL ${config.MODEL} is not a known OpenRouter model`);

  const boss = new PgBoss({ connectionString: config.DATABASE_URL, ...overrides.boss });
  boss.on("error", (err) => log.error({ err }, "pg-boss error"));
  await boss.start();

  const bot = new Bot(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_API_ROOT ? { client: { apiRoot: config.TELEGRAM_API_ROOT } } : {});
  const ui = new TelegramUi(bot.api, log, overrides.ui, redact);
  const approvals = new ApprovalService(repo, ui, config.APPROVAL_TIMEOUT_SECONDS, log);
  const memory = new MemoryStore(config.MEMORY_DIR, pool);
  await memory.init();
  const settings = new Settings(pool);
  const scheduler = new SchedulerService(boss, pool, log, config.TZ, () => settings.isPaused());
  const budget = new BudgetService(pool, { monthlyUsd: config.MONTHLY_BUDGET_USD, taskUsd: config.TASK_BUDGET_USD, timezone: config.TZ });
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
    maxOutputChars: config.MAX_TOOL_OUTPUT_CHARS,
    systemPrompt: await loadSystemPrompt(),
    modelMaxRetries: config.MODEL_MAX_RETRIES,
    redact,
    toolFactories: [
      (getRun) => createMemoryTools(memory, getRun),
      (getRun) => createScheduleTools(scheduler, getRun),
      (getRun) => (browser ? createBrowserTools(browser, getRun) : []),
      (getRun) =>
        vault.enabled ? [createVaultTool(vault, { browser, sandbox, toolTimeoutSeconds: config.TOOL_TIMEOUT_SECONDS, workspace: rules.workspace }, getRun)] : [],
      () => mcp.tools(),
      () => (macBridge ? [createMacShortcutTool(macBridge.url, macBridge.token)] : []),
    ],
    getPromptAddendum: async () => {
      const profile = await memory.profileForPrompt();
      return profile
        ? `What you know about the owner, from their own messages (more topics via the recall tool):\n\n${profile}`
        : "You don't know anything about the owner yet. When they tell you something to remember, use the remember tool.";
    },
  });
  await runtime.init();
  const orchestrator = new Orchestrator(
    boss,
    repo,
    runtime,
    ui,
    log,
    {
      concurrency: 4,
      jobTimeoutSeconds: 24 * 3600, // pg-boss maximum; covers a routine waiting for approval
      approvalTimeoutSeconds: config.APPROVAL_TIMEOUT_SECONDS,
      routineApprovalTimeoutSeconds: config.ROUTINE_APPROVAL_TIMEOUT_SECONDS,
      maxTurnsPerTask: config.MAX_TURNS_PER_TASK,
      isPaused: () => settings.isPaused(),
    },
    budget,
  );
  scheduler.setFireHandler(async (schedule) => {
    await orchestrator.enqueueRoutine(schedule);
  });
  const health = new HealthReporter({
    pool,
    boss,
    sandbox,
    log,
    send: (chatId, md) => ui.sendMarkdown(chatId, md),
    chatIds: config.TELEGRAM_ALLOWED_USER_IDS,
    dataDir: config.DATA_DIR,
    workspace: rules.workspace,
    timezone: config.TZ,
    cron: config.HEALTH_REPORT_CRON,
    startedAt,
  });

  registerHandlers(bot, {
    allowedUserIds: config.TELEGRAM_ALLOWED_USER_IDS,
    orchestrator,
    runtime,
    approvals,
    repo,
    ui,
    log,
    approvalTimeoutSeconds: config.APPROVAL_TIMEOUT_SECONDS,
    timezone: config.TZ,
    scheduler,
    memory,
    budget,
    extraHandlers: [
      (b) => registerControlCommands(b, { settings, report: (chatId) => health.sendTo(chatId) }),
      (b) => registerVaultCommands(b, { vault, log }),
    ],
  });

  let polling = false;
  const http = createHttpServer({
    db: async () => (await pool.query("SELECT 1")).rowCount === 1,
    sandbox: () => sandbox.health(),
    telegram: () => polling,
  }, (fastify) => {
    if (!config.DASHBOARD_TOKEN) {
      log.info("no DASHBOARD_TOKEN; dashboard disabled");
      return;
    }
    registerDashboard(fastify, {
      token: config.DASHBOARD_TOKEN,
      staticDir: path.join(ROOT, "dist", "dashboard"),
      pool,
      orchestrator,
      approvals,
      scheduler,
      memory,
      budget,
      settings,
      startedAt,
      redact,
    });
  });
  await http.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
  const address = http.server.address();
  const httpPort = typeof address === "object" && address ? address.port : config.HTTP_PORT;

  await bot.init();
  await bot.api.setMyCommands(COMMANDS).catch((err: unknown) => log.warn({ err }, "could not set bot commands"));
  await orchestrator.start();
  await scheduler.start();
  await health.start();

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
    scheduler,
    memory,
    settings,
    httpPort,
    stop: async () => {
      log.info("shutting down");
      polling = false;
      await bot.stop().catch(() => undefined);
      await pollingDone;
      await orchestrator.stopAll();
      await boss.stop({ graceful: true, timeout: 10_000 }).catch(() => undefined);
      runtime.dispose();
      await mcp.close();
      await http.close();
      await pool.end();
    },
  };
}
