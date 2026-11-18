import { z } from "zod";

const intFromEnv = (def: number, min = 1) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min) {
        ctx.addIssue({ code: "custom", message: `must be an integer >= ${min}, got "${v}"` });
        return z.NEVER;
      }
      return n;
    });

const usdFromEnv = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return def;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        ctx.addIssue({ code: "custom", message: `must be a positive number of dollars, got "${v}"` });
        return z.NEVER;
      }
      return n;
    });

export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[\w-]{20,}$/, "does not look like a BotFather token"),
  TELEGRAM_ALLOWED_USER_IDS: z
    .string()
    .min(1)
    .transform((v, ctx) => {
      const ids = v.split(",").map((s) => s.trim()).filter(Boolean);
      const out: number[] = [];
      for (const id of ids) {
        if (!/^\d+$/.test(id)) {
          ctx.addIssue({ code: "custom", message: `"${id}" is not a numeric Telegram user id` });
          return z.NEVER;
        }
        out.push(Number(id));
      }
      if (out.length === 0) {
        ctx.addIssue({ code: "custom", message: "at least one user id is required" });
        return z.NEVER;
      }
      return out;
    }),
  OPENROUTER_API_KEY: z.string().min(10),
  MODEL: z.string().regex(MODEL_ID_PATTERN, "must look like provider/model").default("deepseek/deepseek-v4.1-flash"),
  DATABASE_URL: z.string().url(),
  SANDBOX_URL: z.string().url(),
  SANDBOX_TOKEN: z.string().min(24, "use at least 24 random characters (openssl rand -hex 32)"),
  APPROVAL_TIMEOUT_SECONDS: intFromEnv(600),
  TOOL_TIMEOUT_SECONDS: intFromEnv(120),
  MAX_TOOL_OUTPUT_CHARS: intFromEnv(20000),
  // Phase 2: routines and limits
  MONTHLY_BUDGET_USD: usdFromEnv(20),
  TASK_BUDGET_USD: usdFromEnv(1),
  MAX_TURNS_PER_TASK: intFromEnv(40),
  // Routine approvals wait for you; pg-boss caps a job at 24 h, so keep this under 23 h.
  ROUTINE_APPROVAL_TIMEOUT_SECONDS: intFromEnv(43200).refine((n) => n <= 82800, "must be at most 82800 (23 hours)"),
  MODEL_MAX_RETRIES: intFromEnv(4, 0),
  // Phase 3: browser, vault, MCP
  BROWSER_URL: z.string().url().optional(),
  BROWSER_TOKEN: z.string().min(24, "use at least 24 random characters").optional(),
  VAULT_KEY_FILE: z.string().default("/run/secrets/vault_master_key"),
  MCP_CONFIG: z.string().default("config/mcp.yaml"),
  // Phase 4: dashboard, health report, Mac bridge
  DASHBOARD_TOKEN: z.string().min(24, "use at least 24 random characters").optional(),
  HEALTH_REPORT_CRON: z.string().default("17 9 * * 1"),
  MAC_BRIDGE_URL: z.string().url().optional(),
  MAC_BRIDGE_TOKEN_FILE: z.string().default("/run/secrets/mac_bridge_token"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TZ: z.string().default("America/Toronto"),
  // Not in the user-facing .env; defaults suit the Docker setup.
  HTTP_HOST: z.string().default("0.0.0.0"),
  HTTP_PORT: intFromEnv(8080, 0),
  DATA_DIR: z.string().default("/data"),
  MEMORY_DIR: z.string().default("/memory"),
  POLICY_FILE: z.string().default("config/policy.yaml"),
  WORKSPACE_DIR: z.string().default("/workspace"),
  TELEGRAM_API_ROOT: z.string().url().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}\nSee .env.example.`);
  }
  return parsed.data;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}
