#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Stage a queue of pre-signed releases on the server for the release robot (deploy/server/release-robot.py).
# Every first-parent commit of main..<branch> that carries a "Release-Title:" trailer is one release (it ships with
# the commits before it); "Release-Note:" is the Telegram note, "Release-Web-Only: yes" deploys with --web-only.
#   bash scripts/release-queue.sh <branch> [tech-updates.pdf]
# Then on the server: sudo bookrunner-release arm 2026-11-20T14:00:00Z   (T0, UTC; optional interval in minutes)
set -euo pipefail
BR="${1:?usage: release-queue.sh <branch> [pdf]}"; PDF="${2:-}"
HOST="${RELEASE_HOST:-usecert-ubuntu}"
git fetch -q origin main
git merge-base --is-ancestor origin/main "$BR" || { echo "!! $BR does not start from origin/main: rebase it first"; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
n=0
: > "$TMP/items.tsv"
for c in $(git rev-list --reverse --first-parent "origin/main..$BR"); do
  git verify-commit "$c" >/dev/null 2>&1 || { echo "!! $c is not signed by the trusted key"; exit 1; }
  title="$(git log -1 --format='%(trailers:key=Release-Title,valueonly,unfold)' "$c" | head -1)"
  [ -n "$title" ] || continue
  note="$(git log -1 --format='%(trailers:key=Release-Note,valueonly,unfold)' "$c" | head -1)"
  web="$(git log -1 --format='%(trailers:key=Release-Web-Only,valueonly)' "$c" | head -1)"
  printf '%s\t%s\t%s\t%s\n' "$c" "$title" "$note" "$web" >> "$TMP/items.tsv"
  n=$((n + 1))
done
[ "$n" -gt 0 ] || { echo "!! no commit with a Release-Title trailer in origin/main..$BR"; exit 1; }
last="$(tail -1 "$TMP/items.tsv" | cut -f1)"
[ "$last" = "$(git rev-parse "$BR")" ] || echo "note: commits after the last Release-Title commit are not released"
node -e '
const fs=require("fs");const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(l=>l.split("\t"));
fs.writeFileSync(process.argv[2],JSON.stringify({t0:null,intervalSec:3600,items:rows.map(([sha,title,note,web])=>({sha,title,note,webOnly:/^yes$/i.test(web||"")}))},null,2));
' "$TMP/items.tsv" "$TMP/release-plan.json"
git bundle create -q "$TMP/queue.bundle" "origin/main..$BR" "$BR"
cut -f1,2 "$TMP/items.tsv" | nl
files=("$TMP/release-plan.json" "$TMP/queue.bundle"); [ -n "$PDF" ] && files+=("$PDF")
scp -q "${files[@]}" "$HOST:/tmp/"
ssh "$HOST" "sudo bash -c 'set -e; install -o root -g root -m 0600 /tmp/release-plan.json /etc/bookrunner/release-plan.json; \
  install -o root -g root -m 0600 /tmp/queue.bundle /var/lib/bookrunner-release/queue.bundle; \
  if [ -f /tmp/$(basename "${PDF:-none}") ] && [ -n \"$PDF\" ]; then install -o root -g root -m 0600 /tmp/$(basename "${PDF:-none}") /var/lib/bookrunner-release/tech-updates.pdf; fi; \
  rm -f /tmp/release-plan.json /tmp/queue.bundle; echo staged $n releases; echo arm with: sudo bookrunner-release arm YYYY-MM-DDTHH:MM:SSZ'"
