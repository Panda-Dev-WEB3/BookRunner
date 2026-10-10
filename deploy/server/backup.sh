#!/usr/bin/env bash
# Bookrunner backup: Postgres (pg_dump -Fc of bookrunner_<network>), Redis (BGSAVE snapshot), the state tree
# .data/<network> (mock venue snapshot, ops keys, sagas; logs excluded) and contracts/deployments/*.json.
# Keeps 14 daily + 8 weekly sets; optional off-site copy (rsync over ssh and/or rclone). Records the outcome
# in Redis (bkrn:backup:last) so services/alerts reports a missing, stale or failed backup.
#
# Runs as ROOT from the root-owned deploy copy only (HARDENING.md), via bookrunner-backup.timer (daily):
#   sudo systemctl start bookrunner-backup.service            # one run now
#   sudo /usr/local/lib/bookrunner-deploy/backup.sh --verify  # restore drill of the newest set into
#                                                             # scratch copies (live data untouched)
#   sudo /usr/local/lib/bookrunner-deploy/backup.sh --list    # sets on disk
# It only READS the bookrunner-owned app tree (tar without following symlinks), never executes from it.
#
# Settings (optional) in /etc/bookrunner/backup.env (root:root 0600; the unit's EnvironmentFile):
#   BACKUP_NETWORK=testnet            # bookrunner_<network> DB, .data/<network>
#   BACKUP_DIR=/var/backups/bookrunner
#   BACKUP_KEEP_DAILY=14  BACKUP_KEEP_WEEKLY=8
#   BACKUP_REDIS_DB=1                 # db index the stack uses (status key); testnet 1, otherwise 0
#   BACKUP_RSYNC_TARGET=backup@host:/srv/bookrunner/   BACKUP_RSYNC_SSH_KEY=/root/.ssh/bookrunner_backup
#   BACKUP_RCLONE_REMOTE=crypt-remote:bookrunner       BACKUP_RCLONE_CONFIG=/root/.config/rclone/rclone.conf
# The sets contain secret material (.data/<network>/keys): local copies are root-only (0700/0600); use an
# encrypted off-site target (rclone crypt, or an encrypted volume behind the rsync host).
set -euo pipefail
umask 077

DEPLOY=/usr/local/lib/bookrunner-deploy
APP="${BACKUP_APP_DIR:-/opt/bookrunner/app}"
NETWORK="${BACKUP_NETWORK:-testnet}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/bookrunner}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-14}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-8}"
PG_CONTAINER="${BACKUP_PG_CONTAINER:-bookrunner-postgres-1}"
REDIS_CONTAINER="${BACKUP_REDIS_CONTAINER:-bookrunner-redis-1}"
REDIS_IMAGE="${BACKUP_REDIS_IMAGE:-redis:7-alpine}"
COMPOSE_NETWORK="${BACKUP_COMPOSE_NETWORK:-bookrunner_default}"
DB="bookrunner_${NETWORK}"
if [ -z "${BACKUP_REDIS_DB:-}" ]; then
  if [ "$NETWORK" = testnet ]; then BACKUP_REDIS_DB=1; else BACKUP_REDIS_DB=0; fi
fi
STATUS_KEY="bkrn:backup:last"
LOCK="${BACKUP_LOCK:-/run/bookrunner-backup.lock}"

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
case "$NETWORK" in *[!a-z0-9_]*|"") echo "!! BACKUP_NETWORK must be [a-z0-9_]: $NETWORK" >&2; exit 1 ;; esac
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
if [ "${BACKUP_ALLOW_ANY_PATH:-0}" != 1 ]; then
  [ "$(dirname "$SELF")" = "$DEPLOY" ] || { echo "!! run the root-owned copy: sudo $DEPLOY/backup.sh $*" >&2; exit 1; }
  [ "$(stat -c %u "$DEPLOY")" = 0 ] && [ "$(stat -c %u "$SELF")" = 0 ] || { echo "!! $DEPLOY is not owned by root: refusing" >&2; exit 1; }
fi

