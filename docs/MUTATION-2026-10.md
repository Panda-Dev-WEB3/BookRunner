# Mutation testing, October 2026

The audit's testing score noted that the core contracts had no mutation testing (register row C-3). This file records
a mutation pass on Tranche, BookLogic, MMMandate and PoolEngine (audit remediation Task 7c, 2026-10-19). For each
contract it gives the score, the tests added to kill the survivors that matter, and the survivors accepted with a
reason.

## Tooling

**Tools considered.**
- Gambit (Certora) and vertigo-rs were not needed: the pinned Foundry image (`scripts/forge.sh`, forge 1.8.1) ships
  `forge test --mutate`. Nothing was downloaded.
- The built-in tool runs, but it is slow here. It copies the project and compiles it from scratch for every mutant,
  and its binary-operator mutator tries every operator against every other one. MMMandate gave 930 mutants, at
  about 3 mutants a minute on 12 cores, or 5 to 6 hours for one contract. It stays available as
  `MUTATION_ENGINE=forge bash scripts/mutation.sh <target>` for an exhaustive run.

**What ran instead** (`scripts/mutation.sh`, `scripts/mutation-gen.ts`, `scripts/mutation-run.sh`):
- **Workspace.** Each target runs in its own workspace, `contracts/cache/mutation-ws/<target>` (gitignored). It holds
  only the suites that exercise the target (`bash scripts/mutation.sh --list`) and the src and test files they import.
  This is the `--match-path` selection; nothing else is compiled or run.
- **Mutants.** `scripts/mutation-gen.ts` makes one meaningful mutant per site:
  - `cmp`: `<` and `<=`, `>` and `>=`, `==` and `!=` swapped;
  - `arith`: `+` and `-` swapped, `*` and `/` swapped, `+=` and `-=` swapped;
  - `logic`: `&&` and `||` swapped;
  - `not`: a negation removed;
  - `bool`: a boolean literal flipped;
  - `constant`: a constant plus one;
  - `guard`: `if (cond) revert` made `if (false) revert`;
  - `require`: `require(cond, ...)` made `require(true, ...)`;
  - `access`: an `onlyX` modifier removed;
  - `delete`: a state-writing statement deleted.

  Comments and strings are never mutated (`scripts/mutation-gen.test.ts`).
- **Execution.** Mutants run in the pinned Foundry container. The workspace is built once, then each mutant gets an
  incremental compile and `forge test --fail-fast`. Fuzz runs drop to 64 and invariant campaigns to 16 x 32, with no
  shrinking.
  - **killed**: a test fails;
  - **survived**: every test passes;
  - **timeout**: counted as killed;
  - **stillborn**: does not compile, so it is excluded.
- **Throttle.** On a developer machine the run is throttled by default: one container at a time,
  `FORGE_DOCKER_ARGS="--cpus=2 --memory=3g"` (passed through `scripts/forge.sh`), 2 workers, and one forge thread
  each.
- **Sampling.** `MUTATION_SAMPLE` defaults to 40 per contract and is reproducible (seed `20261019`). Every
  access-modifier mutant is kept. The rest are drawn by weighted random sampling without replacement
  (Efraimidis-Spirakis), so money, access-control and liveness lines come first:
  - guard and require: weight 4;
  - delete and arith: 3;
  - cmp: 2;
  - the others: 1.

  `MUTATION_IDS=1,2,3` re-tests chosen mutants, for example the survivors after new tests are added.
- **Score.** The score is killed (timeouts included) over killed plus survived. For a sample it comes with a Wilson
  95% interval. Because the sample is weighted toward guards and money lines, read that interval as the score of
  those lines; it is not an unbiased estimate for the whole file.
- **CI.** `.github/workflows/mutation.yml` (`workflow_dispatch` only) runs every generated mutant
  (`MUTATION_SAMPLE=0`), unthrottled, on a hosted runner.

## Runs

All runs used the same generator and seed.

- **MMMandate and Tranche: every mutant, before the throttle.** Run on 11 workers before the owner asked for a
  throttle; every generated mutant was tested.
