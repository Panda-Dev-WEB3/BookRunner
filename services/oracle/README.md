# @bookrunner/oracle

Attested oracle (ARCHITECTURE §4 row `oracle`, port 4410): Chainlink-signed prices confirmed by a DEX TWAP on
mainnet, a multi-source median on devnet / testnet.

Per tick (`ORACLE_TICK_MS`, default 1s): collect every source for every equity → aggregate by
`ORACLE_POLICY` (below) → index levels `Σ wᵢ·pᵢ` (weights in bps) → session hold →
EIP-712 sign (`priceTypedData`, role `oracleSigner`) → publish `OraclePriceMsg` to
`KEYS.oracleLast(id)` + `CHANNELS.oraclePrice(id)` and the **signed bundle** (below) to
`KEYS.oracleBundle` → builder price to the venue for Orderly books. On the push policy (first, every
`ORACLE_PUSH_INTERVAL_MS`, a move > `ORACLE_PUSH_DEVIATION_BPS`, or a held flip) the due updates are
recorded in `oracle_prices` (history), and — in heartbeat mode only — sent to `AttestedOracle.pushMany`.

## Aggregation policy (`ORACLE_POLICY`)

- **`primary-confirm`** (default and required on 4663; `src/domain/confirm.ts`): the Chainlink observation alone
  is the price, signed with `sourceCount` 1 (`ORACLE_MIN_SOURCES` 1, on-chain `minSources()` 1). Every other fresh
  observation — the Uniswap v3 TWAP (`dex-twap`), optionally Pyth Pro / HTTP — only confirms it: a confirmer more
  than `ORACLE_CONFIRM_BPS` (200) from Chainlink still publishes Chainlink, with a rate-limited warn log and the
  ticker `diverged` in `/health` `confirm[]`; no fresh confirmer in session = `unavailable` (published
  unconfirmed, logged after `ORACLE_CONFIRM_UNAVAILABLE_WARN_MS`, 10 min). No fresh Chainlink observation = no
  price (`no-primary`): a confirmer never substitutes; in session the ticker is skipped (the last signed price ages
  to `StalePrice` after `maxPriceAge`), off-hours the hold continues (a start off-hours without history seeds from
  Chainlink only). `sourcesHash` covers Chainlink **and** every fresh confirmer.
- **`median`** (default off mainnet: devnet / testnet / tests): median of fresh observations, sources further than
  `ORACLE_OUTLIER_BPS` (150) from it rejected, ≥ `max(ORACLE_MIN_SOURCES, AttestedOracle.minSources())` accepted
  (`ORACLE_MIN_SOURCES` default 3); with only two accepted a non-held price is refused when they are more
  than `ORACLE_OUTLIER_BPS` apart or one is a Chainlink round older than `ORACLE_CHAINLINK_PAIR_MAX_AGE_MS` (1 h),
  and such a pair never seeds an off-hours hold.

## Push modes (`ORACLE_PUSH_MODE`, docs/LOW_GAS.md §1)

- **`pull` (default)**: the oracle sends **no transaction at all**. Consumers carry the signed prices in
  the transaction that needs them (`PoolEngine.trade/liquidate(..., priceData)`,
  `BookrunnerDesk.executeWithPrices(action, priceData)`, `MarkRegistry.commitAndApply(..., priceData, ...)`),
  which calls `AttestedOracle.update(priceData)` first. `oracle_prices` rows have `pushed_tx = null`.
  Against a pre-low-gas AttestedOracle (its code has no `update(bytes)`; checked once per contract)
  nobody could carry the bundle, so the service keeps the heartbeat pushes and warns
  (`/health`: `effectivePushMode: "heartbeat"`, `onchain.pullSupported: false`) until the redeploy.
- **`heartbeat`**: the pre-low-gas behaviour, for debugging: pushes on the policy above (receipt awaited,
  tx hash in `pushed_tx`). The sender is the `oracleSigner` account itself. `ORACLE_PUSH_DEVIATION_BPS`
  (default 10) must stay below the cheapest in-house round trip (spread + 2 × taker fee; RHX5: 10 + 2 × 6
  = 22 bps), the service warns above 10 bps.

### Signed bundle (both modes)

