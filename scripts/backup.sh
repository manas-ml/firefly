#!/bin/sh
# One backup: pg_dump + tarballs of the sessions, memory and workspace volumes.
# Runs inside the `backup` container (postgres:17-alpine). Writes to /backups/<stamp>.
set -eu
KEEP="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
OUT="/backups/$STAMP"
TMP="$OUT.partial"

mkdir -p "$TMP"
pg_dump --format=custom --file="$TMP/db.dump"
for v in sessions memory workspace; do
  tar -C "/volumes/$v" -czf "$TMP/$v.tgz" .
done
(cd "$TMP" && sha256sum db.dump sessions.tgz memory.tgz workspace.tgz > SHA256SUMS)
mv "$TMP" "$OUT"
echo "backup written: $OUT ($(du -sh "$OUT" | cut -f1))"

# Keep KEEP days of backups; also clear out failed partial runs.
find /backups -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime +"$KEEP" -exec rm -rf {} \;
find /backups -mindepth 1 -maxdepth 1 -type d -name '*.partial' -mmin +120 -exec rm -rf {} \;
