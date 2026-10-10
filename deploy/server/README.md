# Server install (Robinhood Chain testnet stack)

One Linux host runs the whole testnet stack: every service, one agent per book, the trader simulator,
Postgres/Timescale + Redis in Docker, and nginx serving `https://bookrunner.use-cert.com`: the public site
(`apps/site`) at `/`, the operator app (`apps/web`) at `/app/`, and the API at `/trpc` + `/health`.
The host is shared with other services, so everything is loopback-only and memory-capped.

Hardening (root-owned deploy copy, infra unit, sandbox, passwords, secrets per process) and the exact
operator steps to move an existing server: [HARDENING.md](HARDENING.md).

Mainnet (Robinhood Chain 4663) runs on a separate host with the network-parametrised unit
[`bookrunner@.service`](bookrunner@.service) (`bookrunner@mainnet`), KMS role keys and no simulators:
[MAINNET.md](MAINNET.md). This testnet host keeps `bookrunner.service`.

| Piece | Where |
|---|---|
| Code | `/opt/bookrunner/app` (git clone of this repo, user `bookrunner`; built and run as that user) |
| Deploy scripts / units / nginx conf / compose, as root runs them | `/usr/local/lib/bookrunner-src` (root-owned clone) → `/usr/local/lib/bookrunner-deploy` (root-owned copy of `deploy/server`) |
| Secrets + state (never in git) | `.env.testnet` (mode 600: mnemonic, `ORACLE_SEED`, ...), `contracts/deployments/46630.json`, `.data/testnet/`; infra passwords in `/usr/local/lib/bookrunner-deploy/.env.infra` (root, 600) |
| Stack | `bookrunner.service` (user `bookrunner`, sandboxed) → `scripts/dev.ts --network testnet --no-web` (cap 2.5 GB RAM) |
| Infra | `bookrunner-infra.service` (root) → `docker-compose.yml` → Postgres 127.0.0.1:54400, Redis 127.0.0.1:63790 (both password-protected) |
| Web | site → `/var/www/bookrunner/`, app → `/var/www/bookrunner/app/`; nginx site `bookrunner` + snippet `/etc/nginx/snippets/bookrunner-locations.conf` + rate-limit zones `/etc/nginx/conf.d/bookrunner-ratelimit.conf` |
| Logs | `/opt/bookrunner/app/.data/testnet/dev.log` (logrotate daily, 7 kept) |

## URL layout

| URL | Served from | Built by | Cache |
|---|---|---|---|
| `/`, `/research/`, `/jobs/`, `/documents/`, `/dashboard/`, … | `/var/www/bookrunner/` (`apps/site/dist`, one `index.html` per directory) | `cd apps/site && bun run build` | HTML `no-cache`; `/assets/` (not hashed) 1 day; other files 1 hour |
| `/app/…` | `/var/www/bookrunner/app/` (`apps/web/dist`, single-page app: unknown paths → `/app/index.html`) | `cd apps/web && WEB_BASE=/app/ bun run build:testnet` (vite `base`, react-router `basename` `/app`) | HTML `no-cache`; `/app/assets/` (hashed) immutable, 1 year |
| `/trpc/…`, `/health` | proxy → API `127.0.0.1:4400` | — | — |
| `*.webm`, `*.mp4` | either tree, explicit `video/*` types, byte ranges | — | 1 day |
| `/invest`, `/books/…`, `/learn`, … (the app's old root URLs) | 301 → `/app/…` | — | — |

The app is built with `VITE_API_URL=same-origin`: it calls `{origin}/trpc` and `{origin}/health` at the host
root, never under `/app/`. The dev server (`bun run dev`) still serves the app at `/`.

### nginx files

- `nginx-bookrunner.conf` — the site template (`server{}` with `server_name`, `root`, security headers and
  `include /etc/nginx/snippets/bookrunner-locations.conf;`). `install.sh` installs it only on a first install:
  certbot rewrites that file in place (TLS listeners, port-80 redirect), so it is never overwritten later.
- `nginx-bookrunner-locations.conf` — every `location` block, the security headers (HSTS, the
  Content-Security-Policy `$bookrunner_csp`, Permissions-Policy), `server_tokens off`, `*.map` → 404 and the
  per-IP rate limits of `/trpc/` and `/health`. `install.sh` and `update.sh` copy it to
  `/etc/nginx/snippets/bookrunner-locations.conf` (nginx's `www-data` cannot read `/opt/bookrunner`, mode 750),
  validate with `nginx -t`, reload, and put the previous copy back if validation fails.
- `nginx-bookrunner-http.conf` — the http{}-level rate-limit zones the snippet uses, installed (same validate /
  rollback) to `/etc/nginx/conf.d/bookrunner-ratelimit.conf` before the snippet.
- `patch-nginx.sh` — one-time conversion of a live site that predates the snippet: in each `server{}` block that
  has location blocks (the 443 block certbot made), it replaces them with the `include`, keeping certbot's
  listeners/certificates, then runs `nginx -t` and reloads, or restores the backup
  (`/etc/nginx/bookrunner-backups/`) on failure. `--dry-run` prints the diff only. Idempotent.
- `nginx-lib.sh` — the shared install/validate/rollback helpers.

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
sudo certbot --nginx -d bookrunner.141-94-203-130.sslip.io   # works at once (sslip.io resolves to the IP)
# once the A record bookrunner.use-cert.com -> 141.94.203.130 exists, add it to the same certificate:
sudo certbot --nginx --expand -d bookrunner.141-94-203-130.sslip.io -d bookrunner.use-cert.com
```

## Operate

```bash
sudo systemctl status bookrunner bookrunner-infra   # stack, infra
sudo tail -f /opt/bookrunner/app/.data/testnet/dev.log
sudo systemctl restart bookrunner
sudo /usr/local/lib/bookrunner-deploy/update.sh            # deploy origin/main
sudo /usr/local/lib/bookrunner-deploy/update.sh --web-only # site + app + nginx + units, no restart
```

`update.sh` (root-owned copy only; it refuses to run from the app tree) fetches `origin/main` into the root
clone, refreshes `/usr/local/lib/bookrunner-deploy` (re-running itself when `update.sh` changed),
fast-forwards the app checkout to the same commit (refusing local modifications), builds the app
(`apps/web`, base `/app/`) and the site (`apps/site`) as `bookrunner`, publishes the app with
`rsync --delete` to `/var/www/bookrunner/app/` and the site with `rsync --delete --exclude=/app` to
`/var/www/bookrunner/` (so the site's `--delete` never removes the app), installs the nginx rate-limit conf +
snippet and the units from the root copy, applies a changed compose file (`systemctl reload
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
curl -sI https://bookrunner.use-cert.com/ | head -5               # site, Cache-Control: no-cache
curl -sI https://bookrunner.use-cert.com/app/books | head -5      # app index.html (SPA fallback)
curl -s  https://bookrunner.use-cert.com/health                   # API
curl -sI https://bookrunner.use-cert.com/books | grep -i location # 301 -> /app/books
```
