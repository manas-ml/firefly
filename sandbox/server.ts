/**
 * Sandbox exec server. Runs inside the `sandbox` container as a non-root user,
 * listens only on the internal Docker network, and holds no secrets other than
 * the token the agent uses to call it.
 *
 * Zero dependencies; runs with Node's built-in TypeScript type stripping:
 *   node sandbox/server.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { constants as fsc } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 7070);
const HOST = process.env.HOST ?? "0.0.0.0";
const TOKEN = process.env.SANDBOX_TOKEN ?? "";
const WORKSPACE = path.resolve(process.env.WORKSPACE_DIR ?? "/workspace");
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES ?? 2 * 1024 * 1024);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES ?? 25 * 1024 * 1024);
const MAX_BODY_BYTES = MAX_FILE_BYTES * 2 + 1024 * 1024;
const MAX_TIMEOUT_SEC = 3600;

if (TOKEN.length < 24) {
  console.error("SANDBOX_TOKEN is missing or shorter than 24 characters");
  process.exit(1);
}

// Commands never see the server's environment (which holds SANDBOX_TOKEN).
const COMMAND_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: process.env.HOME ?? "/home/sandbox",
  USER: process.env.USER ?? "sandbox",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TERM: "dumb",
  TZ: process.env.TZ ?? "UTC",
  PYTHONUNBUFFERED: "1",
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------- path safety ----------

let workspaceReal = WORKSPACE;

function isInside(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Resolve a user path to an absolute path inside the workspace, following
 * symlinks for every component that exists. Rejects anything that escapes.
 */
async function safePath(input: unknown): Promise<string> {
  if (typeof input !== "string" || input === "" || input.includes("\0")) {
    throw new HttpError(400, "path must be a non-empty string");
  }
  const abs = path.resolve(WORKSPACE, input);
  if (!isInside(abs, WORKSPACE)) throw new HttpError(403, `path is outside ${WORKSPACE}: ${input}`);

  // Walk up to the nearest existing ancestor and realpath it.
  let existing = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(existing);
      const full = path.join(real, ...rest);
      if (!isInside(full, workspaceReal)) throw new HttpError(403, `path is outside ${WORKSPACE}: ${input}`);
      return full;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = path.dirname(existing);
      if (parent === existing) throw new HttpError(403, `path is outside ${WORKSPACE}: ${input}`);
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

// ---------- exec ----------

interface Running {
  child: ChildProcess;
  cancelled: boolean;
}
const running = new Map<string, Running>();

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

class Capped {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  push(b: Buffer): void {
    if (this.size >= MAX_OUTPUT_BYTES) {
      this.truncated = true;
      return;
    }
    const room = MAX_OUTPUT_BYTES - this.size;
    const part = b.length > room ? b.subarray(0, room) : b;
    if (part.length < b.length) this.truncated = true;
    this.chunks.push(part);
    this.size += part.length;
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8") + (this.truncated ? "\n[output truncated by sandbox]" : "");
  }
}

async function exec(body: Record<string, unknown>) {
  const command = body.command;
  if (typeof command !== "string" || command.trim() === "") throw new HttpError(400, "command is required");
  const execId = typeof body.execId === "string" && /^[\w-]{1,64}$/.test(body.execId) ? body.execId : crypto.randomUUID();
  if (running.has(execId)) throw new HttpError(409, "execId already running");
  const cwd = await safePath(typeof body.cwd === "string" ? body.cwd : WORKSPACE);
  const timeoutSec = Math.min(Math.max(Number(body.timeoutSec) || 120, 1), MAX_TIMEOUT_SEC);

  const child = spawn("bash", ["-lc", command], {
    cwd,
    env: COMMAND_ENV,
    detached: true, // own process group, so the whole tree can be killed
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entry: Running = { child, cancelled: false };
  running.set(execId, entry);
  const stdout = new Capped();
  const stderr = new Capped();
  child.stdout?.on("data", (b: Buffer) => stdout.push(b));
  child.stderr?.on("data", (b: Buffer) => stderr.push(b));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child);
  }, timeoutSec * 1000);

  const exitCode = await new Promise<number | null>((resolve) => {
    let code: number | null = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.on("error", (err) => {
      stderr.push(Buffer.from(String(err)));
      finish();
    });
    child.on("exit", (c, signal) => {
      code = c ?? (signal ? 128 + (signalNumber(signal) ?? 9) : null);
      // Background jobs may keep the pipes open; don't wait on them forever.
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, 500).unref();
    });
    child.on("close", finish);
  });
  clearTimeout(timer);
  running.delete(execId);
  return {
    execId,
    exitCode,
    stdout: stdout.text(),
    stderr: stderr.text(),
    timedOut,
    cancelled: entry.cancelled,
  };
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  return os.constants.signals[signal];
}

