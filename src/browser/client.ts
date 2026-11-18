import type { PolicyRules } from "../policy/rules.ts";

export class BrowserError extends Error {
  override name = "BrowserError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface PageInfo {
  url: string;
  title: string;
}

/** Talks to browser/server.ts. Every call carries the network policy from policy.yaml. */
export class BrowserClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly rules: PolicyRules,
  ) {}

  private async call<T>(route: string, body: Record<string, unknown>): Promise<T> {
    const net = {
      allowedDomains: this.rules.browser.allowed_domains,
      blockedDomains: this.rules.browser.blocked_domains,
      blockPrivateNetworks: this.rules.browser.block_private_networks,
    };
    let res: Response;
    try {
      res = await fetch(new URL(route, this.baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...body, net }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new BrowserError(`browser unreachable: ${(err as Error).message}`, 0);
    }
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new BrowserError(json.error ?? `HTTP ${res.status}`, res.status);
    return json;
  }

  async health(): Promise<boolean> {
    try {
      const r = await fetch(new URL("/health", this.baseUrl), { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  open(session: string, url: string) {
    return this.call<PageInfo & { status: number | null; blockedRequests: string[] }>("/open", { session, url });
  }
  snapshot(session: string) {
    return this.call<PageInfo & { snapshot: string }>("/snapshot", { session });
  }
  describe(session: string, ref: string) {
    return this.call<Record<string, unknown>>("/describe", { session, ref });
  }
  click(session: string, ref: string) {
    return this.call<PageInfo>("/click", { session, ref });
  }
  type(session: string, ref: string, text: string, submit: boolean) {
    return this.call<PageInfo>("/type", { session, ref, text, submit });
  }
  fillSecret(session: string, ref: string, value: string) {
    return this.call<PageInfo>("/fill-secret", { session, ref, value });
  }
  async screenshot(session: string, fullPage = false): Promise<PageInfo & { png: Buffer }> {
    const r = await this.call<PageInfo & { pngBase64: string }>("/screenshot", { session, fullPage });
    return { url: r.url, title: r.title, png: Buffer.from(r.pngBase64, "base64") };
  }
  close(session: string) {
    return this.call<{ closed: boolean }>("/close", { session });
  }
}