`OracleBundleMsg = {priceData, publishedAt, chainId, oracle, priceIds}` where
`priceData = abi.encode(PriceUpdate[], bytes[])` (`encodePriceData` / `decodePriceData` in
`@bookrunner/shared`) holds the latest signed update of every live price id, in universe order, each
with its own `publishedAt`; `publishedAt` is the newest of them. A key whose latest update is older than
`ORACLE_BUNDLE_MAX_AGE_MS` (default 300 s, sources failing) is left out. Redis `KEYS.oracleBundle`
(`bkrn:oracle:bundle`) is rewritten every tick with that expiry, so a stopped oracle leaves no bundle and
consumers fall back to their non-pull path. Signatures are bound to `(chainId, oracle)`; a new
AttestedOracle drops every signature of the old domain. The same JSON is served at `GET /prices/signed`.

```
bun run start        # idles (log + retry) until contracts/deployments/<chain>.json exists
bun test             # unit tests, no infra
BKRN_IT=1 DATABASE_URL=.../bkrn_oracle_it REDIS_URL=redis://127.0.0.1:63790/5 bun test test/integration.test.ts
# pull mode against the production AttestedOracle on a private anvil (contracts/out from scripts/forge.sh build)
BKRN_IT=1 ORACLE_IT_ANVIL_PORT=8622 bun test test/pull.chain.it.test.ts
```

## Semantics

- **Universe**: `deployment.stockTokens` price ids + books from the deployment and the `books`
  table; each book's charter via `IBook.getCharter` (fallback `charters.struct_json.sessions`);
  index books via `StockTokenRegistry.getIndex`. If the chain cannot be read, books are matched to
  `ORACLE_TICKERS` / `ORACLE_INDEXES` by name/symbol. Refreshed every `ORACLE_UNIVERSE_REFRESH_MS`.
- **Sessions / held**: a key is open only if every governing charter session is open (books on
  that key; components without a book follow their index books; otherwise
  `ORACLE_DEFAULT_SESSIONS`). `SESSIONS_MODE=24x7` overrides. Off-hours the price is held at the
  last open-session price (`held=true`, re-stamped each push so it never goes stale on-chain); the
  last price is restored from Redis after a restart. Starting off-hours with no history seeds the
  hold from what is observable.
- **sourcesHash** = `keccak256(canonicalJson(sources))`, sources reduced to `{name, price, ts}`
  (ts = unix ms) and sorted by name — `OraclePriceMsg.sources` is already in that order.
  Index sources are the components' published prices; index `sourceCount` = weakest component.
- **publishedAt** = wall clock, clamped to `[chainHead, chainHead + 4]` (AttestedOracle accepts
  `≤ block.timestamp + 5`; a time-warped devnet does not make prices look stale). Updates not newer
  than the stored on-chain `publishedAt` wait for the next second.
