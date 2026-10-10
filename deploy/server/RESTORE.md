# Backups and restore

`backup.sh` (root-owned copy in `/usr/local/lib/bookrunner-deploy`, run daily by `bookrunner-backup.timer`)
writes one **set** per run to `/var/backups/bookrunner/daily/<UTC stamp>/` and hard-links it into
`weekly/` on Sundays (or when the newest weekly set is a week old). Retention: 14 daily, 8 weekly.

| File | What | How |
|---|---|---|
| `postgres.dump` | `bookrunner_<network>` (Timescale hypertables and compressed chunks included) | `pg_dump -Fc`, checked with `pg_restore -l` |
| `redis.rdb` | every Redis db (risk journals, signed venue reports, oracle bundle, queues, alert state) | `BGSAVE` then `docker cp` of `dump.rdb` |
| `state.tar.gz` | `.data/<network>/` (mock venue snapshot, **ops keys**, sagas; logs left out) and `contracts/deployments/*.json` | `tar` (symlinks are stored as links, never followed) |
| `MANIFEST`, `SHA256SUMS` | app commit, image references, checksums | |

**Not in the sets:** `.env.<network>` (mnemonic, `ORACLE_SEED`, API keys) and `.env.infra`. Keep a copy of
`.env.<network>` offline (password manager / sealed storage): without it a restored stack cannot sign. A new
host generates a new `.env.infra`.

The sets contain secret material (`.data/<network>/keys`). Locally they are root-only (0700 / 0600). Off-site
(`BACKUP_RSYNC_TARGET` or `BACKUP_RCLONE_REMOTE` in `/etc/bookrunner/backup.env`) must be encrypted at rest:
an rclone `crypt` remote, or an encrypted volume on the rsync host.

Every run records its outcome in Redis (`bkrn:backup:last`). `services/alerts` alerts when no backup is
recorded, the last success is older than 26 h, a run failed, or the off-site copy failed.

## Routine

```bash
sudo systemctl list-timers bookrunner-backup.timer        # next / last run
sudo systemctl start bookrunner-backup.service            # one run now (about 1 min)
sudo journalctl -u bookrunner-backup -n 30 --no-pager
sudo /usr/local/lib/bookrunner-deploy/backup.sh --list
sudo /usr/local/lib/bookrunner-deploy/backup.sh --verify  # restore drill of the newest set (monthly)
```

`--verify` is non-destructive: it checks the checksums and the tar, restores `postgres.dump` into a scratch
database `bookrunner_restore_check` (Timescale pre/post restore), compares row counts of the main tables with
the live database, drops the scratch database, loads `redis.rdb` into a throwaway Redis container without
network and compares the key count. Live data is never touched. Expected output ends with
`==> restore drill OK`.

## Restore (same host, or a new host after install)

Tested end to end (2026-10-10) with these exact commands against the pinned Timescale image and
`redis:7-alpine`: a set taken, the live data then altered (rows deleted and added, Redis keys deleted and added,
a state file changed), restored with steps 3–5, and checked: row counts and the compressed hypertable chunk
back, writes accepted, Redis keys back and still there after a Redis restart (AOF rewritten), state files
back. The same set also passed `backup.sh --verify`.

Run every step in a root shell (`sudo -i`). Downtime: from step 1 to step 6.

### 0. Choose the set and set the variables

```bash
ls /var/backups/bookrunner/daily /var/backups/bookrunner/weekly
S=/var/backups/bookrunner/daily/20261010T031700Z   # the set to restore
NET=testnet; DB=bookrunner_$NET; RDB=1            # mainnet: NET=mainnet, RDB = the db index in its REDIS_URL
PG=bookrunner-postgres-1; RD=bookrunner-redis-1; DNET=bookrunner_default
APP=/opt/bookrunner/app
STAMP=$(date -u +%Y%m%d%H%M)
export REDISCLI_AUTH="$(sed -n 's/^REDIS_PASSWORD=//p' /usr/local/lib/bookrunner-deploy/.env.infra)"
```

On a **new host**: install as in [README.md](README.md) (user, clone, `bun install`, root clone, `install.sh`),
put `.env.<network>` back (mode 600, owner `bookrunner`), then `systemctl start bookrunner-infra` and continue
with step 2. Skip the `RENAME` in step 3 (there is no old database).

### 1. Stop the stack and the timer

```bash
systemctl stop bookrunner bookrunner-backup.timer
systemctl is-active bookrunner-infra                      # active: Postgres + Redis stay up
```

### 2. Check the set

```bash
( cd "$S" && sha256sum -c SHA256SUMS )
cat "$S/MANIFEST"                                       # postgres_image must be the digest in docker-compose.yml
/usr/local/lib/bookrunner-deploy/backup.sh --verify "$S"  # optional: full non-destructive drill first
```

### 3. Postgres

The current database is kept under another name until the restore is confirmed (step 7).

