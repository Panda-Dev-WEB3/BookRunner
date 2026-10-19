# Security policy

## Status

Bookrunner runs on **Robinhood Chain testnet only** (chain id 46630), with test tokens and no real funds. The
contracts have had an internal security review (31 findings, 4 High, all fixed with regression tests in
[`contracts/test/audit/`](contracts/test/audit)). An external audit (October 2026) reported 4 Medium and 3 Low
findings and a set of leads; each one's fix, regression test or accepted rationale is tracked in
[docs/AUDIT-2026-10.md](docs/AUDIT-2026-10.md). A bug bounty is planned before mainnet.

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

The in-scope contracts, the out-of-scope items and the severity guide are listed in
[docs/BOUNTY_SCOPE.md](docs/BOUNTY_SCOPE.md). Every protocol invariant, with the Foundry invariant suite and the
unit tests that check it, is listed in [docs/INVARIANTS.md](docs/INVARIANTS.md). In short:

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

## Off-chain trust boundaries

Redis (the bus between the services, namespaced `bkrn:<ns>:…`) is a shared trust domain: anyone who can write to
it is assumed hostile (audit 2026-10 lead). What such a writer can and cannot do:

- **Prices.** The agent quotes, and plans hedges, only on the oracle's EIP-712 signed `PriceUpdate` for its own
  price id, recovered to an `AttestedOracle` signer under this chain and oracle (`packages/shared/src/oracleVerify.ts`;
  `AGENT_ORACLE_SIGNERS` pins the signers), taking price, age and `held` from the signed fields. ops-venue's builder
  price push, the mark service and risk's valuation feed apply the same check. A forged, tampered, relabelled or
  replayed print is dropped; withholding prices only stops quoting (stale price). One unsigned read remains: when the
  on-chain price is stale and no verified print exists, risk reads `oracle:last` for its off-hours flag and display
  only; it never counts for the quote check (audit M-3), and the agent re-checks off-hours itself.
- **Kill orders.** A kill message (kill channel or the `revoke_key` job) is acted on only when it is the risk
  service's EIP-712 `KillOrder` (book, reason hash, issue time, episode nonce) signed with the RISK key under this
  chain and `BookrunnerConfig`, by a holder of `RISK_ROLE` (on-chain check, cached; or pinned with
  `AGENT_RISK_SIGNERS` / `OPS_RISK_SIGNERS`), at most 120 s old and not replayed (`packages/shared/src/busAuth.ts`).
  Then, as before: the agent cancels and halts, ops-venue revokes the venue trade key at once (unless the key was
  created after the order was issued). An unsigned or forged kill is ignored, logged and counted (alert
  `bus_forged_message`): a Redis writer can no longer halt an agent or revoke a key. When the RISK role check
  cannot run (RPC), ops-venue cancels the book's orders and revokes on the on-chain kill; the mandate `Kill` log
  (`MMMandate.killed()`) stays a second trigger in every case, and the agent halts on it at its next state refresh.
- **Risk state.** The state risk publishes (`ok` … `killed`) carries an EIP-712 `RiskState` signature by the RISK
  key (book, state, time). The agent acts only on a RISK-signed state at most 60 s old and strictly newer than the
  last one it accepted; an unsigned or forged state is ignored and counted. Without a verified state for
  `AGENT_RISK_STATE_TIMEOUT_MS` (30 s) the agent quotes reduce-only (alert `risk_state_unverified`); it never halts
  on that. Halting needs a signed `KillOrder`, a signed `killed` state or the on-chain kill.
- **Agent quotes.** An agent quotes new risk only while its desk session key is active on the mandate
  (`MMMandate.isActiveKey`, re-read at every state refresh: expiry and committee `REVOKE_KEY` take effect); without
  one it runs reduce-only (alert `agent_no_desk_key`). Every quote it publishes then carries an EIP-712 `AgentQuote`
  signature by that key, covering the prices, size, sides, its timestamp and the oracle print it was priced on
  (whose own oracle signature travels with it). Risk accepts a quote only when signed by an active desk key, at most
  5 s old, strictly newer than the last quote it accepted for the book, and priced on a print that verifies and is
  at most 15 s older than the quote; it judges the quote against THAT print. A forged, stale or replayed quote is no
  new quote and can never cause a breach; a replayed genuine quote cannot either, since it is judged against its
  own price. A quote signed by a desk key that expired or was revoked is reported as such, not as a forgery.
- **Signed reports and marks.** Venue reports and marks are EIP-712 signed by role keys and verified on-chain.

## Accepted risks

Known behaviours we accept, with the bound that holds on-chain. Reports that only restate them are out of scope;
a way to exceed the stated bound is in scope.

- **Pull-oracle latency arbitrage on the in-house engine** (audit 2026-10 L-2). The engine is a pull oracle: a
  trader can open at the stored price and, in the same transaction, relay a newer signed print and close on it.
  The auditor's PoC made $49.70 risk-free on $50k at a 40 bp move. Bounds:
  - every engine trade (opens, increases, reductions and closes) needs a live price no older than
    `min(maxPriceAge, 60 s, maxTradePriceAge)`, and `BookrunnerConfig` refuses `maxTradePriceAge` above
    `MAX_TRADE_PRICE_AGE` (15 s), so governance cannot widen the window (a deployment made from this code: the
    current testnet config predates the cap and keeps 15 s by operating rule). The cap equals the default, so
    there is no on-chain headroom: the operating margin is the oracle tick (2 s) plus the chain's inclusion lag
    (agents carry prints at most `maxTradePriceAge` - 3 s old). If the oracle cadence ever slows past it, engine
    trades and desk key swaps stop (fail safe) while liquidations keep working up to `maxPriceAge`;
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
- **Redis write access** (audit 2026-10 lead, see "Off-chain trust boundaries"). A Redis writer can deny service:
  withhold prices (the agent stops quoting), delete the risk state (the agents go reduce-only after 30 s), drop or
  delay jobs, blank the status keys the alerts read (including the forged-message counts and the agents' status).
  The one restriction it can still lift is ops-venue's Orderly market gate (unsigned): the agent may then quote on a
  market Orderly does not open for new risk, where Orderly applies the market status itself. Not possible from Redis:
  moving a price the agent trusts; halting an agent (needs a signed `KillOrder`, a signed `killed` state or the
  on-chain kill); revoking a venue key (needs a signed `KillOrder` or the on-chain kill); making risk breach, kill or
  flatten a book (quotes are signed, fresh, monotonic and judged against their own signed print); lifting a
  risk-published restriction (states are signed, fresh and monotonic). The server's Redis has a password
  (`requirepass`) and listens on 127.0.0.1 only ([deploy/server/HARDENING.md](deploy/server/HARDENING.md)).

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
