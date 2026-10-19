#!/usr/bin/env bash
# Robinhood Chain TESTNET (46630) deployment of the Bookrunner core.
#   bash scripts/deploy-testnet.sh                      # public testnet stack, mock venue (MockOrderlyVault + mock USDC):
#                                                       # .env.testnet, contracts/deployments/46630.json, DB bookrunner_testnet
#   ORDERLY_VENUE=live bash scripts/deploy-testnet.sh   # live-Orderly rehearsal stack, SEPARATE from the public one: the REAL
#                                                       # Orderly testnet vault + testnet USDG, its own mnemonic
#                                                       # (BKRN_TESTNET_LIVE_MNEMONIC in .env.testnet-live), record
#                                                       # 46630.live.json, DB bookrunner_testnet_live
# Then:  dev.ts --network testnet (bookrunner.service) or --network testnet-live (bookrunner@testnet-live): the first start
#        launches the books (docs/RUNBOOK.md "Testnet rehearsal on real Orderly").
#
# Who runs what. Without --phase (a developer machine: the user has docker) every step runs here. On the SERVER this
# script is never run by root (HARDENING.md: root runs only root-owned code; it refuses): the root-owned wrapper
# /usr/local/lib/bookrunner-deploy/rehearsal-deploy.sh (deploy/server) runs the docker steps itself (database create /
# archive, live Redis archive, forge in the pinned Foundry image as the bookrunner uid) and calls the phases below AS
# the bookrunner user (sudo -u bookrunner), with the infra passwords in the environment (never on a command line):
#   --phase check           env, keys, chain, balance, REDEPLOY guards, readiness gate -> writes the plan file
#   --phase archive-files   (needs ARCHIVE_STAMP) copy the record, move the state to .data/testnet-live.<stamp>
#   --phase migrate         database migrations (the database exists: created by the wrapper)
#   --phase finish          startBlock, on-chain verification, ABIs
#
# Keys: the public stack's role keys derive from BKRN_TESTNET_MNEMONIC (.env.testnet), the rehearsal's from
# BKRN_TESTNET_LIVE_MNEMONIC (.env.testnet-live): live mode refuses a missing one or one deriving the same deployer.
# Mnemonics never appear on a command line or in the output (addresses are derived by bun from the environment).
# Infra passwords (POSTGRES_PASSWORD, REDIS_LIVE_PASSWORD) come from the environment only.
# The deployer is index 0 and must hold testnet ETH (faucet: https://faucet.testnet.chain.robinhood.com).
# Live venue: Deploy.s.sol refuses unless Orderly's vault allows USDG and broker `bookrunner` (getAllowedToken /
# getAllowedBroker); the check phase runs `scripts/orderly-readiness.ts --stage venue` (read-only) first. Stock Tokens,
# the swap router and prices stay mock / synthetic (no Stock Tokens / Chainlink / Uniswap on RH testnet, VERIFY T3 / C4).
# REDEPLOY=1 in live mode: refused unless every book of the existing live record is Retired / Cancelled with empty
# adapters (scripts/rehearsal-guard.ts), FORCE_ARCHIVE=1 overrides; either way the old record, database and state
# (.data/testnet-live, incl. the Orderly keys of its accounts, plus a dump of the old DB and the old live Redis snapshot)
# are ARCHIVED, never deleted; refused while bookrunner@testnet-live runs; the readiness gate runs before any archiving.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# root never executes the app tree (it is writable by the stack user): the server path is the root-owned wrapper
if [ "$(id -u)" = 0 ] && [ "$(stat -c %u "$ROOT" 2>/dev/null || echo 0)" != 0 ]; then
  echo "!! refusing to run as root from $ROOT (writable by the stack user, HARDENING.md)."
  echo "!! On the server: sudo /usr/local/lib/bookrunner-deploy/rehearsal-deploy.sh (it runs the steps that need root itself)"; exit 1
