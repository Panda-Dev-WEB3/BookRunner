# Security policy

## Status

Bookrunner runs on **Robinhood Chain testnet only** (chain id 46630), with test tokens and no real funds. The
contracts have had an internal security review (31 findings, 4 High, all fixed with regression tests in
[`contracts/test/audit/`](contracts/test/audit)). They have **not yet been independently audited**; an external
audit and a bug bounty are planned before mainnet.

## Reporting a vulnerability

Please report privately. Do not open a public issue, pull request or discussion for a suspected vulnerability.

1. **Preferred:** GitHub private vulnerability reporting:
   https://github.com/Panda-Dev-WEB3/BookRunner/security/advisories/new
2. **Alternative:** email **contact@bookrunner.tech** with "SECURITY" in the subject line.

Reports in English or French are welcome. The machine-readable contact file is published at
https://bookrunner.tech/.well-known/security.txt (source: `apps/site/public/.well-known/security.txt`; renew its
`Expires` date before it lapses). The web server's hardening is described in
[deploy/server/HARDENING.md](deploy/server/HARDENING.md).

## Scope

The in-scope contracts, the out-of-scope items, the severity guide and the invariants the test suite asserts
are listed in [docs/BOUNTY_SCOPE.md](docs/BOUNTY_SCOPE.md). In short:

- **In scope:** mandate bypass (`MMMandate`, `BookrunnerDesk`, `HedgeExecutor`, `StockTokenRegistry`), waterfall
  and redemption flaws (`Book`, `Tranche`, `UnderwritingVault`, `RevenueRouter`, `Backstop`, `BkrnFeeRouter`,
  `Waterfall`), venue adapters and the in-house engine (`OrderlyAdapter`, `PoolEngineAdapter`, `PoolEngine`),
  marks and prices (`MarkRegistry`, `AttestedOracle`), governance (`MarketCharter`, `RiskCommittee`,
  `BookFactory`, `BookrunnerConfig`, `BkrnStaking`).
- **Out of scope:** venue-side margin, liquidation and ADL rules; oracle price correctness itself (signature,
  staleness and replay handling are in scope); availability of off-chain services; devnet mocks
  (`contracts/src/mocks/`); anything that requires a compromised timelock, committee majority or mark-signer key.

Reports about the off-chain services (`services/`), the web apps (`apps/`) or the testnet host are welcome too
and are handled the same way.

## Accepted risks

Known behaviours we accept, with the bound that holds on-chain. Reports that only restate them are out of scope;
a way to exceed the stated bound is in scope.

- **Pull-oracle latency arbitrage on the in-house engine** (audit 2026-10 L-2). The engine is a pull oracle: a
  trader can open at the stored price and, in the same transaction, relay a newer signed print and close on it.
  The auditor's PoC made $49.70 risk-free on $50k at a 40 bp move. Bounds:
  - every engine trade (opens, increases, reductions and closes) needs a live price no older than
    `min(maxPriceAge, 60 s, maxTradePriceAge)`, and `BookrunnerConfig` refuses `maxTradePriceAge` above
    `MAX_TRADE_PRICE_AGE` (15 s), so governance cannot widen the window;
  - a print can only be relayed if it is newer than the stored one and not already stale, and a held print fills
    no trade;
  - the edge of one round trip is the price move inside that window minus the half-spread on each leg and two
    taker fees (`test_L2_poc_roundTripEdgeIsMoveMinusSpreadAndFees`): the mandate's minimum quote width and the
    charter's taker fee are the per-trade cost;
  - every quote straddles the oracle (audit M-3), and the per-period pool loss budget (`lossBudgetBps` of the pool,
    from the mandate's drawdown kill) caps what the pool can lose to any channel, this one included, per mark
    interval; the drawdown kill at the mark is the backstop.

  The complete fix is two-step orders (an order is filled at a price published after it was placed). It was not
  taken for the launch because it changes every engine trade path (engine, agent, trader UI and a keeper that fills
  orders) while the engine starts with small caps or off (owner decision); the bound above is the accepted residual.
  Desk keys are held to the same freshness rule for their own swaps (audit lead "old prints"): a key's Hedge or
  Flatten needs the token's price within `min(maxPriceAge, maxTradePriceAge)`.

## What to include

- The affected component (contract, function, service or URL) and the commit hash you tested against.
- A description of the issue and its impact, with the severity you believe applies
  ([severity guide](docs/BOUNTY_SCOPE.md#severity-guide)).
- Steps to reproduce, ideally a Foundry test (`bash scripts/forge.sh test --match-test <name>`) or a script.
- Any suggested fix.
- How you would like to be credited, if at all.

## What to expect

These are goals, not contractual commitments:

- **Acknowledgement** within 72 hours.
- **Assessment and updates:** we confirm validity and severity with you and keep you informed until the issue
  is resolved.
- **Coordinated disclosure:** we agree a disclosure date with you once a fix is deployed, and credit you in the
  advisory unless you prefer otherwise.

## Safe harbour

We will not pursue or support legal action against anyone who, in good faith:

- researches and reports a vulnerability under this policy;
- tests only against a local devnet, a fork, or the public testnet deployment, never against other users'
  positions or funds and never against a mainnet deployment;
- avoids degrading the testnet service for others (no denial-of-service, spam or automated scanning at volume);
- does not access, modify or keep data that is not their own, and stops and reports as soon as they reach any;
- keeps the details confidential until coordinated disclosure.

If in doubt about whether an action is covered, ask first at contact@bookrunner.tech.

## Bug bounty

There is no paid bounty programme yet. One is planned alongside the independent audit, with the scope in
[docs/BOUNTY_SCOPE.md](docs/BOUNTY_SCOPE.md).
