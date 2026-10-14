#!/usr/bin/env bash
# Run a command for the overview video (video/) inside Docker: Remotion's compositor and headless Chrome are
# Linux binaries here (Windows application control blocks native binaries under node_modules on this PC).
#   bash scripts/video.sh npm ci
#   bash scripts/video.sh npm run stills
#   bash scripts/video.sh footage     # record the live testnet pages (Playwright image) into video/public/footage/
#   bash scripts/video.sh app-build   # testnet build of apps/web (base /app/, API same-origin) for the demo harness
#   bash scripts/video.sh demo smoke  # demo harness (Playwright image): runs video/demo/<script>.mjs [args]
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
if [ "${1:-}" = app-build ]; then
  # Testnet build of apps/web for the demo harness (same settings as deploy/server/update.sh) into apps/web/dist, on
  # the host: vite runs through node (bun-spawned vite / .bin shims are blocked by application control on this PC).
  # MSYS_NO_PATHCONV: Git Bash would otherwise rewrite WEB_BASE=/app/ into a Windows path.
  BUN="$ROOT/node_modules/bun/bin/bun.exe"; [ -x "$BUN" ] || BUN=bun
  (cd "$ROOT" && "$BUN" install --frozen-lockfile)
  rm -rf "$ROOT/apps/web/dist"
  (cd "$ROOT/apps/web" && MSYS_NO_PATHCONV=1 VITE_API_URL=same-origin WEB_BASE=/app/ node node_modules/vite/bin/vite.js build --mode testnet)
  grep -q 'src="/app/assets/' "$ROOT/apps/web/dist/index.html" || { echo "apps/web/dist/index.html is not built for base /app/" >&2; exit 1; }
  echo "apps/web/dist: testnet build, base /app/, API same-origin"
  exit 0
fi
if [ "${1:-}" = demo ]; then
  # Product demos: video/demo/<script>.mjs in the Playwright image, with the apps/web testnet build mounted read-only at
  # /app-dist (build it first: video/README.md). Playwright + viem live in their own named node_modules volume under
  # /pw; the scripts are copied there so their imports resolve. Outputs and the demo key stay under /work (= video/).
  SCRIPT="${2:?usage: bash scripts/video.sh demo <script> [args]   (video/demo/<script>.mjs)}"
  case "$SCRIPT" in *[!A-Za-z0-9-]*) echo "bad script name: $SCRIPT" >&2; exit 2 ;; esac
  [ -f "$ROOT/video/demo/$SCRIPT.mjs" ] || { echo "no video/demo/$SCRIPT.mjs" >&2; exit 2; }
  shift 2
  DIST="$ROOT/apps/web/dist"
  [ -f "$DIST/index.html" ] || [ "$SCRIPT" = new-wallet ] || { echo "apps/web/dist missing: build the app first (video/README.md, Demo harness)" >&2; exit 1; }
  mkdir -p "$DIST"; command -v cygpath >/dev/null && DIST="$(cygpath -w "$DIST")"
  MSYS_NO_PATHCONV=1 exec docker run --rm -i --ipc=host \
    -v "$HOSTDIR:/work" \
    -v "$DIST:/app-dist:ro" \
    -v bookrunner-video-demo-node-modules:/pw/node_modules \
    -e DEMO_VIDEO_DIR=/work -e APP_DIST=/app-dist \
    -w /pw \
    mcr.microsoft.com/playwright:v1.64.1-noble \
    sh -c 'set -e
      grep -qs "\"version\": \"1.64.1\"" node_modules/playwright/package.json && grep -qs "\"version\": \"2.57.2\"" node_modules/viem/package.json \
        || npm i --no-save --no-package-lock --no-audit --no-fund playwright@1.64.1 viem@2.57.2 >/dev/null
      rm -rf /pw/demo && cp -r /work/demo /pw/demo
      s="$1"; shift; exec node "/pw/demo/$s.mjs" "$@"' demo "$SCRIPT" "$@"
fi
IMAGE=bookrunner-video:1
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -t "$IMAGE" "$ROOT/video"
MSYS_NO_PATHCONV=1 exec docker run --rm -i \
  -v "$HOSTDIR:/work" \
  -v bookrunner-video-node-modules:/work/node_modules \
  -v bookrunner-video-cache:/root/.cache \
  "$IMAGE" "$@"