fi
BUN="$ROOT/node_modules/.bin/bun"
[ -x "$BUN" ] || BUN="$ROOT/node_modules/.bin/bun.exe"
PHASE=all
if [ "${1:-}" = "--phase" ]; then PHASE="${2:-}"; fi
case "$PHASE" in all|check|archive-files|migrate|finish) ;; *) echo "unknown --phase $PHASE"; exit 1 ;; esac
PLAN="${DEPLOY_PLAN_FILE:-$ROOT/.data/rehearsal-deploy.plan}"
# address of mnemonic index 0, read from the env var named $1 (never on a command line)
addr_of() { M_VAR="$1" "$BUN" -e 'const {mnemonicToAccount}=require("viem/accounts");const m=(process.env[process.env.M_VAR]||"").trim();if(!m)process.exit(3);console.log(mnemonicToAccount(m,{addressIndex:0}).address)'; }

VENUE="${ORDERLY_VENUE:-mock}"
case "$VENUE" in
  mock)
    [ -f .env.testnet ] || { echo ".env.testnet missing (needs BKRN_TESTNET_MNEMONIC)"; exit 1; }
    set -a; . ./.env.testnet; set +a
    : "${BKRN_TESTNET_MNEMONIC:?BKRN_TESTNET_MNEMONIC not set in .env.testnet}"
    MNEMONIC_VAR=BKRN_TESTNET_MNEMONIC
    REC=contracts/deployments/46630.json; DB=bookrunner_testnet; STATE=.data/testnet
    if [ -n "${DEPLOY_ORDERLY_VAULT:-}${DEPLOY_SETTLEMENT_TOKEN:-}" ]; then
      echo "DEPLOY_ORDERLY_VAULT / DEPLOY_SETTLEMENT_TOKEN set: use ORDERLY_VENUE=live (separate stack, record 46630.live.json)"; exit 1
    fi
    unset DEPLOY_OUT ;;
  live)
    # the public stack's deployer, for the distinctness check only: its mnemonic is read in a subshell, never exported
    PUBLIC_DEPLOYER=""
    if [ -f .env.testnet ]; then
      PUBLIC_DEPLOYER="$( set -a; . ./.env.testnet >/dev/null 2>&1; set +a; addr_of BKRN_TESTNET_MNEMONIC 2>/dev/null || true )"
    fi
    if [ -f .env.testnet-live ]; then set -a; . ./.env.testnet-live; set +a; fi
    : "${BKRN_TESTNET_LIVE_MNEMONIC:?BKRN_TESTNET_LIVE_MNEMONIC not set (.env.testnet-live): the rehearsal stack needs its own role mnemonic}"
    MNEMONIC_VAR=BKRN_TESTNET_LIVE_MNEMONIC
    REC=contracts/deployments/46630.live.json; DB=bookrunner_testnet_live; STATE=.data/testnet-live
    # Orderly RH testnet externals (VERIFY O2 / O3); the readiness check re-reads them on-chain
    export DEPLOY_ORDERLY_VAULT="${DEPLOY_ORDERLY_VAULT:-0x2A5b650A894409372DDeE241EDAC92d4152bE24d}"
    export DEPLOY_SETTLEMENT_TOKEN="${DEPLOY_SETTLEMENT_TOKEN:-0x7E955252E15c84f5768B83c41a71F9eba181802F}"
    export DEPLOY_ORDERLY_TOKEN="${DEPLOY_ORDERLY_TOKEN:-USDG}"
    export DEPLOY_ORDERLY_BROKER_ID="${DEPLOY_ORDERLY_BROKER_ID:-bookrunner}"
    # the charter fee is paid in real testnet USDG: 10 per book unless set (6 dp)
    export DEPLOY_CHARTER_FEE_USD="${DEPLOY_CHARTER_FEE_USD:-10000000}"
    export DEPLOY_OUT="deployments/46630.live.json" ;;
  *) echo "ORDERLY_VENUE must be mock or live (got $VENUE)"; exit 1 ;;
