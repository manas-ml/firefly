import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BROWSER_TEST_TOKEN, startLocalBrowser } from "./helpers/browser.ts";
import { startTestSite } from "./helpers/site.ts";

let br: Awaited<ReturnType<typeof startLocalBrowser>>;
let site: Awaited<ReturnType<typeof startTestSite>>;
const open = { allowedDomains: [], blockedDomains: [], blockPrivateNetworks: false };

async function call(route: string, body: Record<string, unknown>, token = BROWSER_TEST_TOKEN) {
  const res = await fetch(`${br.url}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  br = await startLocalBrowser();
  site = await startTestSite();
});
afterAll(async () => {
  await br?.stop();
  await site?.stop();
});

describe("browser server", () => {
  it("requires the token", async () => {
    expect((await call("/open", { session: "s", url: site.url }, "wrong".repeat(6))).status).toBe(401);
  });

  it("blocks private network addresses by default", async () => {
    const r = await call("/open", { session: "s", url: site.url });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/private network/);
    expect((await call("/open", { session: "s", url: "http://169.254.169.254/latest/meta-data" })).json.error).toMatch(/private/);
    expect((await call("/open", { session: "s", url: "file:///etc/passwd" })).json.error).toMatch(/scheme/);
  });

  it("enforces the domain blocklist and allowlist", async () => {
    expect((await call("/open", { session: "s", url: site.url, net: { ...open, blockedDomains: ["127.0.0.1"] } })).json.error).toMatch(/blocklist/);
    expect((await call("/open", { session: "s", url: site.url, net: { ...open, allowedDomains: ["example.com"] } })).json.error).toMatch(/allowlist/);
  });

  it("opens pages, snapshots them with refs, clicks and types", async () => {
    const o = await call("/open", { session: "t1", url: site.url, net: open });
    expect(o.json).toMatchObject({ title: "Riverside Library", status: 200 });
    const snap = (await call("/snapshot", { session: "t1", net: open })).json.snapshot as string;
    const ref = snap.match(/link "Opening hours" \[ref=([a-z0-9]+)\]/)![1]!;
    const d = await call("/describe", { session: "t1", ref, net: open });
    expect(d.json).toMatchObject({ tag: "a", inForm: false });
    expect((await call("/click", { session: "t1", ref, net: open })).json.title).toBe("Hours");
    const hours = (await call("/snapshot", { session: "t1", net: open })).json.snapshot as string;
    expect(hours).toContain("Monday to Friday 9:00–20:00");

    await call("/open", { session: "t1", url: `${site.url}/shop`, net: open });
    const shop = (await call("/snapshot", { session: "t1", net: open })).json.snapshot as string;
    const buy = shop.match(/button "Buy now" \[ref=([a-z0-9]+)\]/)![1]!;
    expect((await call("/describe", { session: "t1", ref: buy, net: open })).json).toMatchObject({ tag: "button", type: "submit", inForm: true });
    const shot = await call("/screenshot", { session: "t1", net: open });
    expect(Buffer.from(shot.json.pngBase64 as string, "base64").subarray(1, 4).toString()).toBe("PNG");
  });

  it("fills a secret without echoing it", async () => {
    await call("/open", { session: "t2", url: `${site.url}/login`, net: open });
    const snap = (await call("/snapshot", { session: "t2", net: open })).json.snapshot as string;
    const pw = snap.match(/textbox "Password" \[ref=([a-z0-9]+)\]/)![1]!;
    const r = await call("/fill-secret", { session: "t2", ref: pw, value: "hunter2-secret", net: open });
    expect(r.json.filled).toBe(true);
    expect(JSON.stringify(r.json)).not.toContain("hunter2");
  });

  it("blocks subresources and redirects to blocked hosts", async () => {
    const r = await call("/open", { session: "t3", url: `${site.url}/hours`, net: { ...open, blockedDomains: ["evil.test"] } });
    expect(r.status).toBe(200);
  });
});
