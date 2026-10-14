# Shared nginx helpers for install.sh, update.sh and patch-nginx.sh (sourced, needs root).
# The Bookrunner locations live in one snippet that the site's server{} block includes; nginx (www-data)
# cannot read /opt/bookrunner (mode 750), so the snippet is installed to /etc/nginx/snippets. The
# http{}-level part (rate-limit zones the snippet uses) is a conf.d file, installed before the snippet.

NGINX_SNIPPET_SRC="${NGINX_SNIPPET_SRC:-/opt/bookrunner/app/deploy/server/nginx-bookrunner-locations.conf}"
NGINX_SNIPPET_DST="${NGINX_SNIPPET_DST:-/etc/nginx/snippets/bookrunner-locations.conf}"
NGINX_HTTP_SRC="${NGINX_HTTP_SRC:-$(dirname "$NGINX_SNIPPET_SRC")/nginx-bookrunner-http.conf}"
NGINX_HTTP_DST="${NGINX_HTTP_DST:-/etc/nginx/conf.d/bookrunner-ratelimit.conf}"
# port-80 catch-all for other *.bookrunner.tech names (its own site file, enabled by a sites-enabled link)
NGINX_WILDCARD_SRC="${NGINX_WILDCARD_SRC:-$(dirname "$NGINX_SNIPPET_SRC")/nginx-bookrunner-wildcard.conf}"
NGINX_WILDCARD_DST="${NGINX_WILDCARD_DST:-/etc/nginx/sites-available/bookrunner-wildcard}"
NGINX_WILDCARD_LINK="${NGINX_WILDCARD_LINK:-/etc/nginx/sites-enabled/bookrunner-wildcard}"

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

# The *.bookrunner.tech port-80 redirect site. Once enabled, a changed file goes through nginx_install_file;
# the first time, the file and its sites-enabled link are added together, validated with `nginx -t` and
# both removed again (or the previous file restored) when the check fails.
nginx_install_wildcard_site() {
  local label="wildcard site (*.bookrunner.tech -> https://bookrunner.tech/)"
  if [ -L "$NGINX_WILDCARD_LINK" ] || [ -e "$NGINX_WILDCARD_LINK" ]; then
    nginx_install_file "$NGINX_WILDCARD_SRC" "$NGINX_WILDCARD_DST" "$label"
    return
  fi
  install -d -m 0755 "$(dirname "$NGINX_WILDCARD_DST")" "$(dirname "$NGINX_WILDCARD_LINK")"
  local bak=""
  if [ -f "$NGINX_WILDCARD_DST" ]; then bak="$(mktemp)"; cp -p "$NGINX_WILDCARD_DST" "$bak"; fi
  install -m 0644 "$NGINX_WILDCARD_SRC" "$NGINX_WILDCARD_DST"
  ln -s "$NGINX_WILDCARD_DST" "$NGINX_WILDCARD_LINK"
  if nginx -t -q; then
    systemctl reload nginx
    echo "==> nginx $label installed and enabled ($NGINX_WILDCARD_LINK), nginx reloaded"
    [ -z "$bak" ] || rm -f "$bak"
    return 0
  fi
  echo "!! nginx -t failed with the new $label: rolling it back" >&2
  rm -f "$NGINX_WILDCARD_LINK"
  if [ -n "$bak" ]; then cp -p "$bak" "$NGINX_WILDCARD_DST"; rm -f "$bak"; else rm -f "$NGINX_WILDCARD_DST"; fi
  nginx -t -q || echo "!! nginx -t still fails after the rollback: fix it before the next reload" >&2
  return 1
}

# The live site file is certbot-managed and never reinstalled, so its server-level HSTS line (the one the
# www -> apex redirect and other server-level responses carry) is brought to includeSubDomains in place.
# A no-op once done; validated and rolled back like any other file.
nginx_patch_site_hsts() {
  local site old new tmp rc
  site="$(nginx_site_file)"
  old='Strict-Transport-Security "max-age=31536000" always;'
  new='Strict-Transport-Security "max-age=31536000; includeSubDomains" always;'
  if [ ! -f "$site" ] || ! grep -qF "$old" "$site"; then
    echo "==> nginx site HSTS already current ($site)"
    return 0
  fi
  tmp="$(mktemp)"
  sed "s/$old/$new/" "$site" > "$tmp"
  rc=0
  nginx_install_file "$tmp" "$site" "site HSTS (includeSubDomains)" || rc=$?
  rm -f "$tmp"
  return "$rc"
}
