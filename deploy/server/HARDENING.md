# Server hardening (testnet host) — what changed and the operator steps, in order

The host is shared with other services, so the Bookrunner stack must not be a path to root, must not hand
its secrets to processes that do not need them, and must not sign predictable prices.

| Area | Before | After |
|---|---|---|
| Who runs `update.sh` / installs units, nginx conf, compose | root, from `/opt/bookrunner/app` (writable by `bookrunner`) | root, from **root-owned** `/usr/local/lib/bookrunner-src` (clone) → `/usr/local/lib/bookrunner-deploy` (copy) |
| Docker (Postgres + Redis) | `bookrunner.service` ExecStartPre, user `bookrunner` in the `docker` group (= root) | `bookrunner-infra.service` (root); `bookrunner` leaves the `docker` group |
| Stack sandbox | `ProtectSystem=full`, `NoNewPrivileges` | `ProtectSystem=strict` (writable: `.data/`, `contracts/deployments/`), `ProtectHome`, no capabilities, `RestrictAddressFamilies`, `RestrictNamespaces`, `LockPersonality`, `RestrictRealtime`, `SystemCallArchitectures=native`, `ProtectProc=invisible`, `PrivateDevices`, kernel/clock/hostname protection, `UMask=0027`. **Not** `MemoryDenyWriteExecute` (bun's JIT needs W+X) |
| Infra passwords | Postgres `bookrunner`/`bookrunner`, Redis no auth | random, in `/usr/local/lib/bookrunner-deploy/.env.infra` (root:root 0600) |
| Secrets per process | every child got the whole env (mnemonic, `ANTHROPIC_API_KEY`, ...) | allow-list per child (`packages/shared/src/childenv.ts`) |
| Protocol admin (deployer) key | derived from the shared mnemonic by any process | only with `BKRN_ALLOW_ADMIN_KEY=1` (launch / deploy scripts) or `DEPLOYER_PRIVATE_KEY`; the gas keeper uses a dedicated **funder** key |
| Oracle on testnet | synthetic prices from the public seed `bookrunner-devnet` | refuses to start without a secret `ORACLE_SEED`; per-step CSPRNG entropy |
| nginx | no HSTS / CSP / Permissions-Policy, version in `Server:`, source maps public, no rate limit | all headers (HSTS `max-age=31536000; includeSubDomains`, no `preload`), `server_tokens off`, `*.map` → 404 (and builds emit none), `/trpc/` + `/health` rate-limited per IP (the API caps tRPC batches at 10), `receipts.*` in a stricter zone (2 r/s, audit M-4; one fills a batch); `/trpc/` forwarded normalized with backslashes / encoded separators / dot-segments refused (audit L-3), so `/v1` and `/mcp` stay loopback-only; www → apex 301; unknown `*.bookrunner.tech` (port 80) → apex; `/app/` `X-Robots-Tag: noindex`; the CSP allows no third-party host beyond Framer CDN, Google Fonts, the testnet RPC and WalletConnect / Reown |

Values never appear in these commands' output: every secret is generated into a file and read from it.

## Operator runbook (existing server), in this order

0. **Merge and push** the change to `main` (developer side).

1. **Oracle seed** (the new oracle refuses to run on 46630 without it). Add it once:
   ```bash
   sudo grep -c '^ORACLE_SEED=' /opt/bookrunner/app/.env.testnet   # 0 = not set yet (prints a count only)
   sudo -u bookrunner sh -c 'umask 077; printf "ORACLE_SEED=%s\n" "$(openssl rand -hex 32)" >> /opt/bookrunner/app/.env.testnet'
   ```
   Do not reuse it anywhere else; rotating it later is just a new value + stack restart.

2. **Root-owned clone + install** (installs `/usr/local/lib/bookrunner-deploy`, both units — enabled, nothing
   restarted —, the nginx rate-limit conf + locations snippet (nginx reloads: HSTS/CSP/limits are live from
   here), logrotate; generates `.env.infra`):
   ```bash
   sudo git clone https://github.com/Panda-Dev-WEB3/BookRunner.git /usr/local/lib/bookrunner-src
   sudo git -C /usr/local/lib/bookrunner-src log -1 --format='%H %s'   # the commit you reviewed
   sudo bash /usr/local/lib/bookrunner-src/deploy/server/install.sh
   ```
   If install.sh prints "nginx -t failed", the previous nginx files were restored; fix before continuing.

3. **Code + web, no restart yet** (pull the app to the same commit, build, publish without source maps):
   ```bash
   sudo /usr/local/lib/bookrunner-deploy/update.sh --web-only
   ```
   Until step 5 the running stack keeps its old code and env. (A child that crashes in this window restarts
   with the new code but the old env; the oracle would then refuse to start until step 5 — keep it short.)

4. **Gas funder** (the gas keeper no longer spends the deployer's ETH). Print its address and fund it with
   test ETH, either from the faucet (https://faucet.testnet.chain.robinhood.com) or once from the deployer:
   ```bash
   cd /opt/bookrunner/app
   sudo -u bookrunner HOME=/opt/bookrunner sh -c 'set -a; . ./.env.testnet; set +a; CHAIN_ID=46630 RPC_URL=${RHC_TESTNET_RPC_URL:-https://rpc.testnet.chain.robinhood.com} node_modules/.bin/bun scripts/gas-keeper.ts --address'
   # optional, sends ONE transfer deployer -> funder (operator action, admin opt-in on this command only):
   sudo -u bookrunner HOME=/opt/bookrunner sh -c 'set -a; . ./.env.testnet; set +a; BKRN_ALLOW_ADMIN_KEY=1 CHAIN_ID=46630 RPC_URL=${RHC_TESTNET_RPC_URL:-https://rpc.testnet.chain.robinhood.com} node_modules/.bin/bun scripts/gas-keeper.ts --seed-funder 0.2'
   ```
   (Alternatively put a separate key in `.env.testnet` as `BKRN_TESTNET_FUNDER_PK=0x...` and fund that.)

5. **Cut over: infra unit + passwords** (≈1 min of downtime). Postgres keeps the password of its existing data
   directory, so it is changed in the DB first; Redis gets `requirepass` when its container is recreated.
   ```bash
   sudo systemctl stop bookrunner
   # Postgres: set the generated password (read from the root-only file, never printed)
   sudo sh -c '. /usr/local/lib/bookrunner-deploy/.env.infra; printf "ALTER USER bookrunner WITH PASSWORD '"'"'%s'"'"';\n" "$POSTGRES_PASSWORD" | docker exec -i bookrunner-postgres-1 psql -v ON_ERROR_STOP=1 -q -U bookrunner -d bookrunner'
   # containers adopted by the root unit; redis is recreated with requirepass (AOF volume kept)
   sudo systemctl start bookrunner-infra
   sudo systemctl status bookrunner-infra --no-pager | head -5
   sudo docker exec bookrunner-redis-1 redis-cli ping            # expect: NOAUTH Authentication required
   sudo systemctl start bookrunner
   sudo tail -n 100 /opt/bookrunner/app/.data/testnet/dev.log    # oracle "synthetic GBM sources enabled", no auth errors
   ```
   Rollback of this step only: `sudo rm /usr/local/lib/bookrunner-deploy/.env.infra`, ALTER USER back to
   `bookrunner` (same command with the literal), `sudo systemctl reload bookrunner-infra && sudo systemctl restart bookrunner`.

6. **Drop the docker group** (the stack no longer touches Docker):
   ```bash
   sudo gpasswd -d bookrunner docker
   sudo -u bookrunner docker ps 2>&1 | head -1                    # expect: permission denied
   ```

7. **Check** (from anywhere):
   ```bash
   curl -sI https://bookrunner.tech/ | grep -iE 'strict-transport|content-security|permissions-policy|^server'
   curl -s -o /dev/null -w '%{http_code}\n' https://bookrunner.tech/dashboard/app.js.map        # 404
   curl -s https://bookrunner.tech/health                                                      # capabilities, no procedures/uptime
   curl -s -o /dev/null -w '%{http_code}\n' "https://bookrunner.tech/trpc/$(printf 'book.list,%.0s' {1..11} | sed 's/,$//')?batch=1&input=%7B%7D"   # 400
   ```
   Then open `/`, `/research/`, `/jobs/`, `/dashboard/` and `/app/` in a browser with the console open: there
   must be no "Content Security Policy" violations except the intended one on the Framer pages (`/`,
   `/research/`, `/jobs/`): `https://framer.com/edit/init.mjs` is blocked. That is Framer's "on-page editing"
   bar, which the export would otherwise load from framer.com into every visitor's page (a third-party script
   on the origin that builds wallet transactions); the page works without it (verified locally with this exact
   policy on `/`, `/research/`, `/jobs/`, `/documents/`,
   `/dashboard/`, `/app/`). If a page breaks, switch the header to report-only until fixed (the next update.sh
   restores the enforcing one):
   ```bash
   sudo sed -i 's/add_header Content-Security-Policy /add_header Content-Security-Policy-Report-Only /' /etc/nginx/snippets/bookrunner-locations.conf && sudo nginx -t && sudo systemctl reload nginx
   ```

8. **From now on**: `sudo /usr/local/lib/bookrunner-deploy/update.sh` (refuses to run from the app tree). It
   fetches into the root clone, refreshes the deploy copy (re-running itself when update.sh changed),
   fast-forwards the app to the same commit, refuses local modifications, builds as `bookrunner`, installs
   nginx/units from the root copy. `BOOKRUNNER_REQUIRE_SIGNED=1` additionally requires `git verify-commit`.

## Notes and residual risk

- The deployer (protocol admin / timelock) is still index 0 of `BKRN_TESTNET_MNEMONIC`, which the signing
  services hold. The code no longer derives it in any service, but the secret is the same: the real fix is
  an on-chain rotation of the admin / timelock roles to a key that never touches this host (operator, on-chain).
- `.env.testnet` (mnemonic, `ORACLE_SEED`, `ANTHROPIC_API_KEY`) stays readable by the `bookrunner` user; the
  per-process allow-list keeps it out of the API, indexer, receipts and web.
- `/health?verbose` (full procedure list, uptime) needs `Authorization: Bearer $API_ADMIN_TOKEN`.
- The CSP allows inline scripts by hash only. When a page under `apps/site/public` or `apps/web/index.html`
  changes an inline `<script>`, `apps/site/test/csp.test.ts` fails and prints the hash to add to
  `nginx-bookrunner-locations.conf`. JSON-LD (`type="application/ld+json"`) is a data block and needs none.
  The same test fails when a page or Framer chunk references an image on a host outside `img-src` (the
  export's template avatars on a third-party media host were removed rather than allowed).
- HSTS carries `includeSubDomains` (no `preload`). The certbot-managed site file keeps its own server-level
  HSTS line (it is what the www → apex redirect carries); `update.sh` updates that one line in place
  (`nginx-lib.sh` `nginx_patch_site_hsts`, `nginx -t` + rollback). Every `*.bookrunner.tech` name opened in a
  browser must serve HTTPS from then on.
- Security contact: `/.well-known/security.txt` (RFC 9116, source `apps/site/public/.well-known/security.txt`,
  policy `SECURITY.md`). Its `Expires` is 2027-10-14; `apps/site/test/audit-nginx-headers.test.ts` fails once it
  has passed, as a reminder to renew it.

## One Unix user for every service (audit 2026-10, privileged operations)

**Finding.** Every service runs as the one `bookrunner` user: a compromise of any process (the internet-facing API
included) reads the files and memory-adjacent state of the processes that sign. The testnet stack is one process
tree (`scripts/dev.ts` under `bookrunner.service`), so splitting it per user is a host redesign, not a unit edit.
**Status: partially fixed (testnet sandbox tightened) / mainnet plan below.**

### What the testnet units do now

`update.sh` installs exactly these from the root-owned copy `/usr/local/lib/bookrunner-deploy` (only when the file
differs, then `systemctl daemon-reload`):

| Installed | Where | Then |
|---|---|---|
| `bookrunner.service`, `bookrunner-infra.service`, `bookrunner-backup.service`, `bookrunner-backup.timer` | `/etc/systemd/system/` (0644) | daemon-reload; unless `--web-only`: `systemctl enable --now bookrunner-infra`, `systemctl reload bookrunner-infra`, `systemctl restart bookrunner` |
| `logrotate-bookrunner` | `/etc/logrotate.d/bookrunner` | — |
| nginx http conf, locations snippet, site HSTS line, wildcard site (`nginx-lib.sh`) | `/etc/nginx/...` | `nginx -t`, rollback on failure, reload |
| `/var/backups/bookrunner` | root 0700 | enables `bookrunner-backup.timer` once |
| the web app and the site | `/var/www/bookrunner` (+ `/app`), owner `bookrunner` | — |

It also refreshes `/usr/local/lib/bookrunner-deploy` itself (rsync from the root clone, `.env.infra` kept),
fast-forwards `/opt/bookrunner/app` and runs `bun install --frozen-lockfile` and the two builds **as `bookrunner`**
(outside any unit: they write `node_modules/`, `apps/*/dist` and bun's cache under `HOME=/opt/bookrunner`).
`bookrunner@.service` is not installed by `update.sh` (mainnet host only, MAINNET.md).

What the running stack (`bookrunner.service`) writes, checked against the code:

| Path | Writer | Covered by |
|---|---|---|
| `/opt/bookrunner/app/.data/testnet/dev.log` | systemd (`StandardOutput=append:`), rotated by logrotate (`copytruncate`, root) | `ReadWritePaths=/opt/bookrunner/app/.data` |
| `.data/testnet/mock-orderly.json` (+ `.tmp`) | mock-orderly snapshot | same |
| `.data/testnet/keys/` (0600) | ops-venue Orderly keys | same |
| `.data/testnet/ops-venue/sagas.json` (+ `.tmp`) | ops-venue sagas | same |
| `.data/testnet/mark-spool/` | mark: committed-mark rows waiting for Postgres | same (**new**: was the default `tmpdir()`, i.e. the unit's `PrivateTmp`, emptied on every restart; `MARK_SPOOL_DIR` now set by the testnet and mainnet profiles, resolved against the repo root) |
| `contracts/deployments/46630.json` | `scripts/launch-devnet.ts` / `record-books.ts`, first start only | `ReadWritePaths=-/opt/bookrunner/app/contracts/deployments` |
| `/tmp` | anything transient | `PrivateTmp=true` (private, emptied on stop) |

Not written at run time: the code tree and `node_modules` (read-only), `HOME` (`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`,
no install at run time). Not used: the Docker socket (Postgres and Redis are reached over TCP on localhost;
`bookrunner-infra.service` is the only Docker client).

Added in this change (on top of the sandbox in the table at the top):

- `bookrunner.service` / `bookrunner@.service`: `InaccessiblePaths` for the Docker and containerd sockets (and
  `/etc/bookrunner` on the testnet unit, which reads nothing there), so even a later `docker` group membership gives
  the stack no Docker access; `SystemCallFilter=~@clock @cpu-emulation @debug @module @mount @obsolete @raw-io
  @reboot @swap` with `SystemCallErrorNumber=EPERM` (a deny-list, so an unexpected call fails with EPERM instead of
  killing the process; every group in it is also denied by Docker's default seccomp profile, under which bun runs
  unchanged, except `ptrace`, which bun does not use); `RemoveIPC=yes`.
- `bookrunner-infra.service` (root, Docker CLI only): `NoNewPrivileges`, `ProtectSystem=full`, `PrivateTmp`,
  kernel / clock / cgroup protection, `RestrictSUIDSGID`, `RestrictRealtime`, `LockPersonality`, address families
  unix / inet / netlink, `UMask=0077`. `dockerd` and the containers are untouched (they run under `docker.service`).
- `bookrunner-backup.service`: `ProtectKernelLogs`, `ProtectClock`, `RestrictSUIDSGID`, `RestrictRealtime`,
  `LockPersonality`.

`systemd-analyze verify` (systemd 255) reports no error on any of the four units; `systemd-analyze security
--offline` exposure: `bookrunner.service` 2.9 → 1.5, `bookrunner-infra.service` 9.4 → 6.9, `bookrunner-backup.service`
8.1 → 7.1. Not set, on purpose: `MemoryDenyWriteExecute` (bun's JIT), `ProcSubset=pid` (bun / libuv may read
`/proc/meminfo`, `/proc/stat`), `ProtectHome` on the infra unit (the Docker CLI may create `/root/.docker`).

**Operator steps.** None beyond the usual `sudo /usr/local/lib/bookrunner-deploy/update.sh`: it installs the
changed units, reloads systemd, reloads the infra unit and restarts the stack. Check after it:

```bash
systemctl is-active bookrunner bookrunner-infra            # active / active
sudo tail -n 50 /opt/bookrunner/app/.data/testnet/dev.log  # every service started, no EPERM / EROFS
sudo journalctl -u bookrunner-infra -n 20 --no-pager       # compose "up -d --wait" succeeded
systemd-analyze security bookrunner | tail -1              # ~1.5
```

Rollback of the sandbox only (keeps everything else): `sudo systemctl edit bookrunner` with an empty
`SystemCallFilter=` and `InaccessiblePaths=` (or `sudo systemctl edit bookrunner-infra` with `ProtectSystem=no`),
then `sudo systemctl daemon-reload && sudo systemctl restart bookrunner`. Before this change a mark row spooled
during a Postgres outage sat in the unit's `PrivateTmp` and was lost at the next restart; do not run the update while
`dev.log` shows mark rows waiting in the spool (they are flushed at the mark service's next successful tick).

### Mainnet target (plan, not built)

The signing services run as separate Unix users, on separate hosts where the budget allows, with no key on disk:

| Process group | User / host | Secrets it can use |
|---|---|---|
| `oracle` (price signer) | `bkrn-oracle`, ideally its own host / TEE (the attested signer, VERIFY E1) | `ORACLE_SIGNER_KMS_KEY_ID` (KMS `Sign` only), source API keys |
| `mark` (MARK_SIGNER) | `bkrn-mark` | `MARK_SIGNER_KMS_KEY_ID` |
| `ops-venue` (OPS_VENUE, Orderly keys) | `bkrn-ops`, own host | `OPS_VENUE_KMS_KEY_ID`, its `.data/mainnet/keys` (0600, its own directory) |
| `risk`, `charter` (jury), keeper, agents | one user per role | their own `<ROLE>_KMS_KEY_ID` |
| `api`, `indexer`, `receipts`, `alerts` | `bkrn-api` (internet-facing; no signing material at all) | none (DB / Redis credentials only) |

One systemd unit per group (the `bookrunner@.service` sandbox per unit, `ReadWritePaths` limited to that group's
`.data/mainnet/<group>`), one KMS key policy per role principal (the KMS key of one role cannot be used by another
role's credentials), Redis / Postgres credentials per user, and the internet-facing API on a host or user that
holds no KMS permission. `scripts/dev.ts --network mainnet` already hands each child only its own secret
(`packages/shared/src/childenv.ts`) and refuses a mnemonic; the split replaces the shared user, not that rule.
Until it is built the mainnet host runs `bookrunner@mainnet` as one user (MAINNET.md), which is the residual.
