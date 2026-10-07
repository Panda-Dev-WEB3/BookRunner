#!/usr/bin/env bash
# One-time host setup for the Bookrunner testnet stack (run as root on the server, after the repo is cloned to
# /opt/bookrunner/app and `bun install` ran as the bookrunner user). Idempotent. Does NOT copy secrets/state
# (.env.testnet, contracts/deployments/46630.json, .data/testnet, the DB dump) and does NOT start the stack.
#   sudo bash /opt/bookrunner/app/deploy/server/install.sh
set -euo pipefail
APP=/opt/bookrunner/app
HERE="$APP/deploy/server"
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
id bookrunner >/dev/null 2>&1 || { echo "create the bookrunner user first (see README.md)"; exit 1; }

install -m 0644 "$HERE/bookrunner.service" /etc/systemd/system/bookrunner.service
install -m 0644 "$HERE/logrotate-bookrunner" /etc/logrotate.d/bookrunner
# the locations (site at /, app at /app/, API proxies) live in a snippet the site includes; nginx cannot
# read /opt/bookrunner (mode 750), so it goes to /etc/nginx/snippets. update.sh keeps it current.
install -d -m 0755 /etc/nginx/snippets
install -m 0644 "$HERE/nginx-bookrunner-locations.conf" /etc/nginx/snippets/bookrunner-locations.conf
# never overwrite the site once certbot has added its TLS listeners to it (pass --nginx-site to force)
if [ ! -e /etc/nginx/sites-available/bookrunner ] || [ "${1:-}" = "--nginx-site" ]; then
  install -m 0644 "$HERE/nginx-bookrunner.conf" /etc/nginx/sites-available/bookrunner
fi
# certbot rewrites the enabled site in place; only (re)link when it is not there yet
[ -e /etc/nginx/sites-enabled/bookrunner ] || ln -s /etc/nginx/sites-available/bookrunner /etc/nginx/sites-enabled/bookrunner
install -d -o bookrunner -g bookrunner -m 0755 /var/www/bookrunner /var/www/bookrunner/app
install -d -o bookrunner -g bookrunner -m 0750 "$APP/.data" "$APP/.data/testnet"
systemctl daemon-reload
nginx -t
systemctl reload nginx
echo "installed: bookrunner.service (not started), nginx site + locations snippet, logrotate, /var/www/bookrunner{,/app}"
# a site that predates the snippet (certbot-managed, so not overwritten above) is converted once
grep -q 'bookrunner-locations.conf' /etc/nginx/sites-available/bookrunner \
  || echo "note: the nginx site does not include the locations snippet yet: run sudo bash $HERE/patch-nginx.sh"
