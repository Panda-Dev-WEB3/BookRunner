#!/usr/bin/env bash
# Runs Foundry (forge/cast/anvil/chisel) inside the official Docker image against ./contracts.
# Native forge.exe is blocked on some Windows hosts by application-control policy; this wrapper
# is the supported path. Works from any git worktree: it mounts the contracts dir next to it.
#
#   scripts/forge.sh build
#   scripts/forge.sh test -vvv --match-contract WaterfallTest
#   FOUNDRY_TOOL=cast scripts/forge.sh call ...
#
# RPC on the host (anvil from docker-compose) is reachable as http://host.docker.internal:8547
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TOOL="${FOUNDRY_TOOL:-forge}"
IMAGE="${FOUNDRY_IMAGE:-ghcr.io/foundry-rs/foundry:latest}"

# Convert MSYS path (/d/foo) to a Docker Desktop path (D:/foo) when on Windows Git Bash.
MOUNT="$ROOT"
if [[ "$MOUNT" =~ ^/([a-zA-Z])/(.*)$ ]]; then
  MOUNT="${BASH_REMATCH[1]^^}:/${BASH_REMATCH[2]}"
fi

TTY_FLAGS=()
if [ -t 1 ]; then TTY_FLAGS=(-t); fi
# stdin attached when interactive: `forge script ... --interactive` (deploy-mainnet.sh) prompts for the key
if [ -t 0 ] && [ -t 1 ]; then TTY_FLAGS=(-i -t); fi

MSYS_NO_PATHCONV=1 exec docker run --rm "${TTY_FLAGS[@]}" \
  -v "$MOUNT:/repo" \
  --user root -e HOME=/root -v bookrunner-svm:/root/.svm \
  -v bookrunner-foundry-cache:/root/.foundry/cache \
  -w /repo/contracts \
  --add-host=host.docker.internal:host-gateway \
  -e FOUNDRY_PROFILE="${FOUNDRY_PROFILE:-default}" \
  -e ETH_RPC_URL -e PRIVATE_KEY -e DEPLOY_OUT \
  -e DEV_MNEMONIC -e NETWORK -e MARK_INTERVAL_SECONDS -e TREASURY_ADDRESS -e SLASH_RECIPIENT_ADDRESS \
  -e DEPLOY_ORDERLY_BROKER_ID -e DEPLOY_ORDERLY_TOKEN -e MIGRATE_ORDERLY_ACCOUNTS \
  -e DEPLOY_INPUT -e REHEARSAL \
  --entrypoint "$TOOL" \
  "$IMAGE" "$@"
