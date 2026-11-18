#!/usr/bin/env bash
# Restore a backup folder (from scripts/backup.sh) into this machine's stack:
# database, sessions, memory and workspace. Works on a fresh machine too.
#   scripts/restore.sh /path/to/backups/2026-11-18_033000
# Needs the same secrets/vault_master_key as the original machine for vault secrets.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:?usage: scripts/restore.sh <backup-folder>}"
SRC="$(cd "$SRC" && pwd)"
PROJECT="${COMPOSE_PROJECT_NAME:-firefly}"
COMPOSE=(docker compose)

for f in db.dump sessions.tgz memory.tgz workspace.tgz SHA256SUMS; do
  [[ -f "$SRC/$f" ]] || { echo "missing $SRC/$f"; exit 1; }
done
echo "Verifying checksums…"
docker run --rm -v "$SRC:/b:ro" -w /b alpine:3 sha256sum -c SHA256SUMS >/dev/null

echo "Stopping the agent…"
"${COMPOSE[@]}" stop agent backup >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d postgres
until "${COMPOSE[@]}" exec -T postgres pg_isready -U firefly -d firefly >/dev/null 2>&1; do sleep 1; done

for v in sessions memory workspace; do
  echo "Restoring volume $v…"
  docker volume create "${PROJECT}_${v}" >/dev/null
  docker run --rm -v "${PROJECT}_${v}:/target" -v "$SRC:/b:ro" alpine:3 \
    sh -c 'find /target -mindepth 1 -delete && tar -C /target -xzf "/b/$0.tgz"' "$v"
done

echo "Restoring the database…"
"${COMPOSE[@]}" exec -T postgres psql -U firefly -d firefly -q -c 'DROP SCHEMA IF EXISTS pgboss CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
"${COMPOSE[@]}" exec -T postgres pg_restore --no-owner -U firefly -d firefly < "$SRC/db.dump"

echo "Starting the stack…"
"${COMPOSE[@]}" up -d
echo "Restored from $SRC."
