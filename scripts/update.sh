#!/usr/bin/env bash
# make update: pull, back up, build, migrate (on start), restart; roll back to
# the previous images if the agent doesn't become healthy.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE=(docker compose)
[[ "${SANDBOX_INTERNET:-}" == "true" ]] && COMPOSE+=(-f docker-compose.yml -f docker-compose.internet.yml)
IMAGES=(agent sandbox browser)
TIMEOUT="${UPDATE_HEALTH_TIMEOUT:-180}"

wait_healthy() {
  local deadline=$((SECONDS + TIMEOUT)) id status
  while ((SECONDS < deadline)); do
    id="$("${COMPOSE[@]}" ps -q agent 2>/dev/null || true)"
    status="$( [[ -n "$id" ]] && docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo none)"
    [[ "$status" == "healthy" ]] && return 0
    sleep 3
  done
  return 1
}

echo "Tagging current images as :previous…"
for i in "${IMAGES[@]}"; do
  docker image inspect "firefly-$i:latest" >/dev/null 2>&1 && docker tag "firefly-$i:latest" "firefly-$i:previous"
done

if [[ "${SKIP_PULL:-0}" != "1" ]]; then
  echo "Pulling…"
  git pull --ff-only
fi

echo "Backing up before the update…"
"${COMPOSE[@]}" run --rm --no-deps --entrypoint /bin/sh backup /scripts/backup.sh || echo "warning: pre-update backup failed"

echo "Building…"
if [[ -n "${UPDATE_BUILD_CMD:-}" ]]; then
  bash -c "$UPDATE_BUILD_CMD" # advanced: a custom build (e.g. a remote builder)
else
  "${COMPOSE[@]}" build
fi
echo "Restarting (migrations run when the agent starts)…"
"${COMPOSE[@]}" up -d --no-build --remove-orphans

if wait_healthy; then
  echo "Update complete: the agent is healthy."
  exit 0
fi

echo "The agent did not become healthy within ${TIMEOUT}s. Rolling back to the previous images…"
for i in "${IMAGES[@]}"; do
  docker image inspect "firefly-$i:previous" >/dev/null 2>&1 && docker tag "firefly-$i:previous" "firefly-$i:latest"
done
"${COMPOSE[@]}" up -d --no-build --remove-orphans
if wait_healthy; then
  echo "Rolled back; the previous version is running. If a migration ran, the pre-update backup is in your backup folder (scripts/restore.sh)."
else
  echo "Rollback did not become healthy either. Check: make logs"
fi
exit 1