- **Every contract: a throttled weighted sample of 40.** BookLogic and PoolEngine were sampled before their new kill
  tests, MMMandate and Tranche after theirs.
- **Every survivor, re-tested with the new tests in place** (`MUTATION_IDS`), throttled.

| Contract | Mutants (sites) | Run | Killed / valid | Score | With the new tests |
|---|---|---|---|---|---|
| MMMandate | 266 | all | 242 / 266 | 91.0% | 254 / 266 = 95.5%: the re-test of the 24 survivors kills the 12 listed below |
| MMMandate | 266 | sample of 40 (after) | 37 / 40 | 92.5% (Wilson 95%: 80.1-97.4%) | the 3 survivors are accepted below |
| Tranche | 304 | all | 263 / 304 | 86.5% | 276 / 304 = 90.8%: the re-test of the 41 survivors kills the 13 listed below |
| Tranche | 304 | sample of 40 (after) | 35 / 40 | 87.5% (73.9-94.5%) | the 5 survivors are accepted below |
| BookLogic | 210 | sample of 40 (before) | 36 / 40 | 90.0% (76.9-96.0%) | 37 / 40 = 92.5%: of the 4 survivors, #104 is killed (re-test) |
| PoolEngine | 468 | sample of 40 (before) | 36 / 40 | 90.0% (76.9-96.0%) | 37 / 40 = 92.5%: of the 4 survivors, #134 is killed (re-test) |

There are no stillborn mutants and no timeouts. Every access-modifier mutant is killed (Tranche 5, PoolEngine 10;
MMMandate and BookLogic have none: their access checks are guards, which are all killed in the samples). Every
guard mutant is killed except one in MMMandate (#254 below, now killed) and five in Tranche (three now killed; #75 is
unreachable and #132 redundant).

How to read the numbers:
- The full runs are exact for the generated mutant set.
- The sampled scores carry the Wilson interval above. With 40 mutants a contract's true score on the weighted
  population lies, with 95% confidence, within about 13 points below to 6 points above the measured rate.
- The weighting puts guard, require, delete and arithmetic sites first, so the samples measure the money, access and
  liveness lines more than the whole file.
- The two full runs and the two samples of the same contracts agree within their intervals:
  - MMMandate: full run 91.0% before the new tests, sample 92.5% after;
  - Tranche: full run 86.5% before, sample 87.5% after.

## Survivors and what was done

Mutant numbers are the generator's ids (`bun scripts/mutation-gen.ts gen <src> <dir>`, stable while the source is
unchanged). "Killed" names the new test.

### MMMandate (`src/MMMandate.sol`)

Killed by `contracts/test/mandate/MandateMutationKills.t.sol`:

| # | Line | Mutant | Test |
|---|---|---|---|
| 17 | 171 | `desk == 0 \|\| vault == 0 && adapter == 0` at initialize | `test_mut_init_eachMissingComponentRefused` |
| 84, 87 | 320, 321 | float cap `>` -> `>=`; sell `qty > held` -> `>=` | `test_mut_spot_exactFloatCapAndWholeHoldingAllowed` |
| 225, 228 | 640, 642 | naked-spot prior `exposure + before` -> `-`; `net > limit` -> `>=` | `test_mut_spot_nakedRuleUsesThePriorNetPosition` |
| 229, 230 | 645 | band edges `>=` -> `>`, `<=` -> `<` | `test_mut_band_edgesAreInBand` |
| 182, 202 | 521, 587 | key expiry `>` -> `>=` (revocation by anyone, `_requireActiveKey`) | `test_mut_key_lastSecondStillActive` |
| 152 | 457 | off-hours on an oracle read failure `true` -> `false` | `test_mut_offHours_unreadableOracleFailsSafe` |
| 254 | 687 | canonical-token high-bits guard removed | `test_mut_spot_assetWithHighBitsIsNotTheToken` |
| 259 | 702 | `_engineQuote` market id deleted | the mandate mock engine now answers only for the adapter's market id, so the existing reduce-only quote tests (`MMMandate.t.sol` `test_checkQuote_offHoursForbidsAddingRiskCapacity`) catch it |

