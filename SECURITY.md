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
