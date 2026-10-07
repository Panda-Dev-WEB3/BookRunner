#!/usr/bin/env bash
# Devnet deployment: core contracts (forge script in Docker) -> ABIs -> launch books (viem).
#   bash scripts/deploy-local.sh            # deploy core (bun run dev then launches the books)
#   LAUNCH=1 bash scripts/deploy-local.sh   # also launch the books standalone (fallback jury/keeper)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
BUN="$ROOT/node_modules/.bin/bun"
[ -x "$BUN" ] || BUN="$ROOT/node_modules/.bin/bun.exe"

# anvil default account #0 (test mnemonic) — devnet only
PK="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
RPC_IN_DOCKER="${RPC_URL_DOCKER:-http://host.docker.internal:8547}"
mkdir -p contracts/deployments

echo "==> forge build"
bash scripts/forge.sh build >/dev/null

echo "==> Deploy.s.sol -> $RPC_IN_DOCKER"
PRIVATE_KEY="$PK" bash scripts/forge.sh script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_IN_DOCKER" --broadcast --slow -q

echo "==> ABIs"
"$BUN" scripts/gen-abi.ts >/dev/null

if [ "${LAUNCH:-0}" = "1" ]; then
  echo "==> launch books"
  "$BUN" scripts/launch-devnet.ts
fi
echo "==> done: contracts/deployments/31337.json"
