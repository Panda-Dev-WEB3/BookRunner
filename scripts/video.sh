#!/usr/bin/env bash
# Run a command for the overview video (video/) inside Docker: Remotion's compositor and headless Chrome are
# Linux binaries here (Windows application control blocks native binaries under node_modules on this PC).
#   bash scripts/video.sh npm ci
#   bash scripts/video.sh npm run stills
#   bash scripts/video.sh footage     # record the live testnet pages (Playwright image) into video/public/footage/
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOSTDIR="$ROOT/video"; command -v cygpath >/dev/null && HOSTDIR="$(cygpath -w "$HOSTDIR")"
if [ "${1:-}" = footage ]; then
  # Playwright is installed in /pw (its own named node_modules volume), apart from the Remotion install and from
  # video/package.json; the recorder is copied there so `import "playwright"` resolves. It writes to /work/public/footage.
  MSYS_NO_PATHCONV=1 exec docker run --rm -i --ipc=host \
    -v "$HOSTDIR:/work" \
    -v bookrunner-video-footage-node-modules:/pw/node_modules \
    -w /pw \
    mcr.microsoft.com/playwright:v1.64.1-noble \
    sh -c "npm i --no-save --no-package-lock --no-audit --no-fund playwright@1.64.1 && cp /work/scripts/record-footage.mjs /pw/ && node /pw/record-footage.mjs"
fi
IMAGE=bookrunner-video:1
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -t "$IMAGE" "$ROOT/video"
MSYS_NO_PATHCONV=1 exec docker run --rm -i \
  -v "$HOSTDIR:/work" \
  -v bookrunner-video-node-modules:/work/node_modules \
  -v bookrunner-video-cache:/root/.cache \
  "$IMAGE" "$@"
