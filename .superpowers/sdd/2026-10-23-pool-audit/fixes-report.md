# Insurance Pool audit 2026-10-23: fixes report

Branch `pool-fixes` (worktree `.claude/worktrees/pool-fixes`), from `main` 3099919. Owner approval: "fix all". Mainnet
will be redeployed fresh, so no in-place upgrade compatibility was kept (notes at the end).

**Status: DONE_WITH_CONCERNS.** Every finding is fixed or, where noted, documented with a reason. The concerns are
owner decision points (section 2) and the pool's bytecode headroom (74 B).

**Fix round 2 (section 6): DONE.** The owner's rulings settle decision points 1 and 4. The headroom is restored
(InsurancePool now has 1,106 B).

Commits: `C1` = `1134733` (contracts, tests, vectors, ABI and the TS waterfall mirror); `C2` = `c419c19` (services and
web: charter rule, pool view); `C3` = the docs commit that carries this report.

## 1. Findings: fix, commit, regression test, status

| Finding | Fix | Commit | Regression test | Status |
|---|---|---|---|---|
| **B-H1** (a) repaid debt lifts the cover cap; (b) gains restore Senior's IF impairment before the Backstop | An explicit, persistent insurance ledger in Book storage (appended): `seniorIfImpairment`, `juniorIfLoss`, `coverHeld`, `ifDrawAtMark`, plus `poolValue` as a ledger value (`Waterfall.applyPoolMarkPnl`, TS mirror `applyPoolMarkPnl`, vectors `poolMark`). Cover is only `seniorImpairment − seniorIfImpairment`, whatever the claim. Gain order: the pool's shortfall (N2-2), then an IF recovery (Live only), then Senior's other impairment, the Backstop, Senior's IF impairment, Junior. `juniorIfLoss` makes Junior's IF losses stand in front of Senior's later other losses, so cover never exceeds the same book without the IF draw. | C1 | `B_PoolBookAudit.t.sol` `test_B_H1a_repaidDebt_neverLiftsTheCap`, `test_B_H1b_mmRoundTrip_backstopRepaidBeforeSeniorsIfImpairment`; `PoolBook.t.sol` `testFuzz_N1_cumulative_backstopNeverPaysMoreThanWithoutTheIfDraws` (4,096 runs under ci, plus 20,000 runs with another seed); `WaterfallParity.t.sol` `test_parity_poolMark` | Fixed |
| **B-M1** unfunded settled redemptions count as own capital, so Backstop cover reaches the pool | Own capital excludes settled-but-unfunded redemption cash, a Backstop repayment owed and `coverHeld`. A due repayment is capped at idle minus all three (`_repayPoolDue`); settled exits rank ahead of the pool's provisional claim. A loss other than an IF draw consumes the cover first; an IF draw never consumes it. | C1 | `test_B_M1_unfundedRedemptionAndCover_neverRepayThePool` | Fixed |
| **B-M2** no minimum tranche capital for a pool book | `InsurancePool.minOwnCapitalBps` (timelocked, default 5000, ≤ 20000). `Waterfall.poolCapitalOk` is checked by MarketCharter at filing (`UNDERCAPITALISED`, against the MM inventory) and by `closeWindow` (against the raise). TS mirror in `@bookrunner/shared` `poolCharterReason`, the charter service (which reads the pool's value), the api and the web form. **Why 50%:** the tranches stand in front of at least half of a full IF drain, so the pool's loss on a drained book is at most half its allocation. Under the 30% market cap that is at most 15% of the pool per market, before the slice. Every launch charter passes. | C1, C2 | `test_B_M2_undercapitalisedPoolBook_cancelled`, `test_B_M2_atTheMinimumOwnCapital_poolFunds`; `MarketCharter.t.sol` `test_validate_poolMinimumOwnCapital`; TS: `insurance-pool.test.ts`, `services/charter` and `apps/web` `charterForm` tests | Fixed |
| **B-L1** finalize revalues on live idle, so cash is counted twice | `_closeInsurance` repays the ledger's claim; it never revalues from idle. Fee flow credited since the last mark has already restored the claim (B-L2). | C1 | `test_B_L1_feeBetweenLastMarkAndFinalize_countedOnce` | Fixed |
| **B-L2** an exhausted book's fee residual is booked as a Backstop repayment | `Waterfall.applyPoolDistribution` (TS mirror, vectors `poolCredit`): while the pool has a shortfall, the credit restores the claim first (`InsuranceRestored`). The rest follows the ledger's gain order. | C1 | `test_B_L2_exhaustedBook_feeRestoresThePool_seniorKeepsItsCover` | Fixed |
| **B-L3** `backstopDebt` is not scaled on Senior burns or top-ups | `coverHeld` (the cover Senior holds) scales on every Senior burn, together with `seniorImpairment` and `seniorIfImpairment`. `backstopDebt` stays owed from later gains. A top-up never counts as cover. Junior burns scale `juniorIfLoss`. | C1 | `test_B_L3_coverScaledOnSeniorBurns` | Fixed |
| **B-L4** held marks satisfy the epoch gate | `markBook(..., held)`: a held mark moves the claim but does not stamp `lastMarkAt`. | C1 | `test_heldMark_doesNotSatisfyThePoolEpochGate`, `test_heldMark_movesTheClaim_notFreshForTheGate` | Fixed |
| **A-M1** the first-loss slice is accounted per book | The slice is a pool-wide junior tranche: `depositorLoss` is the depositors' outstanding net loss. A recovery from any book, and a slice top-up, restore it first. Invariant: `depositorLoss == 0 \|\| firstLoss == 0`. The per-book split is now reporting only. | C1 | `PoolAuditA.t.sol` `test_A_M1_*` (4 tests); invariant `invariant_firstLossAbsorbsFirst`, extended with recoveries | Fixed |
| **A-M2** a depositor can dilute the slice and block every allocation | The gate covers the exposure: `firstLoss ≥ target × (claims + amount)`, and `maxAllocation` returns exactly the largest allocation that passes. A pool-funded `closeWindow` decides on the pool's views (never on a caught revert, which a caller could gas-starve). If the pool cannot fund the IF, the window is re-run the old way (`InsuranceFallback`) or the book is cancelled at once (`POOL_UNFUNDED`), so it never waits. A paused processing refunds queued deposits (A-L5). | C1 | `test_A_M2_queuedDilution_refundedOnPause_allocationGoesThrough`, `test_A_M2_dilutionMinted_blocksNoAllocation`, `test_A_M2_dustDeposit_blocksNothing`; `PoolBook.t.sol` `test_closeWindow_*` | Fixed |
| **A-L1** stale grace pricing | Past the grace, the fills value stale books at 0, the slice first (`haircut = max(0, staleClaims − firstLoss)`). Deposits keep the stale claim. | C1 | `test_staleProcessing_exitsPricedConservatively`, `test_freshProcessing_noHaircut` | Fixed |
| **A-L2** timelock (48 h) is shorter than the exit latency; one multisig holds every role | Documented in ARCHITECTURE §2.10 with a recommendation: a pool timelock of ≥ 9 days (14 days recommended) for upgrades and for the parameters that weaken protection, plus a guardian separate from the proposer. **Not implemented:** the pool has 74 B of headroom, and the fix belongs in deployment governance, not in pool code. | C3 | — | Documented |
| **A-L3** allocations and slice withdrawals ignore queued withdrawals | `_allocatable` and `withdrawFirstLoss` keep free cash ≥ buffer + the value of every queued withdrawal, due or not. The `WithdrawalsDue` check is removed (subsumed). | C1 | `test_allocate_neverTakesQueuedExitLiquidity`, `test_firstLoss_withdraw_onlyTimelock_keepsTarget_neverQueuedExitLiquidity`; new invariant `invariant_queuedExitsKeepTheirLiquidity` | Fixed |
| **A-L4** provisional shortfall: cohort transfer, last holder, stranding | Fixed: exits take their share of `depositorLoss` (a recovery restores only the holders left, the rest refills the slice). The dust test is `totalSupply() < 10**offset`, not `== 0`. Accepted and documented: entries during a shortfall buy the possible recovery and bear the possible write-off alike, bounded by epoch pricing. | C1 | `test_exitsTakeTheirPartOfTheDepositorLoss`; existing `test_premium_andRecovery_withNoDepositorsLeft_goToSlice` | Fixed / partly documented |
| **A-L5** no emergency brake on pricing | An epoch processed while deposits are paused mints nothing; its deposits are refunded by `claimDeposit` (`EpochDepositsRefunded`, `DepositCancelled`). Exits are unaffected. | C1 | `test_pausedProcessing_refundsQueuedDeposits_exitsNot` | Fixed |
| **A-L6** anyone can `claimDeposit` and start the owner's cooldown | Owner only. | C1 | `test_deposit_queued_mintedAtProcessing_startsCooldown` | Fixed |
| **A-I1** the cooldown starts at the epoch end | It now starts at the hand-over (`claimDeposit`). | C1 | same test (late claim) | Fixed |
| **A-I2** no zero-share refusal | An epoch whose deposits would mint 0 shares refunds them (same path as A-L5). | C1 | (shared branch with A-L5) | Fixed |
| **A-I3** ERC-4626 surface not compliant | `preview*` revert `QueuedOnly`. `convertTo*` and `max*` are documented as display only. | C1 | `test_previews_revert` | Fixed |
| **A-I4** live config pointers | Documented: never repoint the asset or the factory while a pool position is open. `market` canonicalisation is checked by the charter (`_underlyingOk`: canonical token or index id). | C3 | — | Documented |
| **A-I5 / A-I6 / A-I7** stuck book, premium JIT, cap and buffer only at allocation | Documented (§2.10). A-I5 is also bounded by the A-L1 haircut. | C3 | — | Documented |
| **A-I8** deployed unpaused, VerifyHandover gaps | VerifyHandover checks that the implementation's initializers are disabled (ERC-7201 Initializable slot) and that `minOwnCapitalBps == input`. With A-M2 fixed, an early deposit no longer blocks launch allocations, so the "pause until seeded" advice is no longer needed (RUNBOOK 13b updated). | C1, C3 | `DeployMainnet.t.sol` (full suite) | Fixed |
| **A-I9** invariant blind spots | New handler `firstLossWithdraw`. Recovery checks in `mark`. Global junior check (`depositorLoss == 0 \|\| firstLoss == 0`). Refund accounting in `invariant_valueConserved`. `invariant_queuedExitsKeepTheirLiquidity`. Dilution and stale pricing are covered by unit tests. | C1 | `InsurancePoolInvariant.t.sol` (8 invariants) | Fixed |
| **B-I1** OrderlyAdapter 24 B under EIP-170 | No adapter logic was needed: one NatSpec line was updated, and the bytecode is unchanged at **24,552 B (24 B headroom)**. | C1 | sizes | No change needed |
| **B-I2** IF equity is a signer-trust input | Documented: same trust as `deployedValueUsd`. An overstatement cannot make cover exceed the counterfactual of the signed path. An understatement only errs low for the Backstop. | C3 | — | Documented |
| **B-I3** pool identity between filing and close | Documented: rotate `config.insurancePool()` only with no window open. | C3 | — | Documented |
| **B-I4** liveness of the provisional loss | Documented (stuck-book note; the governance mark is still not implemented). | C3 | — | Documented |
| **B-I5** cover split within one mark | Decided: within a mark, Junior absorbs other losses before the IF draw (conservative). Across marks, `juniorIfLoss` gives the same answer. | C1 | `testFuzz_N1_*` | Fixed (owner decision recorded) |
| **B-I6** due ordering is path dependent | One order whatever made the debt due: settled tranche claims first (they are excluded from own capital), then the pool from own idle. | C1 | `test_B_M1_*`, `test_retirement_poolPaidBeforeTrancheClaims` | Fixed |
| **B-I7** premium after closure or write-off | Kept as accepted by the owner; documented. | C3 | — | Documented |

## 2. Decisions to confirm (owner)

1. **Recovery order (written down, ARCHITECTURE §2.5).** A gain goes to the pool's provisional shortfall first (N2-2: the debt is senior). While Live, a fall of the draw then reverses the IF losses (the pool, Senior's, Junior's). The rest goes to Senior's other impairment, then the Backstop, then Senior's IF impairment, then Junior. The Backstop's cash never reaches the pool. However, because the pool's shortfall comes first, an exhausted book's later gains can repay the Backstop **later** than on the same book without the IF draw. The fuzz property is therefore "never covers more", not "never repaid less". The alternative (the Backstop before the pool's shortfall) would let the pool lose more than the draw beyond the book's capital (POOL-9). Owner choice.
2. **Strict counterfactual.** The Backstop never covers more than on the same book whose IF was never drawn, in any path: `juniorIfLoss` also books what a gain gives to the pool or to Senior's IF impairment. This is the stricter reading of "cumulatively". The looser reading would cover any Senior loss once Junior is gone.
3. **The exposure-based first-loss gate (A-M2)** is looser than "10% of the pool" whenever the pool is not fully lent. That is intended: idle depositor cash carries no risk. The 10% now applies to the claims.
4. **The closeWindow fallback** turns a pool-funded charter into a tranche-funded book when the pool cannot fund it but the tranches raised the IF. The alternative is to cancel only. A sponsor who would rather wait loses that option: the window no longer waits.
5. **Residual conservative bias.** Once the debt is due, a draw that cannot be separated from a repayment (for example, IF cash used for settled exits before the pool) is read as an IF draw within a net loss, and it stays booked. The Backstop pays less, never more.

## 3. Sizes (runtime, EIP-170 24,576 B)

| Contract | Before | After | Headroom |
|---|---|---|---|
| InsurancePool | 24,052 | **24,502** | 74 (the `preview*` reverts and one conversion helper replacing OZ's rounding variants pay for the fixes) |
| BookLogic (linked library) | 18,673 | 23,845 | 731 |
| Book | 13,826 | 13,953 | 10,623 |
| MarketCharter | 13,105 | 13,411 | 11,165 |
| OrderlyAdapter | 24,552 | **24,552** | 24 (logic unchanged; one comment line) |

(`OrderlyAdapterV2` is a test mock that was already above the limit.)

## 4. Test evidence

- **RED (the PoCs on the fix).** The audit's PoCs, run unchanged on the fixed code before they were inverted, fail on their bug assertions. For example: `B_H1a` "the Backstop pays Senior's share of the IF draw: 0 != 2500000000"; `B_H1b` "Senior's IF impairment restored: 2500000000 != 0"; `B_M1` "the pool's claim stays whole: 0 != 25000000000"; `B_M2` "no IF_UNFUNDED / minimum raise: 1 != 2"; `B_L1` "6920000000 != 7920000000"; `B_L2` "Senior ends below its cover: 52500000000 != 49332000000"; `A_M1` "slice fully restored: 0 != 10000000000"; `A_M2` "0.00001 USDG blocks every allocation: 30000000003 != 0". They held on 3099919, the auditors' runs. They are now inverted regression tests (`contracts/test/audit/pool2026/`, 7 A + 10 B tests, all green).
- **The fuzz found two real gaps during the work, both fixed.** First, an IF draw offset by an MM gain in the same mark. Second, a gain that restores the pool's shortfall or Senior's IF impairment. Both are now booked to `juniorIfLoss`.
- **GREEN.** Full forge suite: 131 suites, 1,497/1,497 pass. `FOUNDRY_PROFILE=ci` on `test/pool/*` and `test/audit/pool2026/*`: 105/105 pass (invariants at 800 × 128). Repo-wide `bun test`: 2,337 pass, 82 skip, 0 fail. All typechecks pass (`bun run typecheck`, `typecheck:scripts`). check-copy passes (165 files). licence-headers and image-pins tests pass. The Slither gate (pinned image 0.11.6) reports 0 findings outside the allowlist; three intended-zero locals were added with reasons.

## 5. Notes for a future in-place upgrade (not needed: mainnet is redeployed)

- **Book storage.** It is appended (ERC-7201, append-only): `seniorIfImpairment`, `juniorIfLoss`, `coverHeld`, `ifDrawAtMark`. A live pool book upgraded in place would start them at 0, so a migration must set `coverHeld = min(backstopDebt, S)`, `ifDrawAtMark = max(0, debt − IF equity)` and the IF impairment from the last mark.
- **Pool storage.** It is appended: `depositorLoss`, `refundsPending`, `minOwnCapitalBps`. A migration must set `depositorLoss = Σ lossDepositors` and `minOwnCapitalBps = 5000`.
- **`IInsurancePool.markBook` gained `held`.** Book and pool must be upgraded together.
- **`BookPosition` is unchanged**, so the ABI for indexers stays the same. Removed: `DUE_SCAN_EPOCHS`, `WithdrawalsDue`, `Book.InsurancePoolUnset`. Added: `insuranceLedger()`, `depositorLoss()`, `refundsPending()`, `minOwnCapitalBps()`, events `InsuranceRestored`, `InsuranceFallback` and `EpochDepositsRefunded`. ABIs are regenerated (`packages/shared/src/abi`).

## 6. Fix round 2 (the verification audits: audit-A-verify.md, audit-B-verify.md)

Commits: `C4` = `ffa9f58` (contracts, tests, vectors, ABI, the TS mirror, the Slither allowlist); `C5` = `b0d936b`
(services and web); `C6` = the docs commit that carries this section. The auditors' new PoCs (`PoolAuditAVerify.t.sol`,
`B_VerifyFixes.t.sol`) passed on `ec6cf2c`, which demonstrated the problems. They failed on the fixed code (RED) and
are now inverted into regressions.

| Finding | Fix | Commit | Regression test | Status |
|---|---|---|---|---|
| **V-1** an exhausted book's recovery restores the pool before the Backstop, and Senior's share of the IF draw is never charged | Owner ruling: on an exhausted book (`poolValue < poolDebt`), a gain or a distribution repays the Backstop first, then the pool, then Senior's other impairment, Senior's IF impairment, then Junior. A book that is not exhausted keeps the B-H1 order. New ledger field `seniorIfDeferred`: the pool's shortfall taken only because Senior held cover, that is Senior's share of the draw (capped at the shortfall). It is charged to Senior's own capital, restoring the pool, as soon as a gain or a distribution frees that capital after the Backstop is repaid (`_chargeDeferred`, `seniorIfCharged`). It scales on Senior burns, blocks Senior top-ups while owed, and is settled at finalize. TS mirror and vectors (`poolMark` width 41, `poolCredit` width 23). | C4 | `B_VerifyFixes.t.sol` `test_B_V1_exhaustedThenRecovery_backstopFirst_seniorChargedItsIfShare` (Backstop whole, Senior 50k, pool whole). `B_PoolBookAudit.t.sol` `test_B_L2_exhaustedBook_feeRepaysTheBackstop_thenThePool`. The cumulative fuzz in `PoolBook.t.sol` now adds wind-down IF draws and checks the Backstop's **net recovery**, the cover and Senior against the never-drawn counterfactual: 20,000 runs (4,096 under ci), ledger invariants at every step (deferred ≤ shortfall; Junior 0 while short). TS: `waterfall.test.ts` "V-1" and "B-L2 / V-1". | Fixed |
| **V-2** an IF draw in the same mark as a larger MM gain is netted away, so the Backstop is under-repaid | The draw is exact in every state: `Waterfall.poolIfDraw` = IF deployed − IF cash returned to the vault − min(signed IF equity, deployed). The returned cash comes from the adapters' cumulative `insuranceReturnedUsd()` (`IInsuranceReturns`): OrderlyAdapter counts it in `sweepToVault`, PoolEngineAdapter on the IF withdraw. Repayments and recalls never move the draw, so the "due" branch is gone. A mark splits in the ledger order whatever the signs: IF recovery, then other P&L, then the IF draw. | C4 | `test_B_V2_dueBranch_ifDrawInsideNetGain_charged_backstopRepaid` (Backstop repaid 7.5k; Junior and Senior each charged 2.5k). TS `poolIfDraw` and "V-2" tests. `WaterfallParity` `test_parity_poolMark`. | Fixed |
| **V-3** a queued withdrawal just before closeWindow silently switches a pool-funded charter to a tranche-funded one | No silent switch. While the pool cannot fund (`POOL_UNFUNDED`), `closeWindow` reverts `InsurancePoolCannotFund(retryUntil)` until `subscriptionEnds + CLOSE_WINDOW_TIMEOUT`. `cancelStuckWindow` refuses while a close would succeed (`windowCanClose`), until twice the timeout, so the first caller cannot pick the outcome. Then, or at once for `UNDERCAPITALISED`, the book is cancelled and refunded 1:1, unless the charter opted in with the new field `Charter.ifPoolFallback` (default false; `BAD_FALLBACK` on a book-funded IF). The field is mirrored in `@bookrunner/shared` (`poolCharterReason`, `charterArg`), the charter service (validate, draft, JSON, prepare, rule checks, jury prompt), the api, and the web form (checkbox, review row, CharterTerms). | C4, C5 | `test_B_V3_queuedWithdrawal_waits_thenCancels_noSilentSwitch`. `PoolBook.t.sol` `test_closeWindow_poolCannotFund_waits_thenCancels`, `_thenHasRoom_poolFunds`, `_optedInFallback_afterTheTimeout`, `_cancelStuckWindow_cannotPreemptAPoolFundedClose`, `_poolAllocationsPaused_waits`. TS: shared, charter, api and web tests. | Fixed |
| **Info 4** redemptions can take a pool book below the minimum own capital | Exits are never blocked. `Book.capitalShort()` is true for a Live pool book whose own capital (S + J − coverHeld) is below `poolMinCapitalBps` of the debt (the minimum is snapshotted at closeWindow). Risk then holds the book `reduce_only`, the agent goes reduce-only (`POOL_CAPITAL_SHORT`), and the alert `pool_book_capital_short` fires (warning, after 5 min), until the capital is back above the minimum. | C4, C5 | `PoolBook.t.sol` `test_capitalShort_redemptionsBelowTheMinimum_flagged_exitsNotBlocked`. `services/risk` `classify.test.ts`, `bookrunner-agent` `sides-mode.test.ts`, `alerts` `rules-pool.test.ts`. | Fixed |
| **NEW-1 (High)** held marks through the grace value the books at 0, so a 45k exit gets 25k | A stale processing never prices at a stale value. Let exposure = stale claims − slice. Exits fill only `shares × (D − exposure)/D` per epoch, at the normal price; the rest stays queued and exposed. Deposits are deferred, not minted (`depositEpoch` cursor; `claimDeposit` reverts `EpochNotProcessed`). **Bound:** past `STALE_BOUND` = 30 days after the epoch end, the rest fills at the last values with a 50% haircut on the exposure, and deferred deposits are refunded. **Why 30 days:** it equals `BookLogic.MAX_HELD_DEFERRAL`, so a book that is merely held has marked by then; a book still silent later is stuck. **Why 50%:** a stuck book's value is unknown within [0, claim]; the midpoint caps the worst-case transfer between exits and the holders left at half the exposure. Refunding the deposits keeps new entries out of that bet. | C4 | `PoolAuditAVerify.t.sol` `test_verify_NEW1_heldMarksOverTheEpochEnd_noValueMoves` (Alice/Bob: Alice gets 25k at the grace and the rest after the live mark, 45k in all; Bob stays at 45k), `_control_liveMarks_exitWhole`. `InsurancePool.t.sol` `test_staleProcessing_fillsOnlyTheFreshPart_restAfterTheMark`, `test_staleProcessing_pastTheBound_haircutFill_depositRefunded`. | Fixed |
| **NEW-2** the 20% buffer counts queued exits, so depositing and then queueing the exit shrinks the room at no risk | Buffer = 20% × (T − queued) + queued, in `_allocatable`, `checkAllocation` and `withdrawFirstLoss` (`PoolLogic._keep`). | C4 | `test_verify_NEW2_depositAndQueueExit_doesNotShrinkAllocatable` (room not reduced; Carol exits whole); `InsurancePool.t.sol` `test_allocate_neverTakesQueuedExitLiquidity` and the withdrawFirstLoss test. | Fixed |
| **NEW-3** a small slice funds one large book | Implemented (small and sound). The slice must also cover `CONCENTRATION_BPS` = 25% of the largest single allocation, so a 10k slice funds at most a 40k book. A full write-down of that book then puts at most 75% of it on the depositors. With the 50% minimum own capital in front of the IF, the slice absorbs at least half of the pool's worst single-book loss. The launch seed (91,671) covers single IFs up to about 366k. | C4 | `test_verify_AM2_smallSlice_capsTheLargestSingleBook` (max 40k; 100k reverts `FirstLossBelowTarget(10k, 25k)`; after a full write-down the depositors bear 30k); `InsurancePool.t.sol` `test_allocate_needsFirstLossAtTarget`. | Fixed |
| **A-L4 PARTIAL** value moves between holder cohorts during a provisional shortfall | Justified, not changed further. Per-cohort tracking is impossible with fungible shares: a share bought after the loss cannot be told apart from one held through it. The residual is bounded instead: entries are priced at the marked value (POOL-10), a stale epoch never mints at a stale value (NEW-1), and exits scale `depositorLoss` pro rata. Documented in ARCHITECTURE §2.10. | C6 | Bounded by the NEW-1 tests and `test_exitsTakeTheirPartOfTheDepositorLoss`. | Justified |

### Sizes after round 2 (runtime, EIP-170 24,576 B)

Room was made first with two new external libraries, which took custom errors and view helpers with them:
- `PoolLogic`, linked into InsurancePool: allocation, first-loss and mark logic, parameters;
- `BookPoolLogic`, linked into BookLogic: the pool-book logic.

| Contract | Round 1 | Round 2 | Headroom |
|---|---|---|---|
| InsurancePool | 24,502 | **23,470** | 1,106 |
| PoolLogic (new library) | — | 4,929 | 19,647 |
| BookLogic (library) | 23,845 | **19,480** | 5,096 |
| BookPoolLogic (new library) | — | 11,893 | 12,683 |
| Book | 13,953 | 14,388 | 10,188 |
| MarketCharter | 13,411 | 13,568 | 11,008 |
| OrderlyAdapter | 24,552 | **24,143** | 433 (`_bindBook` decodes only the charter words it needs, so the new counter fits) |
| PoolEngineAdapter | — | 14,510 | 10,066 |

### Test evidence (round 2)

- **Full forge suite:** 133 suites, 1,509/1,509 pass.
- **`FOUNDRY_PROFILE=ci`** on `test/pool/*` and `test/audit/pool2026/*`: 117/117 pass. This includes the 8 pool invariants and the cumulative fuzz at 4,096 runs; the fuzz also passed 20,000 runs under the default profile.
- **Repo-wide `bun test`:** 2,349 pass, 82 skip, 0 fail.
- **Typechecks** (`bun run typecheck`, `typecheck:scripts`) pass.
- **Repo checks:** check-copy passes (165 files). The licence-headers, image-pins and slither-gate tests pass.
- **Slither gate** (pinned 0.11.6, after a clean rebuild): 80 findings, 0 outside the allowlist, 0 stale. Two `unused-return` entries were added with reasons, and three stale `uninitialized-local` entries were removed.
- **Parity vectors:** regenerating them reproduces `waterfall.json` byte for byte.

### Notes for a future in-place upgrade (round 2 additions)

- **Book storage (appended):** `seniorIfDeferred` and `poolMinCapitalBps`. A migration sets `poolMinCapitalBps` from the pool, and sets `seniorIfDeferred` to Senior's share of a live shortfall (`min(shortfall, coverHeld)`) or 0.
- **Pool storage (appended):** `depositEpoch`. A migration sets it to `procEpoch`.
- **Charter struct:** `ifPoolFallback` shares the `premiumBps` slot, so stored charters read false.
- **Adapters:** `insuranceReturnedUsd` is appended and starts at 0. A pool book upgraded mid-life needs its adapter upgraded together with BookPoolLogic, with the counter seeded with the IF cash already returned. Otherwise that cash reads as a draw: conservative for the Backstop, but it charges the tranches.
- **Libraries:** InsurancePool now links PoolLogic, and BookLogic links BookPoolLogic. The deployment must deploy and link both (forge links them automatically; `DeployMainnet.t.sol` passes).
