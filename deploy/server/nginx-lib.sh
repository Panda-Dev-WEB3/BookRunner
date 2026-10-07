# Shared nginx helpers for install.sh, update.sh and patch-nginx.sh (sourced, needs root).
# The Bookrunner locations live in one snippet that the site's server{} block includes; nginx (www-data)
# cannot read /opt/bookrunner (mode 750), so the snippet is installed to /etc/nginx/snippets.

NGINX_SNIPPET_SRC="${NGINX_SNIPPET_SRC:-/opt/bookrunner/app/deploy/server/nginx-bookrunner-locations.conf}"
NGINX_SNIPPET_DST="${NGINX_SNIPPET_DST:-/etc/nginx/snippets/bookrunner-locations.conf}"

# The site file nginx actually loads (certbot edits it in place; sites-enabled links to it).
nginx_site_file() {
  if [ -e /etc/nginx/sites-enabled/bookrunner ]; then readlink -f /etc/nginx/sites-enabled/bookrunner; else echo /etc/nginx/sites-available/bookrunner; fi
}

# Does the live site include the snippet yet? (false until patch-nginx.sh ran once)
nginx_site_uses_snippet() {
  local site; site="$(nginx_site_file)"
  [ -f "$site" ] && grep -Eq '^[[:space:]]*include[[:space:]]+[^;]*bookrunner-locations\.conf[[:space:]]*;' "$site"
}

# Install the snippet when it changed, validate with `nginx -t`, reload; on failure restore the previous
# snippet (or remove the new one) and return 1. A no-op when the installed copy is identical.
nginx_install_snippet() {
  install -d -m 0755 "$(dirname "$NGINX_SNIPPET_DST")"
  if [ -f "$NGINX_SNIPPET_DST" ] && cmp -s "$NGINX_SNIPPET_SRC" "$NGINX_SNIPPET_DST"; then
    echo "==> nginx locations snippet unchanged ($NGINX_SNIPPET_DST)"
    return 0
  fi
  local bak=""
  if [ -f "$NGINX_SNIPPET_DST" ]; then bak="$(mktemp)"; cp -p "$NGINX_SNIPPET_DST" "$bak"; fi
  install -m 0644 "$NGINX_SNIPPET_SRC" "$NGINX_SNIPPET_DST"
  if nginx -t -q; then
    systemctl reload nginx
    echo "==> nginx locations snippet installed ($NGINX_SNIPPET_DST), nginx reloaded"
    [ -z "$bak" ] || rm -f "$bak"
    return 0
  fi
  echo "!! nginx -t failed with the new locations snippet: rolling it back" >&2
  if [ -n "$bak" ]; then cp -p "$bak" "$NGINX_SNIPPET_DST"; rm -f "$bak"; else rm -f "$NGINX_SNIPPET_DST"; fi
  nginx -t -q || echo "!! nginx -t still fails after the rollback: fix it before the next reload" >&2
  return 1
}
