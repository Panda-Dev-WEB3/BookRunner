#!/usr/bin/env bash
# Server entry point of the live-Orderly rehearsal deployment (docs/RUNBOOK.md "Testnet rehearsal on real Orderly",
# step 3.1). Runs as ROOT from the root-owned deploy copy only (HARDENING.md), like update.sh:
#   sudo /usr/local/lib/bookrunner-deploy/rehearsal-deploy.sh                       # first deployment
#   sudo /usr/local/lib/bookrunner-deploy/rehearsal-deploy.sh --redeploy [--force-archive]
#
# Root never executes, sources or builds anything from the app tree (/opt/bookrunner/app, writable by the stack user):
#   - every bun / script step runs AS the bookrunner user: scripts/deploy-testnet.sh --phase check | archive-files |
#     migrate | finish (it reads its own .env.testnet / .env.testnet-live), with the infra passwords handed over in the
#     environment (sudo --preserve-env, never on a command line);
#   - root does only what needs the Docker daemon, with the pinned images' own tools: the database (create, pg_dump of
#     an archived one, rename) and the live Redis (PING, SAVE, FLUSHDB) through `docker exec` on the infra containers,
#     and forge in the pinned Foundry image (FOUNDRY_IMAGE) run AS THE BOOKRUNNER UID (no root in the container, all
#     capabilities dropped, no-new-privileges, only the app tree and the bookrunner-owned Foundry home mounted, no Docker
#     socket). Residual, contained by that boundary: forge compiles and runs the Solidity deploy script from the app tree
#     inside that unprivileged container; it can write only what the bookrunner user can write anyway.
#   - the only values root reads from the app tree are parsed, never evaluated: the plan file the check phase writes
#     (fixed keys, each validated by a regex) and, from .env.testnet-live, BKRN_TESTNET_LIVE_MNEMONIC /
#     RHC_TESTNET_RPC_URL / FORGE_RPC_URL / MARK_INTERVAL_SECONDS (KEY=VALUE lines, validated) for the forge container.
#   - every file created in the app tree is created by the bookrunner user (dumps are written through `sudo -u bookrunner
#     dd`), so nothing root-owned is left behind.
set -euo pipefail
APP=/opt/bookrunner/app
DEPLOY=/usr/local/lib/bookrunner-deploy
INFRA_ENV="$DEPLOY/.env.infra"
# pinned Foundry image (digest): override only with another digest you have reviewed
FOUNDRY_IMAGE="${FOUNDRY_IMAGE:-ghcr.io/foundry-rs/foundry@sha256:0c00cb0bda1ab1b91c9a6bf60f4c76c09c1a8870824b6d4718afbabacf6f9a17}"
FOUNDRY_HOME=/opt/bookrunner/.foundry-docker
PG=bookrunner-postgres-1
RL=bookrunner-redis-live-1

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
if [ "${REHEARSAL_ALLOW_ANY_PATH:-0}" != 1 ]; then
  [ "$(dirname "$SELF")" = "$DEPLOY" ] || { echo "!! run the root-owned copy: sudo $DEPLOY/rehearsal-deploy.sh $*" >&2; exit 1; }
  [ "$(stat -c %u "$DEPLOY")" = 0 ] && [ "$(stat -c %u "$SELF")" = 0 ] || { echo "!! $DEPLOY is not owned by root: refusing" >&2; exit 1; }
fi
REDEPLOY=0; FORCE_ARCHIVE=0
for a in "$@"; do
  case "$a" in
    --redeploy) REDEPLOY=1 ;;
    --force-archive) FORCE_ARCHIVE=1 ;;
    *) echo "usage: $0 [--redeploy] [--force-archive]" >&2; exit 2 ;;
  esac
done