```bash
docker exec $PG psql -v ON_ERROR_STOP=1 -U bookrunner -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid()"
docker exec $PG psql -v ON_ERROR_STOP=1 -U bookrunner -d postgres -c "ALTER DATABASE $DB RENAME TO ${DB}_pre_restore_$STAMP"
docker exec $PG psql -v ON_ERROR_STOP=1 -U bookrunner -d postgres -c "CREATE DATABASE $DB"
docker exec $PG psql -v ON_ERROR_STOP=1 -U bookrunner -d $DB -c "CREATE EXTENSION IF NOT EXISTS timescaledb" -c "SELECT timescaledb_pre_restore()"
docker cp "$S/postgres.dump" $PG:/tmp/restore.dump
docker exec $PG pg_restore -U bookrunner -d $DB --no-owner /tmp/restore.dump
docker exec $PG psql -v ON_ERROR_STOP=1 -U bookrunner -d $DB -c "SELECT timescaledb_post_restore()"
docker exec $PG rm /tmp/restore.dump
docker exec $PG psql -U bookrunner -d $DB -c "SELECT (SELECT count(*) FROM books) AS books, (SELECT count(*) FROM marks) AS marks, (SELECT max(period_end) FROM marks) AS last_mark, (SELECT count(*) FROM quotes) AS quotes"
```

`pg_restore` must exit without errors. Harmless messages: `extension "timescaledb" already exists, skipping`
and, after the terminate, `you need to manually restart any running background workers` (the post-restore
call restarts them). The dump is restored from a file inside the container because `pg_restore` may need to
seek in it.

### 4. Redis

The live Redis copies the snapshot from a throwaway instance by replication: a full sync replaces its whole
dataset and, with `appendonly yes`, rewrites its AOF from it. (Copying `dump.rdb` into the volume would be
ignored: Redis loads the AOF at start.) The throwaway instance has no password and lives on the compose
network only, for the minute this takes.

```bash
docker rm -f bookrunner-redis-restore 2>/dev/null
docker create --name bookrunner-redis-restore --network $DNET redis:7-alpine redis-server --appendonly no --dir /data --dbfilename dump.rdb
docker cp "$S/redis.rdb" bookrunner-redis-restore:/data/dump.rdb
docker start bookrunner-redis-restore
until docker exec bookrunner-redis-restore redis-cli INFO persistence | tr -d '\r' | grep -qx 'loading:0'; do sleep 1; done
docker exec bookrunner-redis-restore redis-cli INFO keyspace                 # the snapshot's key counts
docker exec -e REDISCLI_AUTH $RD redis-cli REPLICAOF bookrunner-redis-restore 6379
until docker exec -e REDISCLI_AUTH $RD redis-cli INFO replication | tr -d '\r' | grep -qx 'master_link_status:up'; do sleep 1; done
until docker exec -e REDISCLI_AUTH $RD redis-cli INFO replication | tr -d '\r' | grep -qx 'master_sync_in_progress:0'; do sleep 1; done
docker exec -e REDISCLI_AUTH $RD redis-cli REPLICAOF NO ONE
docker exec -e REDISCLI_AUTH $RD redis-cli INFO keyspace                     # must equal the snapshot's
docker rm -f bookrunner-redis-restore
docker exec -e REDISCLI_AUTH $RD redis-cli BGREWRITEAOF
```

### 5. State files

Extracted as the `bookrunner` user (a link planted in the app tree cannot redirect a root write); the current
files are kept next to them.

```bash
mv "$APP/.data/$NET" "$APP/.data/$NET.pre-restore-$STAMP"
mkdir -p /root/pre-restore-$STAMP && cp -a "$APP/contracts/deployments" /root/pre-restore-$STAMP/
cat "$S/state.tar.gz" | sudo -u bookrunner tar -C "$APP" -xzf - --no-same-owner
ls -la "$APP/.data/$NET" "$APP/contracts/deployments"
```

### 6. Start and check

```bash
systemctl start bookrunner bookrunner-backup.timer
sleep 60
curl -s http://127.0.0.1:4400/health; echo
curl -s http://127.0.0.1:4400/status; echo
tail -n 100 "$APP/.data/$NET/dev.log"
```

What to expect: the indexer resumes from the restored `chain_cursor` and replays every chain event since the
backup (marks, distributions, kills land in the DB again); risk re-reads each mandate from the chain; alerts
may report a mark as overdue until the mark service has caught up, then send "resolved". Review the ops-venue
log for sagas the older `sagas.json` resumes.

### 7. After a day without problems

```bash
docker exec $PG psql -U bookrunner -d postgres -c "DROP DATABASE ${DB}_pre_restore_$STAMP"
rm -rf "$APP/.data/$NET.pre-restore-$STAMP" /root/pre-restore-$STAMP
```

### Rollback (before step 7)

```bash
systemctl stop bookrunner
docker exec $PG psql -v ON_ERROR_STOP=1 -U bookrunner -d postgres -c "DROP DATABASE $DB" -c "ALTER DATABASE ${DB}_pre_restore_$STAMP RENAME TO $DB"
rm -rf "$APP/.data/$NET" && mv "$APP/.data/$NET.pre-restore-$STAMP" "$APP/.data/$NET"
cp -a /root/pre-restore-$STAMP/deployments/. "$APP/contracts/deployments/"
systemctl start bookrunner
```

Redis has no pre-restore copy (the live dataset is replaced); take one first if it matters:
`docker exec -e REDISCLI_AUTH $RD redis-cli BGSAVE` and `docker cp $RD:/data/dump.rdb /root/pre-restore-$STAMP/`
before step 4, restorable with step 4.
