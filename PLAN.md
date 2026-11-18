# Firefly — Phase 1 (MVP) plan

A self-hosted personal agent on a Mac mini, controlled from Telegram. Phase 1 delivers a
Telegram chat with a Pi agent that runs shell and file tasks inside a network-isolated sandbox
container, asking the owner for approval before anything risky.

## 1. Review of the build plan

Things checked against the real libraries before writing code (node_modules READMEs, docs and
`.d.ts` files), and what changed as a result.

### Confirmed

| Plan says | Reality |
| --- | --- |
| Pi packages under `@earendil-works/*` or `@mariozechner/*` | `@earendil-works/*` is current (1.5.2, Nov 2026). `@mariozechner/*` stopped at 0.73 (May 2026). |
| OpenRouter through Pi's provider layer | `modelRuntime.getModel("openrouter", "deepseek/deepseek-v4.1-flash")` resolves from Pi's catalog with pricing, so cost per call comes for free. Key is set with `setRuntimeApiKey("openrouter", …)`. |
| Replace Pi's bash/read/write/edit with sandbox-backed versions, same names and schemas | Pi supports this natively: `createBashToolDefinition(cwd, { operations })`, `createReadToolDefinition`, `createWriteToolDefinition`, `createEditToolDefinition` take pluggable `operations`, and a `customTools` entry with a built-in's name replaces it (`_refreshToolRegistry`). Schemas, descriptions and Pi's own truncation stay identical. |
| Session persistence and compaction | `SessionManager.create(cwd, dir)` / `SessionManager.open(file)` write JSONL; compaction is a setting (`SettingsManager.inMemory({ compaction: { enabled: true } })`). |
| One active job per chat, in order | pg-boss 12 has a `key_strict_fifo` queue policy: FIFO per `singletonKey`, other keys run in parallel. |

### Problems found in the plan, and the fix

1. **"Deny attempts to reach the agent or postgres containers" can't be done reliably with a
   command regex** (`curl $(printf 'po%s' stgres):5432`). Fixed at the network layer instead:
   two internal networks. `sandbox_net` = agent + sandbox; `db_net` = agent + postgres. The
   sandbox has no route to Postgres at all. The regex rule stays in `policy.yaml` as a second layer.
   The agent's Fastify server is reachable from the sandbox, so it exposes nothing but `/health`.
2. **`SANDBOX_INTERNET=true|false` can't toggle a network in a single compose file.** Implemented
   as an override file (`docker-compose.internet.yml`) that the Makefile adds when
   `SANDBOX_INTERNET=true`. Default stays offline.
3. **pg-boss `key_strict_fifo`: a failed job blocks every later job with the same key.** One
   crashed task would wedge that chat forever. The worker therefore never throws: failures are
   recorded in `tasks` and the job always completes. On startup, leftover active/failed jobs from
   a crash are deleted during recovery.
4. **Pi's bash schema has no `reason` field**, but the approval message must show "the agent's
   stated reason". Adding a field would change the schema (which the plan forbids). The reason
   shown is the text of the assistant message that issued the tool call (what the model said it
   was about to do), or "(no reason given)".
5. **Pi's `edit` tool takes `{ path, edits: [{ oldText, newText }] }`**, not a single
   `oldText/newText`, and implements it as read → modify → write through its operations. The
   sandbox still exposes `POST /edit {path, oldText, newText}` as specified, but the Pi tool uses
   `/read` + `/write`, so Pi's multi-edit, fuzzy matching and diff output keep working.
6. **The read-only allowlist has holes** if taken literally:
   - `find -exec/-execdir/-ok/-delete/-fprint*`, `git diff --output=…`, `git -c …`,
     `git --ext-diff`, `rg --pre` (runs a program on every file) all write or execute.
     These flags downgrade the command to `ask`.
   - Redirections (`echo x > f`) are writes even when the program is read-only. Output
     redirects make a command `ask`, or `deny` if the target is outside `/workspace`.
   - `PATH=… ls`, `$CMD args`, `/usr/bin/ls` — env-prefixed or non-literal command names → `ask`.
   - Residual risk, documented not fixed: `git status` in an attacker-supplied repo can run
     `core.fsmonitor`. Blast radius is the sandbox (no secrets, no network) only.
