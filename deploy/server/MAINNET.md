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
| Oracle | synthetic GBM (secret seed) | real sources only, primary + confirm (`ORACLE_POLICY=primary-confirm`): the Chainlink feeds of `config/chains/4663.json` (or `ORACLE_CHAIN_CONFIG`) alone set and sign each price (`ORACLE_MIN_SOURCES=1`, pinned; on-chain `minSources() == 1`), a Uniswap v3 TWAP per ticker (`dexConfirm.pools`) confirms it (divergence > `ORACLE_CONFIRM_BPS` alerts, never moves the price); Pyth Pro optional; `ORACLE_SYNTHETIC=0` (services/oracle production rules; VERIFY C6) |
| Alerts | `services/alerts` (role addresses derived from the mnemonic) | `services/alerts` (role addresses: local keys derived, KMS roles resolved by dev.ts, or `ALERT_ROLE_ADDRESSES`); delivery credentials reach the alerts process only |
| Orderly | mock | live (`ORDERLY_MODE=live`, builder key from the env file) |
| Deployment record | `contracts/deployments/46630.json` (launch appends books) | `contracts/deployments/4663.json` (copied from the deploy machine; `scripts/record-books.ts` appends chartered books; read-only to the stack) |
| Database / Redis | `bookrunner_testnet`, Redis db 1, bus namespace `testnet` (`bkrn:testnet:…`, queues `bkrn-testnet-…`) | `bookrunner_mainnet`, Redis db 0, passwords required, bus namespace `mainnet` (`bkrn:mainnet:…`, queues `bkrn-mainnet-…`; `NETWORK=mainnet`, packages/shared queues.ts; dev.ts migrates legacy keys at start, a no-op on a fresh host) |