esac
export REC
export REDIS_LIVE_PASSWORD="${REDIS_LIVE_PASSWORD:-}"
# redis-cli in the redis-live container (all mode only: the server wrapper does this as root); the password travels as
# an env var (REDISCLI_AUTH), never on a command line
rcli_live() { ( if [ -n "${REDIS_LIVE_PASSWORD:-}" ]; then export REDISCLI_AUTH="$REDIS_LIVE_PASSWORD"; else unset REDISCLI_AUTH; fi; docker exec -e REDISCLI_AUTH bookrunner-redis-live-1 redis-cli --no-auth-warning "$@" 2>&1 ); }
# the oracle refuses synthetic prices on a public chain without a secret seed (services/oracle config.ts)
: "${ORACLE_SEED:?ORACLE_SEED not set: add one with  echo ORACLE_SEED=\$(openssl rand -hex 32) >> .env.testnet (live: .env.testnet-live)}"
# the deployer (protocol admin) derives from the mnemonic only with this opt-in (packages/shared devkeys.ts)
export BKRN_ALLOW_ADMIN_KEY=1
RPC="${RHC_TESTNET_RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
# forge runs in Docker: for a local rehearsal chain pass FORGE_RPC_URL=http://host.docker.internal:<port>
FORGE_RPC="${FORGE_RPC_URL:-$RPC}"
MIN_ETH="${DEPLOY_MIN_ETH:-0.03}"
check() { "$BUN" scripts/deploy-check.ts "$@"; }

