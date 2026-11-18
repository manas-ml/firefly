import { defineTool } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";
import { agentTool, type AgentTool } from "../agent/tools.ts";
import type { Logger } from "../logger.ts";
import type { PolicyRules } from "../policy/rules.ts";
import { mcpDecision, mcpToolName, type McpConfig, type McpServerConfig } from "./config.ts";

interface ListedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface Connected {
  name: string;
  cfg: McpServerConfig;
  client: Client;
  tools: ListedTool[];
}

/** Resolve "vault:name" values from the vault. */
export type SecretResolver = (value: string) => string;

/**
 * Connects to the MCP servers listed in config/mcp.yaml and exposes their tools
 * to Pi as `mcp__<server>__<tool>`, each through the same policy guard as every
 * other tool. Policy for each tool comes from its read/write tag.
 */
export class McpManager {
  private servers: Connected[] = [];

  constructor(
    private readonly config: McpConfig,
    private readonly log: Logger,
    private readonly resolveSecret: SecretResolver,
  ) {}

  async connect(): Promise<void> {
    for (const [name, cfg] of Object.entries(this.config.servers)) {
      try {
        const client = new Client({ name: "firefly", version: "1.0.0" });
        const transport = cfg.url
          ? new StreamableHTTPClientTransport(new URL(cfg.url), {
              requestInit: { headers: Object.fromEntries(Object.entries(cfg.headers).map(([k, v]) => [k, this.resolveSecret(v)])) },
            })
          : new StdioClientTransport({
              command: cfg.command!,
              args: cfg.args,
              // A minimal environment: nothing from the agent's (API keys, tokens).
              env: { ...getDefaultEnvironment(), ...Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, this.resolveSecret(v)])) },
              stderr: "ignore",
            });
        await client.connect(transport);
        const { tools } = await client.listTools();
        this.servers.push({ name, cfg, client, tools: tools as ListedTool[] });
        this.log.info({ server: name, tools: tools.length }, "mcp server connected");
      } catch (err) {
        this.log.error({ err, server: name }, "could not connect to mcp server");
      }
    }
  }

  /** Add each MCP tool's decision to the policy (read -> allow, write -> ask, else default). */
  applyPolicy(rules: PolicyRules): void {
    for (const s of this.servers) {
      for (const t of s.tools) rules.tools[mcpToolName(s.name, t.name)] = mcpDecision(s.cfg, t.name);
    }
  }

  summary(): { server: string; tools: number }[] {
    return this.servers.map((s) => ({ server: s.name, tools: s.tools.length }));
  }

  tools(): AgentTool[] {
    const out: AgentTool[] = [];
    for (const s of this.servers) {
      for (const t of s.tools) {
        const name = mcpToolName(s.name, t.name);
        const tag = s.cfg.tools[t.name];
        const def = defineTool({
          name,
          label: `${s.name}: ${t.name}`,
          description: `[${s.name}, ${tag ?? "untagged: asks the owner"}] ${t.description ?? t.name}`,
          promptSnippet: `${s.name} ${t.name}`,
          // MCP tools describe their input as JSON Schema; TypeBox accepts it as-is.
          parameters: Type.Unsafe<Record<string, unknown>>(t.inputSchema ?? { type: "object" }),
          execute: async (_id, params, signal) => {
            const result = await s.client.callTool({ name: t.name, arguments: (params ?? {}) as Record<string, unknown> }, undefined, {
              signal,
              timeout: 120_000,
            });
            const content = (result.content ?? []) as { type: string; text?: string; data?: string; mimeType?: string }[];
            const parts = content.map((c) =>
              c.type === "text"
                ? { type: "text" as const, text: c.text ?? "" }
                : c.type === "image" && c.data && c.mimeType
                  ? { type: "image" as const, data: c.data, mimeType: c.mimeType }
                  : { type: "text" as const, text: JSON.stringify(c) },
            );
            if (result.structuredContent && parts.length === 0) parts.push({ type: "text", text: JSON.stringify(result.structuredContent) });
            if (result.isError) throw new Error(parts.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n") || "MCP tool error");
            return { content: parts.length ? parts : [{ type: "text" as const, text: "(no output)" }], details: undefined };
          },
        });
        // Read tools bring outside content (email, documents) into the task: taint.
        out.push(agentTool(def, { taints: true, describe: (a) => `${s.name} · ${t.name}\n${JSON.stringify(a, null, 1).slice(0, 1500)}` }));
      }
    }
    return out;
  }

  async close(): Promise<void> {
    for (const s of this.servers) await s.client.close().catch(() => undefined);
    this.servers = [];
  }
}