# infra passwords (root-only file): Redis needs auth; Postgres is reached through `docker exec` (local socket)
if [ -z "${REDIS_PASSWORD:-}" ] && [ -f "$DEPLOY/.env.infra" ]; then
  REDIS_PASSWORD="$(sed -n 's/^REDIS_PASSWORD=//p' "$DEPLOY/.env.infra" | head -1)"
fi
# only when set: an empty REDISCLI_AUTH would make redis-cli send AUTH "" to a password-less Redis
if [ -n "${REDIS_PASSWORD:-}" ]; then export REDISCLI_AUTH="$REDIS_PASSWORD"; fi

log() { echo "$(date -u +%FT%TZ) $*"; }
# redis-cli inside the redis container; the password travels as an env var, never on a command line
rcli() { docker exec -e REDISCLI_AUTH "$REDIS_CONTAINER" redis-cli --no-auth-warning "$@"; }
psql_live() { docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -qAt -U bookrunner "$@"; }

record_status() { # ok(true|false) error dir bytes offsite
  local json
  json="$(printf '{"v":1,"ts":%s,"ok":%s,"network":"%s","dir":"%s","bytes":%s,"offsite":"%s","error":"%s"}' \
    "$(date +%s%3N)" "$1" "$NETWORK" "$3" "${4:-0}" "${5:-off}" "$(printf '%s' "$2" | tr -d '"\\\n' | cut -c1-200)")"
  rcli -n "$BACKUP_REDIS_DB" SET "$STATUS_KEY" "$json" >/dev/null 2>&1 || log "!! could not record the backup status in Redis"
}

list_sets() {
  for kind in daily weekly; do
    echo "$kind:"
    if [ -d "$BACKUP_DIR/$kind" ]; then
      find "$BACKUP_DIR/$kind" -mindepth 1 -maxdepth 1 -type d ! -name '*.partial' -printf '%f\n' | sort | while read -r s; do
        printf '  %s  %s\n' "$s" "$(du -sh "$BACKUP_DIR/$kind/$s" | cut -f1)"
      done
    fi
  done
}

newest_set() {
  find "$BACKUP_DIR/daily" -mindepth 1 -maxdepth 1 -type d ! -name '*.partial' -printf '%f\n' 2>/dev/null | sort | tail -1
}

# ------------------------------------------------------------------ restore drill (non-destructive)
verify_set() {
  local set="${1:-}"
  [ -n "$set" ] || set="$BACKUP_DIR/daily/$(newest_set)"
  [ -d "$set" ] || { echo "!! no backup set at $set" >&2; exit 1; }
  log "==> restore drill of $set (scratch DB + scratch Redis; live data untouched)"
  ( cd "$set" && sha256sum --quiet -c SHA256SUMS ) || { echo "!! checksum mismatch in $set" >&2; exit 1; }
  log "    checksums ok"
  tar -tzf "$set/state.tar.gz" >/dev/null
  log "    state.tar.gz readable ($(tar -tzf "$set/state.tar.gz" | wc -l) entries)"

  local scratch=bookrunner_restore_check
  psql_live -d postgres -c "DROP DATABASE IF EXISTS $scratch" -c "CREATE DATABASE $scratch"
  psql_live -d "$scratch" -c "CREATE EXTENSION IF NOT EXISTS timescaledb" -c "SELECT timescaledb_pre_restore()" >/dev/null
  local rc=0
  # restore from a file inside the container (seekable: pg_restore may need blocks out of archive order)
  docker cp "$set/postgres.dump" "$PG_CONTAINER:/tmp/restore-check.dump"
  docker exec "$PG_CONTAINER" pg_restore -U bookrunner -d "$scratch" --no-owner /tmp/restore-check.dump 2> "$set/.restore-check.log" || rc=$?
  docker exec "$PG_CONTAINER" rm -f /tmp/restore-check.dump
  psql_live -d "$scratch" -c "SELECT timescaledb_post_restore()" >/dev/null
  [ "$rc" = 0 ] || log "    pg_restore reported errors (exit $rc), see $set/.restore-check.log"
  local t live restored
  for t in books marks settlements kill_events events limits quotes receipts chain_cursor; do
    restored="$(psql_live -d "$scratch" -c "SELECT count(*) FROM $t" 2>/dev/null || echo "MISSING")"
    live="$(psql_live -d "$DB" -c "SELECT count(*) FROM $t" 2>/dev/null || echo "?")"
    printf '    %-12s restored %-10s live now %s\n' "$t" "$restored" "$live"
    [ "$restored" != MISSING ] || { psql_live -d postgres -c "DROP DATABASE IF EXISTS $scratch"; echo "!! table $t missing from the restored DB" >&2; exit 1; }
  done
  psql_live -d postgres -c "DROP DATABASE IF EXISTS $scratch"
  log "    postgres: restored into $scratch and dropped"

  # a throwaway Redis (no network, no AOF) loads the snapshot; the RDB is copied in (no host mount)
  local name=bookrunner-redis-restore-check
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker create --name "$name" --network none "$REDIS_IMAGE" redis-server --appendonly no --dir /data --dbfilename dump.rdb >/dev/null
  docker cp "$set/redis.rdb" "$name:/data/dump.rdb"
  docker start "$name" >/dev/null
  local keys="" i
  for i in $(seq 1 30); do
    keys="$(docker exec "$name" redis-cli -n "$BACKUP_REDIS_DB" DBSIZE 2>/dev/null || true)"
    [ -n "$keys" ] && [ "$(docker exec "$name" redis-cli INFO persistence 2>/dev/null | sed -n 's/^loading:\([0-9]\).*/\1/p')" = 0 ] && break
    sleep 1
  done
  docker rm -f "$name" >/dev/null
  [ -n "$keys" ] || { echo "!! the Redis snapshot did not load" >&2; exit 1; }
  log "    redis: snapshot loads, db $BACKUP_REDIS_DB has $keys keys (live now: $(rcli -n "$BACKUP_REDIS_DB" DBSIZE))"
  log "==> restore drill OK"
}

