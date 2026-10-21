#!/usr/bin/env bash
# One-off: fresh deployment of the PUBLIC testnet stack (bookrunner.tech, mock venue) from the app tree's commit.
# Mirrors deploy/server/rehearsal-deploy.sh for ORDERLY_VENUE=mock: root runs only the docker steps (DB dump/rename/
# create, Redis snapshot/flush, forge as the bookrunner uid); every app step runs AS bookrunner. Archives, never deletes.
# Run (root-owned copy, bookrunner.service stopped):
#   sudo systemctl stop bookrunner && sudo bash /usr/local/lib/bookrunner-deploy/update.sh --web-only
#   sudo bash /usr/local/lib/bookrunner-deploy/public-redeploy.sh   [--from-forge: resume after a failed forge step]
#   sudo bash /usr/local/lib/bookrunner-deploy/update.sh            (restarts the stack: the first start launches the books)
# Used for testnet v4 on 2026-10-21.
set -euo pipefail
APP=/opt/bookrunner/app
DEPLOY=/usr/local/lib/bookrunner-deploy
INFRA_ENV="$DEPLOY/.env.infra"
TE="$APP/.env.testnet"
PG=bookrunner-postgres-1
RD=bookrunner-redis-1
FOUNDRY_HOME=/opt/bookrunner/.foundry-docker
FOUNDRY_IMAGE="$(sed -n 's/^IMAGE="${FOUNDRY_IMAGE:-\(.*\)}"$/\1/p' /usr/local/lib/bookrunner-src/scripts/forge.sh)"
[[ "$FOUNDRY_IMAGE" == *@sha256:* ]] || { echo "!! foundry image not pinned"; exit 1; }

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
. "$DEPLOY/env-parse.sh"
if systemctl is-active --quiet bookrunner; then echo "!! bookrunner.service is running: stop it first"; exit 7; fi
[ -f "$TE" ] && [ ! -L "$TE" ] || { echo "!! $TE missing or a symlink"; exit 1; }
[ -z "$(env_dupes "$TE")" ] && [ -z "$(env_dupes "$INFRA_ENV")" ] || { echo "!! duplicated keys in an env file"; exit 1; }

