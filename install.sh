#!/usr/bin/env bash
# Firefly installer: checks Docker, generates secrets, walks through .env,
# builds, runs migrations and starts the stack.
#
# Non-interactive: set FIREFLY_TELEGRAM_BOT_TOKEN, FIREFLY_TELEGRAM_USER_ID and
# FIREFLY_OPENROUTER_API_KEY (and optionally FIREFLY_BACKUP_DIR) before running.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

say "Checking prerequisites"
command -v docker >/dev/null || die "Docker isn't installed. Install OrbStack (https://orbstack.dev) or Docker Desktop, then run this again."
docker info >/dev/null 2>&1 || die "Docker isn't running. Start OrbStack or Docker Desktop, then run this again."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (it ships with Docker Desktop and OrbStack)."
command -v openssl >/dev/null || die "openssl is required."
echo "Docker $(docker version --format '{{.Server.Version}}'), Compose $(docker compose version --short 2>/dev/null || echo '?')"

[[ -f .env ]] || cp .env.example .env
chmod 600 .env

get_env() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
set_env() {
  local key="$1" value="$2" updated
  if grep -qE "^$key=" .env; then
    updated="$(awk -v k="$key" -v v="$value" 'BEGIN{FS="="} $1==k {print k "=" v; next} {print}' .env)"
    printf '%s\n' "$updated" > .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}
ask() { # ask KEY "prompt" [secret]
  local key="$1" prompt="$2" secret="${3:-}" value preset="FIREFLY_$1"
  [[ -n "$(get_env "$key")" ]] && return 0
  value="${!preset:-}"
  if [[ -z "$value" ]]; then
    [[ -t 0 ]] || die "$key is not set and there's no terminal to ask. Set FIREFLY_$key."
    if [[ -n "$secret" ]]; then read -r -s -p "$prompt: " value; echo; else read -r -p "$prompt: " value; fi
  fi
  [[ -n "$value" ]] || die "$key is required."
  set_env "$key" "$value"
}
gen() { [[ -n "$(get_env "$1")" ]] || set_env "$1" "$(openssl rand -hex "$2")"; }

say "Configuring .env"
export FIREFLY_TELEGRAM_ALLOWED_USER_IDS="${FIREFLY_TELEGRAM_ALLOWED_USER_IDS:-${FIREFLY_TELEGRAM_USER_ID:-}}"
ask TELEGRAM_BOT_TOKEN "Telegram bot token (from @BotFather)" secret
ask TELEGRAM_ALLOWED_USER_IDS "Your numeric Telegram user id (ask @userinfobot)"
ask OPENROUTER_API_KEY "OpenRouter API key (https://openrouter.ai/keys)" secret
gen SANDBOX_TOKEN 32
gen BROWSER_TOKEN 32
gen DASHBOARD_TOKEN 32
gen POSTGRES_PASSWORD 24
if [[ -z "$(get_env BACKUP_DIR)" || "$(get_env BACKUP_DIR)" == "./backups" ]]; then
  backup_dir="${FIREFLY_BACKUP_DIR:-$PWD/backups}"
  if [[ -z "${FIREFLY_BACKUP_DIR:-}" && -t 0 ]]; then
    read -r -p "Backup folder (e.g. one synced to iCloud, or an external drive) [$backup_dir]: " answer
    backup_dir="${answer:-$backup_dir}"
  fi
  set_env BACKUP_DIR "$backup_dir"
fi
mkdir -p "$(get_env BACKUP_DIR)"

say "Generating secrets"
mkdir -p secrets && chmod 700 secrets
if [[ ! -s secrets/vault_master_key ]]; then
  (umask 022 && openssl rand -hex 32 > secrets/vault_master_key)
  echo "Created secrets/vault_master_key. Back it up somewhere safe (e.g. your password manager):"
  echo "without it the vault can't be decrypted, and backups don't include it."
fi
[[ -f secrets/mac_bridge_token ]] || (umask 022 && : > secrets/mac_bridge_token)

if [[ "${FIREFLY_SKIP_BUILD:-0}" == "1" ]]; then
  say "Using already-built images (FIREFLY_SKIP_BUILD=1)"
else
  say "Building images (a few minutes the first time)"
  make -s build
fi

say "Running database migrations"
docker compose up -d postgres
until docker compose exec -T postgres pg_isready -U firefly -d firefly >/dev/null 2>&1; do sleep 1; done
docker compose run --rm --no-deps agent node dist/db/migrate-cli.js

say "Starting Firefly"
if [[ "${FIREFLY_SKIP_BUILD:-0}" == "1" ]]; then docker compose up -d --no-build --remove-orphans; else make -s up; fi
status=unknown
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q agent)" 2>/dev/null || echo unknown)"
  [[ "$status" == "healthy" ]] && break
  sleep 3
done
[[ "$status" == "healthy" ]] || die "The agent isn't healthy yet ($status). Check: make logs"

port="$(get_env HEALTH_PORT)"
say "Firefly is running"
cat <<MSG
• Send your bot /start on Telegram.
• Dashboard: http://127.0.0.1:${port:-8080}/?token=$(get_env DASHBOARD_TOKEN)
• Nightly backups go to $(get_env BACKUP_DIR) (kept $(get_env BACKUP_KEEP_DAYS | grep . || echo 14) days).
• Keep secrets/vault_master_key safe; you need it to restore vault secrets.
MSG
