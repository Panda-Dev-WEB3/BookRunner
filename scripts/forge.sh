#!/usr/bin/env bash
# Runs Foundry (forge/cast/anvil/chisel) inside the official Docker image against ./contracts.
# Native forge.exe is blocked on some Windows hosts by application-control policy; this wrapper
# is the supported path. Works from any git worktree: it mounts the contracts dir next to it.
#
#   scripts/forge.sh build
#   scripts/forge.sh test -vvv --match-contract WaterfallTest
#   FOUNDRY_TOOL=cast scripts/forge.sh call ...
#   FORGE_SUBDIR=cache/mutation-ws/Tranche scripts/forge.sh test   (runs in that directory under contracts/)
#
# RPC on the host (anvil from docker-compose) is reachable as http://host.docker.internal:8547
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TOOL="${FOUNDRY_TOOL:-forge}"
# Pinned by digest (supply chain: this container sees deploy keys). Tag: ghcr.io/foundry-rs/foundry:v1.8.1 (forge 1.8.1,
# also :latest on 2026-08-28). To bump: docker buildx imagetools inspect ghcr.io/foundry-rs/foundry:<tag>, run the
# full suite, then update this digest and its copies (docker-compose.yml anvil, the gen-fixtures.ts comment) together:
# CI reads the digest from this line, and scripts/image-pins.test.ts fails while any copy differs.
IMAGE="${FOUNDRY_IMAGE:-ghcr.io/foundry-rs/foundry@sha256:0c00cb0bda1ab1b91c9a6bf60f4c76c09c1a8870824b6d4718afbabacf6f9a17}"

# Convert MSYS path (/d/foo) to a Docker Desktop path (D:/foo) when on Windows Git Bash.
MOUNT="$ROOT"
if [[ "$MOUNT" =~ ^/([a-zA-Z])/(.*)$ ]]; then
  MOUNT="${BASH_REMATCH[1]^^}:/${BASH_REMATCH[2]}"
fi

TTY_FLAGS=()
if [ -t 1 ]; then TTY_FLAGS=(-t); fi
# stdin attached when interactive: `forge script ... --interactive` (deploy-mainnet.sh) prompts for the key
if [ -t 0 ] && [ -t 1 ]; then TTY_FLAGS=(-i -t); fi

# Extra docker run flags, e.g. FORGE_DOCKER_ARGS="--cpus=2 --memory=3g" to cap a long run (scripts/mutation.sh).
# Empty by default: normal use is unchanged.
read -r -a EXTRA_DOCKER_ARGS <<<"${FORGE_DOCKER_ARGS:-}"

MSYS_NO_PATHCONV=1 exec docker run --rm "${TTY_FLAGS[@]}" "${EXTRA_DOCKER_ARGS[@]}" \
  -v "$MOUNT:/repo" \
  --user root -e HOME=/root -v bookrunner-svm:/root/.svm \
  -v bookrunner-foundry-cache:/root/.foundry/cache \
  -w "/repo/contracts${FORGE_SUBDIR:+/$FORGE_SUBDIR}" \
  --add-host=host.docker.internal:host-gateway \
  -e FOUNDRY_PROFILE="${FOUNDRY_PROFILE:-default}" \
  -e ETH_RPC_URL -e PRIVATE_KEY -e DEPLOY_OUT \
  -e DEV_MNEMONIC -e NETWORK -e MARK_INTERVAL_SECONDS -e TREASURY_ADDRESS -e SLASH_RECIPIENT_ADDRESS \
  -e DEPLOY_ORDERLY_BROKER_ID -e DEPLOY_ORDERLY_TOKEN -e MIGRATE_ORDERLY_ACCOUNTS -e DEPLOY_VENUE_MIN_IF_ORDERLY \
  -e DEPLOY_ORDERLY_VAULT -e DEPLOY_SETTLEMENT_TOKEN -e DEPLOY_CHARTER_FEE_USD \
  -e DEPLOY_INPUT -e REHEARSAL \
  --entrypoint "$TOOL" \
  "$IMAGE" "$@"