case "${1:-}" in
  --list) list_sets; exit 0 ;;
  --verify) exec 9>"$LOCK"; flock -n 9 || { echo "!! a backup is running" >&2; exit 1; }; verify_set "${2:-}"; exit 0 ;;
  "") ;;
  *) echo "usage: $0 [--list | --verify [SET_DIR]]" >&2; exit 2 ;;
esac

# ------------------------------------------------------------------ backup
exec 9>"$LOCK"
flock -n 9 || { echo "!! another backup is running" >&2; exit 1; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$BACKUP_DIR" "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"
# leftovers of an interrupted run
find "$BACKUP_DIR/daily" -mindepth 1 -maxdepth 1 -type d -name '*.partial' -mmin +60 -exec rm -rf {} +
OUT="$BACKUP_DIR/daily/$STAMP"
WORK="$OUT.partial"
rm -rf "$WORK"
mkdir -m 0700 "$WORK"

on_error() {
  local line="$1"
  log "!! backup FAILED (line $line)"
  rm -rf "$WORK"
  record_status false "backup.sh failed at line $line" "$OUT" 0 off
}
trap 'on_error $LINENO' ERR

# room for the new set: at least twice the previous one (or 1 GiB on the first run)
prev="$(newest_set)"
need_kb=1048576
[ -z "$prev" ] || need_kb=$(( $(du -sk "$BACKUP_DIR/daily/$prev" | cut -f1) * 2 ))
free_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
if [ "$free_kb" -lt "$need_kb" ]; then
  log "!! only $((free_kb / 1024)) MiB free in $BACKUP_DIR, need $((need_kb / 1024)) MiB"
  false
fi

log "==> postgres: pg_dump -Fc $DB"
docker exec "$PG_CONTAINER" pg_dump -U bookrunner -Fc -d "$DB" > "$WORK/postgres.dump"
# the archive must list cleanly (truncated / corrupt dumps fail here, not on the day of the restore)
docker exec -i "$PG_CONTAINER" pg_restore -l < "$WORK/postgres.dump" > /dev/null

log "==> redis: BGSAVE"
before="$(rcli LASTSAVE)"
for _ in $(seq 1 60); do rcli BGSAVE >/dev/null 2>&1 && break; sleep 2; done # "already in progress": wait for it
for _ in $(seq 1 300); do
  [ "$(rcli LASTSAVE)" != "$before" ] && break
  sleep 1
done
[ "$(rcli LASTSAVE)" != "$before" ] || { log "!! BGSAVE did not complete in 300 s"; false; }
[ "$(rcli INFO persistence | sed -n 's/^rdb_last_bgsave_status:\([a-z]*\).*/\1/p')" = ok ] || { log "!! BGSAVE failed"; false; }
docker cp "$REDIS_CONTAINER:/data/dump.rdb" "$WORK/redis.rdb"

log "==> state: $APP/.data/$NETWORK (logs excluded) + contracts/deployments/*.json"
# tar never follows symlinks: a link planted in the app tree cannot pull a root-only file into the set
tar -C "$APP" -czf "$WORK/state.tar.gz" \
  --exclude="./.data/$NETWORK/dev.log*" --exclude='*.log' --exclude='*.log.*' \
  "./.data/$NETWORK" $(cd "$APP" && find ./contracts/deployments -maxdepth 1 -type f -name '*.json' 2>/dev/null)

{
  echo "created=$STAMP"
  echo "network=$NETWORK"
  echo "database=$DB"
  echo "redis_db=$BACKUP_REDIS_DB"
  echo "app_commit=$(git -C "$APP" -c safe.directory="$APP" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "postgres_image=$(docker inspect -f '{{.Config.Image}}' "$PG_CONTAINER" 2>/dev/null || echo unknown)"
  echo "redis_image=$(docker inspect -f '{{.Config.Image}}' "$REDIS_CONTAINER" 2>/dev/null || echo unknown)"
} > "$WORK/MANIFEST"
( cd "$WORK" && sha256sum postgres.dump redis.rdb state.tar.gz MANIFEST > SHA256SUMS )
chmod 0600 "$WORK"/*
mv "$WORK" "$OUT"
BYTES="$(du -sb "$OUT" | cut -f1)"
log "==> set $OUT ($(du -sh "$OUT" | cut -f1))"

# weekly: Sundays (UTC), or when the newest weekly set is a week old; hard links, no extra space
newest_weekly="$(find "$BACKUP_DIR/weekly" -mindepth 1 -maxdepth 1 -type d -mtime -6 | head -1)"
if [ "$(date -u +%u)" = 7 ] || [ -z "$newest_weekly" ]; then
  cp -al "$OUT" "$BACKUP_DIR/weekly/$STAMP"
  log "==> weekly set $BACKUP_DIR/weekly/$STAMP"
fi

# retention (names sort by time)
prune() { # dir keep
  find "$1" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | head -n "-$2" | while read -r old; do
    rm -rf -- "${1:?}/$old"
    log "    pruned $1/$old"
  done
}
prune "$BACKUP_DIR/daily" "$KEEP_DAILY"
prune "$BACKUP_DIR/weekly" "$KEEP_WEEKLY"

# off-site (optional): a failure is reported but keeps the local set
trap - ERR
OFFSITE=off
if [ -n "${BACKUP_RSYNC_TARGET:-}" ]; then
  OFFSITE=ok
  ssh_cmd="ssh -o BatchMode=yes -o StrictHostKeyChecking=yes${BACKUP_RSYNC_SSH_KEY:+ -i $BACKUP_RSYNC_SSH_KEY}"
  if rsync -a --delete -e "$ssh_cmd" "$BACKUP_DIR/" "$BACKUP_RSYNC_TARGET"; then log "==> off-site: rsync -> $BACKUP_RSYNC_TARGET"; else OFFSITE=failed; log "!! off-site rsync FAILED"; fi
fi
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  [ "$OFFSITE" = failed ] || OFFSITE=ok
  if rclone ${BACKUP_RCLONE_CONFIG:+--config "$BACKUP_RCLONE_CONFIG"} sync "$BACKUP_DIR" "$BACKUP_RCLONE_REMOTE"; then log "==> off-site: rclone -> $BACKUP_RCLONE_REMOTE"; else OFFSITE=failed; log "!! off-site rclone FAILED"; fi
fi

record_status true "" "$OUT" "$BYTES" "$OFFSITE"
log "==> backup done ($OFFSITE off-site)"
[ "$OFFSITE" != failed ]