`scripts/dev.ts --network mainnet` refuses to start while any required env var, any role signer, the oracle
sources (a Chainlink feed and a DEX confirm pool per ticker; `ORACLE_POLICY=primary-confirm` and
`ORACLE_MIN_SOURCES=1` pinned, a contradicting value refused; Chainlink max age ≤ heartbeat + 1 h, DEX TWAP
300-3600 s, `ORACLE_DEX_MAX_AGE_MS` ≤ 120 s, `minDepthUsd` ≥ 10,000, `ORACLE_PRIMARY_LAG_BPS` < `ORACLE_CONFIRM_BPS`)
or the DeployMainnet
record is missing, while two roles share a key, or while any `*MNEMONIC*`, the deployer key, the funder key or
`BKRN_ALLOW_ADMIN_KEY` is in the environment (scripts/network-profile.ts).

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
WATERFALL_LIQ_ETH_USD=<USD per ETH, e.g. 3000>         # liquidation keeper gas policy (required: the preflight and the waterfall refuse to start without it); refresh when ETH moves 2x
# oracle (RUNBOOK "Real prices", VERIFY C6): primary + confirm. Chainlink feeds come from config/chains/4663.json in
# the app tree (the DeployMainnet input was checked against it); ORACLE_CHAINLINK_FEEDS only overrides, and only in
# the {"proxy","basis","token"} form (a plain address is refused). Chainlink alone signs (sourceCount 1); the DEX
# confirm pools (Uniswap v3 TWAP over 1800 s, factory-verified, 2% depth floor minDepthUsd $25k: recalibrated from the
# balance-based $50k; confirm-only, so a thin pool can only cause false alerts) come from the same file's dexConfirm.pools. Chainlink
# read failure / oraclePaused / round older than heartbeat + grace in session: no price for that ticker (StalePrice
# after maxPriceAge); the DEX never substitutes. A feed that stops updating but keeps answering is signed as fresh for
# up to heartbeat + grace (24 h 10 min): only the confirm gap shows it. services/alerts: oracle_source_failing:chainlink
# (critical, 60 s; can page at the Sunday 20:00 ET open, expected: do not widen the grace), oracle_primary_suspect_stale
# (gap > ORACLE_PRIMARY_LAG_BPS, no new round, 10 min), oracle_confirm_divergence (> 200 bps, 2 min),
# oracle_confirm_unavailable (10 min). Actions: docs/RUNBOOK.md "Real prices".
# ORACLE_POLICY=primary-confirm                         # pinned by the mainnet profile: leave unset (another value is refused)
# ORACLE_MIN_SOURCES=1                                  # pinned likewise; on-chain AttestedOracle.minSources() is 1 too
# ORACLE_CONFIRM_BPS=200                                # divergence threshold (bps of Chainlink), at most 500 on mainnet
# ORACLE_PRIMARY_LAG_BPS=100                            # stalled-feed gap (oracle_primary_suspect_stale), below ORACLE_CONFIRM_BPS
# ORACLE_CONFIRM_HYSTERESIS_MS=60000                    # a diverged / unavailable / lag / failure run ends only after this
# ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS=600000            # in-session max age = heartbeat + grace; at most 3600000 on mainnet
# ORACLE_CHAINLINK_MAX_AGE_MS=3600000                   # feeds without heartbeatSec; at most 90000000 on mainnet
# ORACLE_DEX_CONFIRM=1                                  # default; cannot be 0 on mainnet
# ORACLE_DEX_TWAP_SEC=600                               # overrides every pool's twapSec; 300-3600 on mainnet
# ORACLE_DEX_MAX_AGE_MS=120000                          # mainnet default; at most 120000, at least 2 x ORACLE_DEX_READ_MS
# RPC cadence (section 5 "RPC budget"; mainnet defaults, bounded at startup):
# ORACLE_CHAINLINK_READ_MS=10000 ORACLE_CHAINLINK_EVENT_READ_MS=300000 ORACLE_TOKEN_STATE_READ_MS=60000 ORACLE_DEX_READ_MS=60000 ORACLE_HEAD_READ_MS=60000
# RHC_WS_URL=wss://<rpc>/<key>                        # log subscriptions; default derived from an Alchemy RHC_RPC_URL; off = polling
# ALERT_ORACLE_PRIMARY_LAG_SECONDS=600                  # services/alerts: suspect-stale gap duration in session
# ORACLE_DEX_RPC_URL=https://<rpc>                      # default ORACLE_CHAINLINK_RPC_URL, else RPC_URL
# optional extra confirm source, only if bought (never counts for signing; licence VERIFY C6):
# ORACLE_PYTH=1
# PYTH_API_KEY=<Pyth Pro access token>                  # reaches the oracle process only (childenv.ts), never logged
# ORACLE_PYTH_MIN_PUBLISHERS=3 ORACLE_PYTH_MIN_PUBLISHERS_EXTENDED=2 ORACLE_PYTH_MAX_CONF_BPS=50; ORACLE_PYTH_URL https only
# optional HTTP confirm sources: tsPath (the vendor's own quote time) and maxAgeMs <= 30000 required; Finnhub refused
# ORACLE_HTTP_SOURCES='[{"name":"<vendor>","url":"https://.../{ticker}","pricePath":"...","tsPath":"...","tsUnit":"ms","maxAgeMs":15000,"headers":{"X-Api-Key":"..."}}]'
ORACLE_ATTESTATION_FILE=/etc/bookrunner/attestation.json   # served at GET /attestation (VERIFY E1)
# alerts (services/alerts): delivery + optional explicit role addresses (default: derived / resolved by dev.ts)
ALERT_EMAIL_TO=<ops address>
ALERT_SMTP_USER=<mailbox>
ALERT_SMTP_PASS=<password>
# ALERT_WEBHOOK_URL=<slack / discord / telegram webhook>
# ALERT_ROLE_ADDRESSES=markSigner=0x...,risk=0x...,...  # = the deploy input's role addresses
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

## 5. RPC budget

