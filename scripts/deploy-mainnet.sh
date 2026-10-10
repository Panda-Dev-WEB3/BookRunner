#!/usr/bin/env bash
# Robinhood Chain MAINNET (4663) deployment + governance handover (contracts/script/DeployMainnet.s.sol) and its
# read-only post-condition check (contracts/script/VerifyHandover.s.sol). docs/RUNBOOK.md "Mainnet" is the
# operator checklist around it. REHEARSAL=1 runs the identical code path on testnet 46630 with real testnet
# externals (input deploy-inputs/46630.json, "network": "rehearsal").
#
#   RHC_RPC_URL=<archive rpc> bash scripts/deploy-mainnet.sh simulate              # dry run: every check + the plan, no tx
#   RHC_RPC_URL=<archive rpc> bash scripts/deploy-mainnet.sh broadcast [wallet]     # the deploy (asks to confirm)
#   RHC_RPC_URL=<archive rpc> bash scripts/deploy-mainnet.sh verify                 # VerifyHandover against the chain
#
# [wallet] = forge wallet flags for the one-shot deployer (default --interactive: the key is typed once, never
# stored; or --ledger / --trezor / --account <keystore> on a native forge). The deployer EOA is fresh, funded with
# just enough ETH for the broadcast, and holds NOTHING afterwards (VerifyHandover asserts it).
# Input: contracts/deploy-inputs/<chainId>.json (copy of 4663.example.json, schema in deploy-inputs/README.md),
# or DEPLOY_INPUT=deploy-inputs/<file>.json (relative to contracts/).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MODE="${1:-simulate}"
shift || true

if [ "${REHEARSAL:-0}" = "1" ]; then
  EXPECTED=46630
  RPC="${RHC_TESTNET_RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
else
  EXPECTED=4663
  RPC="${RHC_RPC_URL:?RHC_RPC_URL (mainnet archive RPC) is not set}"
fi
# forge / cast read the RPC from the environment (forge.sh forwards ETH_RPC_URL): the URL, which may carry an
# API key, never appears on a command line
export ETH_RPC_URL="${FORGE_RPC_URL:-$RPC}"
export DEPLOY_INPUT="${DEPLOY_INPUT:-deploy-inputs/$EXPECTED.json}"
export REHEARSAL="${REHEARSAL:-0}"
# the rehearsal record never touches the testnet stack's contracts/deployments/46630.json
if [ "$EXPECTED" = 4663 ]; then OUT="contracts/deployments/4663.json"; else OUT="contracts/deployments/46630.rehearsal.json"; fi
unset DEPLOY_OUT # DeployMainnet / VerifyHandover use the default record path above

cast_() { FOUNDRY_TOOL=cast bash scripts/forge.sh "$@" | tr -d '\r'; }
die() { echo "deploy-mainnet: $*" >&2; exit 1; }
# startBlock from the deploy receipts (on Arbitrum Orbit chains block.number is the PARENT chain's block)
fix_start_block() {
  local run="contracts/broadcast/DeployMainnet.s.sol/$EXPECTED/run-latest.json"
  [ -f "$run" ] || { echo "    (no $run: startBlock left as recorded)"; return 0; }
  node -e '
const fs=require("fs");const [run,p]=process.argv.slice(1);const r=JSON.parse(fs.readFileSync(run,"utf8"));
const b=(r.receipts||[]).map(x=>parseInt(x.blockNumber,16)).filter(Boolean);if(!b.length)throw new Error("no receipts");
const d=JSON.parse(fs.readFileSync(p,"utf8"));d.startBlock=Math.min(...b)-1;fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n");console.log("    startBlock",d.startBlock);' \
    "$run" "$OUT"
}

[ -f "contracts/$DEPLOY_INPUT" ] || die "input contracts/$DEPLOY_INPUT missing (copy contracts/deploy-inputs/4663.example.json and fill it)"
CHAIN=$(cast_ chain-id)
[ "$CHAIN" = "$EXPECTED" ] || die "RPC is chain $CHAIN, expected $EXPECTED"
DEPLOYER=$(node -e 'const j=require(process.argv[1]);if(j.chainId!==Number(process.argv[2]))throw new Error("input chainId "+j.chainId);console.log(j.deployer)' "$ROOT/contracts/$DEPLOY_INPUT" "$EXPECTED")
echo "==> chain $CHAIN ($([ "$EXPECTED" = 4663 ] && echo MAINNET || echo REHEARSAL)), input contracts/$DEPLOY_INPUT, deployer $DEPLOYER"

case "$MODE" in
  simulate)
    echo "==> forge build"
    bash scripts/forge.sh build >/dev/null
    echo "==> DeployMainnet dry run (validate input, check externals on-chain, simulate every tx; nothing is sent)"
    bash scripts/forge.sh script script/DeployMainnet.s.sol:DeployMainnet --sender "$DEPLOYER"
    echo "==> ok: plan in contracts/broadcast/DeployMainnet.s.sol/$EXPECTED/dry-run/, record contracts/deployments/$EXPECTED.simulation.json"
    echo "    deployer balance: $(cast_ balance "$DEPLOYER" --ether) ETH"
    ;;

  broadcast)
    [ ! -f "$OUT" ] || die "$OUT exists: a deployment is already recorded (move it away deliberately to redeploy)"
    WALLET=("$@")
    [ ${#WALLET[@]} -gt 0 ] || WALLET=(--interactive)
    echo "==> forge build"
    bash scripts/forge.sh build >/dev/null
    printf 'Type the chain id (%s) to BROADCAST the deployment from %s: ' "$EXPECTED" "$DEPLOYER"
    read -r CONFIRM
    [ "$CONFIRM" = "$EXPECTED" ] || die "not confirmed"
    # forge writes $OUT while executing the script, BEFORE it sends the transactions: after a failed / partial
    # broadcast the record exists but VerifyHandover fails (RUNBOOK "Rollback and incidents")
    RESUME="bash scripts/forge.sh script script/DeployMainnet.s.sol:DeployMainnet --sender $DEPLOYER --broadcast --slow --resume ${WALLET[*]}"
    bash scripts/forge.sh script script/DeployMainnet.s.sol:DeployMainnet --sender "$DEPLOYER" --broadcast --slow "${WALLET[@]}" \
      || die "broadcast failed or incomplete: do NOT start services. Resume with (same env): $RESUME ; then: FIX_START_BLOCK=1 bash scripts/deploy-mainnet.sh verify"
    [ -f "$OUT" ] || die "broadcast finished without $OUT"

    fix_start_block
    echo "==> VerifyHandover (read-only)"
    bash scripts/forge.sh script script/VerifyHandover.s.sol:VerifyHandover
    echo "==> ABIs"
    BUN="$ROOT/node_modules/.bin/bun"; [ -x "$BUN" ] || BUN="$ROOT/node_modules/bun/bin/bun.exe"
    "$BUN" scripts/gen-abi.ts >/dev/null
    echo "==> done: $OUT — archive it with the input (gitignored: the services host appends books to it)"
    ;;

  verify)
    [ -f "$OUT" ] || die "$OUT missing"
    [ "${FIX_START_BLOCK:-0}" = "1" ] && fix_start_block # after a --resume
    bash scripts/forge.sh script script/VerifyHandover.s.sol:VerifyHandover
    ;;

  *)
    die "usage: deploy-mainnet.sh simulate | broadcast [forge wallet flags] | verify"
    ;;
esac
