import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const tag = z.enum(["read", "write"]);
const server = z
  .object({
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    tools: z.record(z.string(), tag).default({}),
    default: z.enum(["ask", "deny"]).default("ask"),
  })
  .refine((s) => Boolean(s.url) !== Boolean(s.command), "set exactly one of url or command");

const schema = z.object({ servers: z.record(z.string().regex(/^[a-z0-9_-]{1,32}$/, "server names: a-z 0-9 _ -"), server).nullable().default({}) });

export type McpServerConfig = z.infer<typeof server>;
export type McpConfig = { servers: Record<string, McpServerConfig> };

export function parseMcpConfig(input: unknown): McpConfig {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid config/mcp.yaml: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return { servers: parsed.data.servers ?? {} };
}

export function loadMcpConfig(file: string): McpConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { servers: {} };
  }
  return parseMcpConfig(parseYaml(text));
}

/** Pi tool name for an MCP tool. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
}

/** Policy decision for an MCP tool from its tag: read -> allow, write -> ask, untagged -> server default. */
export function mcpDecision(cfg: McpServerConfig, toolName: string): "allow" | "ask" | "deny" {
  const t = cfg.tools[toolName];
  if (t === "read") return "allow";
  if (t === "write") return "ask";
  return cfg.default;
}
