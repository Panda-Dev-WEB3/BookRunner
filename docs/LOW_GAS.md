# Low-gas mode — "pay only when something happens" (normative)

Goal: an idle book costs ~0 gas. Every on-chain write is either part of a user's own transaction or
one daily keeper transaction per book. Measured baseline (devnet cadences, 3 books): ~5.1 B gas/day —
oracle pushes 69%, venue reports 11%, marks 9%, engine re-quotes 8%, distributions 3%.

Four changes. Signatures below are binding for every contract and service.

## 1. Pull oracle (removes timer pushes)

Prices stay EIP-712 signed off-chain (`PRICE_TYPEHASH` unchanged). Consumers carry them in the
transaction that needs them.

```solidity
// AttestedOracle
/// Verifies and stores every update that is newer than the stored one (skips the rest, never reverts
/// for "not newer"; reverts on a bad signature). Callable by anyone; consumers call it first.
function update(bytes calldata priceData) external;          // priceData = abi.encode(PriceUpdate[], bytes[])
/// Fresh-price read for consumers in the same tx: reverts StalePrice if older than maxPriceAge.
function priceOf(bytes32 underlying) external view returns (uint256 priceWad, bool held); // unchanged
```

- What is signed is USD per **share** (VERIFY C2). Robinhood's per-token Chainlink answers are divided by
  the token's `uiMultiplier()` off-chain, inside the oracle service: no feed or token read on the price
  path. The only on-chain addition is in valuation: a registry token in live-multiplier mode costs one
  `uiMultiplier()` STATICCALL per `valueUsd` (desk hedge valuation loops over held tokens).
- `update` also skips entries that are already stale on arrival (`publishedAt + maxPriceAge < now`), so
  nobody can land an old, favourable print that happens to be newer than the stored one.
- `pushMany` stays (backwards compatible) but **the oracle service no longer pushes on a timer** by
  default (`ORACLE_PUSH_MODE=pull`; `heartbeat` keeps the old behaviour for debugging).
- Every consumer entry point that needs a fresh price gets a trailing `bytes calldata priceData`
  argument and calls `oracle.update(priceData)` first when it is non-empty:
  - `PoolEngine.trade(marketId, sizeDelta, acceptablePriceWad, priceData)`
  - `PoolEngine.liquidate(marketId, trader, priceData)`
  - `PoolEngine.withdrawLiquidity(...)`/`withdrawMargin(...)` keep their signatures but read the stored
    price; callers that need a fresh one call `oracle.update` in a multicall or beforehand.
  - `BookrunnerDesk.execute(Action)` — `Action` gains no field: the desk reads `priceData` from a new
    action kind-independent wrapper `executeWithPrices(Action action, bytes priceData)`; `execute` stays.
- Staleness semantics move from "stored price is old" to "the price used by this tx is old": the
  engine and mandate treat `held` / stale exactly as today, but evaluated after the in-tx update.
- Latency-arbitrage bound: a trade may only use a price whose `publishedAt >= block.timestamp -
  maxTradePriceAge` (new config param `maxTradePriceAge`, default 15 s, timelock-settable) — the
  trader cannot pick an old favourable print; the spread covers the residual. This holds for **every**
  voluntary trade, reductions and closes included (audit A2-01): with no timer pushes the stored price
  can be arbitrarily old, and a market-neutral pair that closes its losing leg at the stale stored
  price and its winning leg at the current print extracts the whole move from the pool. A close
  therefore carries a fresh signed print like an open.
- Off-hours (`held` price): **no** trade fills, closes included (audit A2-03) — the held close is
  known-stale once after-hours news moves the real price. Margin top-ups and liquidations keep working
  at the held price. While held, the maintenance requirement is
  `OFF_HOURS_MARGIN_MULTIPLE` (2) × the market's initial margin (capped at 100 %): positions that
  cannot absorb a reopen gap of that size are liquidated at the held close instead of turning the gap
  into IF bad debt (audit A2-02). Traders top up or deleverage before the session closes.
- Liquidations (`liquidate`, with or without `priceData`) are not bound by `maxTradePriceAge` and work
  at the stored / held price: they are involuntary, need the position under its requirement at that
  price and forfeit the liquidation fee. `forceClose` (wind-down close-out) follows the trade rule:
  live (not held) price within `maxTradePriceAge`, carried via `forceClose(marketId, trader, priceData)`.
  The position owner can call it too, so a held / stale price would be a fee-free free option;
  close-outs of a retiring book wait for the session to reopen.
