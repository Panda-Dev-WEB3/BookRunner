# Tasks 2 (services) and 3 (app): report

**Status: DONE_WITH_CONCERNS.** The concerns are listed at the end. None of them blocks.

- Branch: `insurance-svc`.
- `insurance-pool` was merged twice: at `a44630b` (fix round 2, N-1: signed `insuranceEquityUsd`) and at `c52aa47` (final contracts, round 3: provisional shortfall).
- The services were adapted after each merge.
- No edits to `contracts/` or to the shared waterfall / pool math.

## Commits (mine, oldest first)

| SHA | Subject (short) |
|---|---|
| 69e7222 | services: Charter `ifFromPool` / `premiumBps`. Covers api, charter service, agent and fixtures: BAD_PREMIUM / NO_POOL validators, legacy JSON reads as book-funded, jury rule check and prompt. |
| eb6e8ae | db: pool tables and `settlements.premium_usd`, migration `0001_insurance_pool` (generated with drizzle-kit). |
| 800c5ef | indexer: InsurancePool events. Adds deposits, withdrawals, epochs (processed, stale, fills), claims, per-book position, flows, one snapshot per block, and the PremiumPaid of each distribution. |
| 8517537 | alerts: pool rules. Written by a subagent, reviewed by me. |
| 1871859 | shared: the prepared-tx verifier accepts the pool's queued entry and exit calls. |
| bce589f | api: `pool` router. Reads (`overview`, `position`, `epochs`, `history`, `exposure`) and prepared txs (`deposit`, `cancelDeposit`, `claimDeposit`, `withdraw`, `claim`). |
| ff02731 | mark: signs `insuranceEquityUsd` from the same snapshot that values the IF. The commitAndApply selector is now derived from the ABI. NAV is net of the pool's claim. |
| 9083f3d | waterfall: the premium in preview, parity and conservation, persisted and carried on `distribution.paid`. |
| a60be40 | waterfall keeper: `processEpoch` when the epoch is processable, and `Book.settleInsurance` for a retired book whose final mark failed. |
| c6f20e8 | ops-venue: `fund_if` reports `fundedBy` pool / tranches and the pool's debt. |
| cb678a7 | launch: `ifFromPool` charters, demo pool params, treasury first-loss seed, test deposits. |
| 65bf29a | mark: integration test updated for the premium-aware split. |
| e831ab3 | web: Insurance Pool page, charter form fields, premium line; site mention. Written by a subagent, reviewed by me. |
| 800b1a3 | docs: ARCHITECTURE §4, §5 and §7. |
| 7cd7e1b … e6aa05b | Round-3 provisional-loss semantics in mark, indexer, api, alerts, web and docs. |

## What each part does

### Indexer (tables)

| Table | Written from |
|---|---|
| `pool_deposits` | Deposit requests, cancellations, claims |
| `pool_withdrawals` | Withdrawal requests and claims |
| `pool_epochs` | Epoch processing, stale processing, fills |
| `pool_books` | `bookPosition` re-read at each event's block |
| `pool_flows` | Allocated, repaid, premium, loss, recovery, first-loss deposit / withdraw, claims, fills |
| `pool_snapshots` | One row per block with pool events: share price via `convertToAssets(1e12)`, T, D, FL, utilisation |

- Additive totals (claims, fills, premiums) move only when their `pool_flows` row is new, so replays stay idempotent. The idempotency test re-applies the range.
- Domain events:
  - `pool.epoch_processed`
  - `pool.loss_reported`, with `provisional` = the book is still active
  - `book.insurance_shortfall` (provisional)
  - `book.insurance_written_off` (final)

### API

- **`overview`**: live views plus the queue phase, mirroring `processEpoch`'s gate and `_skipIdleEpochs`. The phases are:
  - `open`
  - `awaiting_marks`
  - `processable`
  - `idle`

  When the chain read fails it falls back to the newest snapshot.
- **`position`**:
  - deposit status: queued, ready, claimed or cancelled, with `cancellable` before the epoch end;
  - withdrawal status: queued, filling, filled or claimed, with pro-rata filled and claimable amounts.
