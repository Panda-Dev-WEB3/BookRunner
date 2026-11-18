#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Install the scheduled release robot (deploy/server/release-robot.py) as root: the script, the
# `bookrunner-release` command, a systemd timer (every 5 min) and a GitHub deploy key (write) for its pushes.
#   sudo bash deploy/server/install-release-robot.sh
# Then add the printed PUBLIC key in GitHub: repo Settings > Deploy keys > Add, "Allow write access".
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
LIB=/usr/local/lib/bookrunner-deploy
install -d -o root -g root -m 0755 "$LIB"
install -o root -g root -m 0700 "$HERE/release-robot.py" "$LIB/release-robot.py"
ln -sf "$LIB/release-robot.py" /usr/local/sbin/bookrunner-release
install -d -o root -g root -m 0700 /var/lib/bookrunner-release /root/.ssh

KEY=/root/.ssh/bookrunner_release
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -C "bookrunner-release-robot" -f "$KEY"
# GitHub's published ed25519 host key fingerprint (docs.github.com, "GitHub's SSH key fingerprints")
GH_FP="SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"
if ! grep -q "^github.com ssh-ed25519" /root/.ssh/known_hosts 2>/dev/null; then
  KS="$(ssh-keyscan -t ed25519 github.com 2>/dev/null)"
  [ "$(printf '%s\n' "$KS" | ssh-keygen -lf - | awk '{print $2}')" = "$GH_FP" ] || { echo "!! github.com host key fingerprint mismatch: refusing"; exit 1; }
  printf '%s\n' "$KS" >> /root/.ssh/known_hosts
fi

cat > /etc/systemd/system/bookrunner-release.service <<'EOF'
[Unit]
Description=BookRunner scheduled release robot (one tick)
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/lib/bookrunner-deploy/release-robot.py tick
TimeoutStartSec=1800
EOF
cat > /etc/systemd/system/bookrunner-release.timer <<'EOF'
[Unit]
Description=BookRunner scheduled release robot
[Timer]
OnCalendar=*:0/5
Persistent=false
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now bookrunner-release.timer >/dev/null
echo "==> release robot installed (timer every 5 min; nothing is released until a plan is armed)"
echo "==> add this deploy key in GitHub (Settings > Deploy keys > Add, tick 'Allow write access'):"
cat "$KEY.pub"
