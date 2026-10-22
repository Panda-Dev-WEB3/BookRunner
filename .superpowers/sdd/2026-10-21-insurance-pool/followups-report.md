# Insurance Pool follow-ups: report

**Status: DONE_WITH_CONCERNS.** All four required items and the design note are done. The concerns are listed at the
end: the OrderlyAdapter size headroom, the direction of the m-6 effect, and one residual window.

- Branch `pool-followups`, from main `3253eb3`.

## Commits

| SHA | Subject (short) |
|---|---|
| 812e3cc | contracts (m-6): OrderlyAdapter splits the IF part of in-transit; PoolBook, adapter unit, fuzz and invariant tests; ABI; AUDIT note |
| 18ecef1 | mark (m-6): signs venue IF (a negative figure as 0) + IF in transit; tests |
| c8f454e | test (mark, m-11): PoolEngine signed IF == engineAtSignedPrice's insuranceUsd, with an engine fake |
| ced9da6 | deploy: update.sh runs the DB migrations before the restart (db-migrate.sh); tests; README / HARDENING |
| 4b1ecd2, 737594d | alerts: settled pool positions are read once, then reused from memory; tests |
| f9c18fb | docs: §2.10 stuck-book design note; the residual m-6 window |
| f4a3d5e | test (deploy): typecheck fix |

## 1. m-6: IF in transit in the signed IF equity

### Finding, corrected on direction

- The book uses the signed `insuranceEquityUsd` only for the Backstop cover cap (`Waterfall.poolCoverNav`): draw =
  claim − IF equity, cap = the cover `applyMarkPnl` gives at NAV + draw.
- An understated IF equity overstates the draw, which raises the NAV the cap is computed at, which **lowers** the cap.
- So an IF transfer in flight made the cap **tighter**, not looser: Senior got less Backstop cover for real MM losses
  at that mark. The cover is offered again at the next mark (`applyMarkPnl` re-offers while Junior is 0 and Senior is
  impaired).
- It never caused a provisional pool loss: the pool's claim (`poolClaimAtMark`) uses idle + `deployedValueUsd`,
  which already counts all in-transit.
- `test_m6_preFixSigning_readsTheRecallAsADraw_tighterCapAtThatMarkOnly` pins this: 27.5k of cover instead of 52.5k
  at that mark, and the full 52.5k at the next one.

### Where the IF can be in flight

- **Deposits.** OrderlyAdapter credits `insuranceUsd` at `depositToVenue`, and a venue report from before the flow
  is refused, both on-chain (`ReportPredatesFlow`) and in the mark's overlay (`reportConsistent`). ops-venue also holds
  its reports for `reportSettleSec`. A deposit in flight was therefore already IF equity. Tests now cover it at the
  adapter, the mark and the book levels.
- **Recalls.** A Confirmed IF withdrawal moved from `insuranceUsd` into the mixed `inTransitUsd`. This was the real
  gap.

### Contract change: OrderlyAdapter only (marked `[2026-10 pool follow-up m-6]`)

- **Storage:** appended field (v5) `inTransitIfUsd`.
- **Updates:**
  - `_confirm` adds the IF part.
  - A new helper `_leaveTransit` is used by `sweepToVault`, `failWithdraw` and `writeOffOperatorPayout`.
  - A sweep cannot tell an IF payout from an MM one, so it clears the IF part **first**. The IF part can then be
    understated (the cover waits a mark), but never overstated (an overstated part would loosen the cap, against N-1).
  - It is always ≤ `inTransitUsd`.
- **View:** `insuranceInTransitUsd()`. It is not added to `IOrderlyAdapter`, because the test copy `OrderlyAdapterV3`
  implements that interface.
- **Unchanged:** Book, BookLogic, Waterfall and the pool. The book still reads only the signed value.
- **Upgrade:** a proxy upgraded while IF is in transit reads 0 (the old behaviour) until that transfer settles.

### Mark service

- **Signed value:** `markInsuranceEquityUsd` = max(venue IF, 0) + `venue.insuranceInTransitUsd`. The snapshot field is
  optional, so it is absent / 0 for the engine and pre-v5 adapters.
