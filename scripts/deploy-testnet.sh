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
DATABASE_URL=postgres://bookrunner:bookrunner@127.0.0.1:54400/bookrunner_testnet "$BUN" run --cwd packages/db migrate

echo "==> forge build"
bash scripts/forge.sh build >/dev/null

echo "==> Deploy.s.sol -> testnet"
DEV_MNEMONIC="$BKRN_TESTNET_MNEMONIC" NETWORK=testnet MARK_INTERVAL_SECONDS="${MARK_INTERVAL_SECONDS:-300}" \
  bash scripts/forge.sh script script/Deploy.s.sol:Deploy --rpc-url "$FORGE_RPC" --broadcast --slow -q

echo "==> ABIs"
"$BUN" scripts/gen-abi.ts >/dev/null
echo "==> done: contracts/deployments/46630.json"
echo "    explorer: https://explorer.testnet.chain.robinhood.com/address/$(node -e 'console.log(require("./contracts/deployments/46630.json").contracts.config)')"
echo "    next: $BUN scripts/dev.ts --network testnet"