Accepted:

| # | Line | Mutant | Reason |
|---|---|---|---|
| 109 | 379 | `me > 0 ? me : 0` -> `>=` | Equivalent: `me == 0` gives 0 both ways. |
| 140 | 438 | off-hours flatten `>` -> `>=` | Boundary of a no-new-risk rule. The mutant only refuses a flatten that leaves net risk unchanged, which is stricter, never looser. |
| 143 | 440 | `exposure < 0` -> `<= 0` | Equivalent: at exposure 0 the band is not enforced and a non-spot leg returns. |
| 144 | 440 | flatten `spot` flag `false` -> `true` | Equivalent: a sell of a long spot hedge against a short exposure under the threshold can never exceed the naked-spot limit (the net position stays within max(\|exposure\|, prior)). |
| 206 | 609 | `addsHedge` `>` -> `>=` | Boundary: a leg of equal size that crosses zero counts as adding hedge. That is stricter (refused while retiring, needs a fresh Orderly report). |
| 226 | 641 | `prior > limit` -> `>=` | Equivalent (equal values). |
| 239, 240, 244, 246 | 667, 668, 673, 674 | `_ratio` / `_dist` boundaries | Equivalent: each boundary case yields the same value either way. |
| 260, 264 | 704, 714 | unreadable engine read `ok = false` -> `true` | Near-equivalent: the live quote is then read as zero, so the reduce-only rule still refuses any quote with a positive max net exposure. Only a zero-exposure quote, which opens no risk, would pass. |

### Tranche (`src/Tranche.sol`)

Killed by `contracts/test/book/TrancheMutationKills.t.sol`:

| # | Line | Mutant | Test |
|---|---|---|---|
| 48 | 261 | `maxDeposit` `cap - used` -> `+` | `test_mut_maxDeposit_isTheRemainingCap` |
| 59 | 343 | `redemptionLiquidity` `bal - commitEscrow` -> `+` (commitments would pay claims) | `test_mut_redemptionLiquidity_excludesCommitments` |
| 57 | 334 | `maxWithdraw` uncapped | `test_mut_maxWithdraw_cappedToOneClaimCall` |
| 64 | 361 | `controllerBuckets` index after a partial claim | `test_mut_controllerBuckets_afterAPartialClaim` |
| 115, 117 | 475, 488 | zero receiver guard removed in `redeem`, `withdraw` | `test_mut_claims_refuseTheZeroReceiver` |
| 120 | 496 | `setOperator` returns false | `test_mut_setOperator_returnsTrue` |
| 91 | 405 | `claimCancelledRefund` `\|\|` -> `&&` | `test_mut_cancelledRefund_noopOnALiveRound` |
| 148 | 561 | top-up due `>=` -> `>` (a round ending on a mark boundary would be refunded a mark later) | `test_mut_topUp_endingOnAMarkBoundarySettlesThere` |
| 231 | 697 | `_pushControllerBucket` `>=` -> `>` (a second Retired request in the same epoch would be unclaimable) | `test_mut_retired_secondRequestInTheSameEpochIsClaimable` |
| 17, 20 | 186 | `BadConfig` guard removed / `\|\|` -> `&&` | `test_mut_initialize_refusesAConfigWithoutUsdc` |
| 300 | 828 | `_symbolString` `n < 32` -> `<=` | `test_mut_initialize_fullWidthSymbol` |

Accepted:

