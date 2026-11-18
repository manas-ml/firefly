import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";

export interface ExecResult {
  execId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

export interface StatResult {
  path: string;
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
  size?: number;
  readable: boolean;
  writable: boolean;
}

export class SandboxError extends Error {
  override name = "SandboxError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Talks to sandbox/server.ts. Uses node:http directly rather than fetch so
 * long-running commands aren't cut off by fetch's default header timeout.
 */
export class SandboxClient {
  private readonly base: URL;

  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    this.base = new URL(baseUrl);
  }

  private request<T>(route: string, body: unknown, options: { auth?: boolean; method?: string } = {}): Promise<T> {
    const url = new URL(route, this.base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const lib = url.protocol === "https:" ? https : http;
    return new Promise<T>((resolve, reject) => {
      const req = lib.request(
        url,
        {
          method: options.method ?? "POST",
          headers: {
            ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
            ...(options.auth === false ? {} : { authorization: `Bearer ${this.token}` }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", reject);
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown;
            try {
              parsed = text ? JSON.parse(text) : {};
            } catch {
              return reject(new SandboxError(`sandbox returned invalid JSON (HTTP ${res.statusCode})`, res.statusCode ?? 0));
            }
            const status = res.statusCode ?? 0;
            if (status >= 400) {
              const message = (parsed as { error?: string }).error ?? `HTTP ${status}`;
              return reject(new SandboxError(message, status));
            }
            resolve(parsed as T);
          });
        },
      );
      req.on("error", (err) => reject(new SandboxError(`sandbox unreachable: ${err.message}`, 0)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  async health(): Promise<boolean> {
    try {
      await this.request("/health", undefined, { auth: false, method: "GET" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run a command. Aborting `signal` asks the sandbox to kill the whole process
   * group; the returned promise then resolves with `cancelled: true`.
   */
  async exec(input: { command: string; cwd?: string; timeoutSec: number; signal?: AbortSignal }): Promise<ExecResult> {
    const execId = randomUUID();
    if (input.signal?.aborted) {
      return { execId, exitCode: null, stdout: "", stderr: "", timedOut: false, cancelled: true };
    }
    const onAbort = () => {
      void this.request("/cancel", { execId }).catch(() => undefined);
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.request<ExecResult>("/exec", {
        execId,
        command: input.command,
        cwd: input.cwd,
        timeoutSec: input.timeoutSec,
      });
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  async read(path: string): Promise<Buffer> {
    const r = await this.request<{ contentBase64: string }>("/read", { path });
    return Buffer.from(r.contentBase64, "base64");
  }

  async write(path: string, content: string | Buffer): Promise<void> {
    const body = typeof content === "string" ? { path, content } : { path, contentBase64: content.toString("base64") };
    await this.request("/write", body);
  }

  async edit(path: string, oldText: string, newText: string): Promise<void> {
    await this.request("/edit", { path, oldText, newText });
  }

  stat(path: string): Promise<StatResult> {
    return this.request<StatResult>("/stat", { path });
  }

  async mkdir(path: string): Promise<void> {
    await this.request("/mkdir", { path });
  }
}