The mainnet RPC (Alchemy) bills every JSON-RPC call by compute units (CU), **each call inside an HTTP batch
too**: eth_call 26, eth_getLogs 75, eth_getBlockByNumber 16, eth_blockNumber 10, eth_getBalance 20 (the owner's
plan; Alchemy's public table lists eth_getLogs 60 and eth_getBlockByNumber 20). WebSocket subscriptions are billed by
the bytes delivered (0.04 CU per byte, ~40 CU for a typical log) plus 10 CU per `eth_subscribe`, never per poll: idle,
a filtered log subscription costs nothing. Three things save CU: Multicall3 `aggregate3` folds many views into ONE
eth_call, log subscriptions replace polling where an event says when to read, and nothing polls faster than it needs.

| 5 tickers | calls/s | CU/s | CU / 30 days |
|---|---|---|---|
| Before, 0 books (measured 2026-10-23, 7 min) | ~49 | ~1,270 | ~3.3 billion |
| After, 0 books, polling only (no WebSocket endpoint) | ~0.5 | ~15 | ~38 million |
| After, 0 books, log subscriptions up | ~0.2 | ~6 | ~16 million |
| After, + 1 book in Subscription (subscriptions up) | | ~14 | ~36 million |
| After, + 1 Live book (subscriptions up) | | ~55 | ~140 million |

Before: the oracle read each ticker's Chainlink round and Stock Token state (4 views) and each DEX pool (slot0,
liquidity, observe + the token's 4 views) every 1 s tick as separate calls (~44 calls/s, ~1,140 CU/s), plus a head
`eth_getBlockByNumber` per tick, the indexer every 2 s, and `BookFactory.bookIds()` every 5 s in four services.

| After, 0 books, per service | Reads (subscriptions up; polling in brackets) | CU/s |
|---|---|---|
| oracle, Chainlink | ONE `aggregate3` per pass (sequencer, every round, decimals once, due token states, block timestamp, aggregators every 10 min). A pass on every `AnswerUpdated` / `NewRound` of a feed's aggregator or `UIMultiplierUpdated` of a token, and every 10 s for the token states (`ORACLE_TOKEN_STATE_READ_MS`, review: a pause has no event; about 2 CU/s); safety re-read `ORACLE_CHAINLINK_EVENT_READ_MS` 5 min. [every `ORACLE_CHAINLINK_READ_MS` 10 s, token states in every pass] | 0.5 [2.6] |
| oracle, DEX TWAP | block + ONE `aggregate3` (every pool + its token at that block) + one for the rings that moved, every `ORACLE_DEX_READ_MS` 60 s | 0.7-1.1 |
| oracle, head / universe | head clock fed by every pass (`ORACLE_HEAD_READ_MS` 60 s); signer + minSources every 60 s; band every 10 min | 0.5 |
| indexer | a step (`eth_blockNumber` + ONE `eth_getLogs`: protocol + every watched book) after each notification of a watched contract, and every `INDEXER_WS_SAFETY_POLL_MS` 120 s [every `INDEXER_POLL_MS` 12 s] | 0.7 [7.1] |
| ops-venue | `bookIds()` every `OPS_BOOK_POLL_MS` 60 s; log / report / fee loops idle without an Orderly book | 0.4 |
| risk | `bookIds()` every `RISK_BOOKS_REFRESH_MS` 60 s | 0.4 |
| mark, waterfall | `bookIds()` every `BOOKS_REFRESH_SECONDS` 60 s each; no head read without a book; buyback / pool epoch every `WATERFALL_PROTOCOL_DUTY_SECONDS` 300 s | 1.0 |
| waterfall, liquidation keeper | no open engine position: one DB query per `WATERFALL_LIQ_IDLE_INTERVAL_SECONDS` 60 s, no RPC; with open positions ONE `aggregate3` (every market + position) per pass every `WATERFALL_LIQ_INTERVAL_SECONDS` 10 s while a market trades (60 s off-hours), configs every 10 min; `eth_estimateGas` + `eth_gasPrice` + the transaction only for a liquidatable position | 0 [~2.6 per traded market] |
| alerts | head + role balances (Multicall3 `getEthBalance`, one call) + buybackPending every 60 s; markInterval hourly | 1.1 |
| charter | jury fallback scan every `JURY_POLL_MS` 60 s; committee sync every `COMMITTEE_SYNC_MS` 300 s | 0.6 |
| **Total** | | **~6 [~15]** |

**Per book.** A book in Subscription adds ~8 CU/s (ops-venue state + IF binding every 60 s and adapter / mandate logs
every `OPS_LOG_POLL_MS` 30 s in ONE `eth_getLogs`, ~2.8 of it; mark and waterfall snapshots every 60 s). A **Live**
book adds ~40 CU/s more, deliberately not slowed down: risk ticks every `RISK_INTERVAL_MS` 2 s (kill-path latency; its
views share one `aggregate3` per round, 2-3 rounds per tick), the agent reads its mandate every
`AGENT_STATE_REFRESH_MS` 5 s, and ops-venue signs a venue report every `OPS_REPORT_INTERVAL_MS` 15 s (risk values
Orderly exposure with it). Lengthening any of these is an owner decision.

**Log subscriptions are triggers, never a data source.** The indexer still indexes with its canonical `eth_getLogs`
range up to `head - INDEXER_CONFIRMATIONS` (2); a notification only makes that step run within ~1 s (retried until the
log's block is confirmed), so a missed notification, a reorg or a dead socket costs latency (at most the 120 s safety
step), never data; on (re)connect it catches up from its cursor at once. The oracle still reads the feed with its pass
and applies the same staleness rules (heartbeat + grace in session); an event only makes the pass happen at the next
tick. No `newHeads` subscription (Robinhood Chain makes several blocks per second, each one billed). The socket is
kept alive with WebSocket ping frames (no JSON-RPC call); no pong for 90 s reconnects. While a subscription is down,
the service polls at the bracketed cadence above and says so in its log.

**Freshness.** The oracle still signs every `ORACLE_TICK_MS` 1 s from the last pass (no RPC), so signed prices stay
as fresh as before for risk (`RISK_QUOTE_PRICE_MAX_AGE_MS` 15 s), ops-venue's builder push (re-sends a price at most
3 ticks old, at least 1/s) and consumers (`maxTradePriceAge`). A new Chainlink round (0.5% deviation, 24 h heartbeat)
is picked up at the next tick after its `AnswerUpdated` (within 10 s while polling; within 60 s if a notification were
missed). The DEX TWAP (1800 s window) confirms with a pass up to 60 s old (`ORACLE_DEX_MAX_AGE_MS` 120 s on mainnet).
Stock Token state (audit M-2): read on its `UIMultiplierUpdated` (VERIFY T2: the event is in the token ABI), at least
every `ORACLE_TOKEN_STATE_READ_MS` 10 s, at every pass (10 s) while its `effectiveAt` is within 10 minutes or its
`oraclePaused` is set (no event is known for the pause), and a change that became active after the cached read forces a
new pass and drops the observation until a post-change read (split windows fail closed). While polling, the states
ride every pass.