# KEY=VALUE from a file, parsed (never sourced); empty when absent
kv() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
# infra passwords: the root-owned .env.infra
POSTGRES_PASSWORD="$(kv "$INFRA_ENV" POSTGRES_PASSWORD)"
REDIS_LIVE_PASSWORD="$(kv "$INFRA_ENV" REDIS_LIVE_PASSWORD)"
[ -n "$REDIS_LIVE_PASSWORD" ] || { echo "!! REDIS_LIVE_PASSWORD missing from $INFRA_ENV: run update.sh (or install.sh) first"; exit 1; }
export POSTGRES_PASSWORD REDIS_LIVE_PASSWORD ORDERLY_VENUE=live REDEPLOY FORCE_ARCHIVE
# the stack user, with the passwords and the deploy flags passed through its environment (never argv)
PRESERVE="POSTGRES_PASSWORD,REDIS_LIVE_PASSWORD,ORDERLY_VENUE,REDEPLOY,FORCE_ARCHIVE,ARCHIVE_STAMP"
AS=(sudo "--preserve-env=$PRESERVE" -u bookrunner HOME=/opt/bookrunner)
phase() { ( cd "$APP" && "${AS[@]}" bash scripts/deploy-testnet.sh --phase "$1" ); }
# redis-cli inside the live Redis container, password via REDISCLI_AUTH (env name only on the command line)
rcli_live() { ( export REDISCLI_AUTH="$REDIS_LIVE_PASSWORD"; docker exec -e REDISCLI_AUTH "$RL" redis-cli --no-auth-warning "$@" 2>&1 | tr -d '\r' ); }
psql_root() { docker exec "$PG" psql -U bookrunner -d bookrunner "$@"; }

