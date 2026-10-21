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

---

## Fix round 1 (review task-23-review.md)

**Status: DONE_WITH_CONCERNS.** Commits `42d2986..8383fc0` (8):

| SHA | Fixes |
|---|---|
| 42d2986 | I-1 (mark) |
| cf7cfd4 | I-2 (keeper, alerts) |
| 9cbeb17 | I-3 and m-3 (indexer, migration 0002) |
| 0524586 | I-4, I-5, m-1 (launch, RUNBOOK, ARCHITECTURE §7) |
| 5fedf06 | api: m-2, m-5, m-8 |
| 4e5b8df | web: m-5, m-7, m-8 |
| 8383fc0 | m-2, m-4, m-10, m-11 (waterfall, charter, alerts) |

### Important

- **I-1 (mark).**
  - `readInsuranceDebt` returns null only for a book-funded IF (pool 0), or for a book whose bytecode lacks `insuranceDebt` (`codeHasSelector`).
  - Any other failure throws `RetryableMarkError`, so the mark is refused and retried, and nothing is signed. If the probe itself fails, the mark is refused too.
  - Tests in `services/mark/test/insurance.test.ts`: the reader cases, and a refused snapshot that commits and stores nothing.
- **I-2 (keeper).**
  - After each confirmed `settleInsurance` that leaves the position open, the keeper backs off with `settleBackoffMs`: it doubles from the action cooldown, capped at 6 h.
  - It warns on each retry, and the backoff resets once the position closes.
  - The indexer now records `book.InsuranceMarkFailed` as the domain event `book.insurance_mark_failed`.
  - New alert `pool_final_mark_stuck:<bookId>` (warning): the book is Retired in the DB but its pool position is still active. It waits `ALERT_POOL_FINAL_MARK_STUCK_SECONDS`, default 1800.
  - Tests: no resend within the backoff, the backoff sequence, the reset, and the rule.
- **I-3 (indexer).**
  - Pool reads now happen at exactly the event's block. Nothing falls back to head, and a rejected read is never cached.
  - `poolBookPosition` and `poolEpochEnd` throw on failure.
  - When a read fails, the event rows are still written, and:
    - that block gets a stale carry-forward snapshot (`pool_snapshots.stale`, carrying the previous good values);
    - the position keeps its last good values with `pool_books.stale`, or uses the Allocated event's own figures;
    - the epoch end stays null.
  - `backfillPool` re-reads all of them on every runner pass, both indexed and idle. No share-price point is lost.
  - Migration `0002_insurance_pool_stale`: the two stale flags, plus the `pool_snapshots_ts` index (m-9).
  - Test: with the pool reads down, everything is recorded and stale; with the reads back, the next pass leaves nothing stale and the values are correct.
- **I-4 (launch).**
  - Contract rule: `setParam("epochLength")` only sets a pending length. The pool applies it on the first request or processing made while the queue is idle and its oldest epoch has ended. The first epoch ends on the weekly grid that `initialize` set.
  - So neither "set it before the first deposit" nor "process the first epoch at launch" can take effect earlier.
  - The launch now queues the test deposits only once the 1-day length is in force, or once the first epoch has ended with an idle queue. That deposit then applies the pending length itself and lands in a 1-day epoch.
  - Otherwise the launch logs the weekly end and defers the deposits. Re-running the idempotent launch after that time queues them; the "already launched" path does this too.
  - ARCHITECTURE §7 now says the first epoch ends on the weekly grid, and that earlier deposits, including from the app, wait for that end.
  - Correction to my first report: "1-day epochs" applies only from the second epoch on.
  - Tests: `testDepositTiming`.
- **I-5.** RUNBOOK step 13b now has the reviewer's text: the first-loss seed of about 91,671 USDG, the `maxAllocation` check, slice withdrawal rules, and no demo parameters on mainnet. I added one ordering paragraph:
  - Open deposits at least one full epoch before the books' `subscriptionEnds`. Processing waits for no book mark while no pool-funded book is active.
  - The processed deposits then count, and the seed only has to keep the slice at 10% plus the cap and buffer headroom.
  - Without that lead time, seed the full amount.

### Minor items done

| Item | Change |
|---|---|
| m-1 | The seed's per-market term is summed per underlying (`BookSize.market`), with a test. |
| m-2 | The keeper reads `staleBooks` only for an ended epoch with work, and positions only when some book is stale. Alerts read positions only for books past their window. `pool.position` reads at most 50 open deposits and 50 unsettled withdrawals live; a filled and claimed request is settled from the index, with a test. |
| m-3 | `book.insurance_shortfall` is emitted once per (book, amount), and is `provisional: false` in the retirement tx. |
| m-4 | waterfall `insurancePool` / `previewPremium` and charter `config.insurancePool` default only on an on-chain revert; a transport error fails the read. |
| m-5 | Web wording follows `params.epochLengthSeconds`. The share-price line is corrected. The api's durations are in words (`durText`), with a test. |
| m-7 | The web caches "no pool" only on an on-chain answer; transport errors are retried. |
| m-8 | `allocatedUsd` renamed to `repayableUsd` in overview / history, labelled "Repayable by books". |
| m-9 | `ts` index, in migration 0002. |
| m-10 | Spec mapping is noted in `rules-pool.ts`: utilisation goes critical when a queue ages, and the shortfall events stand in for "risk" reporting. |
| m-11 | Tests added for I-1, I-2, I-3, and the `processEpoch` front-run. |

### Deferred (for the re-audit or a later round)

- **m-6.** IF in transit is excluded from the signed IF equity, and a negative IF report is signed as 0. Both make the Backstop cover cap looser. Fixing this needs the adapter to split in-transit IF from in-transit MM.
- **m-11 (part).** No PoolEngine test checks that the signed IF equals `engineAtSignedPrice`'s `insuranceUsd`; it needs an engine fake.
- **Not verified from the diff** (from the review):
  - the mark sender's gas headroom for the try/catch `markBook`;
  - `update.sh` running `db:migrate` (migrations 0001 and 0002) before the new indexer starts.
- **Read growth.** Alerts still read every retired book's position. Pruning needs a "fully settled" cutoff.

### Checks (at 8383fc0)

| Check | Result |
|---|---|
| Typecheck, all 17 workspaces | 0 errors |
| Repo-wide `bun test` | 2282 pass, 82 skip, 0 fail |
| check-copy | passed (164 files) |
| licence-headers and image-pins | 10 pass |
