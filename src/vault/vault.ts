import { readFileSync } from "node:fs";
import sodium from "libsodium-wrappers";
import type { Pool } from "../db/pool.ts";

export const SECRET_NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

/** "vault:GitHub" / "github" -> "github". */
export function normalizeSecretName(input: string): string {
  return input.trim().replace(/^vault:/i, "").toLowerCase();
}

/** Parse a 32-byte key file (hex or base64, whitespace ignored). */
export function parseMasterKey(raw: string): Uint8Array {
  const s = raw.trim();
  const bytes = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  if (bytes.length !== 32) throw new Error("vault master key must be 32 bytes (64 hex characters)");
  return new Uint8Array(bytes);
}

/**
 * Secrets encrypted with libsodium secretbox (XSalsa20-Poly1305). The agent
 * refers to them by name only; values are decrypted in memory so tool output
 * can be redacted, and are handed only to the browser field or the single
 * sandbox command they're used for.
 */
export class Vault {
  private key: Uint8Array | undefined;
  private cache = new Map<string, string>();

  constructor(private readonly pool: Pool) {}

  /** Load the master key. Without one the vault stays disabled. */
  async init(keyFile: string | undefined): Promise<boolean> {
    await sodium.ready;
    if (!keyFile) return false;
    let raw: string;
    try {
      raw = readFileSync(keyFile, "utf8");
    } catch {
      return false;
    }
    this.key = parseMasterKey(raw);
    await this.reload();
    return true;
  }

  get enabled(): boolean {
    return this.key !== undefined;
  }

  private requireKey(): Uint8Array {
    if (!this.key) throw new Error("The vault is not set up (no master key file). Run install.sh.");
    return this.key;
  }

  private async reload(): Promise<void> {
    const key = this.requireKey();
    const rows = await this.pool.query<{ name: string; nonce: Buffer; ciphertext: Buffer }>("SELECT name, nonce, ciphertext FROM secrets");
    const next = new Map<string, string>();
    for (const r of rows.rows) {
      const plain = sodium.crypto_secretbox_open_easy(new Uint8Array(r.ciphertext), new Uint8Array(r.nonce), key);
      next.set(r.name, sodium.to_string(plain));
    }
    this.cache = next;
  }

  async set(nameInput: string, value: string): Promise<string> {
    const key = this.requireKey();
    const name = normalizeSecretName(nameInput);
    if (!SECRET_NAME.test(name)) throw new Error("Secret names are lowercase letters, digits, - _ . (max 63).");
    if (!value) throw new Error("Empty secret.");
    if (value.length > 4096) throw new Error("Secret too long.");
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = sodium.crypto_secretbox_easy(sodium.from_string(value), nonce, key);
    await this.pool.query(
      `INSERT INTO secrets (name, nonce, ciphertext) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET nonce = EXCLUDED.nonce, ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
      [name, Buffer.from(nonce), Buffer.from(ciphertext)],
    );
    this.cache.set(name, value);
    return name;
  }

  async remove(nameInput: string): Promise<boolean> {
    const name = normalizeSecretName(nameInput);
    const r = await this.pool.query("DELETE FROM secrets WHERE name = $1", [name]);
    this.cache.delete(name);
    return (r.rowCount ?? 0) > 0;
  }

  async list(): Promise<{ name: string; updated_at: Date }[]> {
    return (await this.pool.query<{ name: string; updated_at: Date }>("SELECT name, updated_at FROM secrets ORDER BY name")).rows;
  }

  has(nameInput: string): boolean {
    return this.cache.has(normalizeSecretName(nameInput));
  }

  /** The plaintext, for vault_fill only. Never return this to the model. */
  reveal(nameInput: string): string {
    this.requireKey();
    const v = this.cache.get(normalizeSecretName(nameInput));
    if (v === undefined) throw new Error(`No secret named ${normalizeSecretName(nameInput)}. Add it with /vault add.`);
    return v;
  }

  /** Replace every known secret value (and common encodings of it) with [vault:name]. */
  redact(text: string): string {
    return redactSecrets(text, this.cache);
  }
}

export function redactSecrets(text: string, secrets: ReadonlyMap<string, string>): string {
  if (!text || secrets.size === 0) return text;
  const variants: [string, string][] = [];
  for (const [name, value] of secrets) {
    if (value.length < 4) continue; // too short to redact without mangling normal text
    const label = `[vault:${name}]`;
    for (const v of new Set([value, encodeURIComponent(value), Buffer.from(value).toString("base64"), JSON.stringify(value).slice(1, -1)])) {
      variants.push([v, label]);
    }
  }
  variants.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [v, label] of variants) if (out.includes(v)) out = out.split(v).join(label);
  return out;
}
