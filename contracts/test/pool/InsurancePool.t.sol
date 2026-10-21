// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {InsurancePool} from "../../src/InsurancePool.sol";
import {IInsurancePool} from "../../src/interfaces/IInsurancePool.sol";
import {PoolFixture} from "./utils/PoolFixture.sol";

/// @notice InsurancePool unit and fuzz tests (POOL-1..POOL-8, POOL-10, docs/INVARIANTS.md).
contract InsurancePoolTest is PoolFixture {
    function setUp() public {
        _deployPool();
        _registerBook(1);
        _registerBook(2);
        _registerBook(3);
        _registerBook(4);
    }

    /// @dev Depositors 90k + slice 10k (the slice at its 10% target): T = 100k.
    function _fund() internal returns (uint256 aliceShares) {
        _seedFirstLoss(10_000 * U);
        aliceShares = _deposit(alice, 90_000 * U);
    }

    // ------------------------------------------------------------------ initialization

    function test_initialize() public view {
        assertEq(pool.asset(), address(usdc));
        assertEq(pool.name(), "BookRunner Insurance Pool USDG");
        assertEq(pool.symbol(), "ibUSDG");
        assertEq(pool.decimals(), 12);
        assertEq(pool.config(), address(cfg));
        (uint16 floor, uint16 cap, uint16 buffer, uint16 flTarget, uint32 cooldown, uint32 len, uint32 grace,) =
            pool.params();
        assertEq(floor, 1200);
        assertEq(cap, 3000);
        assertEq(buffer, 2000);
        assertEq(flTarget, 1000);
        assertEq(cooldown, 7 days);
        assertEq(len, 7 days);
        assertEq(grace, 1 days);
        (uint64 e, uint64 ends,,,) = pool.queue();
        assertEq(e, 0);
        assertEq(ends % 7 days, 0, "epochs on the Unix grid");
        assertGt(ends, block.timestamp);
        assertLe(ends, block.timestamp + 7 days);
    }

    function test_initialize_lockedAndOnce() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        poolImpl.initialize(address(cfg));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        pool.initialize(address(cfg));
    }

    function test_upgrade_onlyTimelock() public {
        InsurancePool next = new InsurancePool();
        vm.prank(alice);
        vm.expectRevert(InsurancePool.NotTimelock.selector);
        pool.upgradeToAndCall(address(next), "");
        vm.prank(timelock);
        pool.upgradeToAndCall(address(next), "");
    }

    // ------------------------------------------------------------------ queued deposits

    function test_deposit_queued_mintedAtProcessing_startsCooldown() public {
        uint256 id = _requestDeposit(alice, 1000 * U);
        assertEq(pool.totalAssets(), 0, "not in the pool until processed");
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.EpochNotProcessed.selector, 0));
        pool.claimDeposit(id);
        uint64 e = _process();
        assertEq(e, 0);
        vm.prank(carol); // anyone may claim for the owner
        uint256 shares = pool.claimDeposit(id);
        assertEq(shares, 1000e12, "1 USDC = 1 share (12 decimals)");
        assertEq(pool.balanceOf(alice), shares);
        assertEq(pool.totalAssets(), 1000 * U);
        assertEq(pool.cooldownEnds(alice), pool.epochInfo(0).endsAt + 7 days);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.DepositDone.selector, id));
        pool.claimDeposit(id);
        _checkLedger();
    }

    function test_deposit_cancelOnlyBeforeTheEpochEnd() public {
        uint256 id = _requestDeposit(alice, 1000 * U);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.NotOwner.selector, bob));
        pool.cancelDeposit(id);
        vm.prank(alice);
        pool.cancelDeposit(id);
        assertEq(usdc.balanceOf(alice), 1000 * U);
        uint256 id2 = _requestDeposit(alice, 500 * U);
        // once the epoch has ended (its price may be known) it can no longer be cancelled, even before processing
        uint256 ends = pool.epochEnd(0);
        vm.warp(ends);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.EpochEnded.selector, 0, ends));
        pool.cancelDeposit(id2);
        _process();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.EpochAlreadyProcessed.selector, 0));
        pool.cancelDeposit(id2);
        _checkLedger();
    }

    function test_directErc4626Entry_andExit_revert() public {
        _deposit(alice, 100 * U);
        assertEq(pool.maxDeposit(alice), 0);
        assertEq(pool.maxMint(alice), 0);
        assertEq(pool.maxWithdraw(alice), 0);
        assertEq(pool.maxRedeem(alice), 0);
        vm.startPrank(alice);
        vm.expectRevert(InsurancePool.QueuedOnly.selector);
        pool.deposit(1, alice);
        vm.expectRevert(InsurancePool.QueuedOnly.selector);
        pool.mint(1, alice);
        vm.expectRevert(InsurancePool.QueuedOnly.selector);
        pool.withdraw(1, alice, alice);
        vm.expectRevert(InsurancePool.QueuedOnly.selector);
        pool.redeem(1, alice, alice);
        vm.stopPrank();
    }

    function test_deposit_pausedByGuardian_exitsNot() public {
        uint256 shares = _deposit(alice, 100 * U);
        vm.prank(guardian);
        pool.setPaused(true, true);
        usdc.mint(bob, 10 * U);
        vm.startPrank(bob);
        usdc.approve(address(pool), 10 * U);
        vm.expectRevert(InsurancePool.DepositsPaused.selector);
        pool.requestDeposit(10 * U);
        vm.stopPrank();
        // exits are never paused
        uint256 id = _request(alice, shares);
        _processThrough(id);
        pool.claim(id);
        assertEq(usdc.balanceOf(alice), 100 * U);
    }

    /// @notice Inflation attack: a donation never moves the price (tracked cash) and the 6-decimal virtual offset
    ///         keeps a 1-unit first deposit from rounding a victim's deposit away.
    function test_inflationAttack_donationIgnored() public {
        _deposit(bob, 1); // attacker: 1 unit
        usdc.mint(address(pool), 1_000_000 * U); // donation
        assertEq(pool.totalAssets(), 1, "donation not counted");
        uint256 shares = _deposit(alice, 1000 * U);
        assertApproxEqRel(pool.convertToAssets(shares), 1000 * U, 1e12, "victim keeps the value of the deposit");
        _checkLedger();
    }

    // ------------------------------------------------------------------ transfers and the cooldown

    function test_transfer_blockedInCooldown_thenFree() public {
        uint256 shares = _deposit(alice, 100 * U);
        uint256 until = pool.cooldownEnds(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.SharesInCooldown.selector, alice, until));
        pool.transfer(bob, shares);
        vm.warp(until);
        vm.prank(alice);
        pool.transfer(bob, shares);
        assertEq(pool.balanceOf(bob), shares);
        // receiving shares does not start a cooldown
        vm.prank(bob);
        pool.transfer(carol, shares / 2);
        vm.prank(carol);
        vm.expectRevert(InsurancePool.DirectEscrow.selector);
        pool.transfer(address(pool), 1);
    }

    // ------------------------------------------------------------------ the epoch gate (audit fix round 1, I-2)

    function test_process_waitsForEveryActiveBookMark_thenGrace() public {
        _fund();
        _allocate(1, 25_000 * U);
        uint256 id = _requestDeposit(bob, 1_000 * U);
        (, uint64 ends,,,) = pool.queue();
        vm.warp(ends);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.BooksNotMarked.selector, 1, 1, uint256(ends) + 1 days));
        pool.processEpoch();
        // a mark after the epoch end opens it
        _markValue(1, 25_000 * U);
        pool.processEpoch();
        assertGt(pool.claimDeposit(id), 0);
        // no mark at all: after the grace period it still goes ahead (exits are never blocked), flagged stale
        _requestDeposit(bob, 1_000 * U);
        (, ends,,,) = pool.queue();
        vm.warp(uint256(ends) + 1 days);
        vm.expectEmit(true, false, false, true, address(pool));
        emit IInsurancePool.EpochProcessedStale(2, 1);
        pool.processEpoch();
    }

    /// @notice An exit cannot dodge a loss marked after its epoch's end: processing waits for the mark.
    function test_exitCannotDodgeALossMarkedAfterTheEpochEnd() public {
        uint256 shares = _fund();
        _allocate(1, 25_000 * U);
        uint256 id = _request(alice, shares);
        uint64 target = pool.requestInfo(id).epoch;
        // walk to the request's epoch end (marking at each step, nothing lost yet)
        while (_procEpoch() < target) _process();
        vm.warp(pool.epochEnd(target));
        // the book is exhausted at the epoch end (its loss is not marked yet): nobody can process ahead of the mark
        vm.expectRevert();
        pool.processEpoch();
        _markValue(1, 5_000 * U); // 20k lost: slice 10k, depositors 10k
        pool.processEpoch();
        assertApproxEqAbs(pool.claimable(id), 75_000 * U - 0, 2, "the free 75k at the post-loss price");
        assertLt(pool.convertToAssets(shares), 90_000 * U - 9_000 * U, "alice's shares bore the loss");
    }

    /// @notice A recovery known before an epoch is processed cannot be bought cheaply: the deposit is priced after it.
    function test_knownRecoveryCannotBeBoughtCheaply() public {
        _fund();
        _allocate(1, 25_000 * U);
        _markValue(1, 5_000 * U); // the book was exhausted: 20k lost (slice 10k, depositors 10k)
        uint256 priceLow = pool.convertToAssets(1e12);
        uint256 id = _requestDeposit(bob, 10_000 * U);
        (, uint64 ends,,,) = pool.queue();
        vm.warp(ends);
        _markValue(1, 25_000 * U); // it recovered (marked after the epoch end, before processing)
        pool.processEpoch();
        uint256 shares = pool.claimDeposit(id);
        assertGt(pool.convertToAssets(1e12), priceLow, "recovered before bob's shares were priced");
        assertApproxEqAbs(pool.convertToAssets(shares), 10_000 * U, 2, "bob got no windfall");
        _checkLedger();
    }

    // ------------------------------------------------------------------ withdrawals

    function test_request_inCooldown_queuedAfterIt_neverRefused() public {
        uint256 shares = _deposit(alice, 100 * U);
        uint256 cd = pool.cooldownEnds(alice);
        vm.prank(guardian);
        pool.setPaused(true, true);
        uint256 id = _request(alice, shares);
        assertEq(pool.balanceOf(address(pool)), shares, "escrowed");
        uint256 end = pool.epochEnd(pool.requestInfo(id).epoch);
        assertGe(end, cd, "after the cooldown");
        assertLt(end, cd + 7 days, "the first such epoch");
        _processThrough(id);
        assertEq(pool.claim(id), 100 * U);
    }

    function test_fill_priceUnchanged_claimProRata() public {
        _seedFirstLoss(40 * U);
        uint256 aliceShares = _deposit(alice, 300 * U);
        uint256 bobShares = _deposit(bob, 100 * U);
        uint256 a = _request(alice, aliceShares / 3);
        uint256 b = _request(bob, bobShares);
        uint256 priceBefore = pool.convertToAssets(1e12);
        _processThrough(b);
        _processThrough(a);
        assertGe(pool.convertToAssets(1e12), priceBefore, "price never falls on a fill");
        assertEq(pool.claim(a), 100 * U);
        assertEq(pool.claim(b), 100 * U);
        _checkLedger();
    }

    function test_partialFill_restAtNextProcessing_proRata() public {
        _seedFirstLoss(12_000 * U);
        uint256 aShares = _deposit(alice, 50_000 * U);
        uint256 bShares = _deposit(bob, 50_000 * U);
        vm.prank(timelock);
        pool.setParam("bufferBps", 0);
        _allocate(1, 33_000 * U); // cap 30% of 112k = 33.6k
        _allocate(2, 33_000 * U, bytes32("TSLA")); // free 46k
        uint256 a = _request(alice, aShares);
        uint256 b = _request(bob, bShares);
        _processThrough(a);
        assertApproxEqAbs(pool.claimable(a), 23_000 * U, 2, "half of the 46k free");
        assertApproxEqAbs(pool.claimable(b), 23_000 * U, 2);
        _repay(1, 33_000 * U);
        assertApproxEqAbs(pool.claimable(a), 23_000 * U, 2, "no fill between processings");
        _process();
        assertApproxEqAbs(pool.claimable(a), 39_500 * U, 2);
        _repay(2, 33_000 * U);
        _process();
        assertApproxEqAbs(pool.claim(a), 50_000 * U, 2);
        assertApproxEqAbs(pool.claim(b), 50_000 * U, 2);
        _checkLedger();
    }

    function test_claim_unknownRequest() public {
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.UnknownRequest.selector, 9));
        pool.claim(9);
    }

    /// @notice An idle queue (nothing queued) catches up in one step: a year without activity never blocks anything.
    function test_idleQueue_catchesUpInOneStep() public {
        uint256 shares = _fund();
        vm.warp(block.timestamp + 365 days);
        _allocate(1, 10_000 * U);
        uint256 id = _request(alice, shares);
        (uint64 e, uint64 ends,,,) = pool.queue();
        assertGt(ends, block.timestamp);
        assertEq(pool.requestInfo(id).epoch, e, "the current epoch (cooldown long over)");
    }

    // ------------------------------------------------------------------ allocations

    function test_allocate_sendsToVault_recordsBook() public {
        _fund();
        (address book, address vault, address router) = _bookAddrs(1);
        vm.expectEmit(true, true, true, true, address(pool));
        emit IInsurancePool.Allocated(1, book, vault, MKT, 25_000 * U);
        _allocate(1, 25_000 * U);
        assertEq(usdc.balanceOf(vault), 25_000 * U);
        IInsurancePool.BookPosition memory p = pool.bookPosition(1);
        assertEq(p.book, book);
        assertEq(p.vault, vault);
        assertEq(p.router, router);
        assertEq(p.market, MKT);
        assertEq(p.allocation, 25_000 * U);
        assertEq(p.claim, 25_000 * U);
        assertTrue(p.active);
        assertEq(pool.activeBooks().length, 1);
        assertEq(pool.marketAllocated(MKT), 25_000 * U);
        assertEq(pool.totalAssets(), 90_000 * U, "allocation never moves the price");
        assertEq(pool.utilisationBps(), 2500);
        _checkLedger();
    }

    function test_allocate_onlyFactoryBook_once() public {
        _fund();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.NotBook.selector, 1, alice));
        pool.allocate(1, 1 * U, MKT);
        _allocate(1, 1 * U);
        (address book,,) = _bookAddrs(1);
        vm.prank(book);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.AlreadyAllocated.selector, 1));
        pool.allocate(1, 1 * U, MKT);
    }

    /// @notice The cap is per market: the books on one underlying share it (minor m-1).
    function test_allocate_perMarketCap_acrossBooks() public {
        _fund();
        assertEq(pool.maxAllocation(1, MKT), 30_000 * U);
        _allocate(1, 20_000 * U);
        assertEq(pool.maxAllocation(2, MKT), 10_000 * U, "the second NVDA book shares the 30%");
        (address book2,,) = _bookAddrs(2);
        vm.prank(book2);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.OverMarketCap.selector, 10_001 * U, 10_000 * U));
        pool.allocate(2, 10_001 * U, MKT);
        _allocate(2, 10_000 * U);
        _allocate(3, 20_000 * U, bytes32("TSLA")); // another market has its own room
        // a final mark frees the market's room
        (address book1,,) = _bookAddrs(1);
        vm.prank(book1);
        pool.markBook(1, 20_000 * U, uint64(block.timestamp), true);
        assertEq(pool.marketAllocated(MKT), 10_000 * U);
        assertEq(pool.activeBooks().length, 2);
    }

    function test_allocate_keepsBuffer() public {
        _seedFirstLoss(20_000 * U);
        _deposit(alice, 180_000 * U); // T 200k: cap 60k, buffer 40k
        _allocate(1, 60_000 * U);
        _allocate(2, 60_000 * U, bytes32("TSLA"));
        assertEq(pool.maxAllocation(3, bytes32("AAPL")), 40_000 * U, "free 80k - buffer 40k");
        (address book3,,) = _bookAddrs(3);
        vm.prank(book3);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.InsufficientFreeLiquidity.selector, 40_001 * U, 40_000 * U));
        pool.allocate(3, 40_001 * U, bytes32("AAPL"));
    }

    /// @notice New allocations need the first-loss slice at its target; exits never do (minor m-3).
    function test_allocate_needsFirstLossAtTarget() public {
        uint256 shares = _deposit(alice, 100_000 * U);
        assertEq(pool.maxAllocation(1, MKT), 0);
        (address book,,) = _bookAddrs(1);
        vm.prank(book);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.FirstLossBelowTarget.selector, 0, 10_000 * U));
        pool.allocate(1, 1 * U, MKT);
        uint256 id = _request(alice, shares);
        _processThrough(id);
        assertEq(pool.claim(id), 100_000 * U, "exits never need the slice");
    }

    function test_allocate_refusedWhileWithdrawalsDue() public {
        uint256 shares = _fund();
        uint256 id = _request(alice, shares / 2);
        vm.warp(pool.epochEnd(pool.requestInfo(id).epoch));
        (address book,,) = _bookAddrs(1);
        vm.prank(book);
        vm.expectRevert(InsurancePool.WithdrawalsDue.selector);
        pool.allocate(1, 1 * U, MKT);
    }

    function test_allocate_paused() public {
        _fund();
        vm.prank(guardian);
        pool.setPaused(false, true);
        assertEq(pool.maxAllocation(1, MKT), 0);
        (address book,,) = _bookAddrs(1);
        vm.prank(book);
        vm.expectRevert(InsurancePool.AllocationsPaused.selector);
        pool.allocate(1, 1 * U, MKT);
    }

    // ------------------------------------------------------------------ marks: losses, first-loss slice, recovery

    function test_markLoss_firstLossAbsorbsFirst() public {
        _fund();
        _allocate(1, 25_000 * U);
        uint256 priceBefore = pool.convertToAssets(1e12);
        vm.expectEmit(true, false, false, true, address(pool));
        emit IInsurancePool.LossReported(1, 6_000 * U, 6_000 * U, 0, 19_000 * U);
        _markValue(1, 19_000 * U);
        assertEq(pool.firstLossAssets(), 4_000 * U);
        assertEq(pool.convertToAssets(1e12), priceBefore, "depositors untouched while the slice lasts");
        _markValue(1, 10_000 * U); // 4k slice, 5k depositors
        assertEq(pool.firstLossAssets(), 0);
        assertEq(pool.totalAssets(), 85_000 * U);
        IInsurancePool.BookPosition memory p = pool.bookPosition(1);
        assertEq(p.lossFirstLoss, 10_000 * U);
        assertEq(p.lossDepositors, 5_000 * U);
        assertEq(p.allocation - p.claim, p.lossFirstLoss + p.lossDepositors, "position identity");
        _checkLedger();
    }

    function test_markRecovery_restoresDepositorsFirst_thenSlice() public {
        _fund();
        _allocate(1, 25_000 * U);
        _markValue(1, 10_000 * U); // slice 10k, depositors 5k
        _markValue(1, 17_000 * U);
        assertEq(pool.totalAssets(), 90_000 * U, "depositors restored first");
        assertEq(pool.firstLossAssets(), 2_000 * U);
        _markValue(1, 25_000 * U);
        assertEq(pool.firstLossAssets(), 10_000 * U);
        (address book,,) = _bookAddrs(1);
        vm.prank(book);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.ExceedsAllocation.selector, 25_001 * U, 25_000 * U));
        pool.markBook(1, 25_001 * U, 0, false);
        _checkLedger();
    }

    function test_markBook_auth() public {
        _fund();
        _allocate(1, 25_000 * U);
        (address book2,,) = _bookAddrs(2);
        vm.prank(book2);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.NotBook.selector, 1, book2));
        pool.markBook(1, 1, 0, false);
        vm.prank(book2);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.NotBook.selector, 2, book2));
        pool.markBook(2, 0, 0, false);
    }

    function test_repay_onlyVault_overpaymentIsARecoveryFirst() public {
        _fund();
        _allocate(1, 25_000 * U);
        _markValue(1, 15_000 * U); // 10k lost (the slice)
        (address book,,) = _bookAddrs(1);
        vm.prank(book);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.NotBookVault.selector, 1, book));
        pool.repay(1, 1);
        _repay(1, 20_000 * U); // the book could pay more than its last mark said: 5k recovered first
        IInsurancePool.BookPosition memory p = pool.bookPosition(1);
        assertEq(p.claim, 0);
        assertEq(p.allocation, 5_000 * U, "the loss left");
        assertEq(pool.firstLossAssets(), 5_000 * U);
        assertEq(pool.marketAllocated(MKT), 5_000 * U);
        (, address vault,) = _bookAddrs(1);
        vm.startPrank(vault);
        usdc.approve(address(pool), 6_000 * U);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.ExceedsAllocation.selector, 6_000 * U, 5_000 * U));
        pool.repay(1, 6_000 * U);
        vm.stopPrank();
        _checkLedger();
    }

    // ------------------------------------------------------------------ premium

    function test_premium_proRataSliceAndDepositors() public {
        _fund();
        _allocate(1, 25_000 * U);
        (,, address router) = _bookAddrs(1);
        usdc.mint(router, 1_000 * U);
        vm.startPrank(router);
        usdc.approve(address(pool), 1_000 * U);
        vm.expectEmit(true, false, false, true, address(pool));
        emit IInsurancePool.PremiumReceived(1, 1_000 * U, 100 * U);
        pool.notifyPremium(1, 1_000 * U);
        vm.stopPrank();
        assertEq(pool.firstLossAssets(), 10_100 * U);
        assertEq(pool.totalAssets(), 90_900 * U);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.NotBookRouter.selector, 1, alice));
        pool.notifyPremium(1, 1);
        _checkLedger();
    }

    function test_premium_andRecovery_withNoDepositorsLeft_goToSlice() public {
        uint256 shares = _fund();
        _allocate(1, 25_000 * U);
        _markValue(1, 5_000 * U); // 20k lost: slice 10k, depositors 10k
        uint256 id = _request(alice, shares);
        _processThrough(id); // 75k free of alice's 80k
        _repay(1, 5_000 * U);
        _process();
        pool.claim(id);
        assertEq(pool.totalSupply(), 0);
        _markValue(1, 10_000 * U); // a later recovery
        _premium(1, 500 * U);
        assertEq(pool.firstLossAssets(), 10_500 * U, "no windfall for the next depositor");
        uint256 s2 = _deposit(bob, 100 * U);
        assertApproxEqAbs(pool.convertToAssets(s2), 100 * U, 1);
    }

    // ------------------------------------------------------------------ first-loss slice

    function test_firstLoss_withdraw_onlyTimelock_keepsTarget_notWhileDue() public {
        _seedFirstLoss(20_000 * U);
        uint256 shares = _deposit(alice, 90_000 * U);
        vm.prank(alice);
        vm.expectRevert(InsurancePool.NotTimelock.selector);
        pool.withdrawFirstLoss(1, alice);
        // after withdrawing x: 20k - x >= 10% of (110k - x)  =>  x <= 10k
        vm.prank(timelock);
        vm.expectRevert();
        pool.withdrawFirstLoss(10_001 * U, treasury);
        uint256 id = _request(alice, shares / 10);
        vm.warp(pool.epochEnd(pool.requestInfo(id).epoch));
        vm.prank(timelock);
        vm.expectRevert(InsurancePool.WithdrawalsDue.selector);
        pool.withdrawFirstLoss(1, treasury);
        _processThrough(id);
        vm.prank(timelock);
        pool.withdrawFirstLoss(9_000 * U, treasury);
        assertEq(usdc.balanceOf(treasury), 9_000 * U);
        _checkLedger();
    }

    // ------------------------------------------------------------------ governance

    function test_params_boundsAndAuth() public {
        vm.prank(alice);
        vm.expectRevert(InsurancePool.NotTimelock.selector);
        pool.setParam("bufferBps", 1000);
        vm.startPrank(timelock);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.ParamOutOfRange.selector, bytes32("premiumFloorBps"), 5001));
        pool.setParam("premiumFloorBps", 5001);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.ParamOutOfRange.selector, bytes32("marketCapBps"), 99));
        pool.setParam("marketCapBps", 99);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.ParamOutOfRange.selector, bytes32("bufferBps"), 9001));
        pool.setParam("bufferBps", 9001);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.ParamOutOfRange.selector, bytes32("cooldown"), 31 days));
        pool.setParam("cooldown", 31 days);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.ParamOutOfRange.selector, bytes32("epochLength"), 1 days - 1));
        pool.setParam("epochLength", 1 days - 1);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.ParamOutOfRange.selector, bytes32("processGrace"), 59 minutes));
        pool.setParam("processGrace", 59 minutes);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.ParamOutOfRange.selector, bytes32("processGrace"), 8 days));
        pool.setParam("processGrace", 8 days);
        vm.expectRevert(
            abi.encodeWithSelector(InsurancePool.ParamOutOfRange.selector, bytes32("firstLossTargetBps"), 5001)
        );
        pool.setParam("firstLossTargetBps", 5001);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.UnknownParam.selector, bytes32("nope")));
        pool.setParam("nope", 1);
        pool.setParam("premiumFloorBps", 1500);
        vm.stopPrank();
        assertEq(pool.premiumFloorBps(), 1500);
    }

    /// @notice An epoch-length change waits for an idle queue: it never moves a queued request (minor m-6).
    function test_epochLength_pendingUntilIdle_neverMovesARequest() public {
        uint256 shares = _deposit(alice, 1_000 * U);
        uint256 id = _request(alice, shares);
        uint256 end = pool.epochEnd(pool.requestInfo(id).epoch);
        vm.prank(timelock);
        pool.setParam("epochLength", 1 days);
        (,,,,, uint32 len,, uint32 pending) = pool.params();
        assertEq(len, 7 days);
        assertEq(pending, 1 days);
        assertEq(pool.epochEnd(pool.requestInfo(id).epoch), end, "the queued request keeps its epoch end");
        _processThrough(id);
        pool.claim(id);
        vm.warp(block.timestamp + 8 days);
        _requestDeposit(bob, 1 * U); // the idle queue applies the new length
        (,,,,, len,, pending) = pool.params();
        assertEq(len, 1 days);
        assertEq(pending, 0);
        (, uint64 ends,,,) = pool.queue();
        assertEq(ends % 1 days, 0);
    }

    function test_pause_guardianOnlyAdds_timelockLifts() public {
        vm.prank(alice);
        vm.expectRevert(InsurancePool.NotGuardianOrTimelock.selector);
        pool.setPaused(true, true);
        vm.prank(guardian);
        pool.setPaused(true, false);
        vm.prank(guardian);
        vm.expectRevert(InsurancePool.NotTimelock.selector);
        pool.setPaused(false, false);
        vm.prank(guardian);
        pool.setPaused(true, true);
        vm.prank(timelock);
        pool.setPaused(false, false);
        (bool d, bool a) = pool.paused();
        assertFalse(d);
        assertFalse(a);
    }

    // ------------------------------------------------------------------ exits never blocked (fuzz)

    /// @notice POOL-3: requestWithdraw is never refused and the exit always completes, whatever the pauses, the
    ///         cooldown and whether the books mark at all (the grace period).
    function testFuzz_exitsNeverBlocked(uint96 amount, uint32 waitBefore, bool pauseDeposits, bool pauseAlloc, bool marks)
        public
    {
        amount = uint96(bound(amount, 1 * U, 10_000_000 * U));
        _seedFirstLoss(uint256(amount) / 5 + 1);
        uint256 shares = _deposit(alice, amount);
        _allocate(1, Math_min(pool.maxAllocation(1, MKT), uint256(amount) / 10 + 1));
        vm.warp(block.timestamp + bound(waitBefore, 0, 40 days));
        vm.prank(guardian);
        pool.setPaused(pauseDeposits, pauseAlloc);
        uint256 id = _request(alice, shares);
        uint64 target = pool.requestInfo(id).epoch;
        for (uint256 i; i < 16 && _procEpoch() <= target; ++i) {
            (, uint64 ends,,,) = pool.queue();
            if (marks) {
                if (block.timestamp < ends) vm.warp(ends);
                _markAllFresh();
            } else {
                vm.warp(uint256(ends) + 1 days); // nobody marks: the grace period
            }
            pool.processEpoch();
        }
        assertGt(pool.claim(id), 0, "paid (free liquidity)");
        _checkLedger();
    }

    /// @notice POOL-5: the share price never moves on deposit processing or a fill (rounding in the pool's favour).
    function testFuzz_priceStableOnDepositAndFill(uint96 a, uint96 b, uint96 premium, uint96 loss) public {
        a = uint96(bound(a, 1 * U, 1_000_000 * U));
        b = uint96(bound(b, 1, 1_000_000 * U));
        _seedFirstLoss(uint256(a) / 5 + 1);
        _deposit(alice, a);
        _allocate(1, Math_min(pool.maxAllocation(1, MKT), uint256(a) / 4 + 1));
        _premium(1, bound(premium, 0, a));
        uint256 claim1 = pool.bookPosition(1).claim;
        _markValue(1, claim1 - bound(loss, 0, claim1));
        uint256 p0 = pool.convertToAssets(1e12);
        uint256 dep = _requestDeposit(bob, b);
        _process();
        uint256 p1 = pool.convertToAssets(1e12);
        assertGe(p1 + 1, p0, "deposit: price not lower (1 unit of rounding)");
        assertLe(p1, p0 + 1 + p0 / 1e6, "deposit: price not higher");
        pool.claimDeposit(dep);
        uint256 id = _request(alice, pool.balanceOf(alice));
        uint256 p2 = pool.convertToAssets(1e12);
        _processThrough(id);
        assertGe(pool.convertToAssets(1e12) + 1, p2, "fill: price not lower");
        _checkLedger();
    }

    function Math_min(uint256 x, uint256 y) private pure returns (uint256) {
        return x < y ? x : y;
    }

    function test_request_moreThanBalance_reverts() public {
        uint256 shares = _deposit(alice, 1 * U);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, shares, shares + 1)
        );
        pool.requestWithdraw(shares + 1);
    }
}
