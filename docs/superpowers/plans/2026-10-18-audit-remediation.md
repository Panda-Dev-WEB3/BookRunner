# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every finding of the external audit (grade 6.8/10, commit 037f257, re-scored at 7e77b1e): the 4 Mediums, 3 Lows, the privileged-operations items, the leads, and the testing/CI/hygiene gaps — with a regression test (the auditor's PoC scenario) for each finding.

**Source:** the audit text is at `.superpowers/AUDIT_REPORT.txt` in this worktree (gitignored). Each task cites the finding ids it closes. Record every finding's status in a new `docs/AUDIT-2026-10.md` (finding → fix commit → regression test → status), created in Task 1 and extended by each task.

**Architecture:** no change to the economic design except where a finding requires it. Contract changes are made so a fresh deployment (the planned live-Orderly testnet rehearsal) gets them; Book is UUPS (logic in the linked BookLogic library), MMMandate/Tranche/Desk/Vault are clones — note per task what an existing deployment would need (upgrade vs redeploy) in docs/AUDIT-2026-10.md.

**Tech Stack:** Solidity 0.8.30 + OZ 5.x + Foundry (Docker: `bash scripts/forge.sh`), TypeScript/bun services, nginx, GitHub Actions.

## Global Constraints

- Owner decisions in force: oracle mainnet policy primary-confirm (Chainlink signs alone, DEX TWAP confirms) — keep; RHX5/PoolEngine small caps/off at launch.
- Exits must never be blocked (requestRedeem, claims, unstake, claimReward ignore pause/kill/state) — the audit lists this as a strength; no fix may weaken it.
- ERC-7201 storage is append-only; EIP-712 type changes bump the type string and are mirrored in packages/shared (TS signers/verifiers) with parity tests; waterfall changes keep Solidity ↔ TypeScript parity vectors passing.
- Every fix: a failing regression test first (the auditor's PoC), then the fix; `bash scripts/forge.sh test` full suite green; touched services' bun tests + typechecks green; `node_modules/bun/bin/bun.exe scripts/check-copy.ts` green.
- Environment: this worktree installs its OWN node_modules (`npx -y bun@1.4.2 install --frozen-lockfile`), never a junction; bun via `node_modules/bun/bin/bun.exe` (never node_modules/.bin/*.exe); no network writes, no servers, no secrets.

---

### Task 1: M-1 — no redemption/subscription settlement on held marks
Closes M-1. Add a signed `held` flag to the mark input (MarkInput / the EIP-712 mark type, signed by the mark service from the oracle's held state); on held marks Book/BookLogic applies P&L but does NOT settle redemption buckets, top-up rounds or subscriptions (they settle at the first non-held mark). Also enforce, at charter validation, a minimum Junior notice ≥ one mark interval (defence in depth; document the choice). Regression test = the auditor's PoC (sponsor's Junior loses 60% vs 20%; early exiter avoids the gap) must now share the loss pro rata. Update services/mark (sets held from the oracle's signed price state), packages/shared types/signers, parity tests. Create docs/AUDIT-2026-10.md.

### Task 2: M-2 — stock split / multiplier change while the price is held
Closes M-2. StockTokenRegistry fails closed when the stored price was published before the token's multiplier `effectiveAt()` and the multiplier has changed since (no valuation, desk/engine trades revert, marks hold); preferably also have the oracle sign the multiplier it used (AttestedOracle price struct or a parallel signed field) and reject a mismatch — implement if it fits the EIP-712 + service changes cleanly, else document why the registry guard suffices. Regression: auditor's PoC (desk spends $10k, keeps $1k) now reverts; reverse split mirrored; marks in that window hold.

### Task 3: M-3 — pool drain with in-mandate quotes + missing invariant
Closes M-3 + "missing invariant" lead. checkQuote requires |skew| ≤ width/2 (quote can never sit entirely on one side of the oracle); validateMandate and MarketCharter.validate enforce maxSkew ≤ minWidth/2; add a per-period budget on PoolEngine pool P&L measured against the oracle (breach → reduce-only + kill path as the mandate defines). New invariant suite: pool equity cannot fall at a constant oracle price under arbitrary quote/trade sequences. Regression: auditor's PoC (25 round trips, pool −$7k) now fails.

### Task 4: M-4 + L-3 — API receipts cost and nginx path confusion
Closes M-4, L-3. Cache Merkle trees for closed hours (or read proofs stored by the receipts service); count `receipts.*` as heavy inside a tRPC batch (lower batch cap); `receipts.root` checks the book exists; a stricter nginx rate zone for receipts. nginx: forward `/trpc/` with a normalized path (`proxy_pass http://127.0.0.1:4400/trpc/;` style) and reject backslashes / dot-segments so `/trpc/..\v1\books` can't reach other API routes; tests (nginx config test + API tests). Regression: the PoC load now stays within normal CPU.

### Task 5: CI, licence and supply-chain hygiene
Closes "No CI", "No LICENSE", floating pragma/images, install controls. GitHub Actions workflow(s), actions pinned by commit SHA, `permissions:` minimal: forge test with the CI profile (invariants ≥ 100k calls), bun test (unit) + an integration job (Postgres/Redis/Anvil services; BKRN_IT=1), typecheck, check-copy, gitleaks, Slither (with a reviewed allowlist), Semgrep. LICENSE = BUSL-1.1 (Licensor: BookRunner / Panda-Dev-WEB3; Licensed Work: BookRunner; Change Date: 2030-10-18; Change License: MIT; Additional Use Grant: none) + SPDX headers consistent; fixed `pragma solidity 0.8.30;`; scripts/forge.sh Foundry image pinned by digest; redis/dev compose images pinned by digest; bun `minimumReleaseAge` / trusted-dependencies (whatever bun 1.4.2 supports — verify) ; fix the failing ops-venue integration test (chain.it.test.ts:108) and the 2 flaky timeouts if reproducible. Testnet mnemonic no longer on a process command line (pass via env/file).

### Task 6: L-1, L-2 and the privileged-operations items
Closes L-1 (fee flow repays Senior impairment and backstop debt before crediting Junior — in Solidity and the TS reference, parity vectors updated, design note), L-2 (accepted risk in SECURITY.md + mitigation: cap the relay age for desk/engine use, or two-step orders — choose the smaller sound change), committee state keyed by charter address (not just id), charter deadline stored at filing (not read live), guardian can pause but not lift a timelock pause, migration paths for Backstop and BkrnFeeRouter balances, VerifyHandover enumerates role holders (any extra holder = failure), UpgradeBook checks ABI/storage compatibility of existing clones, desk "old prints up to 300 s" tightened to the oracle's freshness bound.

### Task 7: Remaining leads, docs and mutation testing
Closes the leads: liquidation keeper reward floor when margin is gone (or documented keeper policy), settle path for delisted/permanently held markets (timelocked settle-at-price), Redis trust (sign or verify the kill-channel and quote-price messages, or move the revocation trigger to an authenticated path), unconfirmed deposits stuck in Subscription (refund/cancel path after a timeout). Docs: an invariants doc linking each invariant to its test; update SECURITY.md, docs/AUDIT-2026-10.md (all findings closed or explicitly accepted with rationale). Run a mutation-testing pass on Tranche, BookLogic, MMMandate, PoolEngine (tool that works with Foundry in Docker, e.g. Gambit/vertigo-rs — verify) and record the score; add tests for surviving mutants that matter.
