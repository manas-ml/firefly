import type { PolicyRules } from "./rules.ts";
import type { PolicyResult } from "./types.ts";

function matchesDomain(host: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^\*?\./, "");
  return host === d || host.endsWith(`.${d}`);
}

/** Domain rules for a URL the agent wants to open. */
export function classifyUrl(raw: unknown, rules: PolicyRules): PolicyResult {
  if (typeof raw !== "string") return { decision: "deny", reason: "no URL given" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { decision: "deny", reason: `invalid URL ${raw}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { decision: "deny", reason: `only http(s) URLs (${url.protocol})` };
  const host = url.hostname.toLowerCase();
  const b = rules.browser;
  if (b.blocked_domains.some((d) => matchesDomain(host, d))) return { decision: "deny", reason: `${host} is on the blocklist` };
  if (b.allowed_domains.length > 0 && !b.allowed_domains.some((d) => matchesDomain(host, d))) {
    return { decision: "deny", reason: `${host} is not on the allowlist` };
  }
  return { decision: "allow", reason: `open ${host}` };
}

export interface ElementInfo {
  tag?: string;
  type?: string;
  role?: string;
  name?: string;
  href?: string;
  inForm?: boolean;
  formMethod?: string;
}

/** A click that submits, buys, posts or sends asks first; plain navigation is allowed. */
export function classifyClick(element: ElementInfo | undefined, rules: PolicyRules, preflightError?: unknown): PolicyResult {
  if (!element) {
    return { decision: "ask", reason: preflightError ? `couldn't inspect the element (${String(preflightError)})` : "unknown element" };
  }
  const label = (element.name ?? "").toLowerCase();
  const word = rules.browser.risky_words.find((w) => new RegExp(`(^|[^a-z])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(label));
  if (word) return { decision: "ask", reason: `clicks “${element.name}” (${word})` };
  const submits =
    element.type === "submit" || element.type === "image" || (element.tag === "button" && element.inForm && (element.type === "" || element.type === "submit"));
  if (submits) return { decision: "ask", reason: `submits a form (“${element.name || element.tag}”)` };
  if (element.tag === "a" && element.href) {
    try {
      const host = new URL(element.href).hostname;
      if (rules.browser.blocked_domains.some((d) => matchesDomain(host, d))) return { decision: "deny", reason: `${host} is on the blocklist` };
    } catch {
      /* relative or javascript: links are fine to click */
    }
  }
  return { decision: "allow", reason: `click “${element.name || element.tag}”` };
}
