#!/usr/bin/env bash
# Update the server to origin/main: refresh the ROOT-OWNED deploy copy, pull the app, build + publish the
# public site and the operator app, install the nginx conf + units, restart the stack.
#   sudo /usr/local/lib/bookrunner-deploy/update.sh            # full update (stack restarts, ~20 s)
#   sudo /usr/local/lib/bookrunner-deploy/update.sh --web-only # site + app + nginx, no stack restart
#
# Why a root-owned copy (HARDENING.md): this script runs as root, so it must never execute or install a file
# the bookrunner user can write. Everything root runs or installs (this script, nginx-lib.sh, the nginx conf,
# the systemd units, docker-compose.yml) comes from /usr/local/lib/bookrunner-src, a root-owned clone of
# the repo, copied to /usr/local/lib/bookrunner-deploy. The app checkout (/opt/bookrunner/app, owned by
# bookrunner) is only fast-forwarded to the SAME commit and built as the bookrunner user.
# BOOKRUNNER_REQUIRE_SIGNED=1: refuse a commit whose signature `git verify-commit` does not accept.
#
# Layout under /var/www/bookrunner (nginx: nginx-bookrunner-locations.conf):
#   /       apps/site/dist   public site (multi-page static tree)
#   /app/   apps/web/dist    operator app (vite base /app/; API stays at /trpc + /health on the host root)
set -euo pipefail
APP=/opt/bookrunner/app
SRC=/usr/local/lib/bookrunner-src
DEPLOY=/usr/local/lib/bookrunner-deploy
WWW=/var/www/bookrunner
# same-origin: the app calls /trpc + /health on whatever host served it (nginx proxies them to the API)
API_URL="${API_URL:-same-origin}"
AS=(sudo -u bookrunner HOME=/opt/bookrunner)
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
if [ "$(dirname "$SELF")" != "$DEPLOY" ]; then
  echo "!! run the root-owned copy: sudo $DEPLOY/update.sh $*" >&2
  echo "!! (not set up yet? see deploy/server/HARDENING.md: clone to $SRC, then sudo bash $SRC/deploy/server/install.sh)" >&2
  exit 1
fi
for d in "$SRC" "$DEPLOY"; do
  [ "$(stat -c %u "$d")" = 0 ] || { echo "!! $d is not owned by root: refusing" >&2; exit 1; }
done

if [ -z "${BOOKRUNNER_UPDATE_REEXEC:-}" ]; then
  # ---- 1. root-owned source: the commit everything below is built from
  git -C "$SRC" fetch -q origin main
  git -C "$SRC" checkout -q --detach FETCH_HEAD
  WANT="$(git -C "$SRC" rev-parse HEAD)"
  if [ "${BOOKRUNNER_REQUIRE_SIGNED:-0}" = 1 ]; then
    git -C "$SRC" verify-commit "$WANT" || { echo "!! $WANT is not signed by a trusted key: refusing" >&2; exit 1; }
  fi
  # ---- 2. root-owned deploy copy (.env.infra is local state, kept); re-run when this script changed
  before="$(sha256sum "$SELF" | cut -d' ' -f1)"
  rsync -a --delete --exclude=/.env.infra "$SRC/deploy/server/" "$DEPLOY/"
  chown -R root:root "$DEPLOY"
  chmod -R go-w "$DEPLOY"
  if [ "$before" != "$(sha256sum "$DEPLOY/update.sh" | cut -d' ' -f1)" ]; then
    echo "==> update.sh changed in $WANT: re-running the new version"
    export BOOKRUNNER_UPDATE_REEXEC=1 BOOKRUNNER_WANT="$WANT"
    exec bash "$DEPLOY/update.sh" "$@"
  fi
else
  WANT="${BOOKRUNNER_WANT:?}"
fi

# ---- 3. app checkout (bookrunner): the same commit, and nothing modified locally
cd "$APP"
"${AS[@]}" git fetch -q origin main
"${AS[@]}" git merge -q --ff-only "$WANT"
[ "$("${AS[@]}" git rev-parse HEAD)" = "$WANT" ] || { echo "!! $APP is not at $WANT after the merge: refusing" >&2; exit 1; }
if [ -n "$("${AS[@]}" git status --porcelain --untracked-files=no)" ]; then
  echo "!! $APP has local modifications to tracked files: refusing to build them" >&2
  "${AS[@]}" git status --short --untracked-files=no >&2
  exit 1
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
# --delete never touches the app; each tree drops its own stale files (old *.map files included).
# --safe-links: a symlink in a build output pointing outside the tree is not published.
install -d -o bookrunner -g bookrunner -m 0755 "$WWW" "$WWW/app"
rsync -a --safe-links --delete apps/web/dist/ "$WWW/app/"
if [ "$SITE_BUILT" = 1 ]; then
  rsync -a --safe-links --delete --exclude=/app apps/site/dist/ "$WWW/"
fi
chown -R bookrunner:bookrunner "$WWW"
echo "==> published: site $([ "$SITE_BUILT" = 1 ] && echo "-> $WWW/" || echo "unchanged"), app -> $WWW/app/"

# ---- nginx: rate-limit zones (http level) first, then the locations that use them (validated; rolled back if nginx -t fails)
NGINX_SNIPPET_SRC="$DEPLOY/nginx-bookrunner-locations.conf"
NGINX_HTTP_SRC="$DEPLOY/nginx-bookrunner-http.conf"
# shellcheck source=nginx-lib.sh
. "$DEPLOY/nginx-lib.sh"
nginx_install_http_conf || echo "!! nginx rate-limit conf NOT updated (see the nginx -t output above)" >&2
nginx_install_snippet || echo "!! nginx snippet NOT updated (see the nginx -t output above); the site keeps the previous locations" >&2
if ! nginx_site_uses_snippet; then
  echo "!! $(nginx_site_file) does not include $NGINX_SNIPPET_DST yet: /app/ is not routed." >&2
  echo "!! run once: sudo bash $DEPLOY/patch-nginx.sh --dry-run   then   sudo bash $DEPLOY/patch-nginx.sh" >&2
fi

# ---- systemd units (from the root-owned copy)
units_changed=0
for u in bookrunner.service bookrunner-infra.service; do
  if ! cmp -s "$DEPLOY/$u" "/etc/systemd/system/$u"; then
    install -m 0644 "$DEPLOY/$u" "/etc/systemd/system/$u"
    units_changed=1
    echo "==> installed $u"
  fi
done
install -m 0644 "$DEPLOY/logrotate-bookrunner" /etc/logrotate.d/bookrunner
[ "$units_changed" = 0 ] || systemctl daemon-reload

if [ "${1:-}" != "--web-only" ]; then
  echo "==> infra (applies a changed compose file; unchanged containers keep running)"
  systemctl enable --now bookrunner-infra >/dev/null
  systemctl reload bookrunner-infra
  echo "==> restart stack"
  systemctl restart bookrunner
fi
echo "==> done ($WANT)"
