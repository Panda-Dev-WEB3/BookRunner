# Live Orderly on Testnet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps (docs/RUNBOOK.md "Switching testnet books to real Orderly", VERIFY O17–O22) so that BookRunner's Orderly-venue books can run against REAL Orderly (testnet first, same code path as mainnet): builder market symbols, a live builder price feed, manual listing in Orderly One, an insurance-fund account fallback, and a hybrid rehearsal deployment.

**Architecture:** No change to the economic design. The book's capital still reaches Orderly through `OrderlyAdapter` (MM = adapter's own Orderly account; per-book `OrderlyIFAccount` for the insurance fund). New pieces are configuration-driven so devnet/testnet-mock keep working unchanged: a venue-symbol mapping, a builder-oracle push client, a `manual` listing mode, an IF-account mode, and a deploy option that binds adapters to a real Orderly vault + real settlement token (testnet USDG) while stock tokens / prices stay mock/synthetic on testnet.

**Tech Stack:** TypeScript (bun), services/ops-venue, services/oracle, services/bookrunner-agent, services/risk, packages/shared, Foundry (Docker), Orderly REST + WebSocket APIs (docs: orderly.network/docs/build-on-omnichain/*).

## Global Constraints

- Owner decisions in force: oracle policy primary-confirm on mainnet (Chainlink signs alone; DEX TWAP confirms) — do not change.
- Broker ID `bookrunner` (testnet + mainnet), admin wallet 0x9c1B7179554304995dD58bA9ba203b0cbA8fe8b9 (Orderly account 0xaa04410b18eb0856e02832221f24b2cd37fde7c6f6f8eec83fe95a2f62702e5c). The system never holds the admin wallet key; anything only the admin can do is a documented manual step.
- Orderly RH testnet vault 0x2A5b650A894409372DDeE241EDAC92d4152bE24d (no token / broker allowed yet); RH mainnet vault 0x816f722424B49Cf1275cc86DA9840Fbd5a6167e9 (USDG allowed, broker allowed). USDG testnet 0x7E955252E15c84f5768B83c41a71F9eba181802F, mainnet 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168.
- Orderly builder symbol format: `PERP_<BASE>_USDC_<broker>` (e.g. `PERP_NVDA_USDC_bookrunner`) — verify against Orderly docs and the live `/v1/public/info` list (e.g. `PERP_AAPL_USDC_mythos`).
- Testnet IF requirement > 100 USDG per symbol; mainnet > 25,000 (strictly greater).
- Every Orderly endpoint/body/signature format used must be checked against the official docs; anything not confirmable is behind config, marked VERIFY in docs/VERIFY.md, and never fatal to unrelated books.
- No transactions, no server changes, no secrets in code/logs/commits. Tests never need network or keys.
- Bun: `node_modules/bun/bin/bun.exe` (never node_modules/.bin/*.exe); never `bun install` through a junctioned node_modules; Foundry only via `bash scripts/forge.sh`.

---

### Task 1: Venue symbol mapping (G3 / VERIFY O19)
**Goal:** every component that talks to Orderly uses the book's VENUE symbol (`PERP_NVDA_USDC_bookrunner`), while charters, marks and the UI keep the charter symbol (`PERP_NVDA_USDC`).
- A single pure helper in packages/shared (e.g. `venueSymbol({ charterSymbol, brokerId, mode })` + `parseVenueSymbol(sym) → { base, quote, broker? }`) used by services/ops-venue, bookrunner-agent, risk (wherever the Orderly symbol is built/parsed today — grep for `PERP_` and `_USDC`). Config: `ORDERLY_SYMBOL_SUFFIX` (default none = current behaviour; live testnet/mainnet = `_bookrunner`) or derived from broker id — pick one and document.
- Fix ops-venue's `^PERP_(.+)_USDC$` base parse to accept the broker suffix.
- Unit tests: mapping both ways, suffix/no suffix, invalid symbols.
- Acceptance: all existing tests pass with the default (mock) config; new tests cover the live config.

### Task 2: Builder-pushed price feed to Orderly (G2 / VERIFY O18)
**Goal:** the oracle's signed per-share price for each Orderly book is pushed to Orderly as a builder index source at ≥ 1 update/s during the market session.
- Research Orderly's builder-oracle docs (orderly.network/docs/build-on-omnichain/user-flows/builder-oracle.md and linked API pages): WS endpoint per network (testnet + mainnet), auth (Orderly key, Ed25519), message format, symbol/base field, rate, heartbeat, error codes. Record findings with URLs in VERIFY O18.
- Wire it: whichever service owns the Orderly key (ops-venue's OrderlyBuilderClient.setBuilderPrice exists) subscribes to the oracle's published prices (Redis/pubsub as the codebase does) and pushes per venue symbol; network-specific host via config; base derived via Task 1's parser; push cadence ≥ 1/s by re-sending the latest price between oracle ticks (oracle ticks every 2 s on testnet) — never fabricate a new price, only resend the last signed one, and stop pushing when the oracle price is stale/held per its own flags (let Orderly's own off-market handling apply).
- Replace `LiveOrderlyPriceClient`'s NotConfiguredError path accordingly (or remove the dead path) — keep one clear owner.
- Health + alert: per-symbol last push time; alert when pushing fails > 30 s in session.
- Unit tests with a fake WS server: message shape, signing, cadence, stop on stale, reconnect/backoff.

### Task 3: Manual listing mode (G4 / VERIFY O20)
**Goal:** markets can be listed by the admin in Orderly One; ops-venue verifies instead of creating.
- `ORDERLY_LISTING_MODE=api|manual` (default keeps today's behaviour for the mock). In `manual`: provisioning checks `/v1/public/info` (or the builder symbol endpoint) for the venue symbol and its status; if missing, the book's provisioning waits (retry with backoff, clear log + /health + alert "awaiting listing in Orderly One") without aborting other books. Never call unverified listing endpoints in manual mode.
- Reduce-only control: if the live `setSymbolStatus` endpoint is unconfirmed, manual mode documents the Orderly One action and our own reduce-only (agent/mandate side) remains the enforcement.
- Tests for both modes, incl. "one book not listed doesn't block another".

### Task 4: Insurance-fund account mode (G5 / VERIFY O10)
**Goal:** support both IF account models until Orderly confirms one.
- `ORDERLY_IF_MODE=contract|builder`: `contract` = today's per-book OrderlyIFAccount (delegate) path; `builder` = a builder-held IF account (an Orderly account owned by an operator EOA behind the multisig) whose account id is configured per book, funded via the same on-chain `Vault.depositTo(accountId)` path, with every deposit recorded on-chain/in the receipts. Clarify in code where the IF account id comes from in each mode.
- `venueMinIf`: testnet default must exceed 100 USDG (e.g. 101e6) via deploy config; mainnet stays 25,001e6. Check the config contract/deploy scripts set it per network.
- Tests for mode selection and min-IF checks; docs (RUNBOOK + VERIFY O10) for which admin clicks each mode needs in Orderly One (assign IF account to symbol).

### Task 5: Hybrid rehearsal deployment + live-Orderly testnet profile (G1, G6, G7 / VERIFY O17, O21, O22)
**Goal:** one documented path to deploy a fresh testnet BookRunner whose Orderly books are bound to the REAL Orderly testnet vault and settle in REAL testnet USDG, while stock tokens and prices stay mock/synthetic (no Stock Tokens / Chainlink / Uniswap on RH testnet).
- Deploy.s.sol (or a new script reusing it): options `DEPLOY_ORDERLY_VAULT=<addr>` and `DEPLOY_SETTLEMENT_TOKEN=<addr>` (6 decimals, must be `vault.getAllowedToken(tokenHash)`), `DEPLOY_ORDERLY_BROKER_ID=bookrunner`, `DEPLOY_ORDERLY_TOKEN=USDG`; when set, no MockOrderlyVault / MockERC20 settlement token is deployed for Orderly books; PoolEngine (RHX5) can keep a mock settlement token only if the design allows mixed tokens — otherwise everything settles in USDG (decide from the code and document). Foundry tests with a mock vault that mimics getAllowedToken/allowed broker.
- scripts/dev.ts testnet profile: a live-Orderly variant driven by env (ORDERLY_MODE=live, network hosts, ORDERLY_LEDGER_ADDRESS testnet, OPS_FEE_SWEEP_AUTO=false, listing mode manual, IF mode, symbol suffix) that does NOT start mock-orderly; mock remains the default.
- Builder admin key (G6): ops-venue uses a builder Orderly key registered by the admin wallet (ORDERLY_BUILDER_KEY_SECRET); document the one-time admin registration flow in Orderly One / API; automated fee sweep off.
- Extend scripts/orderly-readiness.ts with the new deployment record checks (adapters bound to the real vault, settlement token USDG, venue symbols listed, IF accounts funded > requirement).
- RUNBOOK: the full rehearsal procedure end to end (readiness → admin steps in Orderly One → deploy → fund → start → verify → rollback), replacing the earlier "switch" section where needed; VERIFY rows updated; note the open question "testnet USDG source" (to ask Orderly/Paxos).
