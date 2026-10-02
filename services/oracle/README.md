# @bookrunner/oracle

Attested multi-source oracle (ARCHITECTURE §4 row `oracle`, port 4410).

Per tick (`ORACLE_TICK_MS`, default 1s): collect every source for every equity → median of fresh
observations, reject sources > `ORACLE_OUTLIER_BPS` (150) from it, require ≥ `max(ORACLE_MIN_SOURCES,
AttestedOracle.minSources())` accepted → index levels `Σ wᵢ·pᵢ` (weights in bps) → session hold →
EIP-712 sign (`priceTypedData`, role `oracleSigner`) → publish `OraclePriceMsg` to
`KEYS.oracleLast(id)` + `CHANNELS.oraclePrice(id)` and the **signed bundle** (below) to
`KEYS.oracleBundle` → builder price to the venue for Orderly books. On the push policy (first, every
`ORACLE_PUSH_INTERVAL_MS`, a move > `ORACLE_PUSH_DEVIATION_BPS`, or a held flip) the due updates are
recorded in `oracle_prices` (history), and — in heartbeat mode only — sent to `AttestedOracle.pushMany`.

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

| Source | Enabled by | Notes |
|---|---|---|
| `synthetic-a/b/c` | `ORACLE_SYNTHETIC=1` (default, chain 31337 only) | one seeded GBM path per ticker (`ORACLE_SEED`, vols NVDA 45% TSLA 60% AAPL 25% MSFT 25% AMZN 30%, `ORACLE_VOL_SCALE`), per-source noise, dropouts, rare spikes |
| HTTP JSON | `ORACLE_HTTP_SOURCES` JSON array, `ORACLE_HTTP_FINNHUB=1` + key | VERIFY endpoints, symbols, licensing |
| AggregatorV3 | `ORACLE_CHAINLINK_FEEDS={"NVDA":"0x…"}` | VERIFY feed addresses; none on devnet |

## HTTP

Bound to `ORACLE_HOST` (default `127.0.0.1`, set `0.0.0.0` only behind a proxy / firewall).

- `GET /health` — status, universe, last push (tx), on-chain + venue state.
- `GET /prices`, `GET /prices/:priceId` — per key, without its signature: pull mode the latest price;
  heartbeat mode the last price that has LANDED on-chain (with on-chain pushes disabled: the latest) —
  there a fresher signed update the chain has not seen is never served (a trader could trade at the
  stored price, relay the newer one and close in one transaction).
- `GET /prices/signed` — the signed bundle (503 before the first live tick). Public by design in pull
  mode: every trade carries its own price and PoolEngine only accepts one published within
  `maxTradePriceAge` (default 15 s) of the block; the spread covers the residual.
- `GET /attestation` — signer address + `{type: "devnet-plain-key", quote: null}` (TEE quote
  verification is VERIFY).

## Venue builder prices

`ORDERLY_MODE=mock`: `POST ORDERLY_BASE_URL/mock/price {symbol, price, held}` for Orderly books.
`ORDERLY_MODE=live`: `LiveOrderlyPriceClient` throws `NotConfiguredError` (builder price-source
endpoint is VERIFY); venue pushes are then disabled and reported in `/health`.
