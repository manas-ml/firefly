import { z } from "zod";

const intFromEnv = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) {
        ctx.addIssue({ code: "custom", message: `must be a positive integer, got "${v}"` });
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
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TZ: z.string().default("America/Toronto"),
  // Not in the user-facing .env; defaults suit the Docker setup.
  HTTP_HOST: z.string().default("0.0.0.0"),
  HTTP_PORT: intFromEnv(8080),
  DATA_DIR: z.string().default("/data"),
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
