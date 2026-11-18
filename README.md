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

### 1. Connect Telegram to the Mac mini

Telegram needs no port forwarding, no public address and no webhook. The agent on the Mac
mini makes an outbound connection to Telegram and asks it for new messages (long polling),
so it works behind any home router. You only need the bot's token and your own user id.

**a. Create the bot (on your phone or any Telegram app)**

1. Open a chat with **@BotFather** (the verified one with the blue check).
2. Send `/newbot`.
3. Give it a display name (e.g. `My Agent`), then a username ending in `bot`
   (e.g. `my_firefly_agent_bot`). It must be unique across Telegram.
4. BotFather replies with a token that looks like `123456789:AAH…`. Copy it. **Treat it like
   a password**: anyone with it can control the bot. If it leaks, send BotFather `/revoke`.
5. Optional but recommended: send BotFather `/setprivacy`, choose your bot, then **Enable**.
   Firefly ignores group chats anyway; this is just a second layer.

**b. Find your numeric Telegram user id**

Message **@userinfobot** and copy the number after `Id:` (for example `123456789`). This is
not your username. Firefly drops every message that isn't from this id (and all group
chats), silently, and logs the attempt. To allow a second person, comma-separate ids:
`TELEGRAM_ALLOWED_USER_IDS=111111111,222222222`.

**c. Put them on the Mac mini**

`./install.sh` (step 2) asks for the token and the id and writes them to `.env`. To do it by
hand, edit `.env` on the Mac mini:

```sh
TELEGRAM_BOT_TOKEN=123456789:AAH...
TELEGRAM_ALLOWED_USER_IDS=123456789
```

