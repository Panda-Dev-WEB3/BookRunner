#!/usr/bin/env bash
# Robinhood Chain TESTNET (46630) deployment of the Bookrunner core.
#   bash scripts/deploy-testnet.sh
# Then:  ./node_modules/.bin/bun scripts/dev.ts --network testnet   (first start launches NVDA / TSLA / RHX5)
#
# Keys: role keys derive from BKRN_TESTNET_MNEMONIC in .env.testnet (gitignored, generated locally).
# The deployer is index 0 and must hold testnet ETH (faucet: https://faucet.testnet.chain.robinhood.com).
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

CHAIN=$(cast chain-id --rpc-url "$RPC")
[ "$CHAIN" = "46630" ] || { echo "RPC $RPC is chain $CHAIN, expected 46630"; exit 1; }
DEPLOYER=$(cast wallet address --mnemonic "$BKRN_TESTNET_MNEMONIC" --mnemonic-index 0)
BAL=$(cast balance "$DEPLOYER" --rpc-url "$RPC" --ether)
echo "==> Robinhood Chain testnet via $RPC"
echo "    deployer $DEPLOYER balance $BAL ETH (need >= $MIN_ETH incl. gas for service keys)"
if ! awk -v b="$BAL" -v m="$MIN_ETH" 'BEGIN { exit !(b + 0 >= m + 0) }'; then
  echo "    fund it from https://faucet.testnet.chain.robinhood.com (or set DEPLOY_MIN_ETH)"; exit 2
fi

if [ -f contracts/deployments/46630.json ] && [ "${REDEPLOY:-0}" != "1" ]; then
  echo "contracts/deployments/46630.json exists — set REDEPLOY=1 to deploy a fresh stack"; exit 3
fi

echo "==> testnet database"
docker exec bookrunner-postgres-1 psql -U bookrunner -d bookrunner -tc "SELECT 1 FROM pg_database WHERE datname='bookrunner_testnet'" | grep -q 1 \
  || docker exec bookrunner-postgres-1 psql -U bookrunner -d bookrunner -c "CREATE DATABASE bookrunner_testnet" >/dev/null
DATABASE_URL="postgres://bookrunner:${POSTGRES_PASSWORD:-bookrunner}@127.0.0.1:54400/bookrunner_testnet" "$BUN" run --cwd packages/db migrate

echo "==> forge build"
bash scripts/forge.sh build >/dev/null

echo "==> Deploy.s.sol -> testnet"
DEV_MNEMONIC="$BKRN_TESTNET_MNEMONIC" NETWORK=testnet MARK_INTERVAL_SECONDS="${MARK_INTERVAL_SECONDS:-3600}" \
  bash scripts/forge.sh script script/Deploy.s.sol:Deploy --rpc-url "$FORGE_RPC" --broadcast --slow -q

echo "==> startBlock from deploy receipts (on Arbitrum Orbit chains block.number is the PARENT chain's block)"
node -e '
const fs=require("fs");const r=JSON.parse(fs.readFileSync("contracts/broadcast/Deploy.s.sol/46630/run-latest.json","utf8"));
const b=(r.receipts||[]).map(x=>parseInt(x.blockNumber,16)).filter(Boolean);if(!b.length)throw new Error("no receipts");
const p="contracts/deployments/46630.json";const d=JSON.parse(fs.readFileSync(p,"utf8"));d.startBlock=Math.min(...b)-1;
fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n");console.log("    startBlock",d.startBlock);'

echo "==> verify on-chain (a partial broadcast must never pass silently)"
CFG=$(node -e 'console.log(require("./contracts/deployments/46630.json").contracts.config)')
REG=$(node -e 'console.log(require("./contracts/deployments/46630.json").contracts.stockRegistry)')
FAC=$(node -e 'console.log(require("./contracts/deployments/46630.json").contracts.factory)')
[ "$(cast code "$CFG" --rpc-url "$RPC" | wc -c)" -gt 10 ] || { echo "config has no code at $CFG"; exit 4; }
NTOK=$(cast call "$REG" "tokens()(address[])" --rpc-url "$RPC" | tr ',' '\n' | grep -c 0x)
[ "$NTOK" -ge 5 ] || { echo "stock registry has $NTOK tokens (expected 5) — broadcast incomplete"; exit 4; }
[ "$(cast call "$FAC" "implementation(bytes32)(address)" "$(cast --format-bytes32-string BOOK)" --rpc-url "$RPC")" != "0x0000000000000000000000000000000000000000" ] || { echo "factory implementations not set"; exit 4; }
echo "    ok: config, 5 stock tokens, factory implementations"

echo "==> ABIs"
"$BUN" scripts/gen-abi.ts >/dev/null
echo "==> done: contracts/deployments/46630.json"
echo "    explorer: https://explorer.testnet.chain.robinhood.com/address/$(node -e 'console.log(require("./contracts/deployments/46630.json").contracts.config)')"
echo "    next: $BUN scripts/dev.ts --network testnet"
