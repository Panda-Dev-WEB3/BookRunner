# @bookrunner/oracle

Attested multi-source oracle (ARCHITECTURE §4 row `oracle`, port 4410).

Per tick (`ORACLE_TICK_MS`, default 1s): collect every source for every equity → median of fresh
observations, reject sources > `ORACLE_OUTLIER_BPS` (150) from it, require ≥ `max(ORACLE_MIN_SOURCES,
AttestedOracle.minSources())` accepted → index levels `Σ wᵢ·pᵢ` (weights in bps) → session hold →
EIP-712 sign (`priceTypedData`, role `oracleSigner`) → publish `OraclePriceMsg` to
`KEYS.oracleLast(id)` + `CHANNELS.oraclePrice(id)` → builder price to the venue for Orderly books.
On the push policy (first, every `ORACLE_PUSH_INTERVAL_MS`, a move > `ORACLE_PUSH_DEVIATION_BPS`, or
a held flip) the due updates go to `AttestedOracle.pushMany` (receipt awaited, tx hash logged) and
to `oracle_prices` with `pushed_tx`. The pushMany sender is the `oracleSigner` account itself:
AttestedOracle only accepts relays from an active signer, the KEEPER role or the timelock.

`ORACLE_PUSH_DEVIATION_BPS` (default 10) must stay below the cheapest in-house round trip (spread +
2 × taker fee; RHX5: 10 + 2 × 6 = 22 bps): otherwise the on-chain price can lag the market by a move a
trader can arbitrage against the pool. The service logs a warning above 10 bps.

```
bun run start        # idles (log + retry) until contracts/deployments/<chain>.json exists
bun test             # unit tests, no infra
BKRN_IT=1 DATABASE_URL=.../bkrn_oracle_it REDIS_URL=redis://127.0.0.1:63790/5 bun test test/integration.test.ts
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
  tick continues; `pushMany` errors back off 5s → 60s; pushes pause while the signer is not
  registered on AttestedOracle.

## Sources

| Source | Enabled by | Notes |
|---|---|---|
| `synthetic-a/b/c` | `ORACLE_SYNTHETIC=1` (default, chain 31337 only) | one seeded GBM path per ticker (`ORACLE_SEED`, vols NVDA 45% TSLA 60% AAPL 25% MSFT 25% AMZN 30%, `ORACLE_VOL_SCALE`), per-source noise, dropouts, rare spikes |
| HTTP JSON | `ORACLE_HTTP_SOURCES` JSON array, `ORACLE_HTTP_FINNHUB=1` + key | VERIFY endpoints, symbols, licensing |
| AggregatorV3 | `ORACLE_CHAINLINK_FEEDS={"NVDA":"0x…"}` | VERIFY feed addresses; none on devnet |

## HTTP

Bound to `ORACLE_HOST` (default `127.0.0.1`, set `0.0.0.0` only behind a proxy / firewall).

- `GET /health` — status, universe, last push (tx), on-chain + venue state.
- `GET /prices`, `GET /prices/:priceId` — per key, the last price that has LANDED on-chain (with
  on-chain pushes disabled: the latest), always without its signature. A fresher signed update the
  chain has not seen is never served: a trader could trade at the stored price, relay the newer one
  and close in one transaction. The full signed message stays internal (Redis `KEYS.oracleLast`).
- `GET /attestation` — signer address + `{type: "devnet-plain-key", quote: null}` (TEE quote
  verification is VERIFY).

## Venue builder prices

`ORDERLY_MODE=mock`: `POST ORDERLY_BASE_URL/mock/price {symbol, price, held}` for Orderly books.
`ORDERLY_MODE=live`: `LiveOrderlyPriceClient` throws `NotConfiguredError` (builder price-source
endpoint is VERIFY); venue pushes are then disabled and reported in `/health`.
