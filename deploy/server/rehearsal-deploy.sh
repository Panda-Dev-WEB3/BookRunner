#!/usr/bin/env bash
# Server entry point of the live-Orderly rehearsal deployment (docs/RUNBOOK.md "Testnet rehearsal on real Orderly",
# step 3.1). Runs as ROOT from the root-owned deploy copy only (HARDENING.md), like update.sh:
#   sudo /usr/local/lib/bookrunner-deploy/rehearsal-deploy.sh                       # first deployment
#   sudo /usr/local/lib/bookrunner-deploy/rehearsal-deploy.sh --redeploy [--force-archive]
#
# One source for every secret and setting: the root-owned /etc/bookrunner/testnet-live.env (root:root 0600; the same
# file bookrunner@testnet-live reads as its EnvironmentFile): BKRN_TESTNET_LIVE_MNEMONIC, ORACLE_SEED, optional
# RHC_TESTNET_RPC_URL / FORGE_RPC_URL / MARK_INTERVAL_SECONDS and the optional DEPLOY_ORDERLY_VAULT /
# DEPLOY_SETTLEMENT_TOKEN / DEPLOY_ORDERLY_TOKEN / DEPLOY_ORDERLY_BROKER_ID / DEPLOY_CHARTER_FEE_USD overrides. Root
# PARSES it (deploy/server/env-parse.sh, the mirror of scripts/env-file.ts: a key defined twice refuses the file),
# validates every value and hands the SAME values to the bookrunner steps (environment, never argv) and to forge. An
# .env.testnet-live in the app tree is refused (no second source); the infra passwords come from .env.infra.
#
# Root never executes, sources or builds anything from the app tree (/opt/bookrunner/app, writable by the stack user):
#   - every bun / script step runs AS the bookrunner user: scripts/deploy-testnet.sh --phase check | archive-files |
#     migrate | finish (sudo --preserve-env with the values above);
#   - root does only what needs the Docker daemon, with the pinned images' own tools: the database (create, pg_dump of
#     an archived one, rename) and the live Redis (PING, SAVE, FLUSHDB) through `docker exec` on the infra containers,
#     and forge in the pinned Foundry image (FOUNDRY_IMAGE) run AS THE BOOKRUNNER UID: all capabilities dropped,
#     no-new-privileges, no Docker socket, the app tree bind-mounted READ-ONLY with only contracts/{out,cache,broadcast,
#     deployments} and the Foundry home writable; each mount source is re-checked (real path, no symlink, owned by
#     bookrunner) right before the run, and --mount refuses a missing source. The RPC URL reaches forge as ETH_RPC_URL
#     (environment, not argv). Residual, contained by that boundary: forge compiles and runs the Solidity deploy script
#     from the app tree inside that unprivileged container, which can write only those bookrunner-owned paths.
#   - the only app-tree file root reads is the check phase's plan (fixed keys, each validated, symlink refused);
#   - every file created in the app tree is created by the bookrunner user (dumps through `sudo -u bookrunner dd`);
#   - phase finish refuses a deployment whose broadcast transactions were not ALL sent by the plan's deployer.
set -euo pipefail
APP=/opt/bookrunner/app
DEPLOY=/usr/local/lib/bookrunner-deploy
INFRA_ENV="$DEPLOY/.env.infra"
LIVE_ENV="${REHEARSAL_LIVE_ENV:-/etc/bookrunner/testnet-live.env}"
# pinned Foundry image (digest): override only with another digest you have reviewed
FOUNDRY_IMAGE="${FOUNDRY_IMAGE:-ghcr.io/foundry-rs/foundry@sha256:0c00cb0bda1ab1b91c9a6bf60f4c76c09c1a8870824b6d4718afbabacf6f9a17}"
FOUNDRY_HOME=/opt/bookrunner/.foundry-docker
PG=bookrunner-postgres-1
RL=bookrunner-redis-live-1

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
# REHEARSAL_ALLOW_ANY_PATH=1: TEST ONLY (running a checkout's copy on a scratch host). It skips the root-owned-copy
# checks; sudo resets the environment, so only a root shell can set it. Never on the server.
if [ "${REHEARSAL_ALLOW_ANY_PATH:-0}" != 1 ]; then
  [ "$(dirname "$SELF")" = "$DEPLOY" ] || { echo "!! run the root-owned copy: sudo $DEPLOY/rehearsal-deploy.sh $*" >&2; exit 1; }
  [ "$(stat -c %u "$DEPLOY")" = 0 ] && [ "$(stat -c %u "$SELF")" = 0 ] || { echo "!! $DEPLOY is not owned by root: refusing" >&2; exit 1; }
