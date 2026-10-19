# Protocol invariants and the tests that check them

Each protocol invariant below is listed with the tests that check it. Stateful invariant suites (Foundry
`invariant_*`, a handler driving random call sequences) come first, then the fuzz and unit tests that pin the same
property at its boundaries. The [suite index](#suite-index) at the end lists every test file under `contracts/test`
with the invariants it covers.

Running them:

- `bash scripts/forge.sh test` runs the default profile: invariants at 128 runs x 64 depth, fuzz at 512 runs.
- `FOUNDRY_PROFILE=ci bash scripts/forge.sh test` runs the CI profile (`.github/workflows/ci.yml`): every invariant
  suite at 800 x 128 = 102,400 calls, fuzz at 4,096 runs. Suites with their own `forge-config` keep it
  (OrderlyInvariant 400 x 256, M3PoolEquityInvariant 800 x 128).
- Off-chain mirrors of on-chain rules are checked against the contracts by parity vectors (section
  [Off-chain parity](#off-chain-parity)).

Paths are relative to `contracts/test/`.

## Capital: Book, Tranche, UnderwritingVault, Waterfall

| ID | Invariant | Invariant suite | Key fuzz / unit tests |
|---|---|---|---|
| CAP-1 | Redemption is never gated by permission. `requestRedeem` and claims never revert for lack of permission (tranche pause, guardian pause, kill, Retiring, Retired); only `InsufficientLiquidity` may revert a claim. | `book/BookInvariant.t.sol` `invariant_redemptionNeverPermissionGated` | `book/Tranche.t.sol` `test_redemption_neverPermissionGated`, `test_claim_insufficientLiquidity_onlyRevertReason`; `book/Book.t.sol` `test_sponsorBelowSkin_onRedeem_neverGated`; `audit/ext2026/M1HeldMarkSettlement.t.sol` `test_M1_requestRedeem_unblockedDuringHold` |
| CAP-2 | Waterfall conservation at every mark: S + J == marked NAV + backstop cover - backstop repayment. | `book/BookInvariant.t.sol` `invariant_waterfallConservation` | `book/Waterfall.t.sol` `testFuzz_mark_lossOrdering`, `testFuzz_mark_gainOrdering`, `testFuzz_mark_backstopDebt`; `book/Book.t.sol` `test_mark_*` |
| CAP-3 | Book accounting identity: S + J + unfunded claims == vault idle + deployed (venue) value. | `book/BookInvariant.t.sol` `invariant_accountingIdentity` | `book/Book.t.sol` `test_markedNavPreview_netsUnfundedClaims`, `test_unfundedClaims_thenFundClaims` |
| CAP-4 | Claimable assets never exceed the tranche's redemption escrow plus its unfunded claims; the subscription escrow is always funded. | `book/BookInvariant.t.sol` `invariant_claimableCovered` | `book/Tranche.t.sol` `testFuzz_claimsNeverExceedBucket`; `book/Waterfall.t.sol` `testFuzz_sharePrice_neverOverpays` |
| CAP-5 | Tranche shares are only held by known parties or in escrow (no unaccounted supply). | `book/BookInvariant.t.sol` `invariant_supplyAccounted` | `book/Tranche.t.sol` `test_requestRedeem_emitsAndEscrows`, `test_redeem_and_withdraw_partial_FIFO` |
| CAP-6 | Marks and retirement are never blocked (backstop, kill or venue failures never stop `applyMark` / `finalizeRetirement`). | `book/BookInvariant.t.sol` `invariant_marksNeverBlocked` | `book/Book.t.sol` `test_mark_backstopReverts_markStillApplies`, `test_mark_killReverts_markStillApplies`; `book/BackstopRepayment.t.sol` `test_vaultCannotRepay_neverBlocksMarks_keepsReserved`; `core/MarkRegistryReplace.t.sol` |
| CAP-7 | Held marks (audit M-1) apply P&L but settle no redemption bucket and no top-up round, up to `MAX_HELD_DEFERRAL`; the first settling mark clears every due bucket. | `book/BookInvariant.t.sol` `invariant_heldMarksDeferSettlement` | `audit/ext2026/M1HeldMarkSettlement.t.sol` (all, incl. `testFuzz_M1_exitDuringHold_sharesGapProRata`, `test_M1_longHold_settlesAfterMaxDeferral`); `integration/LowGasMark.t.sol` `test_atomicMark_heldMark_defersSettlement_endToEnd` |
| CAP-8 | Loss order: Junior absorbs losses first, then Senior (impairment), then the backstop covers Senior; gains restore Senior impairment, then repay backstop debt, then go to Junior. | `book/BookInvariant.t.sol` (CAP-2 under random marks) | `book/Waterfall.t.sol` `testFuzz_mark_lossOrdering`, `testFuzz_mark_gainOrdering`; `book/Book.t.sol` `test_mark_loss_juniorFirst`, `test_mark_gain_restoresSeniorFirst_thenJunior`; `book/BackstopRepayment.t.sol`; `audit/area5/Area5BackstopSubsidy.t.sol` |
| CAP-9 | Fee flow follows the same order (audit L-1): the Junior residual of a distribution restores Senior impairment, then repays the backstop, then goes to Junior. | `core/FeeFlowInvariant.t.sol` (FEE-1, FEE-2) | `audit/ext2026/L1FeeFlowSeniorFirst.t.sol` `testFuzz_L1_conservationAndOrder` and PoCs |
| CAP-10 | Subscription window: allocations are bounded by commitments and caps; the sponsor skin rule cancels only when the sponsor's own commitment is short; Senior is capped by Junior. | — | `book/Waterfall.t.sol` `testFuzz_allocateWindow_*`, `testFuzz_juniorWindowAllocation_sumsBounded`, `testFuzz_walletAllocation_sumsBounded`; `book/Book.t.sol` `test_closeWindow_*`; `book/BookReviewFixes.t.sol` |
| CAP-11 | Drawdown kill fires once, at the mark that crosses `killAtDrawdownBps`. | — | `book/Waterfall.t.sol` `testFuzz_drawdownKill`; `book/Book.t.sol` `test_mark_drawdownKill_*` |
| CAP-12 | Capital leaves the vault only through the book's own flows (deploy, recall, fund desk, pay tranches); unfunded claim cash is reserved. | — | `book/UnderwritingVault.t.sol` (all); `audit/area1/CapitalCoreAudit.t.sol` |
| CAP-13 | A book upgrade keeps every piece of state, and incompatible clones / registries / layouts are refused before broadcast. | — | `book/UpgradeBookScript.t.sol`; `audit/ext2026/DUpgradeBookCompat.t.sol` |

## Pool engine (in-house venue)

| ID | Invariant | Invariant suite | Key fuzz / unit tests |
|---|---|---|---|
| ENG-1 | Conservation: the engine's USDC equals the sum of the per-market ledgers (pool cash, insurance, margins, fees). | `engine/PoolEngineInvariant.t.sol` `invariant_conservation`; `audit/ext2026/M3PoolEquityInvariant.t.sol` `invariant_conservation` | `engine/PoolEngine.t.sol` `test_trade_openLong_exactAccounting`, `test_liquidityAndInsurance_depositWithdraw` |
| ENG-2 | After every successful new-risk trade, the pool's net exposure is within `maxNetExposureUsd`. | `engine/PoolEngineInvariant.t.sol` `invariant_exposureCapAfterNewRisk` | `engine/PoolEngineFuzz.t.sol` `testFuzz_exposureCapHolds`; `engine/PoolEngineAdapter.t.sol` `testFuzz_poolExposureNeverAboveMaxInventory`; `engine/EngineCloseOut.t.sol` `test_inventoryCap_*` |
| ENG-3 | Market isolation: actions on one market (including ADL) never change another market. | `engine/PoolEngineInvariant.t.sol` `invariant_marketIsolation` | `engine/PoolEngine.t.sol` `test_liquidate_ADL_isolatedToMarket`, `test_regimes_otherMarketUnaffected` |
| ENG-4 | The O(1) aggregates (long / short size, margins, trader P&L minus funding) equal the per-position sums. | `engine/PoolEngineInvariant.t.sol` `invariant_aggregatesMatchPositions` | `engine/PoolEngine.t.sol` `test_poolEquity_aggregateMatchesPerPosition` |
| ENG-5 | At a constant oracle price, pool equity never falls and a colluding desk + traders coalition never extracts value; with every position closed, pool cash never falls (audit M-3 "missing invariant"). | `audit/ext2026/M3PoolEquityInvariant.t.sol` `invariant_poolEquityNeverFallsAtConstantPrice`, `invariant_coalitionNeverProfits`, `invariant_flatPoolCashNeverFalls` | `audit/ext2026/M3PoolDrainSkew.t.sol` `testFuzz_M3_engineQuoteStraddlesOracle`, `test_M3_maxAllowedSkew_roundTrips_poolNeverLoses`; `engine/PoolEngineFuzz.t.sol` `testFuzz_roundTripNeverProfits` |
| ENG-6 | Every engine quote straddles the oracle (mandate `maxSkewBps <= minQuoteWidthBps / 2`), and a per-period loss budget caps what the pool can lose to new risk. | ENG-5 suite | `audit/ext2026/M3PoolDrainSkew.t.sol` `test_M3_validateMandate_requiresSkewAtMostHalfWidth`, `test_M3_lossBudget_*` |
| ENG-7 | Fills round against the trader; entry prices and realised P&L are exact; initial margin is enforced; funding is zero-sum. | — | `engine/PoolEngineFuzz.t.sol` `testFuzz_fillPrice`, `testFuzz_averageEntryAndRealisedPnl`, `testFuzz_initialMarginEnforced`, `testFuzz_fundingZeroSum`, `testFuzz_liquidationAccounting`; `engine/PoolEngine.t.sol` `test_fillPrice_roundsAgainstTrader`, `test_trade_*`, `test_funding_*` |
| ENG-8 | Price regimes: held / stale prices block every trade, liquidations keep working; reduce-only blocks new risk only; new risk needs a price within `maxTradePriceAge` (15 s, capped on-chain). | — | `engine/PoolEngineFuzz.t.sol` `testFuzz_regimesBlockTrades`; `engine/EngineReviewRegressions.t.sol` `test_regression_newRiskNeedsRecentPrice`, `test_regression_oracleSandwich_traderCannotRelaySignedPrice`; `audit/area2/Area2EngineAudit.t.sol`; `engine/PoolEngine.t.sol` `test_offHours_*`, `test_stale_*`, `test_reduceOnly_blocksNewRiskOnly`; `engine/PoolEnginePull.t.sol`; `audit/ext2026/L2LatencyAndOldPrints.t.sol` `test_L2_maxTradePriceAge_cappedOnChain` |
| ENG-9 | Positions across a split: while an out-of-band multiplier change of the market's token is pending, the market is close-only; in the window every trade reverts until repriced (audit N-1). | — | `audit/ext2026/N1EngineSplit.t.sol` |
| ENG-10 | Wind-down: close-out is scheduled only by a retiring kill, reduce-only cannot be lifted while winding down, `forceClose` settles winners and losers at the oracle with bad debt to insurance. | — | `engine/EngineCloseOut.t.sol`; `engine/PoolEngineAdapter.t.sol` `test_setReduceOnly_cannotClearWhenKilledOrWindingDown`, `test_regression_retiringBookClosesOutPositionsAndFinalizes` |
| ENG-11 | Pool liquidity can only be withdrawn while the pool stays solvent for its open interest. | — | `engine/PoolEngine.t.sol` `test_withdrawLiquidity_solvencyCheck`, `test_withdrawLiquidity_staleWithExposureReverts`; `engine/PoolEngineAdapter.t.sol` `test_requestWithdraw_poolSolvencyEnforced` |

## Mandate, desk and hedging

| ID | Invariant | Invariant suite | Key fuzz / unit tests |
|---|---|---|---|
| MAN-1 | A revoked key, or any key after a kill, never executes (including revocation between validation and execution). | `mandate/MandateInvariant.t.sol` `invariant_revokedKeysNeverAct` | `mandate/MandateRedTeam.t.sol` `test_redteam_revocationRace_*`; `mandate/MMMandate.t.sol` `test_kill_byRiskRevokesAllKeysAndGoesReduceOnly` |
| MAN-2 | Keys are bounded; a killed mandate has no usable key on either side (mandate and desk mirror). | `mandate/MandateInvariant.t.sol` `invariant_keysBoundedAndKillRevokes` | `mandate/MMMandate.t.sol` `test_registerKey_maxActiveKeys`, `test_kill_*`, `test_remandate_clearsKillAndRequiresReRegistration` |
| MAN-3 | Every quote that reaches the engine is within the mandate (width, skew, inventory). | `mandate/MandateInvariant.t.sol` `invariant_quotesWithinMandate` | `mandate/MMMandate.t.sol` `test_checkQuote_*`; `mandate/MandateFuzz.t.sol` (parity with `packages/shared/src/mandate.ts`); `engine/EngineMandateIntegration.t.sol` |
| MAN-4 | Desk Stock Token inventory never exceeds the registry's `floatCapRaw`. | `mandate/MandateInvariant.t.sol` `invariant_floatCapNeverExceeded` | `mandate/MandateRedTeam.t.sol` `test_redteam_floatCaps`; `mandate/MMMandate.t.sol` `test_checkHedgeExecuted_floatCapOnBuysOnly` |
| MAN-5 | The desk's held-token set matches its balances (no untracked inventory, no stale entries). | `mandate/MandateInvariant.t.sol` `invariant_heldSetConsistent` | `mandate/BookrunnerDesk.t.sol` `test_hedge_sellAllRemovesHeldToken`, `test_hedge_maxHeldTokens` |
| MAN-6 | The hedge executor never retains balances or allowances between calls. | `mandate/MandateInvariant.t.sol` `invariant_executorHoldsNothing` | `mandate/HedgeExecutor.t.sol` `testFuzz_swap_neverRetainsFunds`, `test_swap_refundsUnspentInput_andResetsApproval`; `mandate/HedgeExecutorRoutes.t.sol` |
| MAN-7 | A key cannot administer, exceed limits or run untyped actions; RISK may only run reduce-only kinds. | — | `mandate/MandateRedTeam.t.sol` `test_redteam_escalation_*`; `mandate/BookrunnerDesk.t.sol` `test_execute_*`, `test_execute_noGenericCallSurface` |
| MAN-8 | Off-hours / stale prices block risk-adding paths and allow reducing ones; the RISK flatten is never blocked by a stale price; key swaps need a price within min(maxPriceAge, maxTradePriceAge) (audit lead "old prints"). | — | `mandate/MandateRedTeam.t.sol` `test_redteam_offHours_*`, `test_redteam_staleOracle_isOffHours_flattenStillWorks`; `mandate/MMMandate.t.sol` `test_offHours_*`; `mandate/BookrunnerDesk.t.sol` `test_flatten_byRiskAfterKill_evenWithStalePrice`; `audit/ext2026/L2LatencyAndOldPrints.t.sol` `test_lead_*` |
| MAN-9 | Stock Token value = qty x multiplier x per-share price, the multiplier applied exactly once; a split while the price is held is never valued at the new multiplier (audit M-2). | — | `mandate/StockTokenRegistry.t.sol` `testFuzz_valueMatchesFormula`, `test_redteam_multiplierAppliedExactlyOnce`; `mandate/StockTokenRegistryLiveMultiplier.t.sol` `testFuzz_appliedOnce`; `mandate/MandateRedTeam.t.sol` `test_redteam_multiplierDoubleApply_deskValuation`; `audit/ext2026/M2SplitHeldPrice.t.sol` |
| MAN-10 | Hedge rules: not borrowable (sells capped by holdings), spot never offsets a long venue position, band and leverage rules, allow-list proofs; a Retiring book only shrinks. | — | `mandate/MMMandate.t.sol` `test_checkHedge_*`; `mandate/MandateRedTeam.t.sol` `test_redteam_notBorrowable_*`, `test_redteam_allowList_*` |
| MAN-11 | RISK flatten slippage is bounded and the per-period key slippage budget counts losses only. | — | `mandate/DeskRiskControls.t.sol` |
| MAN-12 | Capital flows of the desk are blocked while a mark is pending (RISK exempt); `ReturnToVault` has a minimum, so a key cannot void marks by bumping `flowNonce`. | — | `mandate/BookrunnerDesk.t.sol` `test_capitalFlows_blockedWhileMarkPending_riskExempt`, `test_returnToVault_minimumUnlessWholeBalance`; `audit/area3/Area3KeyMarkGrief.t.sol` |
| MAN-13 | Account-abstraction gas: a key cannot drain the desk's EntryPoint deposit (op cost capped, prefund cumulative). | — | `mandate/BookrunnerDesk.t.sol` `test_validateUserOp_capsOpMaxCost`, `test_validateUserOp_prefundBudgetIsCumulative`; `audit/area3/Area3DeskGasDrain.t.sol` |
| MAN-14 | Operator tier bonds are released on the staking contract that holds the lock, even after a repoint. | — | `mandate/MMMandate.t.sol` `test_bondReleasedOnLockingStakingAfterRepoint`; `audit/area5/Area5MandateBondStaking.t.sol` |

## Oracle and marks

| ID | Invariant | Invariant suite | Key fuzz / unit tests |
|---|---|---|---|
| ORC-1 | Only a registered signer's EIP-712 price, under this chain and oracle domain, is stored; tampered, malleable, cross-domain or deregistered signatures revert. | — | `engine/AttestedOracle.t.sol` `testFuzz_push_unregisteredKeyAlwaysReverts`, `test_push_*`; `engine/AttestedOracleUpdate.t.sol` `testFuzz_update_neverAcceptsForeignSigner`, `test_update_wrongDomainReverts`, `test_update_tamperedPayloadReverts` |
| ORC-2 | `publishedAt` is monotonic per underlying: an entry that is not newer, or already stale on arrival, is skipped (never stored, never reverts). | — | `engine/AttestedOracle.t.sol` `testFuzz_monotonicPublishedAt`, `testFuzz_staleness`; `engine/AttestedOracleUpdate.t.sol` `testFuzz_update_storesOnlyNewerAndNotStale`, `test_update_replayIsNoop` |
| ORC-3 | Signer registration requires an allow-listed TEE measurement and the timelock. | — | `engine/AttestedOracleAttestation.t.sol` |
| MRK-1 | A mark is accepted only with a valid MARK_SIGNER signature over every field (including `held`), aligned, after the last period and not in the future; cross-registry replay fails. | — | `core/MarkRegistry.t.sol` `testFuzz_commit_onlyValidPeriods`, `test_hashMark_heldIsSigned`, `test_commit_*`; `core/MarkRegistryCommitAndApply.t.sol` `testFuzz_commitAndApply_sameAcceptanceAsCommit` |
| MRK-2 | `commitAndApply` is atomic: a bad price, venue report or mark reverts everything; a stale unapplied mark is replaceable, so a capital flow between commit and apply (or a front-run commit) never burns a period. | — | `core/MarkRegistryCommitAndApply.t.sol`; `core/MarkRegistryReplace.t.sol`; `integration/LowGasMark.t.sol` `test_atomicMark_*`; `audit/area2/Area2MarkAudit.t.sol`; `audit/area7/Area7CrossContract.t.sol` |
| MRK-3 | A mark applies only against the book's current `flowNonce`. | — | `book/Book.t.sol` `test_applyMark_staleAfterCapitalFlow_reverts`; `integration/LowGasMark.t.sol` `test_atomicMark_capitalFlowAfterSigning_revertsAndPeriodStaysOpen` |

## Orderly venue adapter

| ID | Invariant | Invariant suite | Key fuzz / unit tests |
|---|---|---|---|
| ORL-1 | USDC that reaches the adapter, vault, venue or router only ever moves among them (never to anyone else). | `orderly/OrderlyInvariant.t.sol` `invariant_usdcOnlyToVaultOrRouter` | `orderly/OrderlyAdapter.t.sol` `test_rescueToken_neverUsdc`, `test_sweep_*` |
| ORL-2 | No leakage: every USDC unit is held by the vault, the adapter, the venue or the router. | `orderly/OrderlyInvariant.t.sol` `invariant_noLeakage` | `orderly/OrderlyCycle.t.sol` |
| ORL-3 | Adapter bookkeeping (deposited, in transit, withdrawn) matches the actual token movements. | `orderly/OrderlyInvariant.t.sol` `invariant_flowAccountingMatchesTransfers` | `orderly/OrderlyAdapter.t.sol` `test_deposit_*`, `test_confirm_*`; `orderly/OrderlyWithdrawProtocol.t.sol` |
| ORL-4 | Builder fee sweeps never exceed what OPS_VENUE authorised (each authorisation within the cap, once per period). | `orderly/OrderlyInvariant.t.sol` `invariant_feeFlowBounded` | `orderly/OrderlyAdapter.t.sol` `testFuzz_sweepFees_neverExceedsCapOrDuplicates` |
| ORL-5 | Vault-only and role-gated entry points never succeed for anyone else. | `orderly/OrderlyInvariant.t.sol` `invariant_gatedEntryPointsNeverSucceedForOthers` | `orderly/OrderlyAdapter.t.sol` `testFuzz_gatedFunctionsRejectStrangers` |
| ORL-6 | Venue reports: signed by an OPS_VENUE holder for this adapter and chain, monotonic, never before the last flow, refused while a withdrawal is Requested; `reportSigned` has exactly `report`'s acceptance rules. | — | `orderly/OrderlyReportSigned.t.sol` `testFuzz_reportSigned_parityWithReport` and rejections; `audit/area3/Area3ReportSameSecond.t.sol` |
| ORL-7 | Orderly accounts: MM and IF account ids follow Orderly's derivation; IF payouts land on the per-book IF account and are pulled by the adapter; the adapter binds only an allowed settlement token and broker. | — | `orderly/OrderlyAccounts.t.sol`; `orderly/OrderlyLiveVault.t.sol`; `orderly/MockOrderlyVault.t.sol` |

## Fees, backstop and staking

| ID | Invariant | Invariant suite | Key fuzz / unit tests |
|---|---|---|---|
| FEE-1 | Every USDC unit in the fee flow is in exactly one place (router, fee router, backstop, vault, expense recipient, swap router). | `core/FeeFlowInvariant.t.sol` `invariant_usdcConserved` | `core/RevenueRouter.t.sol` `testFuzz_distribute_conservesUsdc`; `core/CoreFlow.t.sol` |
| FEE-2 | RevenueRouter: acknowledged but undistributed USDC is always held; each leg (expenses, carry, vault) goes where it should; one distribution per period. | `core/FeeFlowInvariant.t.sol` `invariant_routerAccounting` | `core/RevenueRouter.t.sol` `testFuzz_computeSplit_conservationAndOrder`, `test_distribute_oncePerPeriod`; `core/RevenueRouterParity.t.sol` |
| FEE-3 | Carry splits 50/50 between buyback and backstop (odd unit to the backstop); pending buyback is always held. | `core/FeeFlowInvariant.t.sol` `invariant_carrySplit` | `core/BkrnFeeRouter.t.sol` `testFuzz_notifyCarry_split`, `testFuzz_buybackConservation`, `test_notifyCarry_cannotDoubleCountPendingBuyback` |
| FEE-4 | Buybacks are bounded by an on-chain price reference, whatever the keeper passes. | — | `core/BkrnFeeRouter.t.sol` `test_executeBuyback_floorOverridesKeeperMin`, `test_executeBuyback_usesPinnedPoolFee`; `core/BkrnFeeRouterTwap.t.sol`; `core/UniswapV3Twap.t.sol`; `audit/area5/Area5BuybackKeeper.t.sol` |
| BST-1 | The backstop pays only what it holds (balance == deposits - cover), never more than the shortfall or `maxCoverBps`; cover is book debt repaid from later gains. | `core/FeeFlowInvariant.t.sol` `invariant_backstop` | `core/Backstop.t.sol` `testFuzz_cover_neverExceedsPoolOrShortfall`; `book/BackstopRepayment.t.sol` |
| STK-1 | Staking is solvent: it holds every staked token plus every unclaimed reward. | `core/BkrnStakingInvariant.t.sol` `invariant_solvent`; `core/FeeFlowInvariant.t.sol` `invariant_stakingSolvent` | `core/BkrnStaking.t.sol` `testFuzz_slashKeepsInvariant` |
| STK-2 | Staking accounting: sum of stakes == totalStaked; per account staked >= locked + pending; locks sum to locked; earning == staked - pending. | `core/BkrnStakingInvariant.t.sol` `invariant_accounting` | `core/BkrnStaking.t.sol` `test_lockedStakeCannotBeUnstaked`, `test_lock_excludesPendingUnstake` |
| STK-3 | Rewards owed never exceed rewards notified minus claimed; rewards stream over `rewardsDuration` (no just-in-time capture). | `core/BkrnStakingInvariant.t.sol` `invariant_rewardsBounded` | `core/BkrnStaking.t.sol` `testFuzz_rewardsProportional`, `test_rewards_*`; `audit/area5/Area5JitStaking.t.sol` |
| STK-4 | Slashed BKRN goes only to the slash recipient. | `core/BkrnStakingInvariant.t.sol` `invariant_slashRecipient` | `core/BkrnStaking.t.sol` `test_slash_*` |
| TOK-1 | BKRN supply is fixed at construction (80/10/5/5 split, no mint afterwards). | — | `core/BkrnToken.t.sol` |

## Governance, configuration and deployment

| ID | Invariant | Invariant suite | Key fuzz / unit tests |
|---|---|---|---|
| GOV-1 | The charter contract holds exactly the fees of Filed charters. | `gov/GovInvariant.t.sol` `invariant_feeEscrowMatchesFiledCharters` | `gov/MarketCharter.t.sol` `test_file_storesRecordPullsFeeLocksBond`, `test_decide_rejectRefundsFeeAndUnlocksBond`, `test_expire_*` |
| GOV-2 | USDC conservation across sponsors, escrow and the expense recipient. | `gov/GovInvariant.t.sol` `invariant_usdcConservation` | `gov/MarketCharter.t.sol` `testFuzz_file_feeAndBondFollowConfig` |
| GOV-3 | Sponsor bonds are locked exactly while a charter is Filed or Approved, and staking agrees; escrow contracts are pinned at filing. | `gov/GovInvariant.t.sol` `invariant_sponsorBondsTrackStatus` | `gov/MarketCharter.t.sol` `test_escrowPinnedAcrossConfigChanges`, `test_onRetired_*`, `test_closeCancelled_releasesBond` |
| GOV-4 | Books exist exactly for Approved charters, and decisions come only from this committee. | `gov/GovInvariant.t.sol` `invariant_booksMatchApprovals` | `gov/MarketCharter.t.sol` `test_decide_*`; `gov/BookFactory.t.sol` `test_create_*`; `gov/GovLifecycle.t.sol` |
| GOV-5 | Committee member bonds are backed 1:1 by staking locks. | `gov/GovInvariant.t.sol` `invariant_memberBondsBackedByLocks` | `gov/RiskCommittee.t.sol` `test_bond_*`, `test_releaseBond_onlyAfterReplacement`, `test_bondStakingPinnedAcrossConfigChange` |
| GOV-6 | Decision rule: jury approve + 2 approvals, jury reject needs 3 of 3, two rejections reject; replaced members' votes no longer count; the decision deadline is fixed at filing and committee state is keyed by charter address (audit D). | — | `gov/RiskCommittee.t.sol` `testFuzz_decisionRule`, `test_threshold_*`, `test_replacedMember*`; `gov/MarketCharter.t.sol` `testFuzz_expire_timing`; `audit/ext2026/DPrivilegedGov.t.sol`; `audit/area4/Area4Committee.t.sol` |
| CFG-1 | Every 48 h-gated power checks `config.timelock()`, which follows `DEFAULT_ADMIN_ROLE`; the guardian can pause but cannot lift a timelock pause. | — | `core/TimelockAdminCoupling.t.sol`; `audit/ext2026/DPrivilegedCore.t.sol` `test_D_*Pause*`; `core/BookrunnerConfig.t.sol` `test_setNewBooksPaused_*` |
| CFG-2 | Parameters stay in their bounds (no zero that bricks a function; `maxTradePriceAge` <= 15 s). | — | `core/BookrunnerConfig.t.sol` `test_setParam_rangeChecks`, `testFuzz_agentTierBond_monotonic`; `core/BookrunnerConfigLowGas.t.sol`; `audit/area4/Area4ConfigBounds.t.sol` |
| CFG-3 | A repointed Backstop / BkrnFeeRouter can migrate its whole balance to the replacement, and only then. | — | `audit/ext2026/DPrivilegedCore.t.sol` `test_D_*Migrate*`, `test_D_migrate_twice_andLateDonation` |
| CFG-4 | The book factory creates a book atomically, only for the charter contract, with locked implementations; an implementation change affects only future books. | — | `gov/BookFactory.t.sol` |
| DEP-1 | Mainnet deployment hands every role to the timelock / multisig and VerifyHandover flags any missing or extra holder. | — | `deploy/DeployMainnet.t.sol`; `audit/area4/Area4DeployHandover.t.sol` |
| DEP-2 | Venue deployments: the live venue binds only to an allowed token and broker; `venueMinIf[Orderly]` stays above Orderly's per-market IF requirement. | — | `deploy/DeployLiveVenue.t.sol`; `deploy/DeployVenueMinIf.t.sol` |

## Cross-contract

| ID | Invariant | Tests |
|---|---|---|
| XC-1 | One Orderly book on the real stack (config, factory, book, tranches, vault, mandate, router, desk, adapter, registry, backstop): no cross-contract path breaks CAP / ORL invariants. | `audit/area7/Area7CrossContract.t.sol` |
| XC-2 | Pull oracle end to end: every price-checked transaction carries the prices it needs, and stored-price readers still work after a permissionless `oracle.update`. | `engine/EnginePullIntegration.t.sol`; `mandate/DeskPullOracle.t.sol`; `engine/PoolEnginePull.t.sol`; `engine/PullOracleGas.t.sol` (gas evidence) |
| XC-3 | Kill, re-mandate and a fresh key re-open an engine market under the new terms; a re-mandate clamps the live quote at once. | `engine/EngineMandateIntegration.t.sol`; `mandate/MandateReviewRegressions.t.sol` `test_regression_remandateAppliesNewTermsToEngineAdapter`; `engine/EngineCloseOut.t.sol` `test_applyMandate_*` |

## Off-chain parity

The services re-implement some on-chain rules. Shared vectors keep them identical:

| Rule | Solidity side | TypeScript side |
|---|---|---|
| Waterfall (window, split, mark, credit) | `book/WaterfallParity.t.sol`, `core/RevenueRouterParity.t.sol` (vectors `contracts/test/vectors/waterfall.json`) | `packages/shared/test/waterfall.test.ts` |
| Mandate checks | `mandate/MandateFuzz.t.sol` (literal port) | `packages/shared/src/mandate.ts` |
| EIP-712 Mark / Price / VenueReport | `core/MarkRegistry.t.sol` `test_markStructHash_parityVector`, `engine/AttestedOracle.t.sol` `test_typehash_matchesSharedEip712`, `orderly/OrderlyReportSigned.t.sol` `test_typehash_matchesLowGasSpec` | `packages/shared/test/eip712.test.ts` |
| Multiplier applied once | `mandate/StockTokenRegistryLiveMultiplier.t.sol` `test_vector_*` | `packages/shared/test/stock-tokens.test.ts` |
| Allow-list Merkle leaves | `mandate/MandateRedTeam.t.sol` `test_redteam_allowList_*` | `packages/shared/src/merkle.ts` |

Service-side invariants that do not live on-chain (the agent never quotes on an unsigned Redis price, only a
RISK-signed kill order halts an agent or revokes a venue key, risk never breaches on an unsigned agent quote, alert
hysteresis) are tested in `services/*/test` and described in `SECURITY.md`.

## Suite index

Every test file under `contracts/test`, with the invariants above it covers. Helper files (`*/utils/*`, `mocks/*`,
`orderly/utils/*`) are fixtures and handlers, not suites.

| Suite | Kind | Covers |
|---|---|---|
| `audit/area1/CapitalCoreAudit.t.sol` | audit PoCs (fail on the audited code) | CAP-4, CAP-8, CAP-10 |
| `audit/area2/Area2EngineAudit.t.sol` | audit PoCs | ENG-8 |
| `audit/area2/Area2MarkAudit.t.sol` | audit PoC | MRK-2 |
| `audit/area3/Area3DeskGasDrain.t.sol` | audit PoC | MAN-13 |
| `audit/area3/Area3KeyMarkGrief.t.sol` | audit PoC | MAN-12, MRK-2 |
| `audit/area3/Area3ReportSameSecond.t.sol` | audit PoCs | ORL-6 |
| `audit/area4/Area4Committee.t.sol` | audit PoCs | GOV-5, GOV-6 |
| `audit/area4/Area4ConfigBounds.t.sol` | audit PoCs | CFG-2 |
| `audit/area4/Area4DeployHandover.t.sol` | audit PoCs | DEP-1 |
| `audit/area5/Area5BackstopSubsidy.t.sol` | audit PoC | CAP-8, BST-1 |
| `audit/area5/Area5BuybackKeeper.t.sol` | audit PoCs | FEE-4 |
| `audit/area5/Area5JitStaking.t.sol` | audit PoCs | STK-3 |
| `audit/area5/Area5MandateBondStaking.t.sol` | audit PoC | MAN-14 |
| `audit/area7/Area7CrossContract.t.sol` | cross-contract PoCs | XC-1, MAN-12, MRK-2 |
| `audit/ext2026/DPrivilegedCore.t.sol` | audit 2026-10 D | CFG-1, CFG-3 |
| `audit/ext2026/DPrivilegedGov.t.sol` | audit 2026-10 D | GOV-6 |
| `audit/ext2026/DUpgradeBookCompat.t.sol` | audit 2026-10 D | CAP-13 |
| `audit/ext2026/L1FeeFlowSeniorFirst.t.sol` | audit 2026-10 L-1 (fuzz) | CAP-9 |
| `audit/ext2026/L2LatencyAndOldPrints.t.sol` | audit 2026-10 L-2, lead "old prints" | ENG-8, MAN-8 |
| `audit/ext2026/M1HeldMarkSettlement.t.sol` | audit 2026-10 M-1 (fuzz) | CAP-7, CAP-1 |
| `audit/ext2026/M2SplitHeldPrice.t.sol` | audit 2026-10 M-2 | MAN-9 |
| `audit/ext2026/M3PoolDrainSkew.t.sol` | audit 2026-10 M-3 (fuzz) | ENG-5, ENG-6 |
| `audit/ext2026/M3PoolEquityInvariant.t.sol` | **invariant** (4) | ENG-5, ENG-1 |
| `audit/ext2026/N1EngineSplit.t.sol` | audit remediation N-1 | ENG-9 |
| `book/BackstopRepayment.t.sol` | unit | BST-1, CAP-8, CAP-6 |
| `book/Book.t.sol` | unit | CAP-1..CAP-3, CAP-6, CAP-8, CAP-10, CAP-11, MRK-3 |
| `book/BookInvariant.t.sol` | **invariant** (7) | CAP-1..CAP-7 |
| `book/BookReviewFixes.t.sol` | review regressions | CAP-8, CAP-10, CAP-11 |
| `book/Tranche.t.sol` | unit + fuzz | CAP-1, CAP-4, CAP-5 |
| `book/UnderwritingVault.t.sol` | unit | CAP-12 |
| `book/UpgradeBookScript.t.sol` | script rehearsal | CAP-13 |
| `book/Waterfall.t.sol` | fuzz | CAP-2, CAP-4, CAP-8, CAP-10, CAP-11 |
| `book/WaterfallParity.t.sol` | parity vectors | off-chain parity |
| `core/Backstop.t.sol` | unit + fuzz | BST-1 |
| `core/BkrnFeeRouter.t.sol` | unit + fuzz | FEE-3, FEE-4 |
| `core/BkrnFeeRouterTwap.t.sol` | unit | FEE-4 |
| `core/BkrnStaking.t.sol` | unit + fuzz | STK-1..STK-4 |
| `core/BkrnStakingInvariant.t.sol` | **invariant** (4) | STK-1..STK-4 |
| `core/BkrnToken.t.sol` | unit + fuzz | TOK-1 |
| `core/BookrunnerConfig.t.sol` | unit + fuzz | CFG-1, CFG-2 |
| `core/BookrunnerConfigLowGas.t.sol` | unit | CFG-2, ENG-8 |
| `core/CoreFlow.t.sol` | end to end | FEE-1, BST-1, MRK-1 |
| `core/FeeFlowInvariant.t.sol` | **invariant** (5) | FEE-1..FEE-3, BST-1, STK-1 |
| `core/MarkRegistry.t.sol` | unit + fuzz | MRK-1, off-chain parity |
| `core/MarkRegistryCommitAndApply.t.sol` | unit + fuzz | MRK-1, MRK-2 |
| `core/MarkRegistryReplace.t.sol` | review regressions | MRK-2, CAP-6 |
| `core/MockSwapRouter.t.sol` | test double | (fixture correctness) |
| `core/RevenueRouter.t.sol` | unit + fuzz | FEE-1, FEE-2 |
| `core/RevenueRouterParity.t.sol` | parity vectors | FEE-2, off-chain parity |
| `core/TimelockAdminCoupling.t.sol` | review regressions | CFG-1 |
| `core/UniswapV3Twap.t.sol` | vectors | FEE-4 |
| `deploy/DeployLiveVenue.t.sol` | deploy script | DEP-2 |
| `deploy/DeployMainnet.t.sol` | deploy script + VerifyHandover | DEP-1 |
| `deploy/DeployVenueMinIf.t.sol` | deploy script | DEP-2 |
| `engine/AttestedOracle.t.sol` | unit + fuzz | ORC-1, ORC-2, off-chain parity |
| `engine/AttestedOracleAttestation.t.sol` | unit | ORC-3 |
| `engine/AttestedOracleUpdate.t.sol` | unit + fuzz | ORC-1, ORC-2 |
| `engine/EngineCloseOut.t.sol` | unit | ENG-10, ENG-2 |
| `engine/EngineMandateIntegration.t.sol` | integration | XC-3, MAN-3 |
| `engine/EnginePullIntegration.t.sol` | integration | XC-2 |
| `engine/EngineReviewRegressions.t.sol` | review regressions | ENG-2, ENG-7, ENG-8 |
| `engine/PoolEngine.t.sol` | unit | ENG-1..ENG-4, ENG-7, ENG-8, ENG-11 |
| `engine/PoolEngineAdapter.t.sol` | unit + fuzz | ENG-2, ENG-10, ENG-11 |
| `engine/PoolEngineFuzz.t.sol` | fuzz | ENG-2, ENG-5, ENG-7, ENG-8 |
| `engine/PoolEngineInvariant.t.sol` | **invariant** (4) | ENG-1..ENG-4 |
| `engine/PoolEnginePull.t.sol` | unit | ENG-8, XC-2 |
| `engine/PullOracleGas.t.sol` | gas evidence | XC-2 |
| `gov/BookFactory.t.sol` | unit | CFG-4, GOV-4 |
| `gov/GovInvariant.t.sol` | **invariant** (5) | GOV-1..GOV-5 |
| `gov/GovLifecycle.t.sol` | end to end | GOV-4 |
| `gov/MarketCharter.t.sol` | unit + fuzz | GOV-1..GOV-4, GOV-6 |
| `gov/RiskCommittee.t.sol` | unit + fuzz | GOV-5, GOV-6 |
| `integration/LowGasMark.t.sol` | integration + gas | MRK-2, MRK-3, CAP-7 |
| `mandate/BookrunnerDesk.t.sol` | unit | MAN-5, MAN-7, MAN-8, MAN-12, MAN-13 |
| `mandate/DeskPullOracle.t.sol` | unit | XC-2, MAN-8 |
| `mandate/DeskRiskControls.t.sol` | unit | MAN-11 |
| `mandate/HedgeExecutor.t.sol` | unit + fuzz | MAN-6 |
| `mandate/HedgeExecutorRoutes.t.sol` | unit | MAN-6, FEE-4 |
| `mandate/MMMandate.t.sol` | unit | MAN-1..MAN-4, MAN-8, MAN-10, MAN-14 |
| `mandate/MandateFuzz.t.sol` | parity fuzz | MAN-3, off-chain parity |
| `mandate/MandateInvariant.t.sol` | **invariant** (6) | MAN-1..MAN-6 |
| `mandate/MandateRedTeam.t.sol` | red team | MAN-1, MAN-4, MAN-7..MAN-10, off-chain parity |
| `mandate/MandateReviewRegressions.t.sol` | review regressions | MAN-8, MAN-11, XC-3 |
| `mandate/StockTokenRegistry.t.sol` | unit + fuzz | MAN-9 |
| `mandate/StockTokenRegistryLiveMultiplier.t.sol` | unit + fuzz | MAN-9, off-chain parity |
| `orderly/MockOrderlyVault.t.sol` | test double | ORL-7 |
| `orderly/OrderlyAccounts.t.sol` | unit | ORL-7 |
| `orderly/OrderlyAdapter.t.sol` | unit + fuzz | ORL-1, ORL-3..ORL-6 |
| `orderly/OrderlyCycle.t.sol` | end to end | ORL-2, ORL-3 |
| `orderly/OrderlyInvariant.t.sol` | **invariant** (5) + random-sequence fuzz | ORL-1..ORL-5 |
| `orderly/OrderlyLiveVault.t.sol` | unit | ORL-7, DEP-2 |
| `orderly/OrderlyReportSigned.t.sol` | unit + fuzz | ORL-6, off-chain parity |
| `orderly/OrderlyWithdrawProtocol.t.sol` | review regressions | ORL-3, ORL-6 |

New suites must add a row here and name the invariant they check (a new ID when it is a new property).