7. **Test 7 vs. the default rules.** The plan's defaults say "read → allow", but test 7 expects
   `read /etc/passwd` to be rejected. The policy denies `read` outside `/workspace` (logged as a
   denied tool call); the sandbox enforces the same with `realpath`.
8. **Sandbox tokens and "holds NO secrets".** The sandbox needs `SANDBOX_TOKEN` to authenticate
   the agent. Commands running as the same non-root user could read it from `/proc/1/environ`
   (the policy denies `environ` reads, but that's best-effort). This is acceptable: the token only
   grants exec inside the sandbox itself, which the reader already has, and nothing else on
   `sandbox_net` except the agent can use it. No API keys ever enter the sandbox.
9. **Telegram MarkdownV2 escaping is brittle** (18 reserved characters, context-dependent).
   Using HTML parse mode with a small Markdown→HTML converter (code fences, inline code, bold,
   italic, links) and full `<>&` escaping; plain-text fallback if Telegram rejects it.
10. **Pi workspace discovery is a prompt-injection vector.** By default Pi loads `AGENTS.md`,
    skills, prompt templates and extensions from `cwd`. A planted `/workspace/AGENTS.md` would
    become system instructions. The agent uses a custom `ResourceLoader` that loads none of them.
11. **Pi's bash tool exports `PI_*` env vars** (model, session id) into commands. Disabled
    (`exposeSessionEnvironment: false`); commands go to the sandbox anyway.
12. **Node 24**: the Docker images use `node:24`. The dev container here has Node 22.23, which
    is enough for tests; `engines` allows ≥22.

### Other deviations

- **Migrations**: a ~50-line SQL migrator (`src/db/migrate.ts`, `migrations/*.sql`, tracked in
  `schema_migrations`) instead of node-pg-migrate/drizzle-kit. Plain SQL, no extra dependency.
- **Bash parser**: `unbash` (typed, maintained Bash 5.3 parser that recurses into `$(…)`,
  `<(…)`, subshells, functions) instead of `bash-parser` (unmaintained since 2022) or
  `shell-quote` (doesn't parse substitutions).
- **Sandbox exec server**: TypeScript with zero dependencies, run with Node's built-in type
  stripping (`node server.ts`), so the sandbox image needs no build step.

## 2. Components

```
agent container (node:24, non-root)            sandbox container (debian slim, non-root)
┌───────────────────────────────────────┐      ┌────────────────────────────┐
│ telegram/  grammY long polling        │      │ sandbox/server.ts :7070    │
│   auth allowlist, commands, approvals │      │  /exec /read /write /edit  │
│   progress (typing, status edits)     │ HTTP │  /cancel  (Bearer token)   │
│ orchestrator/ pg-boss agent.run       │─────▶│  realpath ⊂ /workspace     │
│   key_strict_fifo per chat, /stop     │      │  process-group kill        │
│ agent/  Pi AgentSession per chat      │      └────────────────────────────┘
│   sandbox-backed bash/read/write/edit │         sandbox_net (internal)
│   untrusted wrapping, truncation      │
│ policy/ classify() + policy.yaml      │      ┌────────────────────────────┐
│ approvals/ wait / resolve / expire    │─────▶│ postgres:17  (db_net)      │
│ http/ Fastify /health (127.0.0.1)     │      └────────────────────────────┘
└───────────────────────────────────────┘
     egress_net → Telegram, OpenRouter
```

## 3. Files

```
src/config.ts                 zod-validated env
src/logger.ts                 pino
src/main.ts                   wiring, startup recovery, shutdown
src/db/                       pool, migrate, repositories
src/telegram/                 bot, auth, chunk, format (md→html), progress, commands
src/orchestrator/             queue (pg-boss), worker, recovery, run registry (/stop)
src/agent/                    pi runtime, session store, sandbox client, tools, system-prompt.md
src/policy/                   engine (pure classify), bash analysis, rules loader
src/approvals/                state machine (pure), service (DB + waiters)
src/http/                     Fastify health
sandbox/server.ts             exec server
config/policy.yaml            editable rules
migrations/001_init.sql
docker/agent.Dockerfile, docker/sandbox.Dockerfile
docker-compose.yml, docker-compose.internet.yml, Makefile, .env.example
test/                         vitest unit tests + e2e (fake Telegram Bot API + Pi faux model)
```

## 4. Data model

- `chats(id, model, session_file, session_started_at, created_at)`
- `tasks(id, chat_id, message_id, prompt, status queued|running|waiting_approval|done|failed|cancelled, created_at, started_at, finished_at, error)`
- `tool_calls(id, task_id, tool, args, decision, reason, result_summary, is_error, duration_ms, created_at)`
- `approvals(id, task_id, tool_call_id, chat_id, message_id, summary, status pending|approved|denied|expired, requested_at, expires_at, resolved_at)`
- `usage(id, task_id, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, created_at)`

## 5. Build order

1. Scaffold, config, logger, PLAN.md
2. Policy engine + tests
3. Message chunking / formatting + tests; auth + tests
4. Approval state machine + tests
5. Sandbox exec server + tests
6. DB migrations + repositories
7. Agent runtime (Pi, tools, wrapping, usage)
8. Orchestrator (pg-boss, cancel, recovery)
9. Telegram gateway (commands, progress, approvals UI)
10. Docker, compose, Makefile, README
11. E2E harness (fake Telegram API + faux model, real sandbox + Postgres) for the acceptance tests

## 6. Extension points for later phases

- `policy/engine.ts` takes a `ToolCall` with a `taskContext` (Phase 3 taint tracking).
- `agent/tools.ts` registers tools from a list (Phase 2 schedule/memory tools, Phase 3 browser/MCP).
- `orchestrator/queue.ts` exposes `enqueueRun()` (Phase 2 cron schedules enqueue the same job).
- `usage` table is written per model call (Phase 2 budget enforcement reads it).

## 7. Further deviations made while building

- `tool_calls` has an extra `outcome` column (`executed`, `denied_by_policy`, `denied_by_owner`,
  `expired`, `cancelled`, `error`) so the audit log shows what actually happened, not just the
  policy decision.
- Read-only allowlist additionally contains `cd`, `true`, `date` and `git show` (all harmless).
- Pi runs with thinking level `low` (DeepSeek V4.1 Flash is a reasoning model; `off` hurts
  tool use, `high` costs more). Not configurable yet.
- A graceful shutdown (`docker compose restart agent`) aborts running tasks and records them
  as `failed / interrupted` with a Telegram notice, same as a crash, rather than `cancelled`.
- `/approvals` re-posts each pending approval with live buttons, in case the original message
  scrolled away.
- The official `postgres:17-alpine` entrypoint starts as root and drops to `postgres` for the
  server process. "Non-root in all images" applies to the two images built here.
- `pnpm test` runs only tests that need nothing but Node. The DB-backed integration test and
  the acceptance suite run with `make test-e2e`, which starts its own Postgres container.

## 8. Acceptance results

Automated in `test/e2e/acceptance.test.ts`. It runs the real `startApp()` wiring: grammY
long polling against a fake Bot API that validates HTML like Telegram does, pg-boss on
Postgres 17, the Pi agent loop, the policy engine, approvals and the real sandbox server.
Pi's scripted faux provider stands in for OpenRouter. Checks marked "Docker" were run
against the compose stack.

| # | Test | Result |
| --- | --- | --- |
| 1 | Non-allowed account gets no reply, is logged | Pass (e2e + Docker) |
| 2 | "What files…" runs `ls` without asking | Pass |
| 3 | hello.py written without asking; python asks; Approve runs, Deny explained | Pass |
| 4 | Unanswered approval expires, agent told | Pass |
| 5 | `/stop` kills `sleep 300` within 5 s | Pass (well under 1 s) |
| 6 | `SANDBOX_INTERNET=false`: `curl https://example.com` fails in sandbox | Pass (Docker); sandbox also can't reach Postgres |
| 7 | `read /etc/passwd` rejected | Pass (policy deny, plus sandbox realpath check) |
| 8 | Injected "rm -rf /workspace" doesn't run without approval | Pass, with a scripted model that falls for the injection |
| 9 | `docker compose restart agent` keeps the conversation | Pass (e2e restart; Docker restart and crash recovery) |
| 10 | >4096-char reply split cleanly, code blocks intact | Pass |
| 11 | `pnpm test` passes; `docker compose up` from clean clone | Pass. Both images build; the stack comes up healthy |

Not verifiable in the build environment, still to do on the Mac mini:
- Real OpenRouter and Telegram traffic: no keys here, and the build container can't reach
  `openrouter.ai`. In Docker, a message went all the way to the model call and the
  connection error came back to the chat correctly.
- Test 8 with the real DeepSeek model, to see whether it resists the injection on its own.
  The policy stops the `rm` either way.
- `SANDBOX_INTERNET=true` reaching the internet. The override attaches a separate egress
  network (checked with `docker compose config`); this environment blocks container egress.

---

# Phase 2: routines, memory, cost cap

## Design

- **Scheduler** (`src/scheduler/`): rows in `schedules`; each enabled row is a pg-boss cron
  schedule on queue `schedule.fire`, keyed by schedule id and evaluated in its own time zone.
  A firing creates a `tasks` row (`kind = routine`) and an `agent.run` job keyed
  `routine:<task id>`, so a routine waiting hours for approval never blocks the chat (whose
  jobs share the key `chat:<id>`). `sync()` on startup makes pg-boss match the table.
  `next_run_at` is computed with cron-parser; plain-words descriptions use cronstrue.
- **Fresh sessions for routines**: `AgentRuntime.run({ session: "routine" })` builds a new
  Pi session per firing (kept under `sessions/routines/`) and disposes it afterwards.
- **NO_REPORT**: the routine prompt is wrapped with instructions; a reply of exactly
  `NO_REPORT` (formatting around it allowed) is dropped.
- **Memory** (`src/memory/`): Markdown files in the `memory` volume are the source of truth
  the owner reads and backs up; `memories` has one row per fact with a tsvector for search.
  `profile.md` (capped at ~8000 characters, about 2000 tokens, keeping the newest lines) goes into the system prompt
  through the resource loader's append prompt. It's re-read before every run, and calling
  `setActiveToolsByName()` makes Pi rebuild and persist the changed section.
- **Memory only from the owner, enforced in code**: `remember` refuses when the run was
  started by a routine, or when the task is *tainted* (it has already read files, command
  output, web pages or email). A file that says "remember that…" can't create a memory,
  even in a task the owner started.
- **Taint tracking** (also needed by Phase 3) lives in the tool guard: every tool except
  `write`, memory and routine tools taints the task when it runs. Once tainted, tools in
  `policy.yaml` → `taint.write_tools` (`write`, `edit`) ask instead of being allowed.
- **Budget** (`src/budget/`): Pi emits `turn_start` before each model call; the runtime
  checks the budget there (and before the first call) and aborts the run with a reason if
  over. Monthly spend is computed in `TZ`; `budget_months` holds `/raise` amounts and the
  80% warning flag. `MAX_TURNS_PER_TASK` counts `turn_start` events.
- **Retries**: Pi's own retry with exponential backoff (`retry.baseDelayMs` 2 s,
  `MODEL_MAX_RETRIES` attempts) handles transient OpenRouter errors.

## Deviations

- pg-boss caps a job at 24 h, so routine approvals wait at most 23 h
  (`ROUTINE_APPROVAL_TIMEOUT_SECONDS`, default 12 h) instead of indefinitely. A restart
  while a routine is waiting fails that task as "interrupted" (a Pi run can't be resumed
  mid-tool-call), like any other task.
- "Before every model call" is implemented as a check on Pi's `turn_start` event that
  aborts the run. The check is asynchronous, so in the worst case one request has already
  started when the abort lands; that request is cancelled.
- The taint rule from Phase 3 was pulled forward, because the memory rule needs it.
  Side effect: within one task, editing a file after reading it now asks.
- `/schedules` offers a "Run now" button next to on/off; toggling a routine on/off is
  your own action and doesn't need approval (creating or deleting does).
- `/raise [usd]` adds the given amount (default: one more monthly budget) to this month's
  cap; the per-task cap is a setting, not raisable from chat.

## Results (`test/e2e/phase2.test.ts`)

| Done when | Result |
| --- | --- |
| "Every weekday at 8am…" creates a routine after approval, and it fires on time | Pass. Approval shows "At 08:00, Monday through Friday (America/Toronto)"; nothing created before approval; next run is a weekday 08:00 Toronto. A per-minute routine fired by pg-boss within seconds of the minute boundary, in a fresh session |
| A routine with nothing to report sends nothing | Pass |
| "Remember I prefer metric units" persists across /new and a restart | Pass: it's in the profile in the system prompt of a fresh session and after reboot |
| A file saying "remember that the owner's password is X" creates no memory | Pass: refused (task tainted); the table and `profile.md` stay unchanged |
| `TASK_BUDGET_USD` stops a long task with a clear message | Pass (80% warning, then "This task hit its budget of $0.0500") |

Also covered: invalid cron refused without asking; routine approvals wait past the chat
timeout while the chat keeps working; `/schedules` toggles; routines can't write memory;
`/forget`; `MAX_TURNS_PER_TASK`; monthly cap with `/raise`; `/usage` and `/tasks`.
Faux model calls report no cost, so the budget tests record each call's cost in `usage`,
the same table enforcement reads.

---

# Phase 3: browser, connected apps, vault

## Design

- **Browser container** (`browser/server.ts`, `docker/browser.Dockerfile`): Playwright
  1.63 Chromium (`mcr.microsoft.com/playwright:v1.63.0-noble`, non-root `pwuser`, all
  capabilities dropped) with a persistent profile volume. It has its own `browser_net`
  (agent only) and `browser_egress` (internet). A small HTTP API (bearer token), one tab
  per task. Snapshots use Playwright's `ariaSnapshot({ mode: "ai" })`, an accessibility
  tree with refs such as `e12` or `f1e12`, which the agent passes to click and type
  (located via `aria-ref=`).
- **Network guard in the browser**: every request (navigation, redirect, subresource) goes
  through `context.route` and is checked against the domain allow/blocklist from
  `policy.yaml`, which the agent sends with each call, and against private, loopback,
  link-local and CGNAT addresses, after DNS resolution. A page can't reach the agent,
  Postgres, the LAN or cloud metadata endpoints.
- **Browser policy** (`src/policy/browser.ts`): `browser_open` checks scheme and domain
  lists; `browser_snapshot` and `browser_screenshot` are allowed. Before a
  `browser_click`, the tool's *preflight* asks the browser what the element is; submit
  buttons and anything whose label contains a word from `browser.risky_words` (buy, send,
  post, delete, sign in, …) ask, and everything else is allowed. `browser_type` with
  `submit` asks. A screenshot is attached to these approvals.
- **Vault** (`src/vault/`): table `secrets(name, nonce, ciphertext)`, libsodium
  `crypto_secretbox_easy` with a 32-byte master key read from `VAULT_KEY_FILE` (the Docker
  secret `/run/secrets/vault_master_key`, generated by `make secrets`). Values are
  decrypted into memory for redaction. `vault_fill` (always asks) types a value into a
  browser field (`/fill-secret`, never echoed) or passes it as one environment variable to
  one sandbox command (the sandbox's `/exec` takes `env`; `PATH`, `LD_*` and similar names
  are refused).
- **Redaction** of every secret value, plus its URL-encoded, base64 and JSON-escaped forms,
  applies in the tool guard (results, errors, audit log), in every outgoing Telegram
  message, and in every log line (pino `streamWrite` hook). Session files only ever contain
  redacted tool results.
- **/vault add**: the next message is captured by a handler registered before the agent's
  text handler, deleted from the chat immediately, and never enqueued or logged.
- **MCP** (`src/mcp/`): `@modelcontextprotocol/sdk` client over streamable HTTP or stdio
  for the servers in `config/mcp.yaml` only. stdio servers get the SDK's minimal default
  environment plus their own listed env, never the agent's keys. Header and env values
  `vault:<name>` come from the vault. Each tool becomes a guarded Pi tool
  `mcp__<server>__<tool>` (JSON Schema passed through `Type.Unsafe`). Its policy comes
  from the tag: `read` is allowed, `write` asks, untagged uses the server `default`
  (`ask`). Every MCP tool taints the task.
- **Composio** is used through its MCP endpoint, so OAuth tokens stay with Composio and
  the Composio API key is in the vault.
- **Taint rule**: already in place from Phase 2; `browser_type` was added to
  `taint.write_tools`, and MCP write tools ask anyway.

## Deviations

- No Composio SDK: Composio's MCP endpoint gives the same apps through the MCP client
  without another dependency, and keeps every app behind one policy path.
- Typing into a page counts as a write, so after the first page is read (which is always,
  once browsing starts), `browser_type` asks. The agent is told to search by opening a
  search URL. This follows the taint rule literally; it can be relaxed in `policy.yaml`.
- "sign in / log in" are risky words, so a login takes up to three approvals (username
  typing after taint, `vault_fill`, the submit click). That's strict on purpose.
- Private-address blocking happens after DNS resolution, but Chromium resolves again
  itself, so DNS rebinding between the check and the request is a residual risk. Blast
  radius: the browser container's network, which has no route to the internal networks.
- Policy changes (e.g. domain lists) need `make restart`, as in earlier phases.

## Results (`test/e2e/phase3.test.ts`, `test/browser.integration.test.ts`)

Run against a local test website, the real browser server (local Chromium), and a fake
Gmail MCP server built with the MCP SDK.

| Done when | Result |
| --- | --- |
| "Find the opening hours of the nearest library" browses and replies without approval | Pass: open, snapshot, click link, snapshot, all `allow` |
| A login flow uses a vault secret without the value in logs or the session file | Pass. The site echoes the password back; the model saw `[vault:site]`. The value isn't in captured logs, session JSONL, `tool_calls`, or any Telegram message; the site received the real password |
| "Summarise my last 5 emails" works via the mail server; "reply to the first one" asks first | Pass (with a fake MCP mail server standing in for Gmail via Composio) |
| An email with injected instructions to forward the inbox leads to no forward without approval | Pass: the (scripted) model calls the untagged forward tool; it asks, Deny, nothing is forwarded |

Also covered: purchase click asks with a screenshot attached, and Deny leaves no order;
`javascript:` URLs refused; screenshots go to Telegram; `/vault add` deletes the message
and stores ciphertext; env injection with output redaction; MCP auth header from the vault;
taint makes a file write ask after reading email; private/metadata IPs, `file:` and the
domain lists are enforced in the browser server; the browser image runs hardened.

Not verifiable here: real Gmail/Calendar/Notion through Composio (no account), and real
websites, since this environment has no general internet access from containers.
