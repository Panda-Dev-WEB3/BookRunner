// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {InsurancePool} from "../../src/InsurancePool.sol";
import {IInsurancePool} from "../../src/interfaces/IInsurancePool.sol";
import {PoolFixture} from "./utils/PoolFixture.sol";

/// @notice InsurancePool unit and fuzz tests (POOL-1..POOL-8, docs/INVARIANTS.md).
contract InsurancePoolTest is PoolFixture {
    function setUp() public {
        _deployPool();
        _registerBook(1);
        _registerBook(2);
        _registerBook(3);
        _registerBook(4);
    }

    // ------------------------------------------------------------------ initialization

    function test_initialize() public view {
        assertEq(pool.asset(), address(usdc));
        assertEq(pool.name(), "BookRunner Insurance Pool USDG");
        assertEq(pool.symbol(), "ibUSDG");
        assertEq(pool.decimals(), 12);
        assertEq(pool.config(), address(cfg));
        (uint16 floor, uint16 cap, uint16 buffer, uint16 flTarget, uint32 cooldown, uint32 len) = pool.params();
        assertEq(floor, 1200);
        assertEq(cap, 3000);
        assertEq(buffer, 2000);
        assertEq(flTarget, 1000);
        assertEq(cooldown, 7 days);
        assertEq(len, 7 days);
        (uint64 e, uint64 ends,,) = pool.queue();
        assertEq(e, 0);
        assertEq(ends, block.timestamp + 7 days);
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

    // ------------------------------------------------------------------ deposits

    function test_deposit_mintsAtPrice_startsCooldown() public {
        uint256 shares = _deposit(alice, 1000 * U);
        assertEq(shares, 1000e12, "1 USDC = 1 share (12 decimals)");
        assertEq(pool.totalAssets(), 1000 * U);
        assertEq(pool.cooldownEnds(alice), block.timestamp + 7 days);
        _checkLedger();
    }

    function test_deposit_onlyToSelf() public {
        usdc.mint(alice, 10 * U);
        vm.startPrank(alice);
        usdc.approve(address(pool), 10 * U);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.ReceiverNotCaller.selector, bob));
        pool.deposit(10 * U, bob);
        vm.stopPrank();
    }

    function test_deposit_pausedByGuardian_exitsNot() public {
        uint256 shares = _deposit(alice, 100 * U);
        vm.prank(guardian);
        pool.setPaused(true, true);
        assertEq(pool.maxDeposit(alice), 0);
        usdc.mint(bob, 10 * U);
        vm.startPrank(bob);
        usdc.approve(address(pool), 10 * U);
        vm.expectRevert();
        pool.deposit(10 * U, bob);
        vm.stopPrank();
        // exits are never paused
        uint256 id = _request(alice, shares);
        _warpPastEpochOf(id);
        pool.claim(id);
        assertEq(usdc.balanceOf(alice), 100 * U);
    }

    function test_noInstantWithdraw() public {
        _deposit(alice, 100 * U);
        vm.warp(block.timestamp + 30 days);
        assertEq(pool.maxWithdraw(alice), 0);
        assertEq(pool.maxRedeem(alice), 0);
        vm.startPrank(alice);
        vm.expectRevert(InsurancePool.QueuedWithdrawalsOnly.selector);
        pool.withdraw(1, alice, alice);
        vm.expectRevert(InsurancePool.QueuedWithdrawalsOnly.selector);
        pool.redeem(1, alice, alice);
        vm.stopPrank();
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
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(InsurancePool.SharesInCooldown.selector, alice, block.timestamp + 7 days)
        );
        pool.transfer(bob, shares);
        vm.warp(block.timestamp + 7 days);
        vm.prank(alice);
        pool.transfer(bob, shares);
        assertEq(pool.balanceOf(bob), shares);
        // receiving shares does not start a cooldown: bob may move them on at once
        vm.prank(bob);
        pool.transfer(carol, shares / 2);
    }

    function test_transfer_directToPool_reverts() public {
        uint256 shares = _deposit(alice, 100 * U);
        vm.warp(block.timestamp + 7 days);
        vm.prank(alice);
        vm.expectRevert(InsurancePool.DirectEscrow.selector);
        pool.transfer(address(pool), shares);
    }

    function test_thirdPartyCannotExtendCooldown() public {
        uint256 shares = _deposit(alice, 100 * U);
        vm.warp(block.timestamp + 7 days);
        // bob cannot deposit for alice, and a fresh deposit of bob's stays bob's
        _deposit(bob, 1 * U);
        assertEq(pool.cooldownEnds(alice), block.timestamp, "alice's cooldown untouched");
        vm.prank(alice);
        pool.transfer(carol, shares);
    }

    // ------------------------------------------------------------------ queue

    function test_request_inCooldown_queuedAfterIt_neverRefused() public {
        uint256 shares = _deposit(alice, 100 * U);
        uint256 t0 = block.timestamp;
        uint256 id = _request(alice, shares);
        InsurancePool.Request memory r = pool.requestInfo(id);
        assertEq(r.owner, alice);
        assertEq(r.shares, shares);
        assertEq(pool.balanceOf(address(pool)), shares, "escrowed");
        // epoch 0 ends at t0 + 7 days == cooldown end: queued there
        assertEq(r.epoch, 0);
        vm.warp(t0 + 7 days - 1);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.NothingToClaim.selector, id));
        pool.claim(id);
        vm.warp(t0 + 7 days);
        assertEq(pool.claim(id), 100 * U);
    }

    function test_request_lateInEpoch_waitsForCooldownEpoch() public {
        vm.warp(block.timestamp + 5 days); // epoch 0 ends in 2 days
        uint256 shares = _deposit(alice, 100 * U);
        uint256 id = _request(alice, shares);
        // cooldown ends in 7 days > epoch 0 end: epoch 1 (ends in 9 days)
        assertEq(pool.requestInfo(id).epoch, 1);
        vm.warp(block.timestamp + 2 days);
        pool.processQueue(10);
        assertEq(pool.claimable(id), 0, "epoch 0 fill does not touch epoch 1");
        vm.warp(block.timestamp + 7 days);
        assertEq(pool.claim(id), 100 * U);
    }

    function test_request_afterCooldown_currentEpoch() public {
        uint256 shares = _deposit(alice, 100 * U);
        vm.warp(block.timestamp + 8 days); // epoch 0 ended, epoch 1 ends at +14d
        uint256 id = _request(alice, shares);
        assertEq(pool.requestInfo(id).epoch, 1);
    }

    function test_fill_priceUnchanged_claimProRata() public {
        _deposit(alice, 300 * U);
        uint256 bobShares = _deposit(bob, 100 * U);
        uint256 aliceShares = pool.balanceOf(alice);
        _seedFirstLoss(40 * U);
        uint256 a = _request(alice, aliceShares / 3);
        uint256 b = _request(bob, bobShares);
        _warpPastEpochOf(a);
        uint256 priceBefore = pool.convertToAssets(1e12);
        pool.processQueue(1);
        assertGe(pool.convertToAssets(1e12), priceBefore, "price never falls on a fill");
        assertEq(pool.claim(a), 100 * U);
        assertEq(pool.claim(b), 100 * U);
        _checkLedger();
    }

    function test_claim_unknownRequest() public {
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.UnknownRequest.selector, 9));
        pool.claim(9);
    }

    /// @notice Losses reported before a request's epoch is filled hit it (it stays exposed until filled).
    function test_lossBeforeFill_hitsQueuedWithdrawal() public {
        uint256 shares = _deposit(alice, 100_000 * U);
        _allocate(1, 25_000 * U);
        uint256 id = _request(alice, shares);
        _loss(1, 10_000 * U); // no first-loss slice: depositors absorb it all
        _warpPastEpochOf(id);
        assertApproxEqAbs(pool.claim(id), 75_000 * U, 2, "the free part, at the post-loss price");
        // the rest fills once the book repays
        _repay(1, 15_000 * U);
        assertApproxEqAbs(pool.claim(id), 15_000 * U, 2);
        assertApproxEqAbs(usdc.balanceOf(alice), 90_000 * U, 2, "alice bore the whole loss (sole depositor)");
        _checkLedger();
    }

    function test_partialFill_thenRestFilledOnRepay_twoRequestsProRata() public {
        uint256 aShares = _deposit(alice, 50_000 * U);
        uint256 bShares = _deposit(bob, 50_000 * U);
        _allocate(1, 30_000 * U); // free 70k
        _allocate(2, 30_000 * U); // free 40k (buffer 20k)
        uint256 a = _request(alice, aShares);
        uint256 b = _request(bob, bShares);
        _warpPastEpochOf(a);
        pool.processQueue(1);
        IInsurancePool.BookPosition memory p1 = pool.bookPosition(1);
        assertEq(p1.claim, 30_000 * U);
        assertApproxEqAbs(pool.claimable(a), 20_000 * U, 2, "half of the 40k free");
        assertApproxEqAbs(pool.claimable(b), 20_000 * U, 2);
        (uint64 e,,,) = pool.queue();
        assertEq(e, 0, "epoch 0 not closed until filled");
        // a later request lands in a later epoch and waits behind epoch 0
        uint256 cShares = _deposit(carol, 10_000 * U);
        uint256 c = _request(carol, cShares);
        assertGt(pool.requestInfo(c).epoch, 0);
        // carol's 10k deposit and the 30k repaid fund the queue first (epoch 0 before carol's own epoch)
        _repay(1, 30_000 * U);
        assertApproxEqAbs(pool.claimable(a), 40_000 * U, 2);
        _repay(2, 30_000 * U);
        assertApproxEqAbs(pool.claim(a), 50_000 * U, 2);
        assertApproxEqAbs(pool.claim(b), 50_000 * U, 2);
        _checkLedger();
    }

    function test_allocate_refusedWhileDueEpochUnfilled() public {
        uint256 shares = _deposit(alice, 100_000 * U);
        _allocate(1, 30_000 * U);
        _request(alice, shares);
        vm.warp(block.timestamp + 7 days);
        (address book2,,) = _bookAddrs(2);
        vm.prank(book2);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.QueueBehind.selector, 0));
        pool.allocate(2, 1 * U);
    }

    /// @notice An idle queue (nothing escrowed) catches up in one step: a year without exits never blocks an
    ///         allocation, and a request after it lands in an epoch ending within one epoch of its cooldown.
    function test_idleQueue_catchesUpInOneStep() public {
        uint256 shares = _deposit(alice, 100_000 * U);
        vm.warp(block.timestamp + 365 days);
        _allocate(1, 10_000 * U);
        (uint64 e, uint64 ends,,) = pool.queue();
        assertEq(e, 52, "52 empty weekly epochs skipped");
        assertGt(ends, block.timestamp);
        assertLe(ends, block.timestamp + 7 days);
        uint256 id = _request(alice, shares);
        assertEq(pool.requestInfo(id).epoch, 52);
    }

    // ------------------------------------------------------------------ allocations

    function test_allocate_sendsToVault_recordsBook() public {
        _deposit(alice, 100_000 * U);
        (address book, address vault, address router) = _bookAddrs(1);
        vm.expectEmit(true, true, false, true, address(pool));
        emit IInsurancePool.Allocated(1, book, vault, 25_000 * U, 100_000 * U);
        _allocate(1, 25_000 * U);
        assertEq(usdc.balanceOf(vault), 25_000 * U);
        IInsurancePool.BookPosition memory p = pool.bookPosition(1);
        assertEq(p.book, book);
        assertEq(p.vault, vault);
        assertEq(p.router, router);
        assertEq(p.allocation, 25_000 * U);
        assertEq(p.claim, 25_000 * U);
        assertEq(pool.totalAssets(), 100_000 * U, "allocation never moves the price");
        assertEq(pool.freeLiquidity(), 75_000 * U);
        assertEq(pool.utilisationBps(), 2500);
        _checkLedger();
    }

    function test_allocate_onlyFactoryBook_once() public {
        _deposit(alice, 100_000 * U);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.NotBook.selector, 1, alice));
        pool.allocate(1, 1 * U);
        _allocate(1, 1 * U);
        (address book,,) = _bookAddrs(1);
        vm.prank(book);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.AlreadyAllocated.selector, 1));
        pool.allocate(1, 1 * U);
    }

    function test_allocate_perMarketCap() public {
        _deposit(alice, 100_000 * U);
        assertEq(pool.maxAllocation(1), 30_000 * U);
        (address book,,) = _bookAddrs(1);
        vm.prank(book);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.OverMarketCap.selector, 30_001 * U, 30_000 * U));
        pool.allocate(1, 30_001 * U);
        _allocate(1, 30_000 * U);
    }

    function test_allocate_keepsBuffer() public {
        _deposit(alice, 100_000 * U);
        _allocate(1, 30_000 * U);
        _allocate(2, 30_000 * U);
        // free 40k, buffer 20k: 20k left
        assertEq(pool.maxAllocation(3), 20_000 * U);
        (address book3,,) = _bookAddrs(3);
        vm.prank(book3);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.InsufficientFreeLiquidity.selector, 20_001 * U, 20_000 * U));
        pool.allocate(3, 20_001 * U);
        _allocate(3, 20_000 * U);
        assertEq(pool.freeLiquidity(), 20_000 * U);
    }

    function test_allocate_paused() public {
        _deposit(alice, 100_000 * U);
        vm.prank(guardian);
        pool.setPaused(false, true);
        assertEq(pool.maxAllocation(1), 0);
        (address book,,) = _bookAddrs(1);
        vm.prank(book);
        vm.expectRevert(InsurancePool.AllocationsPaused.selector);
        pool.allocate(1, 1 * U);
    }

    // ------------------------------------------------------------------ losses, first-loss slice, recovery

    function test_loss_firstLossAbsorbsFirst() public {
        _deposit(alice, 90_000 * U);
        _seedFirstLoss(10_000 * U);
        _allocate(1, 25_000 * U);
        uint256 priceBefore = pool.convertToAssets(1e12);
        vm.expectEmit(true, false, false, true, address(pool));
        emit IInsurancePool.LossReported(1, 6_000 * U, 6_000 * U, 0, 19_000 * U);
        _loss(1, 6_000 * U);
        assertEq(pool.firstLossAssets(), 4_000 * U);
        assertEq(pool.convertToAssets(1e12), priceBefore, "depositors untouched while the slice lasts");
        _loss(1, 9_000 * U); // 4k slice, 5k depositors
        assertEq(pool.firstLossAssets(), 0);
        assertEq(pool.totalAssets(), 85_000 * U);
        IInsurancePool.BookPosition memory p = pool.bookPosition(1);
        assertEq(p.lossFirstLoss, 10_000 * U);
        assertEq(p.lossDepositors, 5_000 * U);
        assertEq(p.allocation - p.claim, p.lossFirstLoss + p.lossDepositors, "position identity");
        _checkLedger();
    }

    function test_recovery_restoresDepositorsFirst_thenSlice() public {
        _deposit(alice, 90_000 * U);
        _seedFirstLoss(10_000 * U);
        _allocate(1, 25_000 * U);
        _loss(1, 15_000 * U); // slice 10k, depositors 5k
        _recovery(1, 7_000 * U);
        assertEq(pool.totalAssets(), 90_000 * U, "depositors restored first");
        assertEq(pool.firstLossAssets(), 2_000 * U);
        _recovery(1, 8_000 * U);
        assertEq(pool.firstLossAssets(), 10_000 * U);
        assertEq(pool.bookPosition(1).claim, 25_000 * U);
        (address book,,) = _bookAddrs(1);
        vm.prank(book);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.ExceedsLosses.selector, 1, 0));
        pool.reportRecovery(1, 1);
        _checkLedger();
    }

    function test_recovery_withNoDepositorsLeft_goesToSlice() public {
        uint256 shares = _deposit(alice, 100_000 * U);
        _allocate(1, 25_000 * U);
        _loss(1, 10_000 * U); // depositors absorb it (no slice)
        uint256 id = _request(alice, shares);
        _warpPastEpochOf(id);
        pool.claim(id); // 75k free
        _repay(1, 15_000 * U); // the rest fills
        pool.claim(id);
        assertEq(pool.totalSupply(), 0);
        _recovery(1, 10_000 * U);
        assertEq(pool.firstLossAssets(), 10_000 * U, "no windfall for the next depositor");
        uint256 s2 = _deposit(bob, 100 * U);
        assertApproxEqAbs(pool.convertToAssets(s2), 100 * U, 1);
        _checkLedger();
    }

    function test_loss_exceedsClaim_andAuth() public {
        _deposit(alice, 100_000 * U);
        _allocate(1, 25_000 * U);
        (address book,,) = _bookAddrs(1);
        vm.prank(book);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.ExceedsClaim.selector, 25_001 * U, 25_000 * U));
        pool.reportLoss(1, 25_001 * U);
        (address book2,,) = _bookAddrs(2);
        vm.prank(book2);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.NotBook.selector, 1, book2));
        pool.reportLoss(1, 1);
        vm.prank(book2); // a book without an allocation
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.NotBook.selector, 2, book2));
        pool.reportLoss(2, 1);
    }

    function test_repay_onlyVault_reducesClaimAndAllocation() public {
        _deposit(alice, 100_000 * U);
        _allocate(1, 25_000 * U);
        _loss(1, 5_000 * U);
        (address book,,) = _bookAddrs(1);
        vm.prank(book);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.NotBookVault.selector, 1, book));
        pool.repay(1, 1);
        (, address vault,) = _bookAddrs(1);
        vm.startPrank(vault);
        usdc.approve(address(pool), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.ExceedsClaim.selector, 20_001 * U, 20_000 * U));
        pool.repay(1, 20_001 * U);
        pool.repay(1, 20_000 * U);
        vm.stopPrank();
        IInsurancePool.BookPosition memory p = pool.bookPosition(1);
        assertEq(p.claim, 0);
        assertEq(p.allocation, 5_000 * U, "the reported loss stays as the book's loss");
        assertEq(pool.totalAssets(), 95_000 * U);
        assertEq(pool.freeLiquidity(), 95_000 * U);
        _checkLedger();
    }

    // ------------------------------------------------------------------ premium

    function test_premium_proRataSliceAndDepositors() public {
        _deposit(alice, 90_000 * U);
        _seedFirstLoss(10_000 * U);
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
        (,, uint256 premiums,) = pool.ledger();
        assertEq(premiums, 1_000 * U);
        _checkLedger();
    }

    function test_premium_onlyRouter_andNoSupplyGoesToSlice() public {
        _deposit(alice, 100_000 * U);
        _allocate(1, 25_000 * U);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.NotBookRouter.selector, 1, alice));
        pool.notifyPremium(1, 1);
        // every depositor leaves: a later premium is the slice's, never a gift to the next depositor
        uint256 id = _request(alice, pool.balanceOf(alice));
        _warpPastEpochOf(id);
        _repay(1, 25_000 * U);
        pool.claim(id);
        assertEq(pool.totalSupply(), 0);
        _premium(1, 500 * U);
        assertEq(pool.firstLossAssets(), 500 * U);
        uint256 shares = _deposit(bob, 100 * U);
        assertApproxEqAbs(pool.convertToAssets(shares), 100 * U, 1, "no windfall for the next depositor");
    }

    // ------------------------------------------------------------------ first-loss slice

    function test_firstLoss_withdraw_onlyTimelock_keepsTarget() public {
        _deposit(alice, 90_000 * U);
        _seedFirstLoss(20_000 * U);
        vm.prank(alice);
        vm.expectRevert(InsurancePool.NotTimelock.selector);
        pool.withdrawFirstLoss(1, alice);
        // after withdrawing x: 20k - x >= 10% of (110k - x)  =>  x <= 10k
        vm.prank(timelock);
        vm.expectRevert();
        pool.withdrawFirstLoss(10_001 * U, treasury);
        vm.prank(timelock);
        pool.withdrawFirstLoss(10_000 * U, treasury);
        assertEq(pool.firstLossAssets(), 10_000 * U);
        assertEq(usdc.balanceOf(treasury), 10_000 * U);
        assertEq(pool.firstLossBps(), 1000);
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

    /// @notice POOL-3: requestWithdraw is never refused and a filled request is always claimable, whatever the
    ///         pauses, the cooldown or the allocations.
    function testFuzz_exitsNeverBlocked(uint96 amount, uint32 waitBefore, bool pauseDeposits, bool pauseAlloc) public {
        amount = uint96(bound(amount, 1 * U, 10_000_000 * U));
        uint256 shares = _deposit(alice, amount);
        _deposit(bob, 1_000 * U);
        vm.warp(block.timestamp + bound(waitBefore, 0, 40 days));
        vm.prank(guardian);
        pool.setPaused(pauseDeposits, pauseAlloc);
        uint256 id = _request(alice, shares);
        _warpPastEpochOf(id);
        uint256 got = pool.claim(id);
        assertApproxEqAbs(got, amount, 1, "full value back");
        _checkLedger();
    }

    function testFuzz_requestNeverLandsInAnEndedEpoch(uint32 t1, uint32 t2) public {
        uint256 shares = _deposit(alice, 1_000 * U);
        vm.warp(block.timestamp + bound(t1, 0, 60 days));
        if (t2 % 2 == 0) pool.processQueue(100);
        uint256 id = _request(alice, shares / 2);
        InsurancePool.Request memory r = pool.requestInfo(id);
        (uint64 e, uint64 ends,,) = pool.queue();
        uint256 end = uint256(ends) + uint256(r.epoch - e) * 7 days;
        assertGt(end, block.timestamp, "epoch ends in the future");
        assertGe(end, pool.cooldownEnds(alice), "after the cooldown");
        assertLe(end, Math_max(block.timestamp, pool.cooldownEnds(alice)) + 7 days, "the first such epoch");
    }

    function Math_max(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a : b;
    }

    /// @notice POOL-5: the share price never moves on a deposit or a fill (rounding only in the pool's favour).
    function testFuzz_priceStableOnDepositAndFill(uint96 a, uint96 b, uint96 premium, uint96 loss) public {
        a = uint96(bound(a, 1 * U, 1_000_000 * U));
        b = uint96(bound(b, 1, 1_000_000 * U));
        _deposit(alice, a);
        _seedFirstLoss(a / 10);
        _allocate(1, Math_min(pool.maxAllocation(1), uint256(a) / 4 + 1));
        _premium(1, bound(premium, 0, a));
        uint256 claim1 = pool.bookPosition(1).claim;
        if (claim1 > 0) _loss(1, bound(loss, 0, claim1 - 1) + 1);
        uint256 p0 = pool.convertToAssets(1e12);
        _deposit(bob, b);
        uint256 p1 = pool.convertToAssets(1e12);
        assertGe(p1 + 1, p0, "deposit: price not lower (1 unit of rounding)");
        assertLe(p1, p0 + 1 + p0 / 1e6, "deposit: price not higher");
        uint256 id = _request(alice, pool.balanceOf(alice));
        _warpPastEpochOf(id);
        uint256 p2 = pool.convertToAssets(1e12);
        pool.processQueue(10);
        uint256 p3 = pool.convertToAssets(1e12);
        assertGe(p3 + 1, p2, "fill: price not lower");
        _checkLedger();
    }

    function Math_min(uint256 x, uint256 y) private pure returns (uint256) {
        return x < y ? x : y;
    }

    // ------------------------------------------------------------------ ERC-20 errors pass through

    function test_request_moreThanBalance_reverts() public {
        uint256 shares = _deposit(alice, 1 * U);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, shares, shares + 1)
        );
        pool.requestWithdraw(shares + 1);
    }
}
