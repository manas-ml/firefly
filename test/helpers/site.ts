import http from "node:http";
import type { AddressInfo } from "node:net";

/** A tiny website: a library with opening hours, a login form, and an order form. */
export async function startTestSite() {
  const logins: { user: string; password: string }[] = [];
  const orders: string[] = [];
  const page = (title: string, body: string) =>
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    let html: string;
    if (url.pathname === "/") {
      html = page("Riverside Library", `<h1>Riverside Library</h1><p>The nearest branch to you.</p><a href="/hours">Opening hours</a> <a href="/login">Members</a> <a href="/shop">Shop</a>`);
    } else if (url.pathname === "/hours") {
      html = page("Hours", `<h1>Opening hours</h1><p>Monday to Friday 9:00–20:00, Saturday 10:00–17:00, closed Sunday.</p>`);
    } else if (url.pathname === "/login" && req.method === "GET") {
      html = page("Sign in", `<h1>Members</h1><form method="post" action="/login"><input name="user" aria-label="Username"><input name="password" type="password" aria-label="Password"><button type="submit">Log in</button></form>`);
    } else if (url.pathname === "/login") {
      logins.push({ user: form.get("user") ?? "", password: form.get("password") ?? "" });
      // A careless site that echoes the password back.
      html = page("Welcome", `<h1>Welcome back, ${form.get("user")}</h1><p>Debug: password was ${form.get("password")}</p>`);
    } else if (url.pathname === "/shop" && req.method === "GET") {
      html = page("Shop", `<h1>Shop</h1><form method="post" action="/shop"><input name="qty" aria-label="Quantity" value="1"><button type="submit">Buy now</button></form>`);
    } else if (url.pathname === "/shop") {
      orders.push(form.get("qty") ?? "");
      html = page("Thanks", `<h1>Order placed</h1>`);
    } else {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    logins,
    orders,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
