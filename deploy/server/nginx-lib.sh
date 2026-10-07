# Shared nginx helpers for install.sh, update.sh and patch-nginx.sh (sourced, needs root).
# The Bookrunner locations live in one snippet that the site's server{} block includes; nginx (www-data)
# cannot read /opt/bookrunner (mode 750), so the snippet is installed to /etc/nginx/snippets. The
# http{}-level part (rate-limit zones the snippet uses) is a conf.d file, installed before the snippet.

NGINX_SNIPPET_SRC="${NGINX_SNIPPET_SRC:-/opt/bookrunner/app/deploy/server/nginx-bookrunner-locations.conf}"
NGINX_SNIPPET_DST="${NGINX_SNIPPET_DST:-/etc/nginx/snippets/bookrunner-locations.conf}"
NGINX_HTTP_SRC="${NGINX_HTTP_SRC:-$(dirname "$NGINX_SNIPPET_SRC")/nginx-bookrunner-http.conf}"
NGINX_HTTP_DST="${NGINX_HTTP_DST:-/etc/nginx/conf.d/bookrunner-ratelimit.conf}"

# The site file nginx actually loads (certbot edits it in place; sites-enabled links to it).
nginx_site_file() {
  if [ -e /etc/nginx/sites-enabled/bookrunner ]; then readlink -f /etc/nginx/sites-enabled/bookrunner; else echo /etc/nginx/sites-available/bookrunner; fi
}

# Does the live site include the snippet yet? (false until patch-nginx.sh ran once)
nginx_site_uses_snippet() {
  local site; site="$(nginx_site_file)"
  [ -f "$site" ] && grep -Eq '^[[:space:]]*include[[:space:]]+[^;]*bookrunner-locations\.conf[[:space:]]*;' "$site"
}

# nginx_install_file SRC DST LABEL: install SRC at DST when it changed, validate with `nginx -t`, reload;
# on failure restore the previous DST (or remove the new one) and return 1. A no-op when identical.
nginx_install_file() {
  local src="$1" dst="$2" label="$3"
  install -d -m 0755 "$(dirname "$dst")"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    echo "==> nginx $label unchanged ($dst)"
    return 0
  fi
  local bak=""
  if [ -f "$dst" ]; then bak="$(mktemp)"; cp -p "$dst" "$bak"; fi
  install -m 0644 "$src" "$dst"
  if nginx -t -q; then
    systemctl reload nginx
    echo "==> nginx $label installed ($dst), nginx reloaded"
    [ -z "$bak" ] || rm -f "$bak"
    return 0
  fi
  echo "!! nginx -t failed with the new $label: rolling it back" >&2
  if [ -n "$bak" ]; then cp -p "$bak" "$dst"; rm -f "$bak"; else rm -f "$dst"; fi
  nginx -t -q || echo "!! nginx -t still fails after the rollback: fix it before the next reload" >&2
  return 1
}

# http{}-level conf (rate-limit zones): must be in place before a snippet that uses them.
nginx_install_http_conf() {
  nginx_install_file "$NGINX_HTTP_SRC" "$NGINX_HTTP_DST" "http-level conf (rate-limit zones)"
}

# The locations snippet (after nginx_install_http_conf: it references the zones).
nginx_install_snippet() {
  nginx_install_file "$NGINX_SNIPPET_SRC" "$NGINX_SNIPPET_DST" "locations snippet"
}
