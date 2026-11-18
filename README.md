# Firefly

A self-hosted personal agent for a Mac mini, controlled from Telegram. It runs the
[Pi](https://github.com/badlogic/pi-mono) agent with an OpenRouter model, executes shell
and file tasks inside an isolated sandbox container, and asks you on Telegram before
anything risky.

This is **Phase 1 (MVP)**. See [PLAN.md](PLAN.md) for the design, the review of the build
plan and the deviations from it.

```
Telegram ──long polling──▶ agent ──▶ OpenRouter
                            │  │
            internal net ───┘  └─── internal net
                 ▼                       ▼
              sandbox                 postgres
       (/workspace, no internet,   (tasks, approvals,
        no secrets)                 audit log, usage)
```

## Setup

### 1. Create the bot

1. In Telegram, open **@BotFather**, send `/newbot`, pick a name and a username.
2. Copy the token it gives you (looks like `123456789:AA…`).

### 2. Find your Telegram user id

Message **@userinfobot** (or **@RawDataBot**) and copy the numeric `Id`. Only this id
will be able to talk to the bot; everyone else is ignored silently.

### 3. Fill in `.env`

```sh
cp .env.example .env
openssl rand -hex 32   # use for SANDBOX_TOKEN
openssl rand -hex 16   # use for POSTGRES_PASSWORD
```

Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, `OPENROUTER_API_KEY`
([openrouter.ai/keys](https://openrouter.ai/keys)), `SANDBOX_TOKEN` and `POSTGRES_PASSWORD`.
Everything else has a sensible default. The agent refuses to start and lists the problems
if anything is missing or malformed.

### 4. Start it

```sh
make up        # build and start (applies SANDBOX_INTERNET from .env)
make logs      # follow logs
make ps        # status
make down      # stop
```

Send your bot `/start`. Health: `curl 127.0.0.1:8080/health`.

`docker compose up -d` works too; `make up` additionally adds
`docker-compose.internet.yml` when `SANDBOX_INTERNET=true`.

## Using it

Just write to it: *"What files are in my workspace?"*, *"Create hello.py that prints hi
and run it"*.

| Command | |
| --- | --- |
| `/start` | Help |
| `/new` | Start a fresh conversation (the old one is archived) |
| `/stop` | Cancel the running task, including a running command |
| `/status` | Running task, model, session age |
| `/model <id>` | Switch model, e.g. `/model deepseek/deepseek-v4.1-flash` |
| `/approvals` | Re-post pending approvals |

Messages sent while a task is running wait their turn. Conversations survive restarts.

### What needs approval

Rules live in [`config/policy.yaml`](config/policy.yaml) (mounted read-only into the agent;
edit it and run `make restart`). Defaults:

- **Allowed without asking:** reading files in `/workspace`; writing and editing files in
  `/workspace`; read-only commands (`ls`, `cat`, `grep`, `rg`, `find`, `git status/log/diff`,
  `jq`, …) on paths inside `/workspace`.
- **Asks you first:** every other command (running programs, installing packages, deleting
  or moving files, redirects that write files), and read-only commands that look outside
  the workspace.
- **Always refused:** writes outside `/workspace`, `rm -rf /`-style commands, fork bombs,
  reading `/proc/*/environ`, reaching the database or agent containers.

Commands are parsed with a real Bash parser: pipelines, `&&`, `;`, subshells and `$(…)` are
split and the strictest decision across all parts wins. Approvals expire after
`APPROVAL_TIMEOUT_SECONDS` (10 minutes by default); the agent is told and doesn't retry.

### The workspace

Files live in the `workspace` Docker volume, mounted at `/workspace` in the sandbox. To copy
files in or out:

```sh
docker compose cp ./notes.txt sandbox:/workspace/
docker compose cp sandbox:/workspace/report.md .
```

## Mac mini notes

- **Docker:** install [OrbStack](https://orbstack.dev) (lighter) or Docker Desktop, and enable
  *Start at login*. The containers use `restart: unless-stopped`, so they come back with Docker.
- **System Settings › Energy:** turn on *Prevent automatic sleeping when the display is off*
  (on some macOS versions: *Battery › Options*, or `sudo pmset -a sleep 0`).
- **System Settings › Energy:** turn on *Start up automatically after a power failure*.
- **System Settings › Users & Groups:** consider automatic login for the account running
  Docker, so it starts after a reboot without you.

## Security model

- Nothing listens for inbound internet traffic. The bot uses long polling; the only
  published port is the health check on `127.0.0.1`.
- Updates from anyone but your user id, and all group chats, are dropped (and logged).
- Three internal networks: the sandbox can reach only the agent (whose HTTP server serves
  `/health` and nothing else); only the agent can reach Postgres; only the agent can reach
  the internet, unless you set `SANDBOX_INTERNET=true`.
- API keys and the Telegram token live only in the agent container. The sandbox gets only
  its own access token, and commands run with a clean environment.
- The Docker socket is never mounted. All custom images run as non-root users, with all
  Linux capabilities dropped and `no-new-privileges`.
- Pi loads no `AGENTS.md`, skills or extensions from the workspace, so a planted file can't
  become instructions.
- Tool output is wrapped as `<tool_output trust="untrusted">`; the system prompt treats it
  as data. Enforcement is in code and `policy.yaml`, not in the prompt.
- Every tool call (allowed, asked, denied) is logged in the `tool_calls` table, with
  approvals in `approvals` and token cost per model call in `usage`.

The default model is cheap, and cheap models are easier to manipulate. Keep approvals strict.

## Development

```sh
pnpm install
pnpm test          # unit tests (policy, chunking, formatting, auth, approvals, sandbox server)
make test-e2e      # end-to-end acceptance suite (starts a throwaway Postgres container)
pnpm typecheck
```

The end-to-end suite runs the real app wiring (grammY long polling, pg-boss, the Pi agent
loop, the policy engine, approvals, the sandbox server) against a fake Telegram Bot API and
Pi's scripted model, so it needs no Telegram account or OpenRouter key.

Layout: `src/telegram` (gateway), `src/orchestrator` (queue), `src/agent` (Pi runtime and
sandbox-backed tools), `src/policy`, `src/approvals`, `src/db`, `sandbox/server.ts`
(exec server), `config/policy.yaml`, `migrations/`.