- **Reading the new view:** `readIfInTransit`. An adapter without the selector gives 0; any other failure throws
  `RetryableMarkError`, the same policy as `readInsuranceDebt`.
- **Cross-check:** the IF part must be ≤ in-transit.

### Negative IF report: kept as a clamp to 0

The reason is documented in `nav.ts`:

- The field is a uint256, as are the adapter's `insuranceUsd` and the signed `VenueReport`'s.
- At 0, the draw equals the whole claim, so none of the insurance debt gets Backstop cover.
- A deficit beyond the IF is already netted from `deployedValueUsd`. It is a book loss other than the debt, because
  the pool funded only the allocation, so N-1 allows it to be covered. Keeping the sign would wrongly refuse it cover.

### Tests

- **`test/pool/PoolBook.t.sol`:**
  - `test_m6_ifDepositInFlight_noIfDraw_noProvisionalLoss`
  - `test_m6_ifRecallInFlight_noIfDraw_noProvisionalLoss`, which also checks repayment in full on landing
  - the pre-fix contrast test above
  - Each checks: full cover for the MM loss, claim == debt, and no `InsuranceShortfall` event.
  - `MockPoolAdapter` gained an async IF mode, and the fixture signs IF + IF in transit, as the mark does.
- **`test/orderly/OrderlyIfInTransit.t.sol`** (10 tests, including a 16-step fuzz):
  - deposit in flight
  - recall Requested, then Confirmed, then swept
  - an MM recall never counts as IF
  - venue fee
  - IF and MM failures
  - mixed sweep (IF cleared first)
  - partial sweep
  - builder write-off
- **`OrderlyInvariant`:** new `invariant_ifInTransitWithinInTransit`.
- **`services/mark/test/insurance.test.ts`** (+5):
  - recall in flight
  - deposit in flight against a pre-credit report
  - negative IF plus IF in transit
  - the reader's three outcomes
  - the pipeline signs 25k

### TDD

The contract and mark tests were written in the same pass as the code, not red-first. The pre-fix test shows the old
behaviour on the fixed code.

- **RED evidence for m-11:** I mutated `engineAtSignedPrice` to take `insuranceUsd` from `res[6]`. The m-11 test
  failed (1 fail), then passed once the mutation was reverted.

## 2. m-11: PoolEngine signed IF

`services/mark/test/engine-signed-if.test.ts` (3 tests):

- **The fakes:**
  - A `PublicClient` fake answers every read `snapshot()` makes for a PoolEngine book.
  - The deployless eth_call goes through a new `protected readAfterPriceUpdate` seam in `MarkChainAdapter` (behaviour
    unchanged), which the engine fake overrides.
- **What it asserts:**
  - The eth_call asks for the exact 7 views at the snapshot block.
  - `venue.insuranceUsd` is `engineAtSignedPrice`'s value, with source `engine_signed_price`.
  - `markInsuranceEquityUsd` equals that value, not the stored-price view.
  - Fallbacks (eth_call null, update not taken, no newer price) sign the stored-price view.

## 3. update.sh runs the DB migrations

- **New root-owned lib** `deploy/server/db-migrate.sh`, function `db_migrate INFRA_ENV APP DB`:
  - The migration runs as `bookrunner`: `sudo --preserve-env=PGPASSWORD,DATABASE_URL -u bookrunner`, then
    `bun run --cwd packages/db migrate` in the app checkout.
  - `POSTGRES_PASSWORD` is parsed with `env-parse.sh`. The file is never sourced, and a duplicated key refuses it.
    Absent means the default `bookrunner`, as in `dev.ts`.
  - The password is passed only as `PGPASSWORD` in the environment. postgres.js reads it when `DATABASE_URL`
    (`postgres://bookrunner@127.0.0.1:54400/<db>`) has no password. So it never appears on argv or in a URL.
  - A failure returns 1 with a clear message: migrations FAILED on `<db>`, the stack was NOT restarted, and what to
    check.
