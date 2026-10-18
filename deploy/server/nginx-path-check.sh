#!/usr/bin/env bash
# nginx config check in Docker (audit 2026-10 L-3 path confusion, M-4 receipts zone). Runs `nginx -t` on the
# real deploy/server/nginx-bookrunner-http.conf + nginx-bookrunner-locations.conf inside a minimal http{} /
# server{}, with a stand-in for the API on 127.0.0.1:4400 that echoes the path and route header it receives,
# then sends raw HTTP requests (bash /dev/tcp: no client-side URL normalisation) and checks that
#   - /trpc/..\v1\books and its encoded / dot-segment variants are refused or never reach the API's /v1 or /mcp;
#   - normal /trpc/ calls, /health and /status.json still reach the API, normalized and stamped;
#   - receipts.* calls hit the stricter per-IP zone (429 after the burst) while other calls do not.
# Usage: bash deploy/server/nginx-path-check.sh   (needs Docker; image nginx:1.27; no network access needed)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="${NGINX_IMAGE:-nginx:1.27}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp "$HERE/nginx-bookrunner-http.conf" "$WORK/http.conf"
cp "$HERE/nginx-bookrunner-locations.conf" "$WORK/locations.conf"
mkdir -p "$WORK/www"
echo "site" >"$WORK/www/index.html"

cat >"$WORK/nginx.conf" <<'EOF'
worker_processes 1;
error_log /dev/stderr crit;
pid /tmp/nginx.pid;
events {}
http {
    include /etc/nginx/mime.types;
    access_log off;
    include /t/http.conf;
    # stand-in for services/api: shows what nginx forwarded
    server {
        listen 127.0.0.1:4400;
        location / {
            default_type text/plain;
            return 200 "upstream path=$request_uri route=$http_x_bookrunner_route\n";
        }
    }
    server {
        listen 8080;
        server_name bookrunner.tech;
        root /t/www;
        index index.html;
        include /t/locations.conf;
    }
}
EOF

cat >"$WORK/check.sh" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
nginx -t -c /t/nginx.conf || exit 1
nginx -c /t/nginx.conf
sleep 0.5
fails=0
# raw request: prints "<status> <body first line>"
# A request nginx rejects while parsing (e.g. %00) can be answered and reset before `cat` reads the reply:
# retry an empty read a few times.
raw() {
  local resp="" try
  for try in 1 2 3 4 5; do
    exec 3<>/dev/tcp/127.0.0.1/8080
    printf 'GET %s HTTP/1.1\r\nHost: bookrunner.tech\r\nConnection: close\r\n\r\n' "$1" >&3
    resp="$(cat <&3 2>/dev/null)"; exec 3<&-
    [ -n "$resp" ] && break
    sleep 0.2
  done
  local status; status="$(printf '%s' "$resp" | head -n1 | awk '{print $2}')"
  local body; body="$(printf '%s' "$resp" | sed -n '/^\r$/,$p' | sed -n '2p' | tr -d '\r')"
  printf '%s %s' "$status" "$body"
}
expect() { # path, wanted status, optional body substring (or !substring = must not contain)
  local out; out="$(raw "$1")"
  local status="${out%% *}" body="${out#* }"
  local ok=1
  [ "$status" = "$2" ] || ok=0
  if [ -n "${3:-}" ]; then
    case "$3" in
      !*) [[ "$body" == *"${3#!}"* ]] && ok=0 ;;
      *) [[ "$body" == *"$3"* ]] || ok=0 ;;
    esac
  fi
  if [ $ok = 1 ]; then echo "ok   $2  $1  -> $body"; else echo "FAIL $1: got '$out', want $2 ${3:-}"; fails=$((fails+1)); fi
}
B='\'
echo "-- path confusion (L-3): refused, never reaching /v1 or /mcp"
expect "/trpc/..${B}v1${B}books" 400
expect "/trpc/..${B}v1${B}webhooks" 400
expect "/trpc/..${B}mcp" 400
expect "/trpc/book.get/..${B}..${B}v1${B}books" 400
expect "/trpc/..%5Cv1%5Cbooks" 400
expect "/trpc/..%5cv1%5cbooks" 400
expect "/trpc/..%2fv1%2fbooks" 404 "!upstream"   # nginx decodes %2F and resolves ..: $uri /v1/books, not /trpc/
expect "/trpc/..%2Fmcp" 404 "!upstream"
expect "/trpc/%2e%2e/v1/books" 404 "!upstream"
expect "/trpc/.%2e/v1/books" 404 "!upstream"
expect "/trpc/../v1/books" 404 "!upstream"
expect "/trpc/x/../../mcp" 404 "!upstream"
expect "/trpc/./book.get" 400
expect "/trpc/book.get/." 400
expect "/trpc/book.get/x" 400
expect "/trpc/book.get%00" 400
expect "/v1/books" 404 "!upstream"
expect "/mcp" 404 "!upstream"
echo "-- API locations: normalized path, location stamped"
expect "/trpc/book.get?input=%7B%22json%22%3A%7B%22bookId%22%3A1%7D%7D" 200 "upstream path=/trpc/book.get?input=%7B%22json%22%3A%7B%22bookId%22%3A1%7D%7D route=/trpc/"
expect "/trpc/book.get,book.nav?batch=1&input=%7B%7D" 200 "upstream path=/trpc/book.get,book.nav?batch=1&input=%7B%7D route=/trpc/"
expect "/trpc//book.get" 200 "upstream path=/trpc/book.get route=/trpc/"
expect "/health" 200 "upstream path=/health route=/health"
expect "/health?verbose" 200 "upstream path=/health?verbose route=/health"
expect "/status.json" 200 "upstream path=/status route=/status"
echo "-- receipts zone (M-4): 2 r/s burst 10 per IP; other calls unaffected"
codes=""; for i in $(seq 1 16); do out="$(raw "/trpc/receipts.proof?input=%7B%7D")"; codes="$codes ${out%% *}"; done
echo "receipts.proof x16:$codes"
[[ "$codes" == *429* ]] || { echo "FAIL receipts.* never rate-limited"; fails=$((fails+1)); }
codes=""; for i in $(seq 1 16); do out="$(raw "/trpc/book.get?input=%7B%7D")"; codes="$codes ${out%% *}"; done
echo "book.get x16:$codes"
[[ "$codes" == *429* ]] && { echo "FAIL book.get limited by the receipts zone"; fails=$((fails+1)); }
codes=""; for i in $(seq 1 16); do out="$(raw "/trpc/book.get,receipts.root?batch=1&input=%7B%7D")"; codes="$codes ${out%% *}"; done
echo "book.get,receipts.root x16:$codes"
[[ "$codes" == *429* ]] || { echo "FAIL a batch holding receipts.* is not in the receipts zone"; fails=$((fails+1)); }
nginx -s quit -c /t/nginx.conf
echo "failures: $fails"
exit $fails
EOF

MOUNT="$WORK"
command -v cygpath >/dev/null 2>&1 && MOUNT="$(cygpath -w "$WORK")"
MSYS_NO_PATHCONV=1 docker run --rm --network none -v "$MOUNT:/t:ro" "$IMAGE" bash /t/check.sh