**Configuration.** The WebSocket endpoint is `RPC_WS_URL`, set by the mainnet profile from `RHC_WS_URL`, else derived
from `RHC_RPC_URL` for Alchemy (`https://` -> `wss://`, same path). It carries the provider key: never logged (dev.ts
prints only whether subscriptions are on). Another provider needs `RHC_WS_URL`; `RHC_WS_URL=off` forces polling;
`ORACLE_WS=0` turns off the oracle's subscription alone. `scripts/network-profile.ts` `MAINNET_RPC_DEFAULTS` sets the
non-oracle cadences unless `mainnet.env` sets them, and the preflight refuses any value outside `MAINNET_RPC_BOUNDS`
(e.g. `ORACLE_TICK_MS=100`, `INDEXER_POLL_MS=500`, `RISK_INTERVAL_MS` above 5 s, `INDEXER_WS_SAFETY_POLL_MS` above
10 min) or a broken relation (`MARK_WAIT_SECONDS` must exceed `WATERFALL_TICK_SECONDS` + sweep wait + fee-forward
wait). The oracle resolves its own cadence per network (`services/oracle/src/config.ts` `MAINNET_RPC_CADENCE`; devnet /
testnet read every tick, as before, with no subscription) and refuses to start outside `MAINNET_RPC_BOUNDS`
(`services/oracle/src/production.ts`). Multicall3 is `0xcA11bde05977b3631167028862bE2a173976CA11` (packages/shared
chains.ts, listed on the mainnet chain only: every `publicClientFor(4663)` client batches the views of a round into one
`aggregate3`).