# ---- 1. checks + readiness gate, as the stack user (writes the plan)
PLAN="$APP/.data/rehearsal-deploy.plan"
"${AS[@]}" rm -f "$PLAN"
phase check
[ -f "$PLAN" ] && [ ! -L "$PLAN" ] || { echo "!! the check phase wrote no plan"; exit 1; }
ARCHIVE="$(kv "$PLAN" ARCHIVE)"; STAMP="$(kv "$PLAN" STAMP)"; DB="$(kv "$PLAN" DB)"
[[ "$ARCHIVE" =~ ^[01]$ ]] && [[ "$STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] && [ "$DB" = bookrunner_testnet_live ] || { echo "!! malformed plan $PLAN"; exit 1; }

# ---- 2. root checks before anything is archived: the unit is stopped, the live Redis answers with its password
if systemctl is-active --quiet bookrunner@testnet-live; then echo "!! bookrunner@testnet-live is running: stop it first"; exit 7; fi
if docker inspect "$RL" >/dev/null 2>&1; then
  [ "$(rcli_live PING)" = PONG ] || { echo "!! redis-live refuses REDIS_LIVE_PASSWORD from $INFRA_ENV: nothing archived"; exit 8; }
fi
# forge writes contracts/out, cache, broadcast, deployments as the bookrunner uid: they must be its (no root leftovers)
for d in contracts/out contracts/cache contracts/broadcast contracts/deployments; do
  if [ -e "$APP/$d" ] && [ "$(find "$APP/$d" ! -user bookrunner -print -quit 2>/dev/null)" != "" ]; then
    echo "!! $APP/$d holds files not owned by bookrunner (left by an earlier root run): once, by hand,"
    echo "!!   sudo chown -R --no-dereference bookrunner:bookrunner $APP/$d   then re-run"; exit 1
  fi
done

# ---- 3. archive (redeploy): files as the stack user, database and Redis through docker
if [ "$ARCHIVE" = 1 ]; then
  export ARCHIVE_STAMP="$STAMP"
  phase archive-files
  AR="$APP/.data/testnet-live.$STAMP"
  if psql_root -tc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1; then
    docker exec "$PG" pg_dump -U bookrunner -Fc -d "$DB" | "${AS[@]}" sh -c 'umask 077; exec dd of="$1" status=none' sh "$AR/postgres.dump"
    DB_AR="${DB}_$(echo "$STAMP" | tr 'A-Z' 'a-z')"
    psql_root -c "ALTER DATABASE $DB RENAME TO $DB_AR" >/dev/null
    echo "    archived database $DB -> $DB_AR (dump in $AR/postgres.dump)"
  fi
  if docker inspect "$RL" >/dev/null 2>&1; then
    [ "$(rcli_live SAVE)" = OK ] || { echo "!! redis-live SAVE failed: the old Redis was NOT archived or emptied"; exit 8; }
    docker exec "$RL" cat /data/dump.rdb | "${AS[@]}" sh -c 'umask 077; exec dd of="$1" status=none' sh "$AR/redis-live.rdb"
    [ "$(rcli_live FLUSHDB)" = OK ] || { echo "!! redis-live FLUSHDB failed: empty it before starting the new stack"; exit 8; }
    echo "    archived the live Redis snapshot -> $AR/redis-live.rdb, live Redis db 0 emptied"
  fi
fi

# ---- 4. database (docker, root) + migrations (stack user)
psql_root -tc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 || psql_root -c "CREATE DATABASE $DB" >/dev/null
phase migrate

# ---- 5. forge in the pinned image AS THE BOOKRUNNER UID (values parsed from .env.testnet-live, never sourced)
LIVE_ENV="$APP/.env.testnet-live"
[ -f "$LIVE_ENV" ] && [ ! -L "$LIVE_ENV" ] || { echo "!! $LIVE_ENV is missing or a symlink"; exit 1; }
DEV_MNEMONIC="$(kv "$LIVE_ENV" BKRN_TESTNET_LIVE_MNEMONIC)"
[[ "$DEV_MNEMONIC" =~ ^[a-z]+( [a-z]+){11,23}$ ]] || { echo "!! BKRN_TESTNET_LIVE_MNEMONIC in $LIVE_ENV is missing or not 12-24 lowercase words"; exit 1; }
RPC="$(kv "$LIVE_ENV" FORGE_RPC_URL)"; [ -n "$RPC" ] || RPC="$(kv "$LIVE_ENV" RHC_TESTNET_RPC_URL)"; [ -n "$RPC" ] || RPC=https://rpc.testnet.chain.robinhood.com
[[ "$RPC" =~ ^https?://[A-Za-z0-9._:/@%-]+$ ]] || { echo "!! malformed RPC URL in $LIVE_ENV"; exit 1; }
MARK_INTERVAL_SECONDS="$(kv "$LIVE_ENV" MARK_INTERVAL_SECONDS)"; MARK_INTERVAL_SECONDS="${MARK_INTERVAL_SECONDS:-3600}"
[[ "$MARK_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || { echo "!! malformed MARK_INTERVAL_SECONDS"; exit 1; }
"${AS[@]}" mkdir -p "$FOUNDRY_HOME"
UIDGID="$(id -u bookrunner):$(id -g bookrunner)"
export DEV_MNEMONIC NETWORK=testnet MARK_INTERVAL_SECONDS DEPLOY_OUT=deployments/46630.live.json \
  DEPLOY_ORDERLY_VAULT="${DEPLOY_ORDERLY_VAULT:-0x2A5b650A894409372DDeE241EDAC92d4152bE24d}" \
  DEPLOY_SETTLEMENT_TOKEN="${DEPLOY_SETTLEMENT_TOKEN:-0x7E955252E15c84f5768B83c41a71F9eba181802F}" \
  DEPLOY_ORDERLY_TOKEN="${DEPLOY_ORDERLY_TOKEN:-USDG}" DEPLOY_ORDERLY_BROKER_ID="${DEPLOY_ORDERLY_BROKER_ID:-bookrunner}" \
  DEPLOY_CHARTER_FEE_USD="${DEPLOY_CHARTER_FEE_USD:-10000000}"
forge_run() {
  docker run --rm --user "$UIDGID" --cap-drop ALL --security-opt no-new-privileges \
    -v "$APP:/repo" -v "$FOUNDRY_HOME:/home/forge" -e HOME=/home/forge -w /repo/contracts \
    -e DEV_MNEMONIC -e NETWORK -e MARK_INTERVAL_SECONDS -e DEPLOY_OUT -e DEPLOY_ORDERLY_VAULT -e DEPLOY_SETTLEMENT_TOKEN \
    -e DEPLOY_ORDERLY_TOKEN -e DEPLOY_ORDERLY_BROKER_ID -e DEPLOY_CHARTER_FEE_USD \
    --entrypoint forge "$FOUNDRY_IMAGE" "$@"
}
echo "==> forge build (pinned image, uid bookrunner)"
forge_run build >/dev/null
echo "==> Deploy.s.sol -> testnet"
forge_run script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --slow -q
unset DEV_MNEMONIC

# ---- 6. startBlock, on-chain verification, ABIs (stack user)
phase finish
echo "==> rehearsal deployment done; next: fund the live deployer, then sudo systemctl start bookrunner@testnet-live"
