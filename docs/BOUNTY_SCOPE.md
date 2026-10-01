# Bookrunner — Bounty scope (Lane C2)

Kill criterion (Overview §8): **any MMMandate or waterfall bypass found by the bounty → pause new
books (`BookrunnerConfig.setNewBooksPaused(true)`), never redemptions.** The pause switch blocks new
charters, new books and deposits only; `requestRedeem` and every claim path are not affected by it.

## In scope

| Area | Contracts | What counts |
|---|---|---|
| Mandate | `MMMandate`, `BookrunnerDesk`, `HedgeExecutor`, `StockTokenRegistry` | Any on-chain leg executed outside the mandate: hedge outside the allow-list or ratio band, inventory move above limits, quote parameters outside width/skew/max exposure, risk added off-hours when `noNewRiskOffHours`, a revoked/expired key acting (incl. same-block revocation races), a key escalating its own limits, a non-typed call through the desk, selling Stock Tokens not held (borrowing), exceeding float caps, multiplier applied twice in valuation. |
| Waterfall | `Book`, `Tranche`, `UnderwritingVault`, `RevenueRouter`, `Backstop`, `BkrnFeeRouter`, `libraries/Waterfall` | Losses not absorbed Junior → Senior → backstop; fee flow not split expenses → carry (10%) → Senior share → Junior residual; Senior + Junior NAV not conserving the marked NAV; protocol carry taken on principal; a redemption that can be blocked by permission (pause, guardian, kill, state) — only lack of liquidity may delay a claim; claims paying more than the bucket's settled assets; pro-rata allocation or the sponsor ≥ 10% Junior check bypassable. |
| Adapters | `OrderlyAdapter`, `PoolEngineAdapter`, `PoolEngine` | Any path sending book USDC anywhere other than the book's `UnderwritingVault` or `RevenueRouter`; fee sweeps above the per-period cap or more than once per period; engine new risk while the oracle is held/stale or above the pool's max net exposure; ADL leaking across markets; liquidation/IF accounting that breaks engine conservation. |
| Marks | `MarkRegistry`, `AttestedOracle` | Accepting a mark/price not signed by an authorised signer, replaying or reordering marks/prices, applying a mark computed against a stale `flowNonce`. |
| Governance | `MarketCharter`, `RiskCommittee`, `BookFactory`, `BookrunnerConfig`, `BkrnStaking` | Approving a charter without the jury verdict and 2-of-3 bonded members (3-of-3 when the jury recommends reject); unbonded or replaced members voting; bonds released/slashed by the wrong party; upgrades without the 48h timelock. |

## Out of scope

- Venue-side margin, liquidation and ADL on Orderly (the venue's rules; exposure is bounded by the
  book's deposits). Venue quoting on Orderly is monitored-and-revoked, not contract-validated; the
  venue's own limits (isolated margin, position caps) are the hard stop for a compromised trade key.
- Oracle price correctness itself (attested and multi-source, and still an oracle) — but signature,
  staleness and replay handling are in scope.
- Off-chain services' availability (risk/mark/waterfall/agent liveness), devnet mocks (`src/mocks/*`).
- Anything requiring a compromised timelock, committee majority or MARK_SIGNER key.

## Severity guide

Critical — loss or lock of book capital, redemption blocked by permission, mandate bypass on-chain.
High — waterfall misallocation between tranches, carry on principal, unauthorised mark/price.
Medium — griefing that delays marks/claims without loss, accounting dust accumulation > 1 USDC/period.
Low — event/accounting inconsistencies with no fund impact.

## Invariants the test suite asserts (reproduce against these)

1. `requestRedeem` / claims never revert for lack of permission (fuzzed under pause, guardian pause,
   kill, Retiring, Retired).
2. After every `applyMark`: `seniorNav + juniorNav == markedNav + backstopCovered` (modulo flows
   credited in the same transaction).
3. Engine: pool |net exposure| ≤ `maxNetExposureUsd` after any new-risk trade; USDC conservation.
4. Orderly adapter: USDC only ever moves to the book's vault or router.
