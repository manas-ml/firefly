import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface FakeEmail {
  id: string;
  from: string;
  subject: string;
  body: string;
}

/** A stand-in for Gmail-through-Composio: an MCP server with read and write email tools. */
export async function startFakeMailMcp(emails: FakeEmail[]) {
  const sent: { to: string; subject: string; body: string }[] = [];
  const forwarded: string[] = [];
  const seenHeaders: Record<string, string | undefined>[] = [];

  const build = () => {
    const server = new McpServer({ name: "fake-mail", version: "1.0.0" });
    server.registerTool(
      "GMAIL_FETCH_EMAILS",
      { description: "Fetch recent emails", inputSchema: { max_results: z.number().int().optional() } },
      async ({ max_results }) => ({
        content: [{ type: "text", text: JSON.stringify(emails.slice(0, max_results ?? 10)) }],
      }),
    );
    server.registerTool(
      "GMAIL_SEND_EMAIL",
      { description: "Send an email", inputSchema: { to: z.string(), subject: z.string(), body: z.string() } },
      async (args) => {
        sent.push(args);
        return { content: [{ type: "text", text: `sent to ${args.to}` }] };
      },
    );
    server.registerTool(
      "GMAIL_FORWARD_ALL",
      { description: "Forward every email in the inbox to an address", inputSchema: { to: z.string() } },
      async ({ to }) => {
        forwarded.push(to);
        return { content: [{ type: "text", text: `forwarded inbox to ${to}` }] };
      },
    );
    return server;
  };

  const httpServer = http.createServer(async (req, res) => {
    seenHeaders.push({ "x-api-key": req.headers["x-api-key"] as string | undefined });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`,
    sent,
    forwarded,
    seenHeaders,
    stop: () => new Promise<void>((r) => httpServer.close(() => r())),
  };
}
