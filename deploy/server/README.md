# Server install (Robinhood Chain testnet stack)

One Linux host runs the whole testnet stack: every service, one agent per book, the trader simulator,
Postgres/Timescale + Redis in Docker, and nginx serving `https://bookrunner.tech`: the public site
(`apps/site`) at `/`, the operator app (`apps/web`) at `/app/`, and the API at `/trpc` + `/health`.
The host is shared with other services, so everything is loopback-only and memory-capped.

Hardening (root-owned deploy copy, infra unit, sandbox, passwords, secrets per process) and the exact
operator steps to move an existing server: [HARDENING.md](HARDENING.md).

Mainnet (Robinhood Chain 4663) runs on a separate host with the network-parametrised unit
[`bookrunner@.service`](bookrunner@.service) (`bookrunner@mainnet`), KMS role keys and no simulators:
[MAINNET.md](MAINNET.md). This testnet host keeps `bookrunner.service`. It may also run the live-Orderly rehearsal
stack `bookrunner@testnet-live` NEXT TO it (same template + drop-in `bookrunner@testnet-live.service.d/`; its own
mnemonic, record, database, Redis db, state and loopback ports; nginx routes no public traffic to it): docs/RUNBOOK.md
"Testnet rehearsal on real Orderly".

| Piece | Where |
|---|---|
| Code | `/opt/bookrunner/app` (git clone of this repo, user `bookrunner`; built and run as that user) |
| Deploy scripts / units / nginx conf / compose, as root runs them | `/usr/local/lib/bookrunner-src` (root-owned clone) → `/usr/local/lib/bookrunner-deploy` (root-owned copy of `deploy/server`) |
| Secrets + state (never in git) | `.env.testnet` (mode 600: mnemonic, `ORACLE_SEED`, ...), `contracts/deployments/46630.json`, `.data/testnet/`; infra passwords in `/usr/local/lib/bookrunner-deploy/.env.infra` (root, 600). Rehearsal stack: `/etc/bookrunner/testnet-live.env` (root:root 0600, one line per key: `BKRN_TESTNET_LIVE_MNEMONIC`, its `ORACLE_SEED`, `ORDERLY_BUILDER_KEY_SECRET`; no `.env.testnet-live` on the server), `contracts/deployments/46630.live.json`, `.data/testnet-live/` (Orderly keys of accounts holding real testnet USDG), DB `bookrunner_testnet_live` (all in the daily backup, RESTORE.md) |
| Stack | `bookrunner.service` (user `bookrunner`, sandboxed) → `scripts/dev.ts --network testnet --no-web` (cap 2.5 GB RAM); optional `bookrunner@testnet-live` → `scripts/dev.ts --network testnet-live --no-web` (cap 2 GB, API 127.0.0.1:4500, oracle 4510, charter 4530; installed, not enabled) |
| Infra | `bookrunner-infra.service` (root) → `docker-compose.yml` → Postgres 127.0.0.1:54400, Redis 127.0.0.1:63790, Redis `redis-live` 127.0.0.1:63791 (the rehearsal stack's own; all password-protected: `REDIS_LIVE_PASSWORD` added to `.env.infra` by install.sh) |
| Web | site → `/var/www/bookrunner/`, app → `/var/www/bookrunner/app/`; nginx site `bookrunner` + snippet `/etc/nginx/snippets/bookrunner-locations.conf` + rate-limit zones `/etc/nginx/conf.d/bookrunner-ratelimit.conf` |
| Logs | `/opt/bookrunner/app/.data/testnet/dev.log`, `/opt/bookrunner/app/.data/testnet-live/dev.log` (logrotate daily, 7 kept) |

## URL layout

| URL | Served from | Built by | Cache |
|---|---|---|---|
| `/`, `/research/`, `/jobs/`, `/documents/`, `/dashboard/`, … | `/var/www/bookrunner/` (`apps/site/dist`, one `index.html` per directory) | `cd apps/site && bun run build` | HTML `no-cache`; `/assets/` (not hashed) 1 day; other files 1 hour |
| `/app/…` | `/var/www/bookrunner/app/` (`apps/web/dist`, single-page app: unknown paths → `/app/index.html`) | `cd apps/web && WEB_BASE=/app/ bun run build:testnet` (vite `base`, react-router `basename` `/app`) | HTML `no-cache`; `/app/assets/` (hashed) immutable, 1 year |
| `/trpc/<procedures>`, `/health`, `/status.json` | proxy → API `127.0.0.1:4400` (normalized path, `X-Bookrunner-Route` stamp; `/trpc/` paths with a backslash, `%2F` / `%5C` / `%2E` or a dot-segment → 400, audit L-3; check: `bash deploy/server/nginx-path-check.sh`, Docker) | — | — |
| (rule) any nginx location that proxies to `127.0.0.1:4400` | must `proxy_pass` a fixed URI and `proxy_set_header X-Bookrunner-Route <upstream path>`: the API's route check fails open (a request without the header is treated as loopback tooling and may reach `/v1` and `/mcp`); `apps/site/test/audit-nginx-paths.test.ts` lists the allowed proxies | — | — |
| `*.webm`, `*.mp4` | either tree, explicit `video/*` types, byte ranges | — | 1 day |
| `/invest`, `/books/…`, `/learn`, … (the app's old root URLs) | 301 → `/app/…` | — | — |
| `/robots.txt`, `/sitemap.xml`, `/favicon.ico`, `/apple-touch-icon.png` | `apps/site/public/` | copied by vite | 1 hour |
| `/.well-known/security.txt` (RFC 9116) | `apps/site/public/.well-known/` (vite copies dot folders) | copied by vite | 1 day, `text/plain; charset=utf-8` |
| `https://www.bookrunner.tech/…` | 301 → `https://bookrunner.tech/…` (same path and query) | — | — |
| `http://<anything>.bookrunner.tech/` (wildcard DNS) | 301 → `https://bookrunner.tech/` (`nginx-bookrunner-wildcard.conf`) | — | — |

Indexing: `/app/` sends `X-Robots-Tag: noindex` (and its HTML has `<meta name="robots" content="noindex">`);
`robots.txt` disallows `/app/` and `/trpc/` and points at `sitemap.xml` (the six public pages). The site's pages
carry a canonical URL, absolute Open Graph / X card tags (`/assets/bookrunner-og.jpg`, 1200×630) and, on the
home page, Organization + WebSite JSON-LD. The template's old "specification" article is retired: its links
point to the rulebook at `/documents/`, and nginx answers `/research/human-creativity-benchmark` (and
`/human-creativity-benchmark`) with a 301 to `/documents/`.

Behind Cloudflare (optional, recommended before mainnet): the locations snippet trusts `CF-Connecting-IP` only
from Cloudflare's published ranges (`set_real_ip_from`), so rate limits and logs keep seeing the real visitor.
Cloudflare settings this site needs: SSL/TLS mode **Full (strict)**; **Rocket Loader off**, **Email Address
Obfuscation off** and no automatic Web Analytics injection (each inserts a script the CSP blocks); proxy
(orange cloud) on `@` and `www` only, mail and other names DNS-only; caching left at the default (HTML and
`/trpc`, `/health`, `/status.json` are not cached).

The app is built with `VITE_API_URL=same-origin`: it calls `{origin}/trpc` and `{origin}/health` at the host
root, never under `/app/`. The dev server (`bun run dev`) still serves the app at `/`.

### nginx files

- `nginx-bookrunner.conf` — the site template (`server{}` with `server_name bookrunner.tech
  www.bookrunner.tech`, `root`, security headers and `include /etc/nginx/snippets/bookrunner-locations.conf;`).
  `install.sh` installs it only on a first install: certbot rewrites that file in place (TLS listeners, port-80
  redirect), so it is never overwritten later. The one line kept current in the live copy is its server-level
  HSTS header: `update.sh` / `install.sh` (`nginx_patch_site_hsts`) turn `max-age=31536000` into
  `max-age=31536000; includeSubDomains` in place (validated, rolled back on failure; a no-op afterwards).
- `nginx-bookrunner-locations.conf` — the www → apex 301 (a server-level `if ($host = www.bookrunner.tech)`
  holding only a `return`, so the redirect carries the site file's server-level headers, HSTS included),
  every `location` block, the security headers (HSTS `max-age=31536000; includeSubDomains`, never `preload`;
  the Content-Security-Policy `$bookrunner_csp`; Permissions-Policy; `X-Robots-Tag: noindex` on `/app/`),
  `server_tokens off`, gzip for this server (`gzip_types`: CSS, JS incl. the `.mjs` Framer runtime, JSON, XML,
  SVG, text, icons; HTML is always compressed: the 850 KB home page is ~77 KB on the wire), `*.map` → 404,
  `/.well-known/security.txt` as `text/plain`, and the per-IP rate limits of `/trpc/` and `/health`.
  `install.sh` and `update.sh` copy it to
  `/etc/nginx/snippets/bookrunner-locations.conf` (nginx's `www-data` cannot read `/opt/bookrunner`, mode 750),
  validate with `nginx -t`, reload, and put the previous copy back if validation fails.
- `nginx-bookrunner-http.conf` — the http{}-level rate-limit zones the snippet uses, installed (same validate /
  rollback) to `/etc/nginx/conf.d/bookrunner-ratelimit.conf` before the snippet.
- `patch-nginx.sh` — one-time conversion of a live site that predates the snippet: in each `server{}` block that
  has location blocks (the 443 block certbot made), it replaces them with the `include`, keeping certbot's
  listeners/certificates, then runs `nginx -t` and reloads, or restores the backup
  (`/etc/nginx/bookrunner-backups/`) on failure. `--dry-run` prints the diff only. Idempotent.
- `nginx-bookrunner-wildcard.conf` — a port-80 `server{}` for `*.bookrunner.tech` (the DNS wildcard points at
  this host) that answers 301 → `https://bookrunner.tech/`, instead of the host's default server (another
  project's). `update.sh` / `install.sh` install it to `/etc/nginx/sites-available/bookrunner-wildcard` and link
  it in `sites-enabled` (`nginx_install_wildcard_site`: file and link added together, `nginx -t`, both removed
  again on failure). nginx prefers exact names over wildcards, so `bookrunner.tech`, `www.bookrunner.tech` and
  `leveret.bookrunner.tech` (another project on this host, its own site file) are unaffected. There is no
  wildcard certificate, hence no 443 block: `https://unknown.bookrunner.tech` still meets another server's
  certificate.
- `nginx-lib.sh` — the shared install/validate/rollback helpers.

HSTS `includeSubDomains`: once a browser has seen it, it only talks HTTPS to every `*.bookrunner.tech` name for
a year. Every subdomain a person opens in a browser (`leveret.bookrunner.tech`, a webmail, ...) must therefore
serve a valid certificate. `preload` is deliberately not set (it cannot be undone quickly).

## First install

```bash
# as a sudo user on the server
sudo useradd --system --create-home --home-dir /opt/bookrunner --shell /usr/sbin/nologin bookrunner
sudo apt-get install -y docker.io docker-compose-v2   # the bookrunner user is NOT added to the docker group
sudo -u bookrunner HOME=/opt/bookrunner git clone https://github.com/Panda-Dev-WEB3/BookRunner.git /opt/bookrunner/app
sudo -u bookrunner HOME=/opt/bookrunner npm install --prefix /opt/bookrunner/tools bun@1.4.2
cd /opt/bookrunner/app && sudo -u bookrunner HOME=/opt/bookrunner /opt/bookrunner/tools/node_modules/.bin/bun install --frozen-lockfile
# what root runs comes from a root-owned clone, never from the bookrunner-owned app tree
sudo git clone https://github.com/Panda-Dev-WEB3/BookRunner.git /usr/local/lib/bookrunner-src
sudo bash /usr/local/lib/bookrunner-src/deploy/server/install.sh   # also generates .env.infra (fresh DB: used as is)
```

Then move the running stack's secrets and state here (the same keys must never run in two places):
stop the old stack, copy `.env.testnet` (it needs `ORACLE_SEED`, see HARDENING.md step 1),
`contracts/deployments/46630.json`, `.data/testnet/` (mock venue snapshot, ops keys, sagas), restore the
`bookrunner_testnet` Postgres dump and the Redis AOF/RDB, then:

```bash
sudo /usr/local/lib/bookrunner-deploy/update.sh       # builds + publishes the web app, starts infra + stack
# DNS: A records bookrunner.tech and www.bookrunner.tech (and the *.bookrunner.tech wildcard) -> this host
sudo certbot --nginx -d bookrunner.tech -d www.bookrunner.tech   # the certificate covers exactly these two names
```

(The earlier names `bookrunner.use-cert.com` and `bookrunner.141-94-203-130.sslip.io` are retired; the site
template no longer lists them.)

## Operate

```bash
sudo systemctl status bookrunner bookrunner-infra   # stack, infra
sudo tail -f /opt/bookrunner/app/.data/testnet/dev.log
sudo systemctl restart bookrunner
sudo systemctl start bookrunner@testnet-live              # rehearsal stack next to it (stop: systemctl stop bookrunner@testnet-live)
sudo /usr/local/lib/bookrunner-deploy/rehearsal-deploy.sh  # deploy the rehearsal contracts (root-owned wrapper; RUNBOOK step 3.1)
sudo /usr/local/lib/bookrunner-deploy/update.sh            # deploy origin/main
sudo /usr/local/lib/bookrunner-deploy/update.sh --web-only # site + app + nginx + units, no restart
```

Checks after an nginx change:

```bash
curl -sI https://www.bookrunner.tech/research/ | grep -iE '^(HTTP|location|strict-transport)'  # 301 -> https://bookrunner.tech/research/, HSTS includeSubDomains
curl -sI https://bookrunner.tech/app/ | grep -i x-robots-tag                                    # noindex
curl -sI https://bookrunner.tech/.well-known/security.txt | grep -i content-type               # text/plain; charset=utf-8
curl -s -o /dev/null -w '%{size_download}\n' -H 'Accept-Encoding: gzip' https://bookrunner.tech/  # ~77 KB (850 KB raw)
curl -sI -H 'Accept-Encoding: gzip' https://bookrunner.tech/assets/framer/script_main.BdWRP7AY.mjs | grep -i content-encoding  # gzip
curl -sI http://nope.bookrunner.tech/ | grep -iE '^(HTTP|location)'                              # 301 -> https://bookrunner.tech/
curl -sI http://leveret.bookrunner.tech/ | head -1                                             # leveret's own answer, not ours
```

## Alerts, backups, status

- **Alerts** (`services/alerts`, a child of `scripts/dev.ts` like every service; no signing key): every 60 s it
  checks marks, risk / kills, supervised processes (Redis heartbeat `bkrn:<ns>:supervisor:status` written by
  dev.ts), role-key and gas-funder ETH, RPC errors / head lag, indexer lag, venue-report age, buybackPending,
  the API's `/health`, the oracle's `/health` (a live price source failing in-session tickers for > 60 s:
  `oracle_source_failing`, `ALERT_ORACLE_SOURCE_FAIL_SECONDS` — mainnet / primary-confirm: critical for the Chainlink
  primary, a warning after 10 min for a confirm source; median policy: critical when two fail on one ticker;
  `oracle_price_missing` when an in-session ticker has no publishable price for > 2 min; mainnet also
  `oracle_confirm_divergence` (Chainlink vs the DEX TWAP beyond `ORACLE_CONFIRM_BPS` for 2 min),
  `oracle_primary_suspect_stale` (gap above `ORACLE_PRIMARY_LAG_BPS` with no new Chainlink round for
  `ALERT_ORACLE_PRIMARY_LAG_SECONDS`, 10 min: the feed may have stopped updating) and
  `oracle_confirm_unavailable` (no confirm source for 10 min); docs/RUNBOOK.md "Real prices") and the backup
  record, and sends one message per condition (and one "resolved") by email and/or webhook. Configure in `.env.<network>`: `ALERT_EMAIL_TO`, `ALERT_SMTP_USER`, `ALERT_SMTP_PASS`
  (host `mail.ignition-x.com:587` STARTTLS by default), and/or `ALERT_WEBHOOK_URL` (Slack / Discord / Telegram +
  `ALERT_TELEGRAM_CHAT_ID` / generic JSON); optional `ALERT_HEARTBEAT_URL` (dead-man's switch) and
  `ALERT_DIGEST_HOUR_UTC`. Thresholds: `services/alerts/src/config.ts`. Test the channels:
  `sudo -u bookrunner HOME=/opt/bookrunner sh -c 'cd /opt/bookrunner/app/services/alerts && set -a && . ../../.env.testnet && set +a && NETWORK=testnet ../../node_modules/.bin/bun src/main.ts --test'`.
- **Backups**: `bookrunner-backup.timer` (daily, root, `backup.sh` from the root-owned copy) — see
  [RESTORE.md](RESTORE.md) for contents, the restore drill (`backup.sh --verify`) and the restore procedure.
- **Status**: `/status/` (site page) reads `/status.json` (nginx -> API `GET /status`: per book the latest mark
  age, risk ok / warn / breach, last distribution; no addresses or secrets; computed at most every 15 s).

`update.sh` (root-owned copy only; it refuses to run from the app tree) fetches `origin/main` into the root
clone, refreshes `/usr/local/lib/bookrunner-deploy` (re-running itself when `update.sh` changed),
fast-forwards the app checkout to the same commit (refusing local modifications), builds the app
(`apps/web`, base `/app/`) and the site (`apps/site`) as `bookrunner`, publishes the app with
`rsync --delete` to `/var/www/bookrunner/app/` and the site with `rsync --delete --exclude=/app` to
`/var/www/bookrunner/` (so the site's `--delete` never removes the app), installs the nginx rate-limit conf +
snippet, brings the live site's server-level HSTS line to `includeSubDomains`, installs the wildcard site, and
the units from the root copy, applies a changed compose file (`systemctl reload
bookrunner-infra`) and restarts the stack. It warns while the live site does not include the snippet yet
(run `patch-nginx.sh` once).

### Moving an existing server to the site + `/app/` layout (once; historical, before HARDENING.md)

```bash
cd /opt/bookrunner/app
# 1. pull first: the update.sh already on the server predates the re-run-on-change logic
sudo -u bookrunner HOME=/opt/bookrunner git fetch origin main
sudo -u bookrunner HOME=/opt/bookrunner git merge --ff-only origin/main
# 2. build + publish site and app, install the snippet (warns that the site does not include it yet)
sudo bash deploy/server/update.sh --web-only
# 3. switch the certbot-managed site to the snippet: review the diff, then apply (nginx -t, reload, rollback)
sudo bash deploy/server/patch-nginx.sh --dry-run
sudo bash deploy/server/patch-nginx.sh
# 4. check
curl -sI https://bookrunner.tech/ | head -5               # site, Cache-Control: no-cache
curl -sI https://bookrunner.tech/app/books | head -5      # app index.html (SPA fallback)
curl -s  https://bookrunner.tech/health                   # API
curl -sI https://bookrunner.tech/books | grep -i location # 301 -> /app/books
```