# ============================================================== check (no writes besides the plan file)
if [ "$PHASE" = all ] || [ "$PHASE" = check ]; then
  CHAIN=$(check chain-id --rpc "$RPC")
  [ "$CHAIN" = "46630" ] || { echo "RPC $RPC is chain $CHAIN, expected 46630"; exit 1; }
  DEPLOYER="$(addr_of "$MNEMONIC_VAR")" || { echo "$MNEMONIC_VAR is not a valid mnemonic"; exit 1; }
  if [ "$VENUE" = live ]; then
    if [ -n "$PUBLIC_DEPLOYER" ] && [ "$(echo "$PUBLIC_DEPLOYER" | tr '[:upper:]' '[:lower:]')" = "$(echo "$DEPLOYER" | tr '[:upper:]' '[:lower:]')" ]; then
      echo "BKRN_TESTNET_LIVE_MNEMONIC derives the public testnet stack's deployer $DEPLOYER: the rehearsal needs its own mnemonic"; exit 1
    fi
    [ -n "$PUBLIC_DEPLOYER" ] || echo "    note: no .env.testnet here: the live mnemonic was not compared with the public stack's"
  fi
  BAL=$(check balance --rpc "$RPC" --address "$DEPLOYER")
  echo "==> Robinhood Chain testnet via $RPC (venue: $VENUE, record $REC)"
  echo "    deployer $DEPLOYER balance $BAL ETH (need >= $MIN_ETH incl. gas for service keys)"
  if ! awk -v b="$BAL" -v m="$MIN_ETH" 'BEGIN { exit !(b + 0 >= m + 0) }'; then
    echo "    fund it from https://faucet.testnet.chain.robinhood.com (or set DEPLOY_MIN_ETH)"; exit 2
  fi

  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  ARCHIVE=0
  if [ -f "$REC" ]; then
    [ "${REDEPLOY:-0}" = "1" ] || { echo "$REC exists — set REDEPLOY=1 to deploy a fresh stack"; exit 3; }
    if [ "$VENUE" = live ]; then
      # never under a running rehearsal stack: its services hold the DB, the state and the Redis being archived
      if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet bookrunner@testnet-live 2>/dev/null; then
        echo "!! bookrunner@testnet-live is running: stop it first (sudo systemctl stop bookrunner@testnet-live)"; exit 7
      fi
      # all mode: the live Redis must answer with REDIS_LIVE_PASSWORD BEFORE anything is archived (the server wrapper
      # checks this itself, as root)
      if [ "$PHASE" = all ] && docker inspect bookrunner-redis-live-1 >/dev/null 2>&1 && [ "$(rcli_live PING | tr -d '\r')" != PONG ]; then
        echo "!! the live Redis (redis-live) refuses REDIS_LIVE_PASSWORD (missing or wrong): export it (docs/RUNBOOK.md step 3.1). Nothing archived."; exit 8
      fi
      if ! "$BUN" scripts/rehearsal-guard.ts --supervisor; then
        echo "!! the testnet-live supervisor is alive (fresh status key) or its Redis is unreadable: stop that stack first"; exit 7
      fi
      echo "==> REDEPLOY of the live rehearsal: are its books retired and empty? (read-only)"
      if ! "$BUN" scripts/rehearsal-guard.ts --record "$REC" --rpc "$RPC"; then
        if [ "${FORCE_ARCHIVE:-0}" != "1" ]; then
          echo "!! refusing: $REC lists books that are not Retired / Cancelled or hold USDG on Orderly. Retire them first"
          echo "!! (RUNBOOK rehearsal step 5), or set FORCE_ARCHIVE=1 to archive the record + DB + state and deploy anyway."; exit 6
        fi
        echo "!! ===================================================================================================="
        echo "!! FORCE_ARCHIVE=1: replacing a live record whose books may still hold REAL testnet USDG on Orderly."
        echo "!! The archived record and .data/testnet-live keys below are the ONLY way back to those accounts: back them up."
        echo "!! ===================================================================================================="
      fi
      ARCHIVE=1
    fi
  fi

  if [ "$VENUE" = live ]; then
    # the gate runs BEFORE anything is archived: a venue that is not ready leaves the old record, DB and state in place
    echo "==> Orderly readiness, venue stage (read-only: the vault must allow USDG and broker $DEPLOY_ORDERLY_BROKER_ID)"
    RHC_TESTNET_RPC_URL="$RPC" "$BUN" scripts/orderly-readiness.ts --stage venue --broker "$DEPLOY_ORDERLY_BROKER_ID" \
      || { echo "    Orderly has not enabled the testnet venue for us yet (RUNBOOK rehearsal step R1): nothing deployed or archived"; exit 5; }
  fi
  if [ "$PHASE" = check ]; then
    # the plan the root wrapper acts on (it parses these exact keys, never evaluates the file)
    mkdir -p "$(dirname "$PLAN")"
    printf 'VENUE=%s\nARCHIVE=%s\nSTAMP=%s\nDEPLOYER=%s\nDB=%s\n' "$VENUE" "$ARCHIVE" "$STAMP" "$DEPLOYER" "$DB" > "$PLAN"
    echo "==> plan written to $PLAN (archive: $ARCHIVE)"
    exit 0
  fi
fi

