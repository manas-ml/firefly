import { readFileSync } from "node:fs";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { agentTool, type AgentTool } from "../agent/tools.ts";

/** Read the bridge token from its Docker secret file; empty or missing disables the tool. */
export function readBridgeToken(file: string): string | undefined {
  try {
    const t = readFileSync(file, "utf8").trim();
    return t.length >= 24 ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * mac_shortcut: run a macOS Shortcut through the host bridge. Always asks the
 * owner (policy), and the bridge itself only runs allowlisted shortcuts from
 * the "Agent" folder.
 */
export function createMacShortcutTool(bridgeUrl: string, token: string): AgentTool {
  const tool = defineTool({
    name: "mac_shortcut",
    label: "Run Mac Shortcut",
    description:
      "Run a macOS Shortcut on the owner's Mac by exact name (only shortcuts the owner put in the \"Agent\" folder and allowlisted). Always asks the owner first.",
    promptSnippet: "Run an allowlisted macOS Shortcut (asks first)",
    parameters: Type.Object({ name: Type.String(), input: Type.Optional(Type.String({ description: "Text passed to the shortcut" })) }),
    async execute(_id, params, signal) {
      const res = await fetch(new URL("/shortcut", bridgeUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: params.name, input: params.input }),
        signal: signal ?? AbortSignal.timeout(130_000),
      }).catch((err: Error) => {
        throw new Error(`Mac bridge unreachable: ${err.message}`);
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; output?: string; exitCode?: number };
      if (!res.ok) throw new Error(`Mac bridge refused: ${body.error ?? `HTTP ${res.status}`}`);
      return { content: [{ type: "text" as const, text: `Ran “${params.name}” (exit ${body.exitCode}).\n${body.output ?? ""}` }], details: undefined };
    },
  });
  return agentTool(tool, { describe: (a) => `Run Mac Shortcut “${String(a.name)}”${a.input ? ` with input: ${String(a.input).slice(0, 300)}` : ""}` });
}
