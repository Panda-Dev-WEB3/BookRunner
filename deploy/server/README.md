# Server install (Robinhood Chain testnet stack)

One Linux host runs the whole testnet stack: every service, one agent per book, the trader simulator,
Postgres/Timescale + Redis in Docker, and nginx serving the built web app at `https://bookrunner.use-cert.com`.
The host is shared with other services, so everything is loopback-only and memory-capped.

| Piece | Where |
|---|---|
| Code | `/opt/bookrunner/app` (git clone of this repo, user `bookrunner`) |
| Secrets + state (never in git) | `.env.testnet` (mode 600), `contracts/deployments/46630.json`, `.data/testnet/` |
| Stack | `bookrunner.service` → `scripts/dev.ts --network testnet --no-web` (cap 2.5 GB RAM) |
| Infra | `deploy/server/docker-compose.yml` → Postgres 127.0.0.1:54400, Redis 127.0.0.1:63790 |
| Web | built to `/var/www/bookrunner`, nginx site `bookrunner` (proxies `/trpc`, `/health` → API :4400) |
| Logs | `/opt/bookrunner/app/.data/testnet/dev.log` (logrotate daily, 7 kept) |

## First install

```bash
# as a sudo user on the server
sudo useradd --system --create-home --home-dir /opt/bookrunner --shell /usr/sbin/nologin bookrunner
sudo apt-get install -y docker.io docker-compose-v2 && sudo usermod -aG docker bookrunner
sudo -u bookrunner HOME=/opt/bookrunner git clone https://github.com/Panda-Dev-WEB3/BookRunner.git /opt/bookrunner/app
sudo -u bookrunner HOME=/opt/bookrunner npm install --prefix /opt/bookrunner/tools bun@1.4.2
cd /opt/bookrunner/app && sudo -u bookrunner HOME=/opt/bookrunner /opt/bookrunner/tools/node_modules/.bin/bun install --frozen-lockfile
sudo bash deploy/server/install.sh
```

Then move the running stack's secrets and state here (the same keys must never run in two places):
stop the old stack, copy `.env.testnet`, `contracts/deployments/46630.json`, `.data/testnet/` (mock venue
snapshot, ops keys, sagas), restore the `bookrunner_testnet` Postgres dump and the Redis AOF/RDB, then:

```bash
sudo bash deploy/server/update.sh                     # builds + publishes the web app, starts the stack
sudo certbot --nginx -d bookrunner.141-94-203-130.sslip.io   # works at once (sslip.io resolves to the IP)
# once the A record bookrunner.use-cert.com -> 141.94.203.130 exists, add it to the same certificate:
sudo certbot --nginx --expand -d bookrunner.141-94-203-130.sslip.io -d bookrunner.use-cert.com
```

## Operate

```bash
sudo systemctl status bookrunner        # stack
sudo tail -f /opt/bookrunner/app/.data/testnet/dev.log
sudo systemctl restart bookrunner
sudo bash /opt/bookrunner/app/deploy/server/update.sh            # deploy origin/main
sudo bash /opt/bookrunner/app/deploy/server/update.sh --web-only # web app only, no stack restart
```
