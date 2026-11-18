# Firefly

A self-hosted personal agent for a Mac mini, controlled from Telegram. It runs the
[Pi](https://github.com/badlogic/pi-mono) agent with an OpenRouter model, executes shell
and file tasks inside an isolated sandbox container, and asks you on Telegram before
anything risky.

See [PLAN.md](PLAN.md) for the design, the review of the build plan, and the deviations
from it, phase by phase.

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
| `/schedules` | Routines, with on/off and run-now buttons |
| `/run <name>` | Run a routine now |
| `/memory [topic]` | What I remember (profile, or one topic) |
| `/forget <topic>` | Delete a memory topic |
| `/usage` | Spend today, this month, top 5 tasks |
| `/tasks` | Recent tasks and their status |
| `/raise [usd]` | Lift this month's budget cap (default: one more monthly budget) |

Messages sent while a task is running wait their turn. Conversations survive restarts.

### Routines

Ask for something on a schedule: *"Every weekday at 8am, summarise the files changed in
/workspace yesterday"*. The agent proposes a routine and you approve it; the approval shows
the schedule in plain words ("At 08:00, Monday through Friday (America/Toronto)"). Each run
uses a fresh session, so routines don't clutter your chat, and its result is sent to you.
A routine that finds nothing worth reporting stays silent. Approvals a routine needs wait
for you (12 hours by default) without blocking the chat.

### Memory

Say *"remember that I prefer metric units"*. Facts are stored as Markdown in the `memory`
volume (`profile.md`, plus one file per topic) and indexed in Postgres. The profile is in
every conversation; other topics are looked up when needed. Memory is only written from
your own messages: the agent can't save anything during a routine, or after it has read a
file, command output, web page or email in the same task.

### Browser

A Chromium container with its own persistent profile does the web browsing (the sandbox
still has no internet). The agent reads pages as an accessibility tree, clicks and types by
element reference, and can send you screenshots. Opening and reading pages runs without
asking; clicking a submit button or anything labelled buy, send, post, reply, delete, sign
in and so on asks first, with a screenshot of the page attached. Domain allow- and
blocklists are in `policy.yaml` (`browser:`); the browser never loads private or loopback
addresses, so a web page can't reach the agent, the database or your LAN.

### Vault

```
/vault add github     → then send the token as the next message; the bot deletes it
/vault list
/vault rm github
```

Secrets are encrypted with libsodium (secretbox) in Postgres. The master key is
`secrets/vault_master_key`, created by `make up` (or `make secrets`) and mounted as a
Docker secret. It's never in `.env` and never in the sandbox or browser. **Back that file up
separately**: without it, the vault can't be decrypted. The agent refers to secrets by name
(*"log in with vault:github"*) and uses `vault_fill`, which types the value into a browser
field or passes it as an environment variable to one sandbox command. It always asks first.
Any secret value that shows up in tool output is replaced with `[vault:name]` before it
reaches the model, the logs, the session files or Telegram.

### Connected apps (MCP and Composio)

Servers are listed in [`config/mcp.yaml`](config/mcp.yaml); nothing else is loaded. Tag each
tool `read` (runs without asking) or `write` (asks); untagged tools ask. For Gmail, Calendar
and Notion, create a Composio MCP server, add its URL to `mcp.yaml`, and store the API key
with `/vault add composio` (headers can say `vault:composio`). Then `make restart`.

**Taint rule:** once a task has read a web page, an email, a document or command output,
every write in that task asks, including file writes that are normally allowed.

### Spending limits

`MONTHLY_BUDGET_USD` and `TASK_BUDGET_USD` are checked before every model call. You get a
warning at 80% and a hard stop at 100%. `MAX_TURNS_PER_TASK` (default 40) stops runaway
loops. Transient OpenRouter errors are retried with exponential backoff.

### What needs approval

Rules live in [`config/policy.yaml`](config/policy.yaml) (mounted read-only into the agent;
edit it and run `make restart`). Defaults:

- **Allowed without asking:** reading files in `/workspace`; writing and editing files in
  `/workspace`; read-only commands (`ls`, `cat`, `grep`, `rg`, `find`, `git status/log/diff`,
  `jq`, …) on paths inside `/workspace`.
- **Asks you first:** every other command (running programs, installing packages, deleting
  or moving files, redirects that write files), and read-only commands that look outside
  the workspace.
- **Taint rule:** once a task has read files, command output, web pages or email, writes
  and edits ask too, even inside `/workspace`.
- **Routines:** creating or deleting one always asks.
- **Browser:** reading is allowed; submit, buy, send, post and similar ask, with a screenshot.
- **Apps:** MCP tools tagged `write`, or untagged, ask. `vault_fill` always asks.
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
- Internal networks: the sandbox can reach only the agent (whose HTTP server serves
  `/health` and nothing else); only the agent can reach Postgres; the browser has its own
  internet access and refuses private addresses; the sandbox has none unless you set
  `SANDBOX_INTERNET=true`.
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
