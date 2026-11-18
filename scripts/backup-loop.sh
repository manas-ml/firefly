#!/bin/sh
# Runs scripts/backup.sh once a day at BACKUP_TIME (HH:MM, local TZ).
set -u
AT="${BACKUP_TIME:-03:30}"
echo "nightly backups at $AT ($TZ), keeping ${BACKUP_KEEP_DAYS:-14} days"
last=""
while true; do
  now="$(date +%H:%M)"
  today="$(date +%Y-%m-%d)"
  if [ "$now" = "$AT" ] && [ "$last" != "$today" ]; then
    if /bin/sh /scripts/backup.sh; then last="$today"; else echo "backup failed; will retry in a minute"; fi
  fi
  sleep 30
done
