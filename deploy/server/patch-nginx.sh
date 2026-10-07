#!/usr/bin/env bash
# One-time conversion of the LIVE (certbot-managed) nginx site to the locations snippet.
#
# install.sh never overwrites /etc/nginx/sites-available/bookrunner once certbot added its TLS listeners,
# so the location blocks copied there at first install would stay frozen. This script:
#   1. installs deploy/server/nginx-bookrunner-locations.conf to /etc/nginx/snippets/bookrunner-locations.conf
#   2. in every server{} block of the site that has location blocks (the 443 block certbot made; the
#      port-80 redirect block has none and is left alone), replaces those location blocks (and the comment
#      lines right above them) with `include /etc/nginx/snippets/bookrunner-locations.conf;`.
#      Listeners, ssl_* lines, certbot's includes, server_name, root, index and add_header stay as they are.
#   3. validates with `nginx -t`, reloads; on failure restores the backup and reloads nothing.
# Idempotent: a site that already includes the snippet and has no location blocks is left unchanged.
# Afterwards update.sh keeps the snippet current; the site file never needs another edit.
#
#   sudo bash /opt/bookrunner/app/deploy/server/patch-nginx.sh --dry-run   # show the diff, change nothing
#   sudo bash /opt/bookrunner/app/deploy/server/patch-nginx.sh             # apply
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NGINX_SNIPPET_SRC="$HERE/nginx-bookrunner-locations.conf"
# shellcheck source=nginx-lib.sh
. "$HERE/nginx-lib.sh"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
SITE="${SITE:-$(nginx_site_file)}"
INCLUDE="include $NGINX_SNIPPET_DST;"

# Pure transform (stdin -> stdout), POSIX awk (mawk on Debian/Ubuntu). Brace depth is counted outside
# comments and quoted strings.
patch_site() {
  awk -v inc="$INCLUDE" '
    { line[NR] = $0 }
    function depth_scan(s,   i, c, q) {
      q = ""
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (q != "") { if (c == "\\") { i++; continue } if (c == q) q = ""; continue }
        if (c == "\"" || c == "\047") { q = c; continue }
        if (c == "#") break
        if (c == "{") d++
        else if (c == "}") d--
      }
    }
    function first_word(s) { sub(/^[ \t]+/, "", s); sub(/[ \t{;].*$/, "", s); return s }
    END {
      n = NR; d = 0
      for (i = 1; i <= n; i++) { before[i] = d; depth_scan(line[i]); after[i] = d }
      for (i = 1; i <= n; i++) {
        if (before[i] != 0 || first_word(line[i]) != "server") continue
        s = i; e = i
        while (e < n && after[e] != 0) e++
        has_inc = 0
        for (k = s; k <= e; k++) if (before[k] == 1 && index(line[k], "bookrunner-locations.conf") > 0 && first_word(line[k]) == "include") has_inc = 1
        placed = has_inc
        for (k = s + 1; k <= e; k++) {
          if (before[k] != 1 || first_word(line[k]) != "location") continue
          j = k
          while (j < e && after[j] != 1) j++
          # the comment lines directly above the block describe it: drop them with it
          c = k - 1
          while (c > s && !del[c] && line[c] ~ /^[ \t]*#/) { del[c] = 1; c-- }
          if (!placed) {
            ind = line[k]; sub(/[^ \t].*$/, "", ind)
            ins[c + 1] = ind inc
            placed = 1
          }
          for (m = k; m <= j; m++) del[m] = 1
          k = j
        }
        i = e
      }
      prev_del = 0
      for (i = 1; i <= n; i++) {
        if (i in ins) print ins[i]
        if (del[i]) { prev_del = 1; continue }
        # no blank-line runs where blocks were removed
        if (prev_del && line[i] ~ /^[ \t]*$/) continue
        if (prev_del && line[i] !~ /^[ \t]*}/) print ""
        prev_del = 0
        print line[i]
      }
    }
  '
}

# Self-test hook for CI / a laptop: `patch-nginx.sh --transform < site` prints the patched file only.
if [ "${1:-}" = "--transform" ]; then patch_site; exit 0; fi

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
[ -f "$SITE" ] || { echo "no nginx site at $SITE"; exit 1; }
command -v nginx >/dev/null || { echo "nginx is not installed"; exit 1; }

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
patch_site < "$SITE" > "$TMP"

if cmp -s "$SITE" "$TMP"; then
  echo "==> $SITE already includes the snippet (no location blocks left): nothing to patch"
  [ "$DRY" = 1 ] || nginx_install_snippet
  exit 0
fi
grep -Fq "$INCLUDE" "$TMP" || { echo "!! no server{} block with location blocks in $SITE: patch it by hand (see README.md)" >&2; exit 1; }

echo "==> changes to $SITE"
diff -u "$SITE" "$TMP" || true
if [ "$DRY" = 1 ]; then echo "==> dry run: nothing written"; exit 0; fi

# the snippet must exist before the site includes it (validates + reloads on its own; harmless while unused)
nginx_install_snippet

BACKUPS=/etc/nginx/bookrunner-backups   # outside sites-enabled: never loaded by nginx
install -d -m 0700 "$BACKUPS"
BAK="$BACKUPS/$(basename "$SITE").$(date +%Y%m%d-%H%M%S)"
cp -p "$SITE" "$BAK"
cat "$TMP" > "$SITE"   # in place: keeps owner, mode and the sites-enabled link

if nginx -t; then
  systemctl reload nginx
  echo "==> patched $SITE (backup: $BAK); nginx reloaded"
else
  echo "!! nginx -t failed: restoring $BAK" >&2
  cat "$BAK" > "$SITE"
  nginx -t || echo "!! nginx -t still fails after the restore: investigate before reloading" >&2
  exit 1
fi