fi
# shellcheck source=env-parse.sh
. "$(dirname "$SELF")/env-parse.sh"
REDEPLOY=0; FORCE_ARCHIVE=0
for a in "$@"; do
  case "$a" in
    --redeploy) REDEPLOY=1 ;;
    --force-archive) FORCE_ARCHIVE=1 ;;
    *) echo "usage: $0 [--redeploy] [--force-archive]" >&2; exit 2 ;;
  esac
done

# ---- 0. the root-owned sources, parsed (never sourced), duplicates refused, every value validated
for f in "$INFRA_ENV" "$LIVE_ENV"; do
  [ -f "$f" ] && [ ! -L "$f" ] || { echo "!! $f is missing or a symlink"; exit 1; }
  [ "$(stat -c %u "$f")" = 0 ] || { echo "!! $f is not owned by root"; exit 1; }
  dups="$(env_dupes "$f")"
  [ -z "$dups" ] || { echo "!! $f defines $(echo "$dups" | tr '\n' ' ')more than once: keep exactly one line per key"; exit 1; }
done
case "$(stat -c %a "$LIVE_ENV")" in 600|400) ;; *) echo "!! $LIVE_ENV must be mode 0600 (it holds the live mnemonic)"; exit 1 ;; esac
[ ! -e "$APP/.env.testnet-live" ] || { echo "!! $APP/.env.testnet-live exists: on the server the live secrets live ONLY in $LIVE_ENV (one source)"; exit 1; }
POSTGRES_PASSWORD="$(env_get "$INFRA_ENV" POSTGRES_PASSWORD)"
REDIS_LIVE_PASSWORD="$(env_get "$INFRA_ENV" REDIS_LIVE_PASSWORD)"
[ -n "$REDIS_LIVE_PASSWORD" ] || { echo "!! REDIS_LIVE_PASSWORD missing from $INFRA_ENV: run update.sh (or install.sh) first"; exit 1; }
BKRN_TESTNET_LIVE_MNEMONIC="$(env_get "$LIVE_ENV" BKRN_TESTNET_LIVE_MNEMONIC)"
[[ "$BKRN_TESTNET_LIVE_MNEMONIC" =~ ^[a-z]+( [a-z]+){11,23}$ ]] || { echo "!! BKRN_TESTNET_LIVE_MNEMONIC in $LIVE_ENV is missing or not 12-24 lowercase words"; exit 1; }
ORACLE_SEED="$(env_get "$LIVE_ENV" ORACLE_SEED)"
[[ "$ORACLE_SEED" =~ ^[A-Za-z0-9_-]{16,}$ ]] || { echo "!! ORACLE_SEED in $LIVE_ENV is missing or malformed (openssl rand -hex 32)"; exit 1; }
# an RPC URL: http(s), no blanks, quotes, backslashes or shell metacharacters other than a query string's ? = & (it is
# never evaluated by a shell; forge receives it as ETH_RPC_URL)
URL_RE='^https?://[A-Za-z0-9._~:/@%+?=&-]+$'
url_ok() { [[ "$1" =~ $URL_RE ]]; }
RHC_TESTNET_RPC_URL="$(env_get "$LIVE_ENV" RHC_TESTNET_RPC_URL)"; RHC_TESTNET_RPC_URL="${RHC_TESTNET_RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
url_ok "$RHC_TESTNET_RPC_URL" || { echo "!! malformed RHC_TESTNET_RPC_URL in $LIVE_ENV"; exit 1; }
FORGE_RPC="$(env_get "$LIVE_ENV" FORGE_RPC_URL)"; FORGE_RPC="${FORGE_RPC:-$RHC_TESTNET_RPC_URL}"
url_ok "$FORGE_RPC" || { echo "!! malformed FORGE_RPC_URL in $LIVE_ENV"; exit 1; }
MARK_INTERVAL_SECONDS="$(env_get "$LIVE_ENV" MARK_INTERVAL_SECONDS)"; MARK_INTERVAL_SECONDS="${MARK_INTERVAL_SECONDS:-3600}"
[[ "$MARK_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || { echo "!! malformed MARK_INTERVAL_SECONDS"; exit 1; }
# DEPLOY_* : read ONCE here (overrides from the file, else the defaults), passed to the phases and to forge alike
dv() { local v; v="$(env_get "$LIVE_ENV" "$1")"; echo "${v:-$2}"; }
DEPLOY_ORDERLY_VAULT="$(dv DEPLOY_ORDERLY_VAULT 0x2A5b650A894409372DDeE241EDAC92d4152bE24d)"
DEPLOY_SETTLEMENT_TOKEN="$(dv DEPLOY_SETTLEMENT_TOKEN 0x7E955252E15c84f5768B83c41a71F9eba181802F)"
DEPLOY_ORDERLY_TOKEN="$(dv DEPLOY_ORDERLY_TOKEN USDG)"
DEPLOY_ORDERLY_BROKER_ID="$(dv DEPLOY_ORDERLY_BROKER_ID bookrunner)"
DEPLOY_CHARTER_FEE_USD="$(dv DEPLOY_CHARTER_FEE_USD 10000000)"
[[ "$DEPLOY_ORDERLY_VAULT" =~ ^0x[0-9a-fA-F]{40}$ ]] && [[ "$DEPLOY_SETTLEMENT_TOKEN" =~ ^0x[0-9a-fA-F]{40}$ ]] \
  && [[ "$DEPLOY_ORDERLY_TOKEN" =~ ^[A-Za-z0-9_]{1,16}$ ]] && [[ "$DEPLOY_ORDERLY_BROKER_ID" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] \
  && [[ "$DEPLOY_CHARTER_FEE_USD" =~ ^[0-9]{1,18}$ ]] || { echo "!! malformed DEPLOY_* override in $LIVE_ENV"; exit 1; }
export POSTGRES_PASSWORD REDIS_LIVE_PASSWORD ORDERLY_VENUE=live REDEPLOY FORCE_ARCHIVE DEPLOY_ENV_FROM_WRAPPER=1 \
  BKRN_TESTNET_LIVE_MNEMONIC ORACLE_SEED RHC_TESTNET_RPC_URL MARK_INTERVAL_SECONDS \
  DEPLOY_ORDERLY_VAULT DEPLOY_SETTLEMENT_TOKEN DEPLOY_ORDERLY_TOKEN DEPLOY_ORDERLY_BROKER_ID DEPLOY_CHARTER_FEE_USD
# the stack user, with these values passed through its environment (never argv)
PRESERVE="POSTGRES_PASSWORD,REDIS_LIVE_PASSWORD,ORDERLY_VENUE,REDEPLOY,FORCE_ARCHIVE,ARCHIVE_STAMP,EXPECT_DEPLOYER,DEPLOY_ENV_FROM_WRAPPER"
PRESERVE="$PRESERVE,BKRN_TESTNET_LIVE_MNEMONIC,ORACLE_SEED,RHC_TESTNET_RPC_URL,MARK_INTERVAL_SECONDS"
PRESERVE="$PRESERVE,DEPLOY_ORDERLY_VAULT,DEPLOY_SETTLEMENT_TOKEN,DEPLOY_ORDERLY_TOKEN,DEPLOY_ORDERLY_BROKER_ID,DEPLOY_CHARTER_FEE_USD"
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
[ -z "$(env_dupes "$PLAN")" ] || { echo "!! malformed plan $PLAN (duplicated keys)"; exit 1; }
ARCHIVE="$(env_get "$PLAN" ARCHIVE)"; STAMP="$(env_get "$PLAN" STAMP)"; DB="$(env_get "$PLAN" DB)"; DEPLOYER="$(env_get "$PLAN" DEPLOYER)"
[[ "$ARCHIVE" =~ ^[01]$ ]] && [[ "$STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] && [ "$DB" = bookrunner_testnet_live ] && [[ "$DEPLOYER" =~ ^0x[0-9a-fA-F]{40}$ ]] \
  || { echo "!! malformed plan $PLAN"; exit 1; }
# the plan must have been computed from exactly the settings forge will get
for k in DEPLOY_ORDERLY_VAULT DEPLOY_SETTLEMENT_TOKEN DEPLOY_ORDERLY_TOKEN DEPLOY_ORDERLY_BROKER_ID DEPLOY_CHARTER_FEE_USD; do
  [ "$(env_get "$PLAN" "$k")" = "${!k}" ] || { echo "!! the plan's $k differs from $LIVE_ENV: refusing"; exit 1; }
done
export EXPECT_DEPLOYER="$DEPLOYER"

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

# ---- 5. forge in the pinned image AS THE BOOKRUNNER UID, the app tree read-only except its output dirs
RW_DIRS=(contracts/out contracts/cache contracts/broadcast contracts/deployments)
"${AS[@]}" mkdir -p "$FOUNDRY_HOME" "${RW_DIRS[@]/#/$APP/}"
# a mount source must be exactly that path (no symlink swapped in by the stack user) and bookrunner's: checked right
# before the run; --mount (unlike -v) never creates a missing source
mount_src() {
  [ "$(readlink -f "$1")" = "$1" ] && [ -d "$1" ] && [ "$(stat -c %U "$1")" = bookrunner ] \
    || { echo "!! mount source $1 is not a real bookrunner-owned directory (symlink or swapped?): refusing" >&2; return 1; }
  echo "type=bind,src=$1"
}
UIDGID="$(id -u bookrunner):$(id -g bookrunner)"
export DEV_MNEMONIC="$BKRN_TESTNET_LIVE_MNEMONIC" NETWORK=testnet DEPLOY_OUT=deployments/46630.live.json ETH_RPC_URL="$FORGE_RPC"
forge_run() {
  local m=() src d
  src="$(mount_src "$APP")" || return 1
  m+=(--mount "$src,dst=/repo,readonly")
  src="$(mount_src "$FOUNDRY_HOME")" || return 1
  m+=(--mount "$src,dst=/home/forge")
  for d in "${RW_DIRS[@]}"; do
    src="$(mount_src "$APP/$d")" || return 1
    m+=(--mount "$src,dst=/repo/$d")
  done
  docker run --rm --user "$UIDGID" --cap-drop ALL --security-opt no-new-privileges "${m[@]}" \
    -e HOME=/home/forge -w /repo/contracts \
    -e DEV_MNEMONIC -e NETWORK -e MARK_INTERVAL_SECONDS -e DEPLOY_OUT -e ETH_RPC_URL -e DEPLOY_ORDERLY_VAULT \
    -e DEPLOY_SETTLEMENT_TOKEN -e DEPLOY_ORDERLY_TOKEN -e DEPLOY_ORDERLY_BROKER_ID -e DEPLOY_CHARTER_FEE_USD \
    --entrypoint forge "$FOUNDRY_IMAGE" "$@"
}
echo "==> forge build (pinned image, uid bookrunner, app tree read-only)"
forge_run build >/dev/null
echo "==> Deploy.s.sol -> testnet (RPC via ETH_RPC_URL)"
forge_run script script/Deploy.s.sol:Deploy --rpc-url "$ETH_RPC_URL" --broadcast --slow -q  # forge script ignores ETH_RPC_URL alone (simulates locally)
unset DEV_MNEMONIC

# ---- 6. broadcast sender == the plan's deployer, startBlock, on-chain verification, ABIs (stack user)
phase finish
echo "==> rehearsal deployment done; next: fund the live deployer $DEPLOYER, then sudo systemctl start bookrunner@testnet-live"
