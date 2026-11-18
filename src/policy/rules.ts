import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const decision = z.enum(["allow", "ask", "deny"]);
const absPath = z.string().startsWith("/");

const rulesSchema = z.object({
  workspace: absPath,
  read_roots: z.array(absPath).min(1),
  writable_roots: z.array(absPath).min(1),
  tools: z.record(z.string(), decision).default({}),
  taint: z
    .object({
      // Tools that change something. Once a task has read untrusted content, these
      // ask even when they would normally be allowed.
      write_tools: z.array(z.string()).default([]),
    })
    .default({ write_tools: [] }),
  browser: z
    .object({
      allowed_domains: z.array(z.string()).default([]),
      blocked_domains: z.array(z.string()).default([]),
      block_private_networks: z.boolean().default(true),
      risky_words: z.array(z.string()).default([]),
    })
    .default({ allowed_domains: [], blocked_domains: [], block_private_networks: true, risky_words: [] }),
  bash: z.object({
    read_only_commands: z.array(z.string()).default([]),
    non_path_commands: z.array(z.string()).default([]),
    unsafe_flags: z.record(z.string(), z.array(z.string())).default({}),
    git: z
      .object({
        read_only_subcommands: z.array(z.string()).default([]),
        unsafe_flags: z.array(z.string()).default([]),
      })
      .default({ read_only_subcommands: [], unsafe_flags: [] }),
    write_commands: z.array(z.string()).default([]),
    destination_commands: z.array(z.string()).default([]),
    deny_patterns: z.array(z.object({ pattern: z.string(), reason: z.string() })).default([]),
  }),
});

export type RawPolicyRules = z.infer<typeof rulesSchema>;

export interface PolicyRules extends Omit<RawPolicyRules, "bash"> {
  bash: Omit<RawPolicyRules["bash"], "deny_patterns"> & {
    deny_patterns: { regex: RegExp; reason: string }[];
  };
}

export function parsePolicyRules(input: unknown): PolicyRules {
  const parsed = rulesSchema.safeParse(input);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid policy rules: ${msg}`);
  }
  const raw = parsed.data;
  return {
    ...raw,
    bash: {
      ...raw.bash,
      deny_patterns: raw.bash.deny_patterns.map((p) => {
        try {
          return { regex: new RegExp(p.pattern, "i"), reason: p.reason };
        } catch (err) {
          throw new Error(`Invalid deny pattern ${JSON.stringify(p.pattern)}: ${(err as Error).message}`);
        }
      }),
    },
  };
}

export function loadPolicyRules(file: string): PolicyRules {
  return parsePolicyRules(parseYaml(readFileSync(file, "utf8")));
}