- **Failures**: sources time out (`ORACLE_SOURCE_TIMEOUT_MS`); Redis/DB errors are logged and the
  tick continues; heartbeat `pushMany` errors back off 5s → 60s; pushes pause while the signer is not
  registered on AttestedOracle (`/health` reports it in both modes: consumers' updates would revert).

## Sources

Every source reports USD per **share** of the equity (the AttestedOracle unit).

| Source | Enabled by | Notes |
|---|---|---|
| `synthetic-a/b/c` | `ORACLE_SYNTHETIC=1` (default; 31337, or 46630 with a secret `ORACLE_SEED`) | one seeded GBM path per ticker (`ORACLE_SEED`, vols NVDA 45% TSLA 60% AAPL 25% MSFT 25% AMZN 30%, `ORACLE_VOL_SCALE`), per-source noise, dropouts, rare spikes. **Impossible on 4663**: never constructed, the service refuses to start |
| `pyth` (Pyth Pro) | `ORACLE_PYTH=1` + `PYTH_API_KEY` (optional `ORACLE_PYTH_URL`, `ORACLE_PYTH_CHANNEL`, `ORACLE_PYTH_FEEDS`, `ORACLE_PYTH_MAX_AGE_MS`) | optional (`src/sources/pyth.ts`): under primary-confirm an extra confirm source, never counted for signing; a median vote elsewhere. One batched `POST /v1/latest_price` (Bearer token) per tick for every ticker; feed ids `Equity.US.<T>/USD` NVDA 1314, TSLA 1435, AAPL 922, MSFT 1292, AMZN 954 (`ORACLE_PYTH_FEEDS` overrides); price = mantissa × 10^exponent; timestamp = the feed's own `feedUpdateTimestamp` (Pyth repeats the last price when it cannot aggregate, so freshness never comes from the receive time); no observation when the session is `closed` or the feed is missing; an in-session print older than 10 s, below the publisher floor, wider than the confidence limit or without a known session is a failure with a reason. The token is never logged. Licence for on-chain use: VERIFY C6 |
| HTTP JSON | `ORACLE_HTTP_SOURCES` JSON array, `ORACLE_HTTP_FINNHUB=1` + key | optional; a confirm source under primary-confirm; must quote per share; VERIFY endpoints, symbols, licensing. Mainnet: `tsPath` (the vendor's own quote timestamp) and `maxAgeMs` ≤ 30 s are required; the Finnhub preset is refused (regular session only) |
| `chainlink` | `config/chains/<CHAIN_ID>.json` (`ORACLE_CHAIN_CONFIG`) + `ORACLE_CHAINLINK_FEEDS` overlay | per feed: `proxy`, `basis` (`per-token`: Robinhood tokenized-equity feed = share price × `uiMultiplier()`, divided by the token's on-chain `uiMultiplier()`; `per-share`: used as is), `token`, pinned `decimals` (checked against `decimals()`), `heartbeatSec` (in-session max age = heartbeat + `ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS`). A multiplier that became effective after the feed's last round is undone with the multiplier observed with that round (no observation if that round was never seen). No observation while the token's `oraclePaused()` is set, or when the L2 sequencer feed (if configured) is down / in its grace period. `held` never comes from the feed (session calendar only). Reads of one tick are JSON-RPC batched. The only signing source under primary-confirm (role `primary`). None on devnet |
| `dex-twap` (Uniswap v3 TWAP) | `config/chains/<CHAIN_ID>.json` `dexConfirm.pools` (`pool`, `fee`, `quoteToken`, `twapSec`, `minQuoteLiquidityUsd`); `ORACLE_DEX_CONFIRM` (default 1, cannot be 0 on 4663), `ORACLE_DEX_TWAP_SEC` (overrides `twapSec`), `ORACLE_DEX_MAX_AGE_MS` (60 s), `ORACLE_DEX_RPC_URL` (default `ORACLE_CHAINLINK_RPC_URL`, else `RPC_URL`) | confirm source only, never signs (`src/sources/dex-twap.ts`). Per ticker the deepest Stock Token / USDG pool; all reads pinned to one block: `observe([twapSec, 0])` → arithmetic-mean tick (rounded toward −∞) → price of one token in USDG (orientation from `token0`, quote decimals read on-chain) → divided by the token's `uiMultiplier()` like the Chainlink per-token feeds. No observation when the pool's USDG balance is below `minQuoteLiquidityUsd` (USDG assumed = $1), the oldest observation is younger than the window, the token is `oraclePaused()` or its multiplier changed inside the window. Timestamp = block time. Mainnet pools: VERIFY C6 |

### Mainnet (4663) production rules (`src/production.ts`)

The service refuses to start unless: `ORACLE_SYNTHETIC=0` and no synthetic source; `ORACLE_POLICY=primary-confirm`;
`ORACLE_MIN_SOURCES=1`; the on-chain `AttestedOracle.minSources()` is exactly 1 (read at startup from the
deployment's oracle, an unreadable contract refuses too; a later change shows as `/health`
`onchain.minSourcesProblem`); a Chainlink feed with an explicit basis for every `ORACLE_TICKERS` entry (a plain
address in `ORACLE_CHAINLINK_FEEDS` is refused); `ORACLE_DEX_CONFIRM` on and a DEX confirm pool for every ticker with
`minQuoteLiquidityUsd` ≥ 10,000 (the live depth is checked by `source-check` and every tick); `ORACLE_CONFIRM_BPS` ≤
500; `SESSIONS_MODE` is not `24x7`. Optional confirmers keep their own rules: `ORACLE_PYTH=1` needs `PYTH_API_KEY`,
an https `ORACLE_PYTH_URL` and a feed id per ticker; every HTTP source needs `tsPath` (the vendor's own quote
timestamp) and `maxAgeMs` ≤ 30 s; the Finnhub preset is refused. Pyth and any other extra source are not required.
At runtime (`settings.production`) no synthetic source can be wired in and no price — held, restored or seeded
off-hours — is signed with fewer than `max(ORACLE_MIN_SOURCES, AttestedOracle.minSources())` sources.

`GET /health` `unpublished[]` lists in-session price ids without a publishable price (`services/alerts`
`oracle_price_missing` after 2 min). Per-source health (`sources[]`: `role` primary / confirm / median, `lastOkAt`,
`failingSince`, `failingTickers`, `lastError`; in-session tickers only) feeds `oracle_source_failing` (the Chainlink
primary: critical; a confirm source: warning after 10 min); a source failing for > 10 s is logged at warn once a
minute (never a key). `confirm[]` feeds `oracle_confirm_divergence` (2 min in session; critical above 2×
`ORACLE_CONFIRM_BPS` or ≥ 3 tickers at once) and `oracle_confirm_unavailable` (10 min). Pyth prints below Pyth's
session publisher minimum (`ORACLE_PYTH_MIN_PUBLISHERS` 3 / `ORACLE_PYTH_MIN_PUBLISHERS_EXTENDED` 2) or with a
confidence wider than `ORACLE_PYTH_MAX_CONF_BPS` (50) are failures with a reason.

### Operator CLIs (read-only / offline, no key)

```
# every configured feed + Stock Token read live, pass/fail table, exit 1 on FAIL (VERIFY C4/C6/T2/T3); per ticker a
# `dex confirm` row (TWAP vs Chainlink per share, diff bps, USDG depth vs floor, cardinality, history; FAIL on 4663
# when a pool is missing / below its floor / too young / unreadable, WARN above ORACLE_CONFIRM_BPS) and the summary
# rows `sources primary` / `sources confirm`; Pyth / HTTP confirmers and the `pyth calendar` row only WARN / SKIP
# under primary-confirm (Pyth when PYTH_API_KEY is set: bun --env-file=../../.env.pyth src/cli/source-check.ts ...)
bun run source-check --chain 4663 --rpc $RHC_RPC_URL [--registry 0x…] [--config file] [--json] [--no-service-config]
# TEE signer registration (VERIFY E1; docs/RUNBOOK.md "Oracle signer attestation")
bun run attest report-data --chain 4663 --oracle 0x… --signer 0x…
bun run attest register    --chain 4663 --oracle 0x… --doc attestation.json
```

## HTTP

Bound to `ORACLE_HOST` (default `127.0.0.1`, set `0.0.0.0` only behind a proxy / firewall).

- `GET /health` — status, universe, last push (tx), on-chain + venue state; `policy`, `confirmBps`,
  `sources[]` (with `role`), `confirm[]` (primary-confirm: per equity `status` ok / diverged / unavailable /
  no-primary / closed, `diffBps`, `since`, `primaryPrice`, confirmers), `unpublished[]`.
- `GET /prices`, `GET /prices/:priceId` — per key, without its signature: pull mode the latest price;
  heartbeat mode the last price that has LANDED on-chain (with on-chain pushes disabled: the latest) —
  there a fresher signed update the chain has not seen is never served (a trader could trade at the
  stored price, relay the newer one and close in one transaction).
- `GET /prices/signed` — the signed bundle (503 before the first live tick). Public by design in pull
  mode: every trade carries its own price and PoolEngine only accepts one published within
  `maxTradePriceAge` (default 15 s) of the block; the spread covers the residual.
- `GET /attestation` — signer address, the `reportData` its TEE quote must carry
  (`AttestedOracle.reportDataOf`), and the attestation document from `ORACLE_ATTESTATION_FILE` with its
  `quoteHash`, on-chain `digest` and binding checks (`{type: "devnet-plain-key", quote: null}` without one).

## Venue builder prices

`ORDERLY_MODE=mock`: `POST ORDERLY_BASE_URL/mock/price {symbol, price, held}` for Orderly books.
`ORDERLY_MODE=live`: `LiveOrderlyPriceClient` throws `NotConfiguredError` (builder price-source
endpoint is VERIFY); venue pushes are then disabled and reported in `/health`.
