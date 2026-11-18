/**
 * Browser server: Chromium with a persistent profile, driven by the agent over
 * an internal network. Holds no secrets except its access token; a vault secret
 * passes through /fill-secret into a form field and is never returned.
 *
 * Every request the page makes is checked against the network policy the agent
 * sends with each call: blocked/allowed domains from policy.yaml, and no
 * private or loopback addresses (so a web page can't reach the agent, the
 * database or the Mac).
 *
 *   node browser/server.ts
 */
import { timingSafeEqual } from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { chromium, type BrowserContext, type Page } from "playwright-core";

const PORT = Number(process.env.PORT ?? 7071);
const HOST = process.env.HOST ?? "0.0.0.0";
const TOKEN = process.env.BROWSER_TOKEN ?? "";
const PROFILE_DIR = process.env.PROFILE_DIR ?? "/profile";
const MAX_SESSIONS = 6;
const IDLE_MS = 15 * 60 * 1000;
const NAV_TIMEOUT_MS = 30_000;
const MAX_SNAPSHOT_CHARS = 60_000;

if (TOKEN.length < 24) {
  console.error("BROWSER_TOKEN is missing or shorter than 24 characters");
  process.exit(1);
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------- network policy ----------

export interface NetPolicy {
  allowedDomains: string[];
  blockedDomains: string[];
  blockPrivateNetworks: boolean;
}

let netPolicy: NetPolicy = { allowedDomains: [], blockedDomains: [], blockPrivateNetworks: true };

function matchesDomain(host: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^\*?\./, "");
  return host === d || host.endsWith(`.${d}`);
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

const dnsCache = new Map<string, { private: boolean; at: number }>();

async function resolvesPrivate(host: string): Promise<boolean> {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (net.isIP(host)) return isPrivateIp(host);
  const cached = dnsCache.get(host);
  if (cached && Date.now() - cached.at < 60_000) return cached.private;
  let priv: boolean;
  try {
    const addrs = await dns.lookup(host, { all: true });
    priv = addrs.some((a) => isPrivateIp(a.address));
  } catch {
    priv = false; // unresolvable: the request will fail on its own
  }
  dnsCache.set(host, { private: priv, at: Date.now() });
  return priv;
}

/** Why a URL is blocked, or undefined if allowed. */
async function blockReason(raw: string): Promise<string | undefined> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid URL";
  }
  if (["data:", "blob:", "about:"].includes(url.protocol)) return undefined;
  if (url.protocol !== "http:" && url.protocol !== "https:") return `scheme ${url.protocol} not allowed`;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (netPolicy.blockedDomains.some((d) => matchesDomain(host, d))) return `${host} is on the blocklist`;
  if (netPolicy.allowedDomains.length > 0 && !netPolicy.allowedDomains.some((d) => matchesDomain(host, d))) {
    return `${host} is not on the allowlist`;
  }
  if (netPolicy.blockPrivateNetworks && (await resolvesPrivate(host))) return `${host} is a private network address`;
  return undefined;
}

// ---------- browser and sessions ----------

let context: BrowserContext;
const sessions = new Map<string, { page: Page; lastUsed: number; blocked: string[] }>();

async function getPage(sessionId: unknown, create: boolean): Promise<Page> {
  if (typeof sessionId !== "string" || !/^[\w-]{1,64}$/.test(sessionId)) throw new HttpError(400, "session is required");
  const existing = sessions.get(sessionId);
  if (existing && !existing.page.isClosed()) {
    existing.lastUsed = Date.now();
    return existing.page;
  }
  if (!create) throw new HttpError(409, "No page is open. Use browser_open first.");
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (oldest) await closeSession(oldest[0]);
  }
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  const entry = { page, lastUsed: Date.now(), blocked: [] as string[] };
  sessions.set(sessionId, entry);
  // Links that open a new tab: follow them in this session.
  page.on("popup", (popup) => {
    entry.page = popup;
    popup.setDefaultTimeout(NAV_TIMEOUT_MS);
  });
  return page;
}

async function closeSession(id: string): Promise<void> {
  const s = sessions.get(id);
  sessions.delete(id);
  await s?.page.close().catch(() => undefined);
}

function sessionOf(body: Record<string, unknown>) {
  return sessions.get(String(body.session));
}

async function pageInfo(page: Page) {
  return { url: page.url(), title: await page.title().catch(() => "") };
}

function locator(page: Page, ref: unknown) {
  if (typeof ref !== "string" || !/^(f\d{1,4})?e\d{1,6}$/.test(ref)) throw new HttpError(400, "ref must look like e12 or f1e12 (from browser_snapshot)");
  return page.locator(`aria-ref=${ref}`);
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
}

// ---------- handlers ----------

async function open(body: Record<string, unknown>) {
  const url = String(body.url ?? "");
  const reason = await blockReason(url);
  if (reason) throw new HttpError(403, `Blocked: ${reason}`);
  const page = await getPage(body.session, true);
  const s = sessionOf(body);
  if (s) s.blocked = [];
  const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch((err: Error) => {
    throw new HttpError(502, `Could not load ${url}: ${err.message.split("\n")[0]}`);
  });
  await settle(page);
  return { ...(await pageInfo(page)), status: res?.status() ?? null, blockedRequests: s?.blocked.slice(0, 5) ?? [] };
}