Keep `.env` private (`chmod 600 .env`; it's already git-ignored). Never paste the token into
a chat with the agent: tokens and passwords go in the vault (`/vault add`) or `.env`.

**d. Check the connection**

After the stack is up (step 2):

1. Open your bot in Telegram (the link BotFather gave you, `t.me/<username>`), press **Start**
   or send `/start`. It should reply with its help text within a few seconds.
2. Send `What files are in my workspace?`. You should see a "⏳ Working…" status message and
   then an answer.
3. On the Mac mini, `curl 127.0.0.1:8080/health` should print `"telegram":true`.

**If it doesn't reply**

| Symptom | Likely cause and fix |
| --- | --- |
| No reply at all, and logs (`make logs`) show `dropped update from unauthorized sender` | The id in `TELEGRAM_ALLOWED_USER_IDS` isn't yours. Fix `.env` and run `make restart`. |
| The agent won't start and `make logs` shows `Invalid configuration` | A value in `.env` is missing or malformed (the message names it). The token must look like `123456789:AA…`. |
| Logs show `telegram polling stopped` with `401` / `Unauthorized` | The token is wrong or was revoked. Get a fresh one from BotFather (`/token`) and `make restart`. |
| Logs show `telegram polling stopped` with `409` / `Conflict` ("terminated by other getUpdates request") | Another copy is polling with the same token (an old container, or your laptop). Stop it. Only one process can poll a bot. |
| `"telegram":false` in `/health`, or connection timeouts | The Mac mini can't reach `api.telegram.org`. Check its internet, DNS, VPN or firewall (outbound HTTPS to Telegram only). |
| Replies are slow or missing after a power cut or reboot | Docker isn't running yet: see *Mac mini notes* below to start it at login. |

Telegram also needs the Mac mini awake and online. Without the sleep settings in *Mac mini
notes*, the bot goes quiet when the Mac sleeps, and catches up on its messages when it wakes.

**Using it away from home:** nothing to configure. Telegram is the connection, so the bot
answers from anywhere your phone has Telegram. The dashboard stays on the Mac
(`127.0.0.1`); use `/pause`, `/status`, approvals and `/health` in Telegram instead.

### 2. Install

Install [OrbStack](https://orbstack.dev) (lighter) or Docker Desktop, then:

```sh
./install.sh
```

It checks Docker, asks for the bot token, your user id and your OpenRouter key
([openrouter.ai/keys](https://openrouter.ai/keys)), and asks where nightly backups should go.
It generates every other secret (`SANDBOX_TOKEN`, `BROWSER_TOKEN`, `DASHBOARD_TOKEN`,
`POSTGRES_PASSWORD` in `.env`, and the vault master key in `secrets/`), builds the images,
runs migrations, starts the stack, and prints the dashboard link.

**Back up `secrets/vault_master_key` somewhere safe** (a password manager). Backups don't
include it, and without it the vault can't be decrypted.

### 3. Day to day

```sh
make logs        # follow logs
make ps          # status
make restart     # after editing config/policy.yaml or config/mcp.yaml
make dashboard   # print the dashboard link
make backup      # back up now (also runs nightly)
make update      # pull, back up, build, restart; rolls back if the agent isn't healthy
make down        # stop
```

Send your bot `/start`. `make up` adds `docker-compose.internet.yml` when
`SANDBOX_INTERNET=true`; plain `docker compose up -d` keeps the sandbox offline.

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
| `/pause`, `/resume` | Stop / restart new tasks and routines (a running task finishes) |
| `/health` | Uptime, spend, failed tasks, disk usage (also sent weekly) |
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

### Dashboard and menu bar

`make dashboard` prints `http://127.0.0.1:8080/?token=…`. Open it once and a cookie takes
over. It shows tasks, the tool-call audit log, approvals (you can approve or deny there),
usage over the last 30 days, schedules (on/off), memory, and a global pause switch. It's
served only on 127.0.0.1, and everything except `/health` needs the token.

An optional menu bar app lives in [`macos/FireflyMenu`](macos/FireflyMenu/README.md): a
status dot, pending approvals, pause/resume, open dashboard.

### Backups, restore, update

- **Nightly** (`BACKUP_TIME`, default 03:30): a `pg_dump` plus tarballs of the sessions,
  memory and workspace volumes, with checksums, in `BACKUP_DIR`, kept `BACKUP_KEEP_DAYS`
  (14) days. Point `BACKUP_DIR` at a folder synced to iCloud or on an external drive.
- **Restore** (same or another machine): copy the repo, `.env` and
  `secrets/vault_master_key`, then `make restore DIR=<backup folder>`. Conversations,
  memory, routines, the vault and the workspace come back.
- **Update**: `make update` tags the running images `:previous`, pulls, backs up, builds and
  restarts. If the agent isn't healthy within 3 minutes, it switches back to `:previous`.
  Migrations are forward-only; if one ran before a rollback, restore the pre-update backup.

### Mac apps (built, but off)

`bridge/` is a tiny launchd service for the Mac itself. It listens on 127.0.0.1 with a
token, and its only action is `shortcuts run <name>` for shortcuts in a Shortcuts folder
named **Agent** that are also on its allowlist. There's no AppleScript and no shell. It
ships with an empty allowlist, so it rejects every call. To turn it on:

```sh
bridge/install.sh            # on the Mac: installs the launchd agent, makes a token
# add names to ~/Library/Application Support/Firefly/config.json, e.g.
#   { "allowlist": ["Turn on desk lamp"] }
# in .env: MAC_BRIDGE_URL=http://host.docker.internal:7072, then
make restart
```

Every shortcut the agent runs still asks you on Telegram first.

## Mac mini notes

(Telegram setup is in *Setup › 1* above; the Mac only needs to stay awake and online.)

- **Docker:** install [OrbStack](https://orbstack.dev) (lighter) or Docker Desktop, and enable
  *Start at login*. The containers use `restart: unless-stopped`, so they come back with Docker.
- **System Settings › Energy:** turn on *Prevent automatic sleeping when the display is off*
  (on some macOS versions: *Battery › Options*, or `sudo pmset -a sleep 0`).
- **System Settings › Energy:** turn on *Start up automatically after a power failure*.
- **System Settings › Users & Groups:** consider automatic login for the account running
  Docker, so it starts after a reboot without you. Until Docker is up after a reboot, the
  bot can't answer; Telegram holds your messages (for up to 24 hours) and the agent picks
  them up when it connects.
- **Firewall / network:** only outbound HTTPS is needed (Telegram, OpenRouter). Don't open
  or forward any inbound port; nothing listens for the internet.
- **Check after a reboot:** `docker compose ps` (or `make ps`) shows all services, and
  `curl 127.0.0.1:8080/health` should say `"ok":true`.

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
- The dashboard and its API are on 127.0.0.1 and need `DASHBOARD_TOKEN` (the sandbox can
  reach the port internally, so the token is required); changes also need an `x-firefly`
  header, which a cross-site form can't send.
- Every tool call (allowed, asked, denied) is logged in the `tool_calls` table, with
  approvals in `approvals` and token cost per model call in `usage`.

The default model is cheap, and cheap models are easier to manipulate. Keep approvals strict.

## Development

```sh
pnpm install
pnpm test          # unit tests (policy, chunking, formatting, auth, approvals, sandbox, bridge, vault…)
make test-e2e      # acceptance suites for all four phases (starts a throwaway Postgres container)
pnpm typecheck
```

The end-to-end suite runs the real app wiring (grammY long polling, pg-boss, the Pi agent
loop, the policy engine, approvals, the sandbox server) against a fake Telegram Bot API and
Pi's scripted model, so it needs no Telegram account or OpenRouter key.

Layout: `src/telegram` (gateway and commands), `src/orchestrator` (queue), `src/agent` (Pi
runtime and tool guard), `src/policy`, `src/approvals`, `src/scheduler`, `src/memory`,
`src/budget`, `src/browser`, `src/vault`, `src/mcp`, `src/control` (pause, health report),
`src/http` (health and dashboard API), `dashboard/` (React page), `sandbox/server.ts`,
`browser/server.ts`, `bridge/` (Mac host bridge), `scripts/` (backup, restore, update),
`config/`, `migrations/`.