- **In `update.sh`** (full update only):
  - after `systemctl reload bookrunner-infra`, a `pg_isready` wait (up to 60 s);
  - `db_migrate … bookrunner_testnet || exit 1`;
  - `bookrunner_testnet_live` too when that database exists;
  - then the restarts.
- **Tests:** `scripts/db-migrate.test.ts`, 9 tests. They run bash, like `env-file.test.ts`, with a recording stand-in
  for sudo:
  - argv, env and cwd;
  - no secret anywhere but `PGPASSWORD`;
  - a `$(touch …)` value is never executed;
  - default password;
  - duplicate refused;
  - failure message;
  - bad DB name;
  - static ordering in `update.sh`: reload < migrate < migrate live < restart, and never sourcing `.env.infra`.
- **Docs:** README and HARDENING updated.
- **Not run on a server** (no network writes): `sudo --preserve-env` as root is the same pattern `rehearsal-deploy.sh`
  already uses there.

## 4. Alerts: stop reading settled books

- **Settled** (`poolPositionSettled`): DB state Retired, position closed (`active` false) and claim 0. That position
  can no longer change.
- **How it works:**
  - `collect` asks the chain only for the other books.
  - It keeps settled positions in `Memory.poolSettled`, which is persisted with the dedupe state.
  - It re-injects them into `pool.books`, so every rule sees the same input. For example, the write-off notice still
    fires within its window.
- **Still read:**
  - a closed position that still owes (repayment retried);
  - a retired book whose final mark is stuck.
- **Old or malformed memory:** everything is read again.
- **Tests** in `rules-pool.test.ts`:
  - pass 1 reads [3, 6, 8, 9];
  - pass 2, after a JSON round trip, reads [3, 8, 9] and gives identical books and conditions;
  - old / malformed memory reads everything;
  - the predicate's cases.

## 5. Optional: stuck book in Live

Not small, so I wrote a design note in ARCHITECTURE §2.10 instead.

- **Why retiring alone does not help:** the committee can already `retire`, but `finalizeRetirement` needs a mark in
  Retiring with deployed value 0.
- **Proposal:** a timelocked governance mark, `MarkRegistry.commitGovernance`, allowed only once the last mark is older
  than a bounded `staleMarkDays`. It is applied through the unchanged `applyMark`.
- **Rejected:**
  - a forced write-down, because it would realise a loss on capital that may still come back;
  - excluding stale books from the epoch gate, because the grace already bounds the delay.
- It needs an owner decision and the re-audit.

## Checks (at HEAD, after the last source change)

| Check | Result |
|---|---|
| Full forge (`--cpus=2 --memory=3g`) | 129 suites, **1468 passed, 0 failed** |
| ci profile, `test/pool/*` | 4 suites, **79 passed, 0 failed** (7 pool invariants at 800 x 128) |
| Typecheck: 16 workspaces + scripts | 0 errors |
| Repo-wide `bun test` | **2301 pass, 82 skip, 0 fail** (227 files) |
| check-copy | passed (164 files) |
| licence-headers, image-pins, slither-gate tests | 14 pass |
| Slither gate (pinned image, local) | 78 findings, **0 outside the allowlist, 0 stale** |

## Concerns

1. **OrderlyAdapter is 24,552 B, 24 B under the EIP-170 limit.** Any further change to it needs bytecode savings first.
2. **m-6 direction.** The reviewer and the brief described the effect as "looser cap / provisional loss". It was
   neither: the cap was tighter (Senior was under-covered at that mark) and the pool's claim was unaffected. The fix
   removes it anyway. The docs say this.
3. **Residual window.** IF cash already swept back into the vault but not yet repaid still reads as a draw at a mark.
   That lasts until the keeper's next `fundClaims`, or while a repayment fails. It errs in the safe direction and is
   documented in §2.10. Fixing it would mean changing Book.
4. **Mixed sweeps.** A sweep clears the IF part first, so while both an IF and an MM recall are in flight and only the
   MM payout has landed, the IF part reads 0. That is safe and temporary. On Orderly the MM is normally recalled before
   the IF (the IF is locked while the symbol is listed).
5. **The migration step has not run on the real server.** It is covered by tests with a stand-in for sudo only.
