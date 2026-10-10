# Mainnet host (Robinhood Chain 4663)

The mainnet stack runs on its **own host**: never on the testnet server (bookrunner.tech, `bookrunner.service`),
never on a developer PC. Same layout and hardening as the testnet host ([README.md](README.md),
[HARDENING.md](HARDENING.md)) with these differences:

| | Testnet host | Mainnet host |
|---|---|---|
| Unit | `bookrunner.service` (`--network testnet`) | `bookrunner@mainnet.service` (template [`bookrunner@.service`](bookrunner@.service), `--network mainnet`) |
| Secrets | `.env.testnet` in the app tree (mnemonic) | `/etc/bookrunner/mainnet.env` (root:root 0600, read by systemd) — **no mnemonic, no private key of a protocol role on disk**: one KMS key per service role |
| Role keys | derived from `BKRN_TESTNET_MNEMONIC` | `<ROLE>_KMS_KEY_ID` per role (AWS KMS, `ECC_SECG_P256K1`, `SIGN_VERIFY`), `packages/shared/src/signer.ts` |
| Deployer | devkeys index 0, stays `config.timelock()` | one-shot EOA used by `scripts/deploy-mainnet.sh` from the operator machine; holds nothing afterwards |
| Processes | all services + agents + trader-sim + mock-orderly + gas-keeper + launch | services + agents only: no trader-sim, mock-orderly, gas-keeper, launch, web dev server |
| Cadence | marks hourly (3600) | marks daily (86400, the on-chain `markInterval`) |
| Oracle | synthetic GBM (secret seed) | real sources only (`ORACLE_CHAINLINK_FEEDS`, `ORACLE_HTTP_SOURCES`), `ORACLE_SYNTHETIC=0` |
| Orderly | mock | live (`ORDERLY_MODE=live`, builder key from the env file) |
| Deployment record | `contracts/deployments/46630.json` (launch appends books) | `contracts/deployments/4663.json` (copied from the deploy machine; `scripts/record-books.ts` appends chartered books; read-only to the stack) |
| Database / Redis | `bookrunner_testnet`, Redis db 1 | `bookrunner_mainnet`, Redis db 0, passwords required |

`scripts/dev.ts --network mainnet` refuses to start while any required env var, any role signer, the oracle
sources or the DeployMainnet record is missing, while two roles share a key, or while any `*MNEMONIC*`, the
deployer key, the funder key or `BKRN_ALLOW_ADMIN_KEY` is in the environment (scripts/network-profile.ts).

## 1. Host

As in README.md "First install" (user `bookrunner`, root-owned clone `/usr/local/lib/bookrunner-src`,
`install.sh`, infra unit), then:

```bash
sudo install -m 0644 /usr/local/lib/bookrunner-deploy/bookrunner@.service /etc/systemd/system/
sudo systemctl disable --now bookrunner.service 2>/dev/null || true   # the testnet unit never runs here
sudo install -d -m 0700 -o root -g root /etc/bookrunner
sudo docker exec bookrunner-postgres-1 psql -U bookrunner -d bookrunner -c "CREATE DATABASE bookrunner_mainnet"
# migrate with the generated password (read from the root-only file, never printed)
sudo sh -c '. /usr/local/lib/bookrunner-deploy/.env.infra; cd /opt/bookrunner/app && \
  sudo -u bookrunner HOME=/opt/bookrunner DATABASE_URL="postgres://bookrunner:$POSTGRES_PASSWORD@127.0.0.1:54400/bookrunner_mainnet" \
  node_modules/.bin/bun run --cwd packages/db migrate'
```

KMS client (optional dependency, loaded only when a `*_KMS_KEY_ID` is set; not in the lockfile):

```bash
cd /opt/bookrunner/app && sudo -u bookrunner HOME=/opt/bookrunner node_modules/.bin/bun add --no-save @aws-sdk/client-kms
```

(Re-run after every `bun install --frozen-lockfile`. Next step: make it a pinned `optionalDependencies` entry
once the lockfile can be regenerated with network access.)

## 2. Role keys (AWS KMS)

