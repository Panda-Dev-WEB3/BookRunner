#!/usr/bin/env bash
# Run a command for the overview video (video/) inside Docker: Remotion's compositor and headless Chrome are
# Linux binaries here (Windows application control blocks native binaries under node_modules on this PC).
#   bash scripts/video.sh npm ci
#   bash scripts/video.sh npm run stills
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE=bookrunner-video:1
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -t "$IMAGE" "$ROOT/video"
HOSTDIR="$ROOT/video"; command -v cygpath >/dev/null && HOSTDIR="$(cygpath -w "$HOSTDIR")"
MSYS_NO_PATHCONV=1 exec docker run --rm -i \
  -v "$HOSTDIR:/work" \
  -v bookrunner-video-node-modules:/work/node_modules \
  -v bookrunner-video-cache:/root/.cache \
  "$IMAGE" "$@"
