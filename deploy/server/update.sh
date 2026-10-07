#!/usr/bin/env bash
# Update the server to origin/main: pull, install, build + publish the public site and the operator app,
# install the nginx locations snippet, restart the stack.
#   sudo bash /opt/bookrunner/app/deploy/server/update.sh            # full update (stack restarts, ~20 s)
#   sudo bash /opt/bookrunner/app/deploy/server/update.sh --web-only # site + app + nginx snippet, no stack restart
#
# Layout under /var/www/bookrunner (nginx: nginx-bookrunner-locations.conf):
#   /       apps/site/dist   public site (multi-page static tree)
#   /app/   apps/web/dist    operator app (vite base /app/; API stays at /trpc + /health on the host root)
set -euo pipefail
APP=/opt/bookrunner/app
HERE="$APP/deploy/server"
WWW=/var/www/bookrunner
# same-origin: the app calls /trpc + /health on whatever host served it (nginx proxies them to the API)
API_URL="${API_URL:-same-origin}"
AS=(sudo -u bookrunner HOME=/opt/bookrunner)
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
cd "$APP"

if [ -z "${BOOKRUNNER_UPDATE_REEXEC:-}" ]; then
  before="$("${AS[@]}" git rev-parse HEAD)"
  "${AS[@]}" git fetch -q origin main
  "${AS[@]}" git merge -q --ff-only origin/main
  # bash reads a script as it runs: when this file changed in the merge, start over with the new one
  if ! "${AS[@]}" git diff --quiet "$before" HEAD -- deploy/server/update.sh deploy/server/nginx-lib.sh; then
    echo "==> update.sh changed in this pull: re-running the new version"
    export BOOKRUNNER_UPDATE_REEXEC=1
    exec bash "$HERE/update.sh" "$@"
  fi
fi
echo "==> at $("${AS[@]}" git log --oneline -1)"
"${AS[@]}" node_modules/.bin/bun install --frozen-lockfile

# ---- operator app -> /var/www/bookrunner/app/
echo "==> app build (apps/web, base /app/, API: $API_URL)"
( cd apps/web && "${AS[@]}" VITE_API_URL="$API_URL" WEB_BASE=/app/ ../../node_modules/.bin/bun run build:testnet >/dev/null )
[ -f apps/web/dist/index.html ] || { echo "!! apps/web/dist/index.html missing after the build"; exit 1; }
grep -q '/app/assets/' apps/web/dist/index.html || { echo "!! apps/web/dist was not built for /app/ (vite base)"; exit 1; }

# ---- public site -> /var/www/bookrunner/
SITE_BUILT=0
if [ -f apps/site/package.json ]; then
  echo "==> site build (apps/site)"
  ( cd apps/site && "${AS[@]}" ../../node_modules/.bin/bun run build >/dev/null )
  [ -f apps/site/dist/index.html ] || { echo "!! apps/site/dist/index.html missing after the build"; exit 1; }
  SITE_BUILT=1
else
  echo "==> apps/site/package.json not found: skipping the public site (the web root keeps its current files)"
fi

# publish: the app first (its own dir), then the site around it. The site rsync excludes /app, so its
# --delete never touches the app; each tree drops its own stale files.
install -d -o bookrunner -g bookrunner -m 0755 "$WWW" "$WWW/app"
rsync -a --delete apps/web/dist/ "$WWW/app/"
if [ "$SITE_BUILT" = 1 ]; then
  rsync -a --delete --exclude=/app apps/site/dist/ "$WWW/"
fi
chown -R bookrunner:bookrunner "$WWW"
echo "==> published: site $([ "$SITE_BUILT" = 1 ] && echo "-> $WWW/" || echo "unchanged"), app -> $WWW/app/"

# ---- nginx locations (validated; rolled back if nginx -t fails)
NGINX_SNIPPET_SRC="$HERE/nginx-bookrunner-locations.conf"
# shellcheck source=nginx-lib.sh
. "$HERE/nginx-lib.sh"
nginx_install_snippet || echo "!! nginx snippet NOT updated (see the nginx -t output above); the site keeps the previous locations" >&2
if ! nginx_site_uses_snippet; then
  echo "!! $(nginx_site_file) does not include $NGINX_SNIPPET_DST yet: /app/ is not routed." >&2
  echo "!! run once: sudo bash $HERE/patch-nginx.sh --dry-run   then   sudo bash $HERE/patch-nginx.sh" >&2
fi

if [ "${1:-}" != "--web-only" ]; then
  echo "==> restart stack"
  systemctl restart bookrunner
fi
echo "==> done"