One asymmetric key per service role, key spec `ECC_SECG_P256K1`, usage `SIGN_VERIFY`:
`bkrn-mark`, `bkrn-risk`, `bkrn-ops-venue`, `bkrn-jury`, `bkrn-keeper`, `bkrn-oracle`. The host's instance role
may call only `kms:GetPublicKey` and `kms:Sign` on exactly these keys (no `kms:*`, no key creation/deletion).
Each process receives only its own key id (`childenv.ts`). Print the addresses for the deploy input:

```bash
cd /opt/bookrunner/app && sudo -u bookrunner HOME=/opt/bookrunner sh -c 'AWS_REGION=<region> CHAIN_ID=4663 \
  MARK_SIGNER_KMS_KEY_ID=alias/bkrn-mark node_modules/.bin/bun -e "import {roleSigner} from \"./packages/shared/src/signer\"; console.log((await roleSigner(\"markSigner\")).address)"'
```

(repeat per role; the addresses go into `roles.*` / `oracle.signers[].signer` of the deploy input). Fund each
address with a small amount of ETH for gas: there is no gas keeper on mainnet; the operator tops up from the
treasury (alert on balance, RUNBOOK "Operations").

A role may instead use `<ROLE>_PRIVATE_KEY` (local key in the env file) — allowed, not recommended; never two
roles with one key, never both a key and a KMS id for one role.

## 3. `/etc/bookrunner/mainnet.env` (root:root 0600)

```bash
RHC_RPC_URL=https://<archive rpc>                      # VERIFY R2/R3
WEB_ORIGIN=https://<mainnet domain>
API_ADMIN_TOKEN=<openssl rand -hex 32>
ORDERLY_BASE_URL=https://api.orderly.org               # VERIFY: RHC endpoint
ORDERLY_BROKER_ID=<builder broker id>                  # == deploy input externals.orderlyBrokerId
ORDERLY_BUILDER_KEY_SECRET=<base58 ed25519 seed>
ANTHROPIC_API_KEY=<key>                                # charter jury
ORACLE_CHAINLINK_FEEDS='{"NVDA":"0x...",...}'          # = chainlinkFeeds of 4663.json; single quotes (systemd + sh)
AWS_REGION=<region>
MARK_SIGNER_KMS_KEY_ID=alias/bkrn-mark
RISK_KMS_KEY_ID=alias/bkrn-risk
OPS_VENUE_KMS_KEY_ID=alias/bkrn-ops-venue
JURY_KMS_KEY_ID=alias/bkrn-jury
KEEPER_KMS_KEY_ID=alias/bkrn-keeper
ORACLE_SIGNER_KMS_KEY_ID=alias/bkrn-oracle
# per launched book, once the sponsor registered its desk session key (MMMandate.registerKey):
# DESK_KEY_PRIVATE_KEY_<bookId>=0x...                 # reaches that book's agent only
```

`POSTGRES_PASSWORD` / `REDIS_PASSWORD` come from `.env.infra` (install.sh). Never put a mnemonic here.

## 4. Start / operate

```bash
sudo install -m 0640 -o bookrunner -g bookrunner <archived 4663.json> /opt/bookrunner/app/contracts/deployments/4663.json
sudo systemctl enable --now bookrunner@mainnet
sudo tail -f /opt/bookrunner/app/.data/mainnet/dev.log     # a refusal lists every missing item
# after the committee approves a charter (RUNBOOK step 8): list, then append the new books (read-only on chain)
sudo sh -c '. /etc/bookrunner/mainnet.env; cd /opt/bookrunner/app && sudo -u bookrunner HOME=/opt/bookrunner \
  RPC_URL="$RHC_RPC_URL" node_modules/.bin/bun scripts/record-books.ts --file contracts/deployments/4663.json --dry-run'
sudo sh -c '. /etc/bookrunner/mainnet.env; cd /opt/bookrunner/app && sudo -u bookrunner HOME=/opt/bookrunner \
  RPC_URL="$RHC_RPC_URL" node_modules/.bin/bun scripts/record-books.ts --file contracts/deployments/4663.json'
```

dev.ts starts the new books' agents within seconds; archive the updated record. `update.sh` restarts
`bookrunner.service`; on the mainnet host restart `bookrunner@mainnet` instead
(`sudo systemctl restart bookrunner@mainnet`).
