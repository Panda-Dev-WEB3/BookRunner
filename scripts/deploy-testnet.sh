#!/usr/bin/env bash
# Robinhood Chain TESTNET (46630) deployment of the Bookrunner core.
#   bash scripts/deploy-testnet.sh                      # mock venue (MockOrderlyVault + mock USDC): contracts/deployments/46630.json
#   ORDERLY_VENUE=live bash scripts/deploy-testnet.sh   # live-Orderly rehearsal: the REAL Orderly testnet vault + testnet USDG,
#                                                       # contracts/deployments/46630.live.json, database bookrunner_testnet_live
# Then:  ./node_modules/.bin/bun scripts/dev.ts --network testnet   (first start launches the books; live: ORDERLY_MODE=live
#        in .env.testnet selects the live record, docs/RUNBOOK.md "Testnet rehearsal on real Orderly")
#
# Keys: role keys derive from BKRN_TESTNET_MNEMONIC in .env.testnet (gitignored, generated locally).
# The deployer is index 0 and must hold testnet ETH (faucet: https://faucet.testnet.chain.robinhood.com).
# Live venue: Deploy.s.sol refuses unless Orderly's vault allows USDG and broker `bookrunner` (getAllowedToken /
# getAllowedBroker); this script runs `scripts/orderly-readiness.ts --stage venue` (read-only) first. Stock Tokens, the
# swap router and prices stay mock / synthetic (no Stock Tokens / Chainlink / Uniswap on RH testnet, VERIFY T3 / C4).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
BUN="$ROOT/node_modules/.bin/bun"
[ -x "$BUN" ] || BUN="$ROOT/node_modules/.bin/bun.exe"

[ -f .env.testnet ] || { echo ".env.testnet missing (needs BKRN_TESTNET_MNEMONIC)"; exit 1; }
set -a; . ./.env.testnet; set +a
: "${BKRN_TESTNET_MNEMONIC:?BKRN_TESTNET_MNEMONIC not set in .env.testnet}"
# the oracle refuses synthetic prices on a public chain without a secret seed (services/oracle config.ts)
: "${ORACLE_SEED:?ORACLE_SEED not set in .env.testnet: add one with  echo ORACLE_SEED=\$(openssl rand -hex 32) >> .env.testnet}"
# the deployer (protocol admin) derives from the mnemonic only with this opt-in (packages/shared devkeys.ts)
export BKRN_ALLOW_ADMIN_KEY=1
RPC="${RHC_TESTNET_RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
# forge runs in Docker: for a local rehearsal chain pass FORGE_RPC_URL=http://host.docker.internal:<port>
FORGE_RPC="${FORGE_RPC_URL:-$RPC}"
MIN_ETH="${DEPLOY_MIN_ETH:-0.03}"

VENUE="${ORDERLY_VENUE:-mock}"
case "$VENUE" in
  mock)
    REC=contracts/deployments/46630.json; DB=bookrunner_testnet
    if [ -n "${DEPLOY_ORDERLY_VAULT:-}${DEPLOY_SETTLEMENT_TOKEN:-}" ]; then
      echo "DEPLOY_ORDERLY_VAULT / DEPLOY_SETTLEMENT_TOKEN set: use ORDERLY_VENUE=live (separate record 46630.live.json)"; exit 1
    fi
    unset DEPLOY_OUT ;;
  live)
    REC=contracts/deployments/46630.live.json; DB=bookrunner_testnet_live
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

CHAIN=$(cast chain-id --rpc-url "$RPC")
[ "$CHAIN" = "46630" ] || { echo "RPC $RPC is chain $CHAIN, expected 46630"; exit 1; }
DEPLOYER=$(cast wallet address --mnemonic "$BKRN_TESTNET_MNEMONIC" --mnemonic-index 0)
BAL=$(cast balance "$DEPLOYER" --rpc-url "$RPC" --ether)
echo "==> Robinhood Chain testnet via $RPC (venue: $VENUE, record $REC)"
echo "    deployer $DEPLOYER balance $BAL ETH (need >= $MIN_ETH incl. gas for service keys)"
if ! awk -v b="$BAL" -v m="$MIN_ETH" 'BEGIN { exit !(b + 0 >= m + 0) }'; then
  echo "    fund it from https://faucet.testnet.chain.robinhood.com (or set DEPLOY_MIN_ETH)"; exit 2
fi

if [ -f "$REC" ] && [ "${REDEPLOY:-0}" != "1" ]; then
  echo "$REC exists — set REDEPLOY=1 to deploy a fresh stack"; exit 3
fi

