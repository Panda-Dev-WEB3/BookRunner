// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Vm} from "forge-std/Vm.sol";
import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IBook} from "../../src/interfaces/IBook.sol";
import {IInsurancePool} from "../../src/interfaces/IInsurancePool.sol";
import {Book} from "../../src/Book.sol";
import {UnderwritingVault} from "../../src/UnderwritingVault.sol";
import {RevenueRouter} from "../../src/RevenueRouter.sol";
import {InsurancePool} from "../../src/InsurancePool.sol";
import {PoolBookFixture} from "./utils/PoolBookFixture.sol";

/// @notice A pool-funded book end to end (CAP-16, POOL-7, POOL-9, docs/INVARIANTS.md). The window raises only the MM
///         inventory and the pool funds the IF as a senior debt of the book: every IF draw (traders' bad debt or the MM's
///         losses) is the book's loss first (Junior -> Senior -> backstop), the pool loses only what an exhausted book
///         cannot repay, all from the mark's snapshot (no live venue read). The premium comes off gross fee flow first;
///         retirement repays the pool first. A book funded the old way is unchanged.
contract PoolBookTest is PoolBookFixture {
    function setUp() public {
        _setUpPoolBook();
    }

    // ------------------------------------------------------------------ window

    function test_closeWindow_raisesOnlyMm_poolFundsIf() public {
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        vm.expectEmit(true, true, false, true, address(book));
        emit Book.InsuranceFunded(BOOK_ID, address(pool), 25_000e6);
        vm.expectEmit(true, false, false, true, address(book));
        emit IBook.CapitalDeployed(BOOK_ID, 25_000e6, 75_000e6);
        book.closeWindow();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live));
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 52_500e6, "Senior: 70% of the 75k MM raise");
        assertEq(j, 22_500e6);
        assertEq(venue.ifEquity(), 25_000e6, "IF from the pool");
        assertEq(venue.mmValue(), 75_000e6, "MM from the tranches");
        (address p, uint256 debt, uint256 value, bool due, bool closed) = book.insuranceDebt();
        assertEq(p, address(pool));
        assertEq(book.insurancePool(), address(pool));
        assertEq(debt, 25_000e6);
        assertEq(value, 25_000e6);
        assertFalse(due);
        assertFalse(closed);
        IInsurancePool.BookPosition memory pos = pool.bookPosition(BOOK_ID);
        assertEq(pos.book, address(book));
        assertEq(pos.vault, address(vault));
        assertEq(pos.router, address(rrouter));
        assertEq(pos.market, _poolCharter().underlying);
        assertEq(pos.claim, 25_000e6);
        assertEq(book.unfundedClaims(), 0, "a debt not yet due is not reserved cash");
    }

    /// @notice Pool audit 2026-10-23 A-M2: the pool cannot fund the IF now (here its market cap): the window never waits
    ///         on it; the tranches raised enough, so the IF is raised from them (the window re-run the old way).
    function test_closeWindow_poolCannotFund_fallsBackToTheTranches() public {
        vm.prank(timelock);
        pool.setParam("marketCapBps", 100); // 1% of 1.12M = 11.2k < 25k
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        vm.expectEmit(true, false, false, true, address(book));
        emit Book.InsuranceFallback(BOOK_ID, "POOL_UNFUNDED");
        book.closeWindow();
        _assertFundedTheOldWay();
    }

    function test_closeWindow_poolUnset_fallsBackToTheTranches() public {
        cfg.setInsurancePool(address(0));
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        _assertFundedTheOldWay();
    }

    /// @notice A-M2: the pool cannot fund it and the tranches did not raise the IF either: cancelled cleanly at once.
    function test_closeWindow_poolCannotFund_tranchesNeither_cancelledCleanly() public {
        vm.prank(timelock);
        pool.setParam("marketCapBps", 100);
        _deposit(junior, sponsor, 20_000e6); // 20k raised < the 25k IF
        vm.warp(book.subscriptionEnds());
        vm.expectEmit(true, false, false, true, address(book));
        emit IBook.BookCancelled(BOOK_ID, "POOL_UNFUNDED");
        book.closeWindow();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Cancelled), "commitments refundable 1:1");
        assertEq(pool.bookPosition(BOOK_ID).book, address(0), "nothing allocated");
    }

    /// @dev Live, IF 25k + MM 75k raised from the tranches (S 70k, J 30k), no pool position, no premium.
    function _assertFundedTheOldWay() internal view {
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live));
        assertEq(book.insurancePool(), address(0), "funded the old way");
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s + j, 100_000e6, "IF + MM from the tranches");
        assertEq(venue.ifEquity(), 25_000e6);
        assertEq(venue.mmValue(), 75_000e6);
        assertEq(pool.bookPosition(BOOK_ID).book, address(0), "no allocation");
        (address p,,) = rrouter.previewPremium(10_000e6);
        assertEq(p, address(0), "no premium");
    }

    function test_closeWindow_zeroIfTarget_reverts() public {
        BRTypes.Charter memory c = _poolCharter();
        c.ifTargetUsd = 0;
        _deployPoolBook(c);
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        vm.expectRevert(Book.InsuranceTargetZero.selector);
        book.closeWindow();
    }

    function test_closeWindow_poolAllocationsPaused_fallsBackToTheTranches() public {
        vm.prank(guardian);
        pool.setPaused(false, true);
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        _assertFundedTheOldWay();
    }

    // ------------------------------------------------------------------ NAV: the pool's IF is a senior debt

    function test_nav_excludesPoolIf() public {
        _goLivePool();
        assertEq(book.markedNavPreview(venue.deployedValueUsd()), 75_000e6, "100k deployed - 25k debt");
        _applyPoolMark();
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s + j, 75_000e6, "no phantom gain from the pool's IF");
        _identity();
    }

    /// @notice Review I-1: an IF draw is the book's loss first (Junior), the pool keeps its full claim.
    function test_ifDraw_isTheBooksLossFirst_poolUntouched() public {
        _goLivePool();
        venue.setIfEquity(20_000e6); // traders' bad debt (or MM losses paid from the IF) drew 5k
        _applyPoolMark();
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(j, 22_500e6 - 5_000e6, "Junior absorbs the IF draw");
        assertEq(s, 52_500e6);
        (uint256 debt, uint256 value,) = _debt();
        assertEq(debt, 25_000e6, "still owed in full");
        assertEq(value, 25_000e6);
        assertEq(pool.bookPosition(BOOK_ID).claim, 25_000e6);
        assertEq(pool.firstLossAssets(), POOL_FIRST_LOSS, "the pool lost nothing");
        _identity();
    }

    /// @notice The MM blows through its capital and the venue pays winners from the IF: Junior, then Senior absorb it;
    ///         the pool's claim on the exhausted book is what it holds, the rest a (provisional) pool loss, slice first.
    function test_mmBlowThrough_poolLosesOnlyWhatTheBookCannotPay() public {
        _goLivePool();
        venue.setMmValue(0);
        venue.setIfEquity(5_000e6); // 20k of the IF paid out on top of the 75k MM
        uint256 id = _poolMark();
        vm.expectEmit(true, false, false, false, address(book));
        emit Book.InsuranceMarked(BOOK_ID, 25_000e6, 5_000e6, 0, false);
        book.applyMark(id);
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s + j, 0, "the tranches are wiped first");
        (uint256 debt, uint256 value,) = _debt();
        assertEq(debt, 25_000e6, "still owed: the shortfall is provisional");
        assertEq(value, 5_000e6, "the pool's claim: all the book holds");
        assertEq(pool.bookPosition(BOOK_ID).claim, 5_000e6);
        assertEq(pool.firstLossAssets(), POOL_FIRST_LOSS - 20_000e6, "the shortfall, first-loss slice first");
    }

    /// @notice Review N2-2: a shortfall taken on a mark value is provisional. A dip, then a recovery: the pool is restored
    ///         before the tranches gain, so a sponsor cannot time a dip to move pool capital to the tranches.
    function test_N2_2_dipThenRecovery_poolRestoredBeforeTheTranches() public {
        _goLivePool();
        venue.setMmValue(0);
        venue.setIfEquity(5_000e6); // the dip: the book holds 5k for its 25k debt
        _applyPoolMark();
        assertEq(pool.firstLossAssets(), POOL_FIRST_LOSS - 20_000e6, "the pool's share price shows the loss");
        assertEq(pool.bookPosition(BOOK_ID).claim, 5_000e6);
        venue.setMmValue(30_000e6); // the MM recovers 30k (unrealized dip reversed)
        _applyPoolMark();
        (uint256 debt, uint256 value,) = _debt();
        assertEq(debt, 25_000e6);
        assertEq(value, 25_000e6, "the pool's claim restored first");
        assertEq(pool.firstLossAssets(), POOL_FIRST_LOSS, "the pool's loss reversed");
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s + j, 10_000e6, "only what is above the debt is tranche value");
        (,,,, bool closed) = book.insuranceDebt();
        assertFalse(closed);
    }

    /// @notice Review N2-1: a due repayment never takes the Backstop cover Senior holds. Cover received (the MM's loss),
    ///         then the IF recall makes the debt due (the pool's claim is still 25k from the last mark), then wind-down
    ///         bad debt drains the IF: the pool receives no Backstop money, then or at retirement.
    function test_N2_1_dueRepayment_neverPaysThePoolBackstopMoney() public {
        _goLivePool();
        usdc.mint(address(backstop), 1_000_000e6);
        uint256 bal = usdc.balanceOf(address(backstop));
        venue.setMmValue(0); // the MM lost its 75k: Senior's 52.5k covered by the Backstop; the IF is intact
        _applyPoolMark();
        uint256 cover = bal - usdc.balanceOf(address(backstop));
        assertEq(cover, 52_500e6);
        (, uint256 value,) = _debt();
        assertEq(value, 25_000e6);
        charterC.retire(BOOK_ID);
        (uint256 poolCashBefore,,,,) = pool.ledger();
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_IF, 1_000e6); // due; 1k of the IF back
        venue.setIfEquity(0); // wind-down bad debt drains the rest of the IF
        book.fundClaims(); // the vault holds the 52.5k cover + 1k of the book's own
        (uint256 poolCash,,,,) = pool.ledger();
        assertEq(poolCash - poolCashBefore, 1_000e6, "only the book's own cash repaid, not the cover");
        assertEq(vault.idle(), cover, "the Backstop cover stays with Senior");
        _applyPoolMark(); // deployed 0
        book.finalizeRetirement();
        (poolCash,,,,) = pool.ledger();
        assertEq(poolCash - poolCashBefore, 1_000e6, "no Backstop money reached the pool, even at retirement");
        assertEq(pool.bookPosition(BOOK_ID).allocation, 24_000e6, "the IF lost beyond the book's capital: the pool's");
        assertEq(usdc.balanceOf(address(backstop)), bal - cover, "the Backstop paid only the MM loss");
        (uint256 s,) = book.trancheNav();
        assertEq(s, cover, "Senior keeps its cover");
    }

    // ------------------------------------------------------------------ owner ruling N-1: no Backstop for the debt

    /// @notice A book whose losses are all insurance debt (IF 25k > MM 12.5k): exhausted, its debt written down, and
    ///         the Backstop pays nothing for it, over repeated marks.
    function test_N1_exhaustedByInsuranceDebt_drawsNoBackstopCover_overRepeatedMarks() public {
        BRTypes.Charter memory c = _poolCharter();
        c.mmInventoryUsd = 12_500e6; // the pool's minimum own capital: 50% of the IF
        _deployPoolBook(c);
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        book.closeWindow(); // raises 12.5k: S 8.75k, J 3.75k
        usdc.mint(address(backstop), 1_000_000e6);
        uint256 bal = usdc.balanceOf(address(backstop));
        venue.setIfEquity(0); // traders' bad debt drew the whole 25k IF
        for (uint256 i; i < 4; ++i) {
            _applyPoolMark();
            assertEq(usdc.balanceOf(address(backstop)), bal, "the Backstop pays nothing for the insurance debt");
        }
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s + j, 0, "the tranches absorbed it");
        (uint256 debt, uint256 value,) = _debt();
        assertEq(debt, 25_000e6, "owed until retirement");
        assertEq(value, 12_500e6, "the pool's claim: the book's own 12.5k");
        assertEq(pool.bookPosition(BOOK_ID).claim, 12_500e6);
        (uint256 bsDebt,) = book.backstopDebt();
        assertEq(bsDebt, 0);
    }

    /// @notice Pool-debt marks leave the Backstop untouched: the IF draw beyond Junior impairs Senior, uncovered.
    function test_N1_poolDebtMarks_leaveTheBackstopBalanceUnchanged() public {
        _goLivePool();
        usdc.mint(address(backstop), 1_000_000e6);
        uint256 bal = usdc.balanceOf(address(backstop));
        venue.setIfEquity(0); // 25k drawn: Junior 22.5k gone, Senior impaired 2.5k
        for (uint256 i; i < 3; ++i) {
            _applyPoolMark();
        }
        assertEq(usdc.balanceOf(address(backstop)), bal);
        assertEq(book.seniorImpairment(), 2_500e6, "Senior keeps its insurance-debt loss");
        (uint256 debt,,) = _debt();
        assertEq(debt, 25_000e6, "the book is not exhausted: the pool is owed in full");
    }

    /// @notice Mixed: an MM loss is covered as before, the insurance debt is not.
    function test_N1_mixed_mmLossCovered_insuranceDebtNot() public {
        _goLivePool();
        usdc.mint(address(backstop), 1_000_000e6);
        uint256 bal = usdc.balanceOf(address(backstop));
        venue.setMmValue(15_000e6); // the MM lost 60k
        venue.setIfEquity(15_000e6); // bad debt drew 10k of the IF
        _applyPoolMark();
        assertEq(bal - usdc.balanceOf(address(backstop)), 37_500e6, "the Senior part of the MM loss, covered");
        assertEq(book.seniorImpairment(), 10_000e6, "the IF draw stays Senior's");
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 42_500e6);
        assertEq(j, 0);
        _applyPoolMark();
        _applyPoolMark();
        assertEq(bal - usdc.balanceOf(address(backstop)), 37_500e6, "never more, cumulatively");
        (uint256 debt,,) = _debt();
        assertEq(debt, 25_000e6, "the Backstop cash is never netted against the debt");
        assertEq(pool.bookPosition(BOOK_ID).claim, 25_000e6);
    }

    /// @notice POOL-11 (owner ruling N-1), fuzzed: over repeated marks the Backstop pays exactly Senior's part of the
    ///         MM loss and nothing of the IF draw, whatever their mix (exhausted books included).
    function testFuzz_N1_backstopPaysOnlyTheNonInsuranceSeniorLoss(uint256 mmLeft, uint256 ifLeft) public {
        _goLivePool();
        mmLeft = bound(mmLeft, 0, 75_000e6);
        ifLeft = bound(ifLeft, 0, 25_000e6);
        usdc.mint(address(backstop), 1_000_000e6);
        uint256 bal = usdc.balanceOf(address(backstop));
        venue.setMmValue(mmLeft);
        venue.setIfEquity(ifLeft);
        for (uint256 i; i < 3; ++i) {
            _applyPoolMark();
        }
        uint256 mmLoss = 75_000e6 - mmLeft;
        uint256 seniorMmLoss = mmLoss > 22_500e6 ? mmLoss - 22_500e6 : 0;
        if (seniorMmLoss > 52_500e6) seniorMmLoss = 52_500e6;
        assertEq(bal - usdc.balanceOf(address(backstop)), seniorMmLoss, "cover == Senior's MM loss, never the IF draw");
    }

    /// @notice An MM loss within its capital, IF intact: covered exactly as for a book funded the old way.
    function test_N1_mmLossWithinCapital_coveredAsBefore() public {
        _goLivePool();
        usdc.mint(address(backstop), 1_000_000e6);
        uint256 bal = usdc.balanceOf(address(backstop));
        venue.setMmValue(0); // the MM lost all 75k, the IF is intact
        _applyPoolMark();
        assertEq(bal - usdc.balanceOf(address(backstop)), 52_500e6, "all of Senior's loss, covered");
        _applyPoolMark();
        (uint256 s,) = book.trancheNav();
        assertEq(s, 52_500e6, "Senior keeps the cover: it is never netted against the debt");
        (uint256 debt,,) = _debt();
        assertEq(debt, 25_000e6);
    }

    /// @notice Review I-3: NAV and the pool's value come from the mark's snapshot; an IF move between valuation and
    ///         apply creates no phantom NAV (no live venue read).
    function test_ifMoveBetweenValuationAndApply_noPhantomNav() public {
        _goLivePool();
        uint256 id = _poolMark(); // values IF 25k + MM 75k
        venue.setIfEquity(10_000e6); // the IF moves after the valuation
        book.applyMark(id);
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s + j, 75_000e6, "the snapshot's IF against the debt: no phantom loss or gain");
        (, uint256 value,) = _debt();
        assertEq(value, 25_000e6);
        // the next mark values the moved IF: a book loss, still not the pool's
        _applyPoolMark();
        (s, j) = book.trancheNav();
        assertEq(s + j, 60_000e6);
        assertEq(pool.bookPosition(BOOK_ID).claim, 25_000e6);
    }

    /// @notice Review I-2: a venue reporting lag (the IF not yet credited in a snapshot) cannot create a fake pool loss
    ///         and recovery: the book still covers its debt, so the pool's value does not move.
    function test_venueReportLag_noFakePoolLossOrRecovery() public {
        _goLivePool();
        uint256 lossesBefore;
        (,,,, lossesBefore) = pool.ledger();
        uint256 id = _commitMark(_nextPeriodEndAfterWarp(), venue.mmValue(), book.flowNonce()); // IF missing
        book.applyMark(id);
        (, uint256 value,) = _debt();
        assertEq(value, 25_000e6, "the book still holds enough");
        _applyPoolMark(); // the next report has the IF
        (,,,, uint256 lossesAfter) = pool.ledger();
        assertEq(lossesAfter, lossesBefore, "no loss, no recovery at the pool");
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s + j, 75_000e6, "the tranches' dip is undone");
    }

    // ------------------------------------------------------------------ pool follow-up m-6: IF in flight

    /// @notice m-6: the window's IF deposit still in flight at the first mark is counted in the deployed value and in
    ///         the signed IF equity (venue IF + IF in transit): no IF draw, so an MM loss in the same mark is covered as
    ///         usual, and no provisional pool loss.
    function test_m6_ifDepositInFlight_noIfDraw_noProvisionalLoss() public {
        venue.setIfAsync(true);
        _goLivePool();
        assertEq(venue.ifInTransit(), 25_000e6, "the IF is on its way to the venue");
        assertEq(venue.ifEquity(), 0);
        usdc.mint(address(backstop), 1_000_000e6);
        uint256 bal = usdc.balanceOf(address(backstop));
        venue.setMmValue(0); // the MM lost its 75k: Senior's 52.5k is a loss other than the insurance debt
        vm.recordLogs();
        _applyPoolMark();
        _assertNoInsuranceShortfall();
        assertEq(bal - usdc.balanceOf(address(backstop)), 52_500e6, "no IF draw: Senior's MM loss fully covered");
        (uint256 debt, uint256 value,) = _debt();
        assertEq(debt, 25_000e6);
        assertEq(value, debt, "no provisional pool loss");
        assertEq(pool.bookPosition(BOOK_ID).claim, 25_000e6);
        venue.landIf();
        _applyPoolMark();
        assertEq(bal - usdc.balanceOf(address(backstop)), 52_500e6, "landing changes nothing");
        (, value,) = _debt();
        assertEq(value, 25_000e6);
    }

    /// @notice m-6: the wind-down IF recall in flight (left the venue, not yet in the vault) is no IF draw either: full
    ///         cover for the MM loss, the pool's claim whole, and the debt repaid in full once the IF lands.
    function test_m6_ifRecallInFlight_noIfDraw_noProvisionalLoss() public {
        (uint256 bal,) = _recallIfInFlightWithMmLoss();
        vm.recordLogs();
        _applyPoolMark();
        _assertNoInsuranceShortfall();
        assertEq(bal - usdc.balanceOf(address(backstop)), 52_500e6, "no IF draw: Senior's MM loss fully covered");
        (uint256 debt, uint256 value, bool due) = _debt();
        assertTrue(due);
        assertEq(value, debt, "no provisional pool loss");
        assertEq(debt, 25_000e6, "nothing repaid yet: the IF cash is not in the vault");
        assertEq(pool.bookPosition(BOOK_ID).claim, 25_000e6);
        venue.landIf();
        book.fundClaims();
        (debt,,) = _debt();
        assertEq(debt, 0, "repaid in full on landing");
        assertEq(pool.bookPosition(BOOK_ID).allocation, 0);
        assertEq(pool.firstLossAssets(), POOL_FIRST_LOSS, "the pool lost nothing");
    }

    /// @notice m-6, the pre-fix signing for the record (venue IF only, the recall in flight left out): the in-flight IF
    ///         reads as a 25k draw, which TIGHTENS the Backstop cap at that mark (25k less cover for Senior's MM loss; the
    ///         pool's claim is unaffected), and the next mark after repayment re-offers the cover.
    /// @notice Pool audit 2026-10-23: the ledger is cumulative, so the conservative misreading sticks: the 25k the old
    ///         signing read as an IF draw within the MM loss is booked as Senior's insurance-debt impairment and is not
    ///         re-offered after the IF lands (the debt being due, a later fall of the draw is a repayment, never read as
    ///         an IF recovery). The Backstop pays less, never more; the current mark service signs the IF in transit.
    function test_m6_preFixSigning_readsTheRecallAsADraw_conservativeForGood() public {
        (uint256 bal,) = _recallIfInFlightWithMmLoss();
        vm.warp(((block.timestamp / INTERVAL) + 1) * INTERVAL);
        uint256 id = _commitMark(_nextPeriodEnd(), venue.deployedValueUsd(), book.flowNonce(), false, venue.ifEquity());
        book.applyMark(id);
        assertEq(bal - usdc.balanceOf(address(backstop)), 27_500e6, "the IF in flight read as a draw: 25k less cover");
        (uint256 debt, uint256 value,) = _debt();
        assertEq(value, debt, "the pool's claim never depended on the signed IF equity");
        (uint256 impIf,,,) = book.insuranceLedger();
        assertEq(impIf, 25_000e6, "booked as insurance debt");
        venue.landIf();
        book.fundClaims();
        _applyPoolMark();
        assertEq(bal - usdc.balanceOf(address(backstop)), 27_500e6, "never re-offered: the ledger only ever errs low");
        (debt,,) = _debt();
        assertEq(debt, 0, "the pool repaid in full on landing");
    }

    /// @dev Live pool book, Backstop funded, retired, the IF recall in flight (debt due), the MM lost its 75k.
    function _recallIfInFlightWithMmLoss() internal returns (uint256 backstopBalance, uint256 ifInFlight) {
        _goLivePool();
        usdc.mint(address(backstop), 1_000_000e6);
        backstopBalance = usdc.balanceOf(address(backstop));
        charterC.retire(BOOK_ID);
        venue.setIfAsync(true);
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_IF, 25_000e6);
        ifInFlight = venue.ifInTransit();
        assertEq(ifInFlight, 25_000e6, "the IF left the venue, not yet in the vault");
        assertEq(venue.ifEquity(), 0);
        venue.setMmValue(0);
    }

    function _assertNoInsuranceShortfall() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(book)) {
                assertTrue(logs[i].topics[0] != Book.InsuranceShortfall.selector, "no InsuranceShortfall");
            }
        }
    }

    function test_marks_stampTheBookForThePoolEpochGate() public {
        _goLivePool();
        _applyPoolMark();
        assertEq(pool.bookPosition(BOOK_ID).lastMarkAt, book.lastMarkPeriodEnd());
    }

    function test_poolRefusesMark_neverBlocksMarks() public {
        _goLivePool();
        venue.setMmValue(0);
        venue.setIfEquity(5_000e6);
        vm.mockCallRevert(address(pool), abi.encodeWithSelector(InsurancePool.markBook.selector), "down");
        uint256 id = _poolMark();
        vm.expectEmit(true, false, false, true, address(book));
        emit Book.InsuranceMarkFailed(BOOK_ID, 5_000e6, false);
        book.applyMark(id);
        (, uint256 value,) = _debt();
        assertEq(value, 5_000e6, "the book nets its claim");
        assertEq(pool.bookPosition(BOOK_ID).claim, 25_000e6, "the pool's view is unchanged until it accepts a mark");
        vm.clearMockedCalls();
        _applyPoolMark();
        assertEq(pool.bookPosition(BOOK_ID).claim, 5_000e6);
    }

    /// @notice POOL-9: the pool's realized loss on a book <= max(0, IF draw - the book's own capital left).
    function testFuzz_poolRealizedLoss_boundedByDrawBeyondBookCapital(uint256 ifLeft, uint256 mmLeft, uint256 gross)
        public
    {
        _goLivePool();
        ifLeft = bound(ifLeft, 0, 30_000e6);
        mmLeft = bound(mmLeft, 0, 120_000e6);
        gross = bound(gross, 0, 20_000e6);
        if (gross > 0) _distribute(gross, 0);
        venue.setIfEquity(ifLeft);
        venue.setMmValue(mmLeft);
        _applyPoolMark();
        charterC.retire(BOOK_ID);
        vm.startPrank(keeper);
        if (ifLeft > 0) vault.recall(BRTypes.ACCOUNT_IF, ifLeft);
        if (mmLeft > 0) vault.recall(BRTypes.ACCOUNT_MM, mmLeft);
        vm.stopPrank();
        _applyPoolMark(); // deployed 0
        book.finalizeRetirement();
        uint256 draw = ifLeft >= 25_000e6 ? 0 : 25_000e6 - ifLeft;
        uint256 bookCapital = mmLeft + (gross - rrouter.premiumTotal() - _expensesAndCarry());
        uint256 realized = pool.bookPosition(BOOK_ID).allocation; // what was never repaid
        uint256 bound_ = draw > bookCapital ? draw - bookCapital : 0;
        assertLe(realized, bound_, "the pool's loss is only the draw beyond the book's capital");
        assertEq(pool.bookPosition(BOOK_ID).claim, 0, "nothing left owed");
    }

    function _expensesAndCarry() internal view returns (uint256) {
        uint256[5] memory t = rrouter.totals();
        return t[1] + t[2];
    }

    // ------------------------------------------------------------------ vault rules for a pool-funded IF

    function test_vault_deskCannotMoveThePoolsIf() public {
        _goLivePool();
        usdc.mint(address(vault), 1_000e6);
        vm.prank(desk);
        vm.expectRevert(UnderwritingVault.PoolFundedInsurance.selector);
        vault.deployToVenue(BRTypes.ACCOUNT_IF, 1_000e6);
        vm.prank(desk);
        vm.expectRevert(UnderwritingVault.PoolFundedInsurance.selector);
        vault.recall(BRTypes.ACCOUNT_IF, 1_000e6);
        vm.prank(keeper);
        vm.expectRevert(UnderwritingVault.PoolFundedInsurance.selector);
        vault.recall(BRTypes.ACCOUNT_IF, 1_000e6);
        vm.prank(desk);
        vault.deployToVenue(BRTypes.ACCOUNT_MM, 1_000e6);
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_MM, 1_000e6);
    }

    function test_onInsuranceRecall_onlyVault() public {
        _goLivePool();
        vm.prank(eve);
        vm.expectRevert(Book.NotVault.selector);
        book.onInsuranceRecall();
    }

    // ------------------------------------------------------------------ premium

    function test_premium_charterRate_firstThenSplit() public {
        _goLivePool();
        (address p, uint256 premium, uint256 bps) = rrouter.previewPremium(10_000e6);
        assertEq(p, address(pool));
        assertEq(bps, 1200);
        assertEq(premium, 1_200e6);
        usdc.mint(address(rrouter), 10_000e6);
        rrouter.notifySettlement(BRTypes.SRC_ENGINE_FEES, 10_000e6);
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true, address(rrouter));
        emit RevenueRouter.PremiumPaid(BOOK_ID, 77, address(pool), 1_200e6, 1200);
        rrouter.distribute(77, 2_000e6);
        // rest 8,800: expenses capped at 20% = 1,760; carry 10% of 7,040 = 704; Senior 60% of 6,336, Junior the rest
        assertEq(usdc.balanceOf(expenseSink), 1_760e6);
        assertEq(carrySink.carry(), 704e6);
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 52_500e6 + 3_801_600_000);
        assertEq(j, 22_500e6 + 2_534_400_000);
        assertEq(rrouter.premiumTotal(), 1_200e6);
    }

    /// @notice Minor m-4: the router pays the rate fixed in the charter; a later pool floor change does not re-price it.
    function test_premium_floorChange_doesNotRepriceALiveBook() public {
        _goLivePool();
        vm.prank(timelock);
        pool.setParam("premiumFloorBps", 5000);
        (, uint256 premium, uint256 bps) = rrouter.previewPremium(10_000e6);
        assertEq(bps, 1200);
        assertEq(premium, 1_200e6);
    }

    // ------------------------------------------------------------------ retirement

    function test_retirement_repaysThePoolFirst_inFull() public {
        _goLivePool();
        venue.setIfEquity(21_000e6); // 4k drawn while Live: the book's loss
        _applyPoolMark();
        charterC.retire(BOOK_ID);
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_IF, 21_000e6);
        (uint256 debt,, bool due) = _debt();
        assertTrue(due);
        assertEq(book.unfundedClaims(), debt, "a due debt is reserved cash");
        book.fundClaims();
        (debt,,) = _debt();
        assertEq(debt, 4_000e6, "21k repaid at once");
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_MM, 75_000e6);
        _applyPoolMark(); // deployed 0: the rest of the debt comes out of the MM cash first
        book.finalizeRetirement();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Retired));
        IInsurancePool.BookPosition memory pos = pool.bookPosition(BOOK_ID);
        assertEq(pos.allocation, 0, "the pool was repaid in full");
        assertEq(pos.claim, 0);
        assertFalse(pos.active);
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s + j, 71_000e6, "the tranches bore the 4k draw");
        assertEq(vault.idle(), 71_000e6);
    }

    function test_retirement_poolPaidBeforeTrancheClaims() public {
        _goLivePool();
        charterC.retire(BOOK_ID);
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_MM, 20_000e6);
        vm.prank(alice);
        senior.requestRedeem(30_000e6, alice, alice); // alice holds 30k of the 52.5k Senior
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_IF, 25_000e6);
        _applyPoolMark(); // fundClaims: the pool's 25k first, then alice from what is left
        (uint256 debt,,) = _debt();
        assertEq(debt, 0, "pool repaid in full");
        assertEq(book.unfundedOf(BRTypes.SENIOR), 30_000e6 - 20_000e6, "Senior waits for the rest of the MM");
        _identity();
    }

    /// @notice A pool that refuses the repayment never blocks marks, retirement or tranche exits: the due debt stays
    ///         owed and its cash reserved, the tranches are paid from the rest; settleInsurance retries.
    function test_poolRepayFails_neverBlocksMarksOrExits() public {
        _goLivePool();
        charterC.retire(BOOK_ID);
        vm.prank(alice);
        senior.requestRedeem(30_000e6, alice, alice);
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_IF, 25_000e6);
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_MM, 75_000e6);
        vm.mockCallRevert(address(pool), abi.encodeWithSelector(InsurancePool.repay.selector), "down");
        _applyPoolMark();
        (uint256 debt,,) = _debt();
        assertEq(debt, 25_000e6, "still owed");
        assertEq(book.unfundedOf(BRTypes.SENIOR), 0, "alice funded from the rest");
        assertEq(vault.idle(), 100_000e6 - 30_000e6, "the pool's 25k stays reserved in the vault");
        vm.prank(alice);
        senior.claimRedemption(alice, alice);
        book.finalizeRetirement();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Retired));
        (debt,,) = _debt();
        assertEq(debt, 25_000e6, "no write-off while the vault holds it");
        vm.clearMockedCalls();
        book.settleInsurance();
        (debt,,) = _debt();
        assertEq(debt, 0, "repaid on the retry");
    }

    function test_finalize_writesOffWhatTheExhaustedBookCannotRepay() public {
        _goLivePool();
        charterC.retire(BOOK_ID);
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_IF, 1); // the IF recall starts: debt due
        venue.setIfEquity(0);
        venue.setMmValue(0); // everything lost
        _applyPoolMark(); // exhausted: the pool's claim is the 1 unit recalled (repaid), the rest provisional
        vm.expectEmit(true, false, false, true, address(book));
        emit Book.InsuranceWrittenOff(BOOK_ID, 25_000e6 - 1); // final only at retirement
        book.finalizeRetirement();
        (uint256 debt,,) = _debt();
        assertEq(debt, 0);
        (,,,, bool closed) = book.insuranceDebt();
        assertTrue(closed);
        IInsurancePool.BookPosition memory pos = pool.bookPosition(BOOK_ID);
        assertEq(pos.claim, 0);
        assertEq(pos.allocation, 25_000e6 - 1, "the pool's loss");
        assertFalse(pos.active);
    }

    function test_finalize_withoutIfRecall_bookPaysTheDrawnIf() public {
        _goLivePool();
        venue.setIfEquity(0); // the whole IF drawn while Live: the book's loss (it has 75k of MM)
        _applyPoolMark();
        charterC.retire(BOOK_ID);
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_MM, 75_000e6);
        _applyPoolMark();
        book.finalizeRetirement();
        (uint256 debt,, bool due) = _debt();
        assertEq(debt, 0, "repaid from the MM cash");
        assertTrue(due);
        assertEq(pool.bookPosition(BOOK_ID).allocation, 0, "the pool lost nothing");
        assertEq(pool.firstLossAssets(), POOL_FIRST_LOSS);
    }

    // ------------------------------------------------------------------ the old way

    function test_bookFundedTheOldWay_unchanged() public {
        _deployPoolBook(_defaultCharter()); // ifFromPool false
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s + j, 100_000e6, "IF + MM raised from the tranches");
        assertEq(venue.ifEquity(), 25_000e6);
        assertEq(book.insurancePool(), address(0));
        assertEq(pool.bookPosition(BOOK_ID).book, address(0), "no allocation");
        (address p,,) = rrouter.previewPremium(10_000e6);
        assertEq(p, address(0), "no premium");
        _applyPoolMark();
        (s, j) = book.trancheNav();
        assertEq(s + j, 100_000e6, "IF in the NAV as before");
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_IF, 1_000e6);
    }

    /// @notice The charter's new fields share the slot of takerFeeBps / makerFeeBps: Charter keeps its 11 slots, so
    ///         everything after it in Book's ERC-7201 storage stays where it was, and a book stored before reads
    ///         ifFromPool = false, premiumBps = 0 (funded the old way).
    function test_charterStorageSizeUnchanged() public {
        _goLivePool();
        bytes32 loc = 0xafd306892a6154f35c973e251e6b4f2659d2ae19802986651fcc8ec3ae5c4c00;
        assertEq(address(uint160(uint256(vm.load(address(book), bytes32(uint256(loc) + 13))))), address(book));
        assertEq(address(uint160(uint256(vm.load(address(book), bytes32(uint256(loc) + 14))))), address(senior));
        uint256 last = uint256(vm.load(address(book), bytes32(uint256(loc) + 12)));
        assertEq((last >> 32) & 0xff, 1, "ifFromPool packed after the fee fields");
        vm.store(address(book), bytes32(uint256(loc) + 12), bytes32(last & 0xffffffff));
        BRTypes.Charter memory c = book.getCharter();
        assertFalse(c.ifFromPool);
        assertEq(c.premiumBps, 0);
    }

    function test_initialize_rejectsPremiumAbove100pct() public {
        BRTypes.Charter memory c = _poolCharter();
        c.premiumBps = 10_001;
        BRTypes.BookComponents memory comps = book.components();
        comps.book = address(0);
        bytes memory init = abi.encodeCall(Book.initialize, (address(cfg), 2, c, comps));
        vm.expectRevert(Book.BadCharter.selector);
        new ERC1967Proxy(address(bookImpl), init);
    }

    // ------------------------------------------------------------------ pool audit 2026-10-23: the explicit ledger

    /// @notice B-L4: a held mark reaches the pool (its claim moves) but does not stamp the book fresh for the pool's
    ///         epoch gate; the next non-held mark does.
    function test_heldMark_doesNotSatisfyThePoolEpochGate() public {
        _goLivePool();
        _applyPoolMark();
        uint64 at0 = pool.bookPosition(BOOK_ID).lastMarkAt;
        vm.warp(((block.timestamp / INTERVAL) + 1) * INTERVAL);
        uint256 id = _commitMark(
            _nextPeriodEnd(), venue.deployedValueUsd(), book.flowNonce(), true, venue.ifEquity() + venue.insuranceInTransitUsd()
        );
        book.applyMark(id);
        assertEq(pool.bookPosition(BOOK_ID).lastMarkAt, at0, "a held mark is not fresh");
        _applyPoolMark();
        assertEq(pool.bookPosition(BOOK_ID).lastMarkAt, book.lastMarkPeriodEnd());
    }

    /// @notice B-H1 recommendation 3 / owner ruling N-1, cumulative and in any path: over a sequence of marks (IF draws and
    ///         MM moves in any order), a fee distribution and the whole wind-down to retirement, the Backstop never covers
    ///         more than on the same book whose IF was never drawn (runs both paths from one snapshot). Its repayments
    ///         can come later: an exhausted book's later gains restore the pool's provisional shortfall first (N2-2, the
    ///         IF is the book's senior debt), which the Backstop's cash never funds.
    function testFuzz_N1_cumulative_backstopNeverPaysMoreThanWithoutTheIfDraws(
        uint256[3] memory mm,
        uint256[3] memory ifLeft,
        uint256 gross
    ) public {
        _goLivePool();
        usdc.mint(address(backstop), 1_000_000e6);
        gross = bound(gross, 0, 20_000e6);
        for (uint256 i; i < 3; ++i) {
            mm[i] = bound(mm[i], 0, 120_000e6);
            ifLeft[i] = bound(ifLeft[i], 0, 25_000e6);
            if (i > 0 && ifLeft[i] > ifLeft[i - 1]) ifLeft[i] = ifLeft[i - 1]; // bad debt only draws the IF
        }
        uint256 s0 = vm.snapshotState();
        uint256 withDraws = _runPath(mm, ifLeft, gross, true);
        vm.revertToState(s0);
        uint256 without = _runPath(mm, ifLeft, gross, false);
        assertLe(withDraws, without, "the Backstop covered part of the insurance debt");
    }

    /// @dev One path to retirement; returns the cover the Backstop paid (gross, MarkSettled.backstopCovered summed).
    function _runPath(uint256[3] memory mm, uint256[3] memory ifLeft, uint256 gross, bool draws)
        internal
        returns (uint256)
    {
        uint256 covered;
        for (uint256 i; i < 3; ++i) {
            venue.setMmValue(mm[i]);
            venue.setIfEquity(draws ? ifLeft[i] : 25_000e6);
            _applyPoolMark();
            covered += book.lastMarkSummary().backstopCovered;
            if (i == 1 && gross > 0) _distribute(gross, 0);
            _checkLedgerInvariants();
        }
        charterC.retire(BOOK_ID);
        vm.startPrank(keeper);
        uint256 ifEq = venue.ifEquity();
        vault.recall(BRTypes.ACCOUNT_IF, ifEq > 0 ? ifEq : 1);
        if (venue.mmValue() > 0) vault.recall(BRTypes.ACCOUNT_MM, venue.mmValue());
        vm.stopPrank();
        book.fundClaims();
        _applyPoolMark(); // deployed 0
        covered += book.lastMarkSummary().backstopCovered;
        book.finalizeRetirement();
        _checkLedgerInvariants();
        return covered;
    }

    /// @dev The ledger's invariants: IF impairment within the impairment, the cover within Senior NAV and the Backstop
    ///      debt, the claim within the debt, and a shortfall only once the tranches hold no own capital.
    function _checkLedgerInvariants() internal view {
        (uint256 impIf,, uint256 cover,) = book.insuranceLedger();
        (uint256 s, uint256 j) = book.trancheNav();
        (uint256 bsDebt,) = book.backstopDebt();
        (uint256 debt, uint256 value,) = _debt();
        assertLe(impIf, book.seniorImpairment(), "impIf <= imp");
        assertLe(cover, s, "cover <= S");
        assertLe(cover, bsDebt, "cover <= backstopDebt");
        assertLe(value, debt, "claim <= debt");
        if (value < debt && uint8(book.state()) != uint8(BRTypes.BookState.Retired)) {
            assertEq(j, 0, "a shortfall only with Junior empty");
            assertEq(s, cover, "... and Senior holding only cover");
        }
    }

    // ------------------------------------------------------------------ helpers

    function _nextPeriodEndAfterWarp() internal returns (uint64) {
        vm.warp(((block.timestamp / INTERVAL) + 1) * INTERVAL);
        return _nextPeriodEnd();
    }

    /// @dev Book identity for a pool-funded book at an applied mark: S + J + unfundedClaims + (debt not yet due)
    ///      == vault idle + deployed (CAP-3 with the pool's debt), while the book is not exhausted.
    function _identity() internal view {
        (uint256 s, uint256 j) = book.trancheNav();
        (uint256 debt,, bool due) = _debt();
        assertEq(
            s + j + book.unfundedClaims() + (due ? 0 : debt),
            vault.idle() + venue.deployedValueUsd(),
            "identity with the pool's debt"
        );
    }
}