| # | Line | Mutant | Reason |
|---|---|---|---|
| 2, 3 | 57, 59 | `MAX_SETTLE_BUCKETS`, `MAX_CLAIM_BUCKETS` + 1 | Design bounds. The tests are written against the constant (`test_settle_boundedPerMark_continuesNextMark`, `test_claim_boundedPerCall_continues`), so they check the behaviour at whatever the bound is. |
| 6 | 67 | `MODE_ASSETS` 2 -> 3 | Equivalent: only compared for equality. |
| 47, 58, 145, 197 | 261, 343, 556, 643 | `>=` / `>` at an equality | Equivalent: the equal case gives the same value. |
| 75 | 381 | deposit `RoundNotSettled` guard removed | Unreachable: `openRound` requires the previous round settled, and `_settleAllocation` clears a settled round's commitment just before. |
| 132 | 527 | `settleWindow` `currentRound != 0` guard removed | Redundant: round 0 is settled whenever `currentRound != 0`, and the next check reverts. |
| 143, 146, 193, 195, 201, 203, 215, 240 | | `x > 0` -> `>= 0` before a mint, burn, transfer or escrow change | Zero-amount no-ops. |
| 147 | 561 | `r > 0` -> `>= 0` | Unreachable: round 0 is settled at the window, before any mark. |
| 199 | 644 | `c.shares = sharesMinted` deleted | Equivalent: the round is fully claimed and the field is never read again. |
| 205 | 656 | `price <= MAX_TOPUP_PRICE_WAD` -> `<` | Boundary of the A1-02 inflation guard: both sides are safe. |
| 259, 260 | 744 | unsettled bucket return flags | Equivalent: the claim loop stops at an unsettled bucket either way. |
| 268 | 764 | exact-value withdraw `<=` -> `<` | Near-equivalent: the same assets are paid; at most one share unit of zero-value dust stays claimable. |
| 276 | 793 | `avail >= needed` -> `>` | Equivalent: one extra `fundClaims` call. |
| 294-297 | 818 | the Junior sponsor hook's condition widened | Gas only: `Book.onJuniorRedeemRequested` ignores callers other than the Junior tranche, owners other than the sponsor and books that are not Live. |

### BookLogic (`src/libraries/BookLogic.sol`)

| # | Line | Mutant | Result |
|---|---|---|---|
| 104 | 261 | `fundClaims` backstop repayment `idle - funded` -> `+` (a partial repayment would be refused and stay wholly owed) | Killed: `contracts/test/book/BookLogicMutationKills.t.sol` `test_mut_fundClaims_partialBackstopRepaymentFromWhatIsLeft` |
| 2 | 37 | `RETIRED_SETTLE_INDEX` + 2 | Accepted, equivalent: either index is above every normal bucket. |
| 12 | 112 | `ifAmount > 0` -> `>=` | Accepted, unreachable: a charter always has a non-zero IF target, so `closeWindow` never deploys 0. |
| 140 | 344 | `pnl > 0` -> `>=` | Accepted, event only: `GainAllocated` with zero amounts on a zero-P&L mark. |

### PoolEngine (`src/PoolEngine.sol`)

| # | Line | Mutant | Result |
|---|---|---|---|
| 134 | 405 | `startCloseOut` no longer sets reduce-only | Killed: `contracts/test/engine/PoolEngineMutationKills.t.sol` `test_mut_startCloseOut_makesTheMarketReduceOnly` |
| 5, 457 | 34, 1296 | `abs`, max side at an equality | Accepted, equivalent. |
| 451 | 1279 | `LossBudgetBreached` at `loss == budget` | Accepted, boundary of the event only. New risk is refused on `loss > budget` (tested by `test_M3_lossBudget_*`); the mutant only emits the trace one unit early. |

## Reproduce

```bash
bash scripts/mutation.sh --list                                  # the suites per target
bash scripts/mutation.sh PoolEngine                              # throttled weighted sample of 40
MUTATION_SAMPLE=0 bash scripts/mutation.sh MMMandate             # every mutant
MUTATION_IDS=134,451 bash scripts/mutation.sh PoolEngine         # given mutants
MUTATION_ENGINE=forge FORGE_DOCKER_ARGS= MUTATION_JOBS=11 bash scripts/mutation.sh MMMandate  # forge --mutate, hours
```

The report (score per operator and the survivors, each with its mutated line) is written to
`contracts/cache/mutation-ws/<target>.md`.