if [ "$VENUE" = live ]; then
  echo "==> Orderly readiness, venue stage (read-only: the vault must allow USDG and broker $DEPLOY_ORDERLY_BROKER_ID)"
  RHC_TESTNET_RPC_URL="$RPC" "$BUN" scripts/orderly-readiness.ts --stage venue --broker "$DEPLOY_ORDERLY_BROKER_ID" \
    || { echo "    Orderly has not enabled the testnet venue for us yet (RUNBOOK rehearsal step R1): nothing deployed"; exit 5; }
fi

echo "==> testnet database $DB"
docker exec bookrunner-postgres-1 psql -U bookrunner -d bookrunner -tc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 \
  || docker exec bookrunner-postgres-1 psql -U bookrunner -d bookrunner -c "CREATE DATABASE $DB" >/dev/null
DATABASE_URL="postgres://bookrunner:${POSTGRES_PASSWORD:-bookrunner}@127.0.0.1:54400/$DB" "$BUN" run --cwd packages/db migrate

echo "==> forge build"
bash scripts/forge.sh build >/dev/null

echo "==> Deploy.s.sol -> testnet"
DEV_MNEMONIC="$BKRN_TESTNET_MNEMONIC" NETWORK=testnet MARK_INTERVAL_SECONDS="${MARK_INTERVAL_SECONDS:-3600}" \
  bash scripts/forge.sh script script/Deploy.s.sol:Deploy --rpc-url "$FORGE_RPC" --broadcast --slow -q

echo "==> startBlock from deploy receipts (on Arbitrum Orbit chains block.number is the PARENT chain's block)"
node -e '
const fs=require("fs");const r=JSON.parse(fs.readFileSync("contracts/broadcast/Deploy.s.sol/46630/run-latest.json","utf8"));
const b=(r.receipts||[]).map(x=>parseInt(x.blockNumber,16)).filter(Boolean);if(!b.length)throw new Error("no receipts");
const p=process.env.REC;const d=JSON.parse(fs.readFileSync(p,"utf8"));d.startBlock=Math.min(...b)-1;
fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n");console.log("    startBlock",d.startBlock);'

echo "==> verify on-chain (a partial broadcast must never pass silently)"
field() { node -e 'console.log(require("./"+process.env.REC).contracts[process.argv[1]])' "$1"; }
CFG=$(field config); REG=$(field stockRegistry); FAC=$(field factory)
[ "$(cast code "$CFG" --rpc-url "$RPC" | wc -c)" -gt 10 ] || { echo "config has no code at $CFG"; exit 4; }
NTOK=$(cast call "$REG" "tokens()(address[])" --rpc-url "$RPC" | tr ',' '\n' | grep -c 0x)
[ "$NTOK" -ge 5 ] || { echo "stock registry has $NTOK tokens (expected 5) — broadcast incomplete"; exit 4; }
[ "$(cast call "$FAC" "implementation(bytes32)(address)" "$(cast --format-bytes32-string BOOK)" --rpc-url "$RPC")" != "0x0000000000000000000000000000000000000000" ] || { echo "factory implementations not set"; exit 4; }
if [ "$VENUE" = live ]; then
  lc() { tr '[:upper:]' '[:lower:]'; }
  [ "$(cast call "$CFG" "usdc()(address)" --rpc-url "$RPC" | lc)" = "$(echo "$DEPLOY_SETTLEMENT_TOKEN" | lc)" ] || { echo "config.usdc() is not $DEPLOY_SETTLEMENT_TOKEN"; exit 4; }
  [ "$(cast call "$CFG" "orderlyVault()(address)" --rpc-url "$RPC" | lc)" = "$(echo "$DEPLOY_ORDERLY_VAULT" | lc)" ] || { echo "config.orderlyVault() is not $DEPLOY_ORDERLY_VAULT"; exit 4; }
  echo "    ok: config.usdc() = $DEPLOY_SETTLEMENT_TOKEN, config.orderlyVault() = $DEPLOY_ORDERLY_VAULT (no mock venue)"
fi
echo "    ok: config, 5 stock tokens, factory implementations"

echo "==> ABIs"
"$BUN" scripts/gen-abi.ts >/dev/null
echo "==> done: $REC"
echo "    explorer: https://explorer.testnet.chain.robinhood.com/address/$CFG"
if [ "$VENUE" = live ]; then
  echo "    next: fund the deployer with testnet USDG for the launch, set ORDERLY_MODE=live + ORDERLY_BUILDER_KEY_SECRET in .env.testnet,"
  echo "          then $BUN scripts/dev.ts --network testnet (docs/RUNBOOK.md \"Testnet rehearsal on real Orderly\")"
else
  echo "    next: $BUN scripts/dev.ts --network testnet"
fi
