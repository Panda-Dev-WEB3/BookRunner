#!/usr/bin/env bash
# Update the server to origin/main: pull, install, build + publish the web app, restart the stack.
#   sudo bash /opt/bookrunner/app/deploy/server/update.sh            # full update (stack restarts, ~20 s)
#   sudo bash /opt/bookrunner/app/deploy/server/update.sh --web-only # rebuild + publish the web app only
set -euo pipefail
APP=/opt/bookrunner/app
DOMAIN="${DOMAIN:-bookrunner.use-cert.com}"
AS=(sudo -u bookrunner HOME=/opt/bookrunner)
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
cd "$APP"

"${AS[@]}" git fetch -q origin main
"${AS[@]}" git merge -q --ff-only origin/main
echo "==> at $("${AS[@]}" git log --oneline -1)"
"${AS[@]}" node_modules/.bin/bun install --frozen-lockfile

echo "==> web build (API at https://$DOMAIN)"
( cd apps/web && "${AS[@]}" VITE_API_URL="https://$DOMAIN" ../../node_modules/.bin/bun run build:testnet >/dev/null )
rsync -a --delete apps/web/dist/ /var/www/bookrunner/
chown -R bookrunner:bookrunner /var/www/bookrunner

if [ "${1:-}" != "--web-only" ]; then
  echo "==> restart stack"
  systemctl restart bookrunner
fi
echo "==> done"
