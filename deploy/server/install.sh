#!/usr/bin/env bash
# One-time host setup for the Bookrunner testnet stack. Run as root from the ROOT-OWNED clone
# /usr/local/lib/bookrunner-src (HARDENING.md), after the app is cloned to /opt/bookrunner/app and
# `bun install` ran as the bookrunner user. Idempotent. Does NOT copy secrets/state (.env.testnet,
# contracts/deployments/46630.json, .data/testnet, the DB dump) and does NOT start or restart anything.
#   sudo git clone https://github.com/Panda-Dev-WEB3/BookRunner.git /usr/local/lib/bookrunner-src
#   sudo bash /usr/local/lib/bookrunner-src/deploy/server/install.sh
set -euo pipefail
APP=/opt/bookrunner/app
SRC=/usr/local/lib/bookrunner-src
DEPLOY=/usr/local/lib/bookrunner-deploy
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
id bookrunner >/dev/null 2>&1 || { echo "create the bookrunner user first (see README.md)"; exit 1; }
if [ "$HERE" != "$SRC/deploy/server" ] && [ "$HERE" != "$DEPLOY" ]; then
  echo "!! install.sh runs as root: run it from the root-owned clone, not from $HERE" >&2
  echo "!!   sudo git clone https://github.com/Panda-Dev-WEB3/BookRunner.git $SRC && sudo bash $SRC/deploy/server/install.sh" >&2
  exit 1
fi
[ "$(stat -c %u "$HERE")" = 0 ] || { echo "!! $HERE is not owned by root: refusing" >&2; exit 1; }

# ---- root-owned deploy copy: what root runs (update.sh) and installs (units, nginx conf, compose file)
install -d -o root -g root -m 0755 "$DEPLOY"
if [ "$HERE" != "$DEPLOY" ]; then
  rsync -a --delete --exclude=/.env.infra "$HERE/" "$DEPLOY/"
  chown -R root:root "$DEPLOY"
  chmod -R go-w "$DEPLOY"
fi

# ---- infra passwords (Postgres, Redis): generated once, root:root 0600, never in git. On a host whose
# Postgres volume already exists the new password must be set in the DB too (HARDENING.md step 4).
INFRA_ENV="$DEPLOY/.env.infra"
if [ ! -f "$INFRA_ENV" ]; then
  ( umask 077; printf 'POSTGRES_PASSWORD=%s\nREDIS_PASSWORD=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > "$INFRA_ENV" )
  echo "==> generated $INFRA_ENV (POSTGRES_PASSWORD, REDIS_PASSWORD)"
  docker volume inspect bookrunner_pgdata >/dev/null 2>&1 \
    && echo "!! the Postgres volume already exists: set the new password in the DB BEFORE restarting anything (HARDENING.md step 4)"
fi
chown root:root "$INFRA_ENV"
chmod 0600 "$INFRA_ENV"

# ---- units: infra (root, docker) + stack (bookrunner, no docker access)
install -m 0644 "$DEPLOY/bookrunner-infra.service" /etc/systemd/system/bookrunner-infra.service
install -m 0644 "$DEPLOY/bookrunner.service" /etc/systemd/system/bookrunner.service
install -m 0644 "$DEPLOY/logrotate-bookrunner" /etc/logrotate.d/bookrunner
# daily backup (root runs the root-owned $DEPLOY/backup.sh; RESTORE.md): units, backup dir, settings template
install -m 0644 "$DEPLOY/bookrunner-backup.service" /etc/systemd/system/bookrunner-backup.service
install -m 0644 "$DEPLOY/bookrunner-backup.timer" /etc/systemd/system/bookrunner-backup.timer
install -d -o root -g root -m 0700 /var/backups/bookrunner
install -d -o root -g root -m 0750 /etc/bookrunner
if [ ! -f /etc/bookrunner/backup.env ]; then
  ( umask 077; printf '%s\n' \
      "# Bookrunner backup settings (the header of $DEPLOY/backup.sh lists them); unset = defaults" \
      "BACKUP_NETWORK=testnet" \
      "# off-site copy (optional): BACKUP_RSYNC_TARGET=user@host:/path/  BACKUP_RSYNC_SSH_KEY=/root/.ssh/key" \
      "# or: BACKUP_RCLONE_REMOTE=remote:path  BACKUP_RCLONE_CONFIG=/root/.config/rclone/rclone.conf" \
      > /etc/bookrunner/backup.env )
fi

# ---- nginx: rate-limit zones (conf.d, http level) before the locations snippet that uses them; the site
# itself is installed only on a first install (certbot rewrites it in place afterwards; --nginx-site forces it)
NGINX_SNIPPET_SRC="$DEPLOY/nginx-bookrunner-locations.conf"
NGINX_HTTP_SRC="$DEPLOY/nginx-bookrunner-http.conf"
# shellcheck source=nginx-lib.sh
. "$DEPLOY/nginx-lib.sh"
nginx_install_http_conf || echo "!! nginx rate-limit conf NOT installed (see the nginx -t output above)" >&2
nginx_install_snippet || echo "!! nginx locations snippet NOT updated (see the nginx -t output above)" >&2
if [ ! -e /etc/nginx/sites-available/bookrunner ] || [ "${1:-}" = "--nginx-site" ]; then
  install -m 0644 "$DEPLOY/nginx-bookrunner.conf" /etc/nginx/sites-available/bookrunner
fi
# certbot rewrites the enabled site in place; only (re)link when it is not there yet
[ -e /etc/nginx/sites-enabled/bookrunner ] || ln -s /etc/nginx/sites-available/bookrunner /etc/nginx/sites-enabled/bookrunner
install -d -o bookrunner -g bookrunner -m 0755 /var/www/bookrunner /var/www/bookrunner/app
install -d -o bookrunner -g bookrunner -m 0750 "$APP/.data" "$APP/.data/testnet"
systemctl daemon-reload
nginx -t
systemctl reload nginx
systemctl enable bookrunner-infra.service bookrunner.service >/dev/null
systemctl enable --now bookrunner-backup.timer >/dev/null
echo "installed: $DEPLOY (root-owned), bookrunner-infra.service + bookrunner.service (enabled, not (re)started),"
echo "           bookrunner-backup.timer (daily, enabled; settings /etc/bookrunner/backup.env, sets in /var/backups/bookrunner),"
echo "           nginx rate-limit conf + locations snippet, logrotate, /var/www/bookrunner{,/app}"
id -nG bookrunner | grep -qw docker && echo "note: bookrunner is still in the docker group: remove it once bookrunner-infra runs (HARDENING.md step 6)"
# a site that predates the snippet (certbot-managed, so not overwritten above) is converted once
grep -q 'bookrunner-locations.conf' /etc/nginx/sites-available/bookrunner \
  || echo "note: the nginx site does not include the locations snippet yet: run sudo bash $DEPLOY/patch-nginx.sh"
echo "updates from now on: sudo $DEPLOY/update.sh"