# ============================================================== archive (files: as the stack user; docker: all mode)
if [ "$PHASE" = archive-files ]; then
  STAMP="${ARCHIVE_STAMP:?ARCHIVE_STAMP (from the plan) is required}"
  [[ "$STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "bad ARCHIVE_STAMP"; exit 1; }
  ARCHIVE=1
fi
if { [ "$PHASE" = all ] || [ "$PHASE" = archive-files ]; } && [ "${ARCHIVE:-0}" = 1 ]; then
  # archive, never delete: record, state (Orderly keys of the old accounts) with a dump of the old database and a
  # snapshot of the old live Redis inside it (so the daily backup carries them), then the database renamed and the
  # live Redis emptied (the new deployment's books 1, 2 must not read the old books' risk state / reports)
  AR="$STATE.$STAMP"
  cp -p "$REC" "${REC%.json}.$STAMP.json"
  echo "    archived $REC -> ${REC%.json}.$STAMP.json"
  if [ -d "$STATE" ]; then mv "$STATE" "$AR"; else mkdir -p "$AR"; fi
  chmod 0750 "$AR"
  echo "    archived $STATE -> $AR (Orderly keys of the old accounts)"
  if [ "$PHASE" = all ]; then
    if docker exec bookrunner-postgres-1 psql -U bookrunner -d bookrunner -tc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1; then
      ( umask 077; docker exec bookrunner-postgres-1 pg_dump -U bookrunner -Fc -d "$DB" > "$AR/postgres.dump" )
      DB_AR="${DB}_$(echo "$STAMP" | tr 'A-Z' 'a-z')"
      docker exec bookrunner-postgres-1 psql -U bookrunner -d bookrunner -c "ALTER DATABASE $DB RENAME TO $DB_AR" >/dev/null
      echo "    archived database $DB -> $DB_AR (dump in $AR/postgres.dump; drop the renamed DB by hand once no longer needed)"
    fi
    if docker inspect bookrunner-redis-live-1 >/dev/null 2>&1; then
      # every step checked (redis-cli prints an error reply but may exit 0): a failure stops here, loudly
      [ "$(rcli_live SAVE | tr -d '\r')" = OK ] || { echo "!! redis-live SAVE failed: the old Redis was NOT archived or emptied (state and DB are archived in $AR)"; exit 8; }
      docker cp bookrunner-redis-live-1:/data/dump.rdb "$AR/redis-live.rdb" || { echo "!! copying the redis-live snapshot failed"; exit 8; }
      [ "$(rcli_live FLUSHDB | tr -d '\r')" = OK ] || { echo "!! redis-live FLUSHDB failed: empty it before starting the new stack"; exit 8; }
      echo "    archived the live Redis snapshot -> $AR/redis-live.rdb, live Redis db 0 emptied"
    fi
  fi
  [ "$PHASE" = archive-files ] && exit 0
fi

# ============================================================== database
if [ "$PHASE" = all ]; then
  echo "==> testnet database $DB"
  docker exec bookrunner-postgres-1 psql -U bookrunner -d bookrunner -tc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 \
    || docker exec bookrunner-postgres-1 psql -U bookrunner -d bookrunner -c "CREATE DATABASE $DB" >/dev/null
fi
if [ "$PHASE" = all ] || [ "$PHASE" = migrate ]; then
  echo "==> migrations ($DB)"
  DATABASE_URL="postgres://bookrunner:${POSTGRES_PASSWORD:-bookrunner}@127.0.0.1:54400/$DB" "$BUN" run --cwd packages/db migrate
  [ "$PHASE" = migrate ] && exit 0
fi

# ============================================================== forge (all mode; the server wrapper runs its own docker)
if [ "$PHASE" = all ]; then
  echo "==> forge build"
  bash scripts/forge.sh build >/dev/null
  echo "==> Deploy.s.sol -> testnet"
  DEV_MNEMONIC="${!MNEMONIC_VAR}" NETWORK=testnet MARK_INTERVAL_SECONDS="${MARK_INTERVAL_SECONDS:-3600}" \
    bash scripts/forge.sh script script/Deploy.s.sol:Deploy --rpc-url "$FORGE_RPC" --broadcast --slow -q
fi

# ============================================================== finish
echo "==> startBlock from deploy receipts (on Arbitrum Orbit chains block.number is the PARENT chain's block)"
check start-block --record "$REC"
echo "==> verify on-chain (a partial broadcast must never pass silently)"
if [ "$VENUE" = live ]; then
  check verify --rpc "$RPC" --record "$REC" --live-token "$DEPLOY_SETTLEMENT_TOKEN" --live-vault "$DEPLOY_ORDERLY_VAULT"
else
  check verify --rpc "$RPC" --record "$REC"
fi
echo "==> ABIs"
"$BUN" scripts/gen-abi.ts >/dev/null
echo "==> done: $REC"
if [ "$VENUE" = live ]; then
  echo "    next: fund the live deployer with testnet USDG for the launch (and the live gas funder with ETH),"
  echo "          then start bookrunner@testnet-live (dev.ts --network testnet-live; docs/RUNBOOK.md \"Testnet rehearsal on real Orderly\")"
else
  echo "    next: $BUN scripts/dev.ts --network testnet"
fi
