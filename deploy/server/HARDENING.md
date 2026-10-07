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
| nginx | no HSTS / CSP / Permissions-Policy, version in `Server:`, source maps public, no rate limit | all headers, `server_tokens off`, `*.map` → 404 (and builds emit none), `/trpc/` + `/health` rate-limited per IP; the API caps tRPC batches at 10 |

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
   curl -sI https://bookrunner.use-cert.com/ | grep -iE 'strict-transport|content-security|permissions-policy|^server'
   curl -s -o /dev/null -w '%{http_code}\n' https://bookrunner.use-cert.com/dashboard/app.js.map        # 404
   curl -s https://bookrunner.use-cert.com/health                                                      # capabilities, no procedures/uptime
   curl -s -o /dev/null -w '%{http_code}\n' "https://bookrunner.use-cert.com/trpc/$(printf 'book.list,%.0s' {1..11} | sed 's/,$//')?batch=1&input=%7B%7D"   # 400
   ```
   Then open `/`, `/research/`, `/jobs/`, `/dashboard/` and `/app/` in a browser with the console open: there
   must be no "Content Security Policy" violations except the intended one on the Framer pages (`/`,
   `/research/`, `/jobs/`): `https://framer.com/edit/init.mjs` is blocked. That is Framer's "on-page editing"
   bar, which the export would otherwise load from framer.com into every visitor's page (a third-party script
   on the origin that builds wallet transactions); the page works without it (verified locally with this exact
   policy on `/`, `/research/`, `/research/human-creativity-benchmark/`, `/jobs/`, `/documents/`,
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
  `nginx-bookrunner-locations.conf`.