POSTGRES_PASSWORD="$(env_get "$INFRA_ENV" POSTGRES_PASSWORD)"
REDIS_PASSWORD="$(env_get "$INFRA_ENV" REDIS_PASSWORD)"
[ -n "$POSTGRES_PASSWORD" ] && [ -n "$REDIS_PASSWORD" ] || { echo "!! infra passwords missing"; exit 1; }
MN="$(env_get "$TE" BKRN_TESTNET_MNEMONIC)"
[[ "$MN" =~ ^[a-z]+( [a-z]+){11,23}$ ]] || { echo "!! BKRN_TESTNET_MNEMONIC missing or malformed"; exit 1; }
RPC="$(env_get "$TE" RHC_TESTNET_RPC_URL)"; RPC="${RPC:-https://rpc.testnet.chain.robinhood.com}"
[[ "$RPC" =~ ^https?://[A-Za-z0-9._~:/@%+?=\&-]+$ ]] || { echo "!! malformed RPC"; exit 1; }
MARK_INTERVAL_SECONDS="$(env_get "$TE" MARK_INTERVAL_SECONDS)"; MARK_INTERVAL_SECONDS="${MARK_INTERVAL_SECONDS:-3600}"
[[ "$MARK_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || { echo "!! malformed MARK_INTERVAL_SECONDS"; exit 1; }

PLAN="$APP/.data/public-redeploy.plan"
export POSTGRES_PASSWORD REDEPLOY=1 DEPLOY_PLAN_FILE="$PLAN" ORDERLY_VENUE=mock
AS=(sudo --preserve-env=POSTGRES_PASSWORD,REDEPLOY,DEPLOY_PLAN_FILE,ORDERLY_VENUE,ARCHIVE_STAMP,EXPECT_DEPLOYER -u bookrunner HOME=/opt/bookrunner)
phase() { ( cd "$APP" && "${AS[@]}" bash scripts/deploy-testnet.sh --phase "$1" ); }
rcli() { ( export REDISCLI_AUTH="$REDIS_PASSWORD"; docker exec -e REDISCLI_AUTH "$RD" redis-cli --no-auth-warning "$@" 2>&1 | tr -d '\r' ); }
psql_root() { docker exec "$PG" psql -U bookrunner -d bookrunner "$@"; }

FROM_FORGE=0; [ "${1:-}" = "--from-forge" ] && FROM_FORGE=1
if [ "$FROM_FORGE" = 1 ]; then
  # resume after a failed forge step: the plan, the archive and the new database already exist
  [ -f "$PLAN" ] && [ ! -L "$PLAN" ] && [ -z "$(env_dupes "$PLAN")" ] || { echo "!! no plan to resume from"; exit 1; }
  DEPLOYER="$(env_get "$PLAN" DEPLOYER)"; [[ "$DEPLOYER" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "!! malformed plan"; exit 1; }
  export EXPECT_DEPLOYER="$DEPLOYER"
else
echo "==> 1. checks (as bookrunner)"
"${AS[@]}" rm -f "$PLAN"
phase check
[ -f "$PLAN" ] && [ ! -L "$PLAN" ] && [ -z "$(env_dupes "$PLAN")" ] || { echo "!! no / malformed plan"; exit 1; }
ARCHIVE="$(env_get "$PLAN" ARCHIVE)"; STAMP="$(env_get "$PLAN" STAMP)"; DB="$(env_get "$PLAN" DB)"; DEPLOYER="$(env_get "$PLAN" DEPLOYER)"
[[ "$ARCHIVE" =~ ^[01]$ ]] && [[ "$STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] && [ "$DB" = bookrunner_testnet ] && [[ "$DEPLOYER" =~ ^0x[0-9a-fA-F]{40}$ ]] \
  || { echo "!! malformed plan"; exit 1; }
export EXPECT_DEPLOYER="$DEPLOYER"
# deploy-testnet.sh archives only in live mode: for the public stack an existing record is archived here
[ -f "$APP/contracts/deployments/46630.json" ] && ARCHIVE=1
echo "    deployer $DEPLOYER, archive=$ARCHIVE, stamp $STAMP"
[ "$(rcli PING)" = PONG ] || { echo "!! Redis refuses REDIS_PASSWORD: nothing archived"; exit 8; }
for d in contracts/out contracts/cache contracts/broadcast contracts/deployments; do
  if [ -e "$APP/$d" ] && [ -n "$(find "$APP/$d" ! -user bookrunner -print -quit 2>/dev/null)" ]; then
    echo "!! $APP/$d holds files not owned by bookrunner"; exit 1
  fi
done

if [ "$ARCHIVE" = 1 ]; then
  echo "==> 2. archive (record + .data/testnet as bookrunner; DB + Redis via docker)"
  export ARCHIVE_STAMP="$STAMP"
  phase archive-files
  AR="$APP/.data/testnet.$STAMP"
  if psql_root -tc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1; then
    docker exec "$PG" pg_dump -U bookrunner -Fc -d "$DB" | "${AS[@]}" sh -c 'umask 077; exec dd of="$1" status=none' sh "$AR/postgres.dump"
    DB_AR="${DB}_$(echo "$STAMP" | tr 'A-Z' 'a-z')"
    psql_root -c "ALTER DATABASE $DB RENAME TO $DB_AR" >/dev/null
    echo "    database $DB -> $DB_AR (dump $AR/postgres.dump)"
  fi
  [ "$(rcli SAVE)" = OK ] || { echo "!! Redis SAVE failed (record, state and DB already archived in $AR)"; exit 8; }
  docker exec "$RD" cat /data/dump.rdb | "${AS[@]}" sh -c 'umask 077; exec dd of="$1" status=none' sh "$AR/redis.rdb"
  [ "$(rcli FLUSHDB)" = OK ] || { echo "!! Redis FLUSHDB failed: empty it before starting the stack"; exit 8; }
  echo "    Redis snapshot -> $AR/redis.rdb, db 0 emptied"
fi

echo "==> 3. database + migrations"
psql_root -tc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 || psql_root -c "CREATE DATABASE $DB" >/dev/null
phase migrate

fi
echo "==> 4. forge (pinned image, uid bookrunner, 2 CPUs, app tree read-only)"
RW_DIRS=(contracts/out contracts/cache contracts/broadcast contracts/deployments)
install -d -o bookrunner -g bookrunner -m 0750 "$FOUNDRY_HOME"
"${AS[@]}" mkdir -p "${RW_DIRS[@]/#/$APP/}"
mount_src() {
  [ "$(readlink -f "$1")" = "$1" ] && [ -d "$1" ] && [ "$(stat -c %U "$1")" = bookrunner ] || { echo "!! bad mount source $1" >&2; return 1; }
  echo "type=bind,src=$1"
}
UIDGID="$(id -u bookrunner):$(id -g bookrunner)"
export DEV_MNEMONIC="$MN" NETWORK=testnet ETH_RPC_URL="$RPC" MARK_INTERVAL_SECONDS
forge_run() {
  local m=() src d
  src="$(mount_src "$APP")" || return 1; m+=(--mount "$src,dst=/repo,readonly")
  src="$(mount_src "$FOUNDRY_HOME")" || return 1; m+=(--mount "$src,dst=/home/forge")
  for d in "${RW_DIRS[@]}"; do src="$(mount_src "$APP/$d")" || return 1; m+=(--mount "$src,dst=/repo/$d"); done
  docker run --rm --cpus=2 --memory=3g --user "$UIDGID" --cap-drop ALL --security-opt no-new-privileges "${m[@]}" \
    -e HOME=/home/forge -w /repo/contracts -e DEV_MNEMONIC -e NETWORK -e MARK_INTERVAL_SECONDS -e ETH_RPC_URL \
    --entrypoint forge "$FOUNDRY_IMAGE" "$@"
}
forge_run build >/dev/null
echo "    Deploy.s.sol -> testnet"
forge_run script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --slow -q
unset DEV_MNEMONIC MN

echo "==> 5. finish (sender check, startBlock, on-chain verify, ABIs) as bookrunner"
phase finish
install -d -o bookrunner -g bookrunner -m 0750 "$APP/.data/testnet"  # the unit appends its log there
echo "==> done. next: sudo bash $DEPLOY/update.sh (installs units, restarts the stack: first start launches the books)"