- **`exposure`**: per market against the 30% cap, with `provisionalLossUsd` (live books) and `writtenOffUsd` (retired books).
- **`history`**: share price points, daily premiums / losses / recoveries, and the observed change over the window.
- **Prepared txs**: pass `verifyPreparedTxs` in the tests.

### Waterfall

- **Premium**: `previewDistribution(i, premiumBps)` uses `splitPoolDistribution`. Parity and conservation include the premium, and `premiumBps` is 0 unless `book.insurancePool()` is set. The PremiumPaid amount comes from the distribute receipt.
- **Pool keeper**: `planEpoch` mirrors the contract's processing gate and processes up to 4 epochs per pass. While it waits it logs the books that have not marked since the epoch end.
- **"Sync before an epoch ends"** (Task 1 report concern 5): after fix round 1 the contracts need no sync. Pool value moves only at marks, and the mark service marks every period. The one remaining gap was a failed final mark, which would block the epoch gate until the grace. The keeper now retries it with `Book.settleInsurance`.

### Mark

- `insuranceEquityUsd` is the venue IF figure of the snapshot after the signed-report overlay, floored at 0.
- The informational NAV nets `Book.insuranceDebt().value` (the pool's claim) while the debt is not due. Once due, `unfundedClaims` already carries it.

### Launch

- `poolSeedUsd` sizes the treasury's first-loss slice so that every IF can be allocated at window close. Queued deposits count only after their epoch is processed, so at launch the slice is the whole pool.
  - mock venue: 123,750
  - live rehearsal: 550
- Demo params apply only when the deployer is `config.timelock()`: 1-day epochs, 1 h cooldown, 1 h grace.
- Allocators a0 and a1 queue deposits of 60k and 40k on the mock venue.
- The window raises only the MM inventory (`raiseOf`).

### Web

- `/pool` page: overview, actions, queue, history, exposure, first-loss slice, loss order, risks.
- The pool address is read from the chain (`config.insurancePool()`) and is an allowed tx target.
- Charter form: `ifFromPool` / `premiumBps` fields.
- The site's charter terms now show who funds the IF.

## Tests (after the last change, at HEAD)

| Check | Result |
|---|---|
| Typecheck, all 17 workspaces (packages, services, apps/site, apps/web, scripts) | 0 errors |
| Repo-wide `bun test` | 2272 pass, 82 skip, 0 fail (225 files) |
| `scripts/check-copy.ts` | copy check passed (164 files) |
| licence-headers and image-pins tests | 10 pass |

New test files:
- `services/indexer/test/pool.test.ts`
- `services/api/test/pool.test.ts` (14)
- `services/mark/test/insurance.test.ts` (struct hash equals the parity vector `0xf097…d834`; the signed value equals the snapshot's IF equity, and tampering breaks recovery; selector; NAV)
- `services/waterfall/test/pool-keeper.test.ts`
- `services/alerts/test/rules-pool.test.ts`
- `apps/web/test/pool.test.ts`

Pool cases were also added to existing charter, launch-plan, ops-venue, waterfall and web suites.

TDD: the tests were written alongside the code, not red-first.

## Concerns

1. **Copy rules versus the brief.** "protected" and "yield" are banned words.
   - The risk box says Junior, then Senior, then the first-loss slice, then depositors.
   - It does not mention the backstop, because of owner ruling N-1.
   - "Yield history" became "share price and premium history (observed)".
2. **Devnet / testnet first-loss seed.** Deposits only count after the first epoch is processed, so the treasury slice must fund every IF on its own at launch (about 124k on the mock venue). It is larger than 10% until the deposits are processed. It can be withdrawn only through the timelock.
3. **No deposit counter.** The pool has no `depositCount()` view, so the launch walks `depositInfo(1..)` to stay idempotent.
4. **Cost of pool reads.**
   - The indexer reads about 10 pool views per block with pool events (cached per block).
   - The alerts read about 12 views plus one `bookPosition` per book per pass.
   - The keeper reads `bookPosition` for every active book per pass (64 at most).
5. **API gaps when the chain is unreachable** (noted by the web subagent): `exposure` has no cap, and the overview snapshot has no params or queue.
6. **Fresh database migration.** Migration 0001 must be applied: `bun run db:migrate`.
7. **Line endings.** The Python patch helpers briefly wrote CRLF. Git normalised them on commit, and the working tree was cleaned afterwards.
