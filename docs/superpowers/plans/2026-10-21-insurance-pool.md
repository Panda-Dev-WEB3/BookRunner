# Insurance Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use checkbox (`- [ ]`) syntax.

**Goal:** a protocol-wide staking pool (`InsurancePool`, ERC-4626, shares "ibUSDG" — testnet: the settlement token of the
deployment) whose depositors fund the insurance fund (IF) of every book and earn a premium from book revenue. Sponsors
then raise only the market-making capital of a book.

**Design source (owner-approved, 2026-10-20):** Claude Docs "BookRunner Insurance Pool — design proposal". Decisions:
one shared pool; premium 12% of each book's gross fee revenue (protocol floor, charter may set higher); first-loss slice
10% funded by the treasury; weekly withdrawal queue, 20% free buffer target, 7-day cooldown; per-market cap 30% of the
pool; no BKRN boost at launch; exits never blocked (only queued); losses hit the share price before queued withdrawals
are paid. The pool pays only traders' bad debt drawn from an IF (up to that market's allocation); MM trading losses stay
Junior -> Senior -> Backstop.

**Design change after review (2026-10-21, Task 1 fix round 1; the owner to be informed):**
- *Senior debt (review I-1).* The pool's IF is a SENIOR DEBT of the book, netted from NAV. Every IF draw (traders' bad
  debt and MM losses paid from the IF alike) is the book's loss first, Junior -> Senior (never the Backstop, N-1); the pool loses only
  what an exhausted book cannot repay (reported at marks as min(debt, idle + deployed), written off at retirement). An IF
  refill reduces the shortfall first. This replaces "the pool pays traders' bad debt drawn from an IF" above.
- *Epoch pricing (review I-2).* Deposits are queued like withdrawals and priced at epoch processing, which waits for
  every active pool-funded book's mark after the epoch end (grace 24 h, timelocked, so exits are never blocked). Pool
  value changes only through marks, repayments, retirements and premiums; the permissionless live IF sync is gone.
- *One snapshot (review I-3).* The debt is netted at the same signed snapshot that values the IF.
- *Backstop (owner ruling N-1, fix round 2).* Backstop money never goes to the pool: Junior and Senior absorb the
  insurance debt, the Backstop covers only Senior's other losses (cap from the signed IF equity in the mark), Backstop
  cash is never netted against the debt, and an exhausted book's debt is written down to its own capital (the pool's
  loss, the tail risk the premium pays for). A deposit request can be cancelled only before its epoch ends.
- *Minors.* The cap is per market (underlying). Allocations need the first-loss slice at its target. The premium floor
  is fixed into the charter at filing. An epoch-length change waits for an idle queue.

**Architecture today (read first):** `Book.closeWindow` deploys the IF and MM capital from the tranches through
`UnderwritingVault` -> adapter `depositToVenue(IF|MM)`; `MMMandate.ifTargetUsd` / charter `ifTargetUsd` (>=
`config.venueMinIfUsd(venue)`: Orderly 25,001 USDC, PoolEngine 10,000); adapters report `insuranceEquityUsd()` which is
part of the book's `deployedValueUsd` / NAV; `RevenueRouter.distribute` splits fee revenue; retirement recalls IF + MM.
docs/ARCHITECTURE.md §2 and docs/AUDIT-2026-10.md (constraints, launch gate) describe it.

**Tech:** Solidity 0.8.30 + OZ 5.x (ERC4626, ERC-7201 storage), Foundry via `bash scripts/forge.sh` (Docker; for every
forge run pass `FORGE_DOCKER_ARGS="--cpus=2 --memory=3g"` if scripts/forge.sh supports it, else keep runs focused with
`--match-path`), TypeScript/bun services, React app (apps/web).

## Global constraints

- Exits never blocked: deposits/withdraw requests/claims ignore pause, kill and market state (requests are queued, never
  refused). Guardian may pause new allocations and new deposits only.
- Accounting is exact (integer USDC units), conserves funds, rounds against the withdrawer; ERC-4626 inflation attack
  mitigated (virtual shares/offset or seeded first deposit by the treasury slice).
- ERC-7201 storage, timelocked parameter changes (premium floor, caps, buffer, cooldown, queue epoch) with bounds.
- Waterfall changes keep Solidity <-> TypeScript parity (packages/shared) with vectors; EIP-712 unchanged unless needed.
- The book's NAV no longer includes the pool-funded IF; bad debt drawn from the IF is reported to the pool (share price).
- Licence headers (BUSL-1.1 + `pragma solidity 0.8.30;`), check-copy, licence-headers, image-pins, Slither gate green.
- Testnet first; a focused external re-audit before mainnet (note in docs).
- Tools: bun only `node_modules/bun/bin/bun.exe`; never `bun install` through a junction; no network writes, no secrets.

### Task 1: Contracts
- `InsurancePool` (new): ERC-4626 deposit/mint, `requestWithdraw(shares)` -> weekly epoch queue (cooldown 7 d from the
  depositor's last deposit), `claim` once the epoch is processed and liquidity is free; first-loss slice (treasury
  shares that absorb losses first; their own accounting, earn the same premium); `allocate(bookId, amount)` only from
  the Book at `closeWindow` (factory-verified caller) within the per-market cap (30%) and the free liquidity; `recall`
  on retirement / reduction returns funds; `reportLoss(bookId, amount)` from the book/adapter path when bad debt drew
  the IF below its allocation; `notifyPremium` from RevenueRouter; views (free, allocated per book, utilisation,
  queue). Events for everything.
- Book / adapters / vault: `closeWindow` funds the IF from the pool (charter flag `ifFromPool`, default true on new
  charters; a book funded the old way keeps working); retirement returns the IF to the pool; the IF is excluded from
  the book's NAV and deployed value; the IF shortfall (bad debt) is reported. Both venues (Orderly IF account,
  PoolEngine insurance).
- RevenueRouter: premium (>= protocol floor 12%, charter may set higher) paid to the pool first, before expenses/carry.
- Charter / validators: `ifFromPool`, premium bps; MarketCharter + CharterRules + packages/shared validators + forms.
- Tests: unit, fuzz, an invariant suite (pool assets == free + allocated - reported losses + premiums; no market over
  its cap; exits never blocked; first-loss absorbs first; share price never moves on deposit/withdraw), regression of
  the book waterfall without the IF, parity vectors. Deploy.s.sol (testnet) deploys and wires the pool; DeployMainnet
  input + VerifyHandover know it. Docs: ARCHITECTURE, INVARIANTS rows, AUDIT note ("new, needs re-audit").

### Task 2: Services
- ops-venue: allocation/recall flows follow the new path; indexer/api: pool events, positions, queue; waterfall service:
  premium; risk: IF shortfall reporting; alerts: utilisation > 90%, queue older than 2 epochs, per-market IF drawdown,
  first-loss slice depleted; launch-devnet: the treasury seeds the first-loss slice, test users deposit.

### Task 3: App
- apps/web: Insurance Pool page (deposit, request withdraw, claim, queue position, share price / yield history,
  exposure per market, first-loss slice); site copy mention; check-copy.