- Off-chain readers (mark, risk, api, web) value positions from the oracle service's latest signed
  bundle (`GET /prices/signed`, Redis `KEYS.oracleLast`), never from strict on-chain views that revert
  when no recent update landed.

## 2. Venue reports folded into the mark

`OrderlyAdapter.report(...)` stops being a 30 s on-chain loop. ops-venue signs reports off-chain:

```solidity
// OrderlyAdapter — EIP-712 domain ("Bookrunner OrderlyAdapter", "1", chainId, adapter)
// REPORT_TYPEHASH = keccak256("VenueReport(uint256 insuranceUsd,int256 marginUsd,int256 netExposureUsd,uint64 asOf)")
function reportSigned(uint256 insuranceUsd, int256 marginUsd, int256 netExposureUsd, uint64 asOf, bytes calldata sig) external;
```

- Anyone may relay; the signature must recover to an `OPS_VENUE` holder; same monotonic / flow rules
  as `report`. `report` (role-gated, unsigned) stays for compatibility.
- The mark keeper submits the latest signed report inside the daily mark transaction (§3). Desk hedge
  legs on Orderly books carry it the same way when they need a fresh exposure.
- ops-venue publishes signed reports to Redis `bkrn:venue:report:<bookId>` and its HTTP API.

## 3. One mark transaction per book per period

```solidity
// MarkRegistry (Book is at its 24 KB size limit, so the orchestration lives here; Book is unchanged)
/// Atomic, callable by anyone (keeper):
///   1. oracle.update(priceData)                       when priceData is non-empty
///   2. IOrderlyAdapter(adapter).reportSigned(...)     when venueReport is non-empty (Orderly books)
///   3. commit(m, sig)                                 same checks as commit (incl. stale-mark replacement)
///   4. IBook(factory.bookOf(m.bookId)).applyMark(markId)
/// Returns the markId. Reverts atomically if any step reverts (the keeper retries next tick).
function commitAndApply(BRTypes.MarkInput calldata m, bytes calldata sig, bytes calldata priceData, bytes calldata venueReport)
    external returns (uint256 markId);
```

- `venueReport = abi.encode(uint256 insuranceUsd, int256 marginUsd, int256 netExposureUsd, uint64 asOf, bytes sig)`.
- The adapter is `IBookFactory(config.factory()).componentsOf(m.bookId).adapter`.
- `commit` + `Book.applyMark` stay callable separately (backwards compatible).
- Step 3 is idempotent (audit A2-04): if the book's latest mark is already the identical, unapplied
  mark (someone front-ran the keeper with a bare `commit(m, sig)` copied from the mempool), it is
  applied as is instead of reverting `PeriodNotAfterLast`, so the period's prices and venue report
  still land in the keeper's transaction.
- Cadence: `markInterval` = 86 400 (daily, per spec) for mainnet; testnet profile default 86 400 with
  `MARK_INTERVAL_SECONDS` override (hourly costs ~0.0002 ETH/day for 3 books in this mode).
- The waterfall's sweep + distribute run in the same keeper pass, **skipped when there is no fee flow**
  (`router.pendingGross() == 0` and no venue fee settlement), and the mark service no longer waits for
  a distribution that will not happen.

## 4. Skip empty work

- Engine re-quote (`SetQuote`) only when spread/skew move ≥ 5 bps or exposure cap steps ≥ 5%, at most
  once a minute (agent config defaults).
- No fee sweeps when the venue settled nothing; no recalls unless a redemption is due.
- Trader-sim is demo traffic (traders pay their own gas): default 1 trade/min/book on testnet.

## Expected cost (3 idle books, RHC testnet 0.01 gwei)

| Item | Before | After |
|---|---|---|
| Oracle | ~47 000 tx/day | 0 (prices ride in users' txs) |
| Venue reports | ~10 000 tx/day | 0 (in the mark tx) |
| Marks | ~1 700 tx/day | 3 tx/day (daily, atomic) |
| Distributions | ~1 150 tx/day | ≤ 3 tx/day, 0 when no fees |
| **Total** | ~0.05 ETH/day | **~0.00003 ETH/day** + activity paid by traders |