async function snapshot(body: Record<string, unknown>) {
  const page = await getPage(body.session, false);
  let text = await page.ariaSnapshot({ mode: "ai", timeout: 15_000 });
  if (text.length > MAX_SNAPSHOT_CHARS) text = `${text.slice(0, MAX_SNAPSHOT_CHARS)}\n[snapshot truncated]`;
  return { ...(await pageInfo(page)), snapshot: text };
}

/** Facts about an element, for the agent's policy check before a click or type. */
async function describe(body: Record<string, unknown>) {
  const page = await getPage(body.session, false);
  const el = locator(page, body.ref);
  const info = await el.evaluate((e: Element) => {
    const anyEl = e as HTMLInputElement & HTMLButtonElement & HTMLAnchorElement;
    const form = (anyEl.form ?? e.closest("form")) as HTMLFormElement | null;
    return {
      tag: e.tagName.toLowerCase(),
      type: (anyEl.type ?? "").toString().toLowerCase(),
      role: e.getAttribute("role") ?? "",
      name: (e.getAttribute("aria-label") ?? (e as HTMLElement).innerText ?? anyEl.value ?? "").toString().trim().slice(0, 120),
      href: e.tagName === "A" ? anyEl.href : "",
      inForm: Boolean(form),
      formAction: form?.action ?? "",
      formMethod: (form?.method ?? "").toLowerCase(),
    };
  }, undefined, { timeout: 5_000 });
  return info;
}

async function click(body: Record<string, unknown>) {
  const page = await getPage(body.session, false);
  await locator(page, body.ref).click({ timeout: 10_000 });
  const s = sessionOf(body);
  await settle(s?.page ?? page);
  return pageInfo(s?.page ?? page);
}

async function type(body: Record<string, unknown>) {
  const page = await getPage(body.session, false);
  if (typeof body.text !== "string") throw new HttpError(400, "text is required");
  const el = locator(page, body.ref);
  await el.fill(body.text, { timeout: 10_000 });
  if (body.submit === true) {
    await el.press("Enter");
    await settle(page);
  }
  return pageInfo(page);
}

async function fillSecret(body: Record<string, unknown>) {
  const page = await getPage(body.session, false);
  if (typeof body.value !== "string" || body.value === "") throw new HttpError(400, "value is required");
  await locator(page, body.ref).fill(body.value, { timeout: 10_000 });
  return { filled: true, ...(await pageInfo(page)) }; // never echo the value
}

async function screenshot(body: Record<string, unknown>) {
  const page = await getPage(body.session, false);
  const png = await page.screenshot({ fullPage: body.fullPage === true, type: "png", timeout: 15_000 });
  return { ...(await pageInfo(page)), pngBase64: png.toString("base64") };
}

async function close(body: Record<string, unknown>) {
  await closeSession(String(body.session));
  return { closed: true };
}

const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  "/open": open,
  "/snapshot": snapshot,
  "/describe": describe,
  "/click": click,
  "/type": type,
  "/fill-secret": fillSecret,
  "/screenshot": screenshot,
  "/close": close,
};

// ---------- http ----------

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
    if (size > 1024 * 1024) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

function applyNetPolicy(body: Record<string, unknown>): void {
  const p = body.net as Partial<NetPolicy> | undefined;
  if (!p || typeof p !== "object") return;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  netPolicy = {
    allowedDomains: list(p.allowedDomains),
    blockedDomains: list(p.blockedDomains),
    blockPrivateNetworks: p.blockPrivateNetworks !== false,
  };
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, sessions: sessions.size });
    if (!authorized(req.headers.authorization)) return send(res, 401, { error: "unauthorized" });
    const handler = req.method === "POST" && req.url ? routes[req.url] : undefined;
    if (!handler) return send(res, 404, { error: "not found" });
    const body = await readBody(req);
    applyNetPolicy(body);
    send(res, 200, await handler(body));
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    const message = (err as Error).message?.split("\n")[0] ?? "error";
    send(res, 500, { error: message });
  }
});
server.requestTimeout = 120_000;

async function main() {
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: false,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--disable-dev-shm-usage", "--no-first-run", "--disable-features=Translate"],
  });
  // Every request, including redirects and subresources, goes through the policy.
  await context.route("**/*", async (route) => {
    const reason = await blockReason(route.request().url());
    if (!reason) return route.continue();
    for (const s of sessions.values()) if (s.page === route.request().frame()?.page()) s.blocked.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  setInterval(() => {
    for (const [id, s] of sessions) if (Date.now() - s.lastUsed > IDLE_MS) void closeSession(id);
  }, 60_000).unref();
  server.listen(PORT, HOST, () => console.log(JSON.stringify({ msg: "browser listening", port: PORT })));
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close();
    void context?.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

void main();
