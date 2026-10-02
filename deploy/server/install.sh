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
# never overwrite the site once certbot has added its TLS listeners to it (pass --nginx-site to force)
if [ ! -e /etc/nginx/sites-available/bookrunner ] || [ "${1:-}" = "--nginx-site" ]; then
  install -m 0644 "$HERE/nginx-bookrunner.conf" /etc/nginx/sites-available/bookrunner
fi
# certbot rewrites the enabled site in place; only (re)link when it is not there yet
[ -e /etc/nginx/sites-enabled/bookrunner ] || ln -s /etc/nginx/sites-available/bookrunner /etc/nginx/sites-enabled/bookrunner
install -d -o bookrunner -g bookrunner -m 0755 /var/www/bookrunner
install -d -o bookrunner -g bookrunner -m 0750 "$APP/.data" "$APP/.data/testnet"
systemctl daemon-reload
nginx -t
systemctl reload nginx
echo "installed: bookrunner.service (not started), nginx site, logrotate, /var/www/bookrunner"