function cancel(body: Record<string, unknown>) {
  const execId = body.execId;
  if (typeof execId !== "string") throw new HttpError(400, "execId is required");
  const entry = running.get(execId);
  if (!entry) return { cancelled: false };
  entry.cancelled = true;
  killGroup(entry.child);
  return { cancelled: true };
}

// ---------- files ----------

async function readFile(body: Record<string, unknown>) {
  const p = await safePath(body.path);
  const st = await fs.stat(p).catch(() => undefined);
  if (!st) throw new HttpError(404, `no such file: ${String(body.path)}`);
  if (!st.isFile()) throw new HttpError(400, `not a regular file: ${String(body.path)}`);
  if (st.size > MAX_FILE_BYTES) throw new HttpError(413, `file is larger than ${MAX_FILE_BYTES} bytes`);
  const data = await fs.readFile(p);
  return { path: p, size: data.length, contentBase64: data.toString("base64") };
}

async function writeFile(body: Record<string, unknown>) {
  const p = await safePath(body.path);
  let data: Buffer;
  if (typeof body.contentBase64 === "string") data = Buffer.from(body.contentBase64, "base64");
  else if (typeof body.content === "string") data = Buffer.from(body.content, "utf8");
  else throw new HttpError(400, "content is required");
  if (data.length > MAX_FILE_BYTES) throw new HttpError(413, "content too large");
  await fs.mkdir(path.dirname(p), { recursive: true });
  // Re-check after mkdir in case a component was swapped for a symlink.
  const checked = await safePath(body.path);
  await fs.writeFile(checked, data);
  return { path: checked, bytes: data.length };
}

async function editFile(body: Record<string, unknown>) {
  const { oldText, newText } = body;
  if (typeof oldText !== "string" || oldText === "" || typeof newText !== "string") {
    throw new HttpError(400, "oldText (non-empty) and newText are required");
  }
  const p = await safePath(body.path);
  const content = await fs.readFile(p, "utf8").catch(() => {
    throw new HttpError(404, `no such file: ${String(body.path)}`);
  });
  const count = content.split(oldText).length - 1;
  if (count === 0) throw new HttpError(409, "oldText not found");
  if (count > 1) throw new HttpError(409, `oldText matches ${count} times; make it unique`);
  await fs.writeFile(p, content.replace(oldText, () => newText));
  return { path: p, replacements: 1 };
}

async function statFile(body: Record<string, unknown>) {
  const p = await safePath(body.path);
  const st = await fs.stat(p).catch(() => undefined);
  if (!st) return { path: p, exists: false, isFile: false, isDirectory: false, readable: false, writable: false };
  const can = async (mode: number) =>
    fs.access(p, mode).then(
      () => true,
      () => false,
    );
  return {
    path: p,
    exists: true,
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    size: st.size,
    readable: await can(fsc.R_OK),
    writable: await can(fsc.W_OK),
  };
}

async function mkdir(body: Record<string, unknown>) {
  const p = await safePath(body.path);
  await fs.mkdir(p, { recursive: true });
  return { path: await safePath(body.path) };
}

// ---------- http ----------

const routes: Record<string, (body: Record<string, unknown>) => unknown> = {
  "/exec": exec,
  "/cancel": cancel,
  "/read": readFile,
  "/write": writeFile,
  "/edit": editFile,
  "/stat": statFile,
  "/mkdir": mkdir,
};

function authorized(header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
    if (!authorized(req.headers.authorization)) return send(res, 401, { error: "unauthorized" });
    const handler = req.method === "POST" && req.url ? routes[req.url] : undefined;
    if (!handler) return send(res, 404, { error: "not found" });
    const body = await readBody(req);
    send(res, 200, await handler(body));
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return send(res, 403, { error: (err as Error).message });
    if (code === "EISDIR" || code === "ENOTDIR") return send(res, 400, { error: (err as Error).message });
    console.error(err);
    send(res, 500, { error: "internal error" });
  }
});
server.requestTimeout = 0; // exec requests can legitimately run for a long time
server.headersTimeout = 30_000;

async function main() {
  await fs.mkdir(WORKSPACE, { recursive: true });
  workspaceReal = await fs.realpath(WORKSPACE);
  server.listen(PORT, HOST, () => {
    console.log(JSON.stringify({ msg: "sandbox listening", port: PORT, workspace: workspaceReal }));
  });
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    for (const { child } of running.values()) killGroup(child);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

void main();
