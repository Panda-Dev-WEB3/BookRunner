// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {CoreFixture} from "./utils/CoreFixture.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {BkrnStaking} from "../../src/BkrnStaking.sol";
import {IBkrnStaking} from "../../src/interfaces/IBkrnStaking.sol";

contract BkrnStakingTest is CoreFixture {
    bytes32 internal constant LOCK_A = keccak256("lock-a");
    bytes32 internal constant LOCK_B = keccak256("lock-b");

    // ---------------------------------------------------------------- construction

    function test_constructor() public view {
        assertEq(address(staking.config()), address(config));
        assertEq(address(staking.bkrn()), address(bkrn));
        assertEq(staking.cooldown(), 7 days);
    }

    function test_constructor_reverts() public {
        vm.expectRevert(BkrnStaking.ZeroAddress.selector);
        new BkrnStaking(address(0));
        BookrunnerConfig fresh = new BookrunnerConfig(admin);
        vm.expectRevert(BkrnStaking.ZeroAddress.selector);
        new BkrnStaking(address(fresh)); // bkrn unset
    }

    // ---------------------------------------------------------------- stake / unstake

    function test_stake() public {
        _giveBkrn(alice, 100e18);
        vm.startPrank(alice);
        bkrn.approve(address(staking), 100e18);
        vm.expectEmit(true, false, false, true, address(staking));
        emit IBkrnStaking.Staked(alice, 60e18);
        staking.stake(60e18);
        vm.stopPrank();
        assertEq(staking.stakedOf(alice), 60e18);
        assertEq(staking.availableOf(alice), 60e18);
        assertEq(staking.totalStaked(), 60e18);
        assertEq(bkrn.balanceOf(address(staking)), 60e18);
        assertEq(bkrn.balanceOf(alice), 40e18);
    }

    function test_stake_revertsZero() public {
        vm.expectRevert(BkrnStaking.ZeroAmount.selector);
        vm.prank(alice);
        staking.stake(0);
    }

    function test_stake_revertsWithoutAllowance() public {
        _giveBkrn(alice, 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(staking), 0, 1e18
            )
        );
        vm.prank(alice);
        staking.stake(1e18);
    }

    function test_requestUnstake_and_unstake() public {
        _stake(alice, 100e18);
        uint64 expectedAt = uint64(block.timestamp + 7 days);
        vm.expectEmit(true, false, false, true, address(staking));
        emit IBkrnStaking.UnstakeRequested(alice, 30e18, expectedAt);
        vm.prank(alice);
        staking.requestUnstake(30e18);
        (uint256 pending, uint64 at) = staking.pendingUnstakeOf(alice);
        assertEq(pending, 30e18);
        assertEq(at, expectedAt);
        assertEq(staking.availableOf(alice), 70e18);
        assertEq(staking.stakedOf(alice), 100e18);

        vm.warp(expectedAt - 1);
        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.CooldownActive.selector, expectedAt));
        vm.prank(alice);
        staking.unstake();

        vm.warp(expectedAt);
        vm.expectEmit(true, false, false, true, address(staking));
        emit IBkrnStaking.Unstaked(alice, 30e18);
        vm.prank(alice);
        uint256 out = staking.unstake();
        assertEq(out, 30e18);
        assertEq(staking.stakedOf(alice), 70e18);
        assertEq(staking.totalStaked(), 70e18);
        assertEq(bkrn.balanceOf(alice), 30e18);
        (pending, at) = staking.pendingUnstakeOf(alice);
        assertEq(pending, 0);
        assertEq(at, 0);
    }

    function test_requestUnstake_restartsCooldown() public {
        _stake(alice, 100e18);
        vm.prank(alice);
        staking.requestUnstake(10e18);
        vm.warp(block.timestamp + 6 days);
        vm.prank(alice);
        staking.requestUnstake(10e18);
        (uint256 pending, uint64 at) = staking.pendingUnstakeOf(alice);
        assertEq(pending, 20e18);
        assertEq(at, uint64(block.timestamp + 7 days));
    }

    function test_requestUnstake_reverts() public {
        vm.expectRevert(BkrnStaking.ZeroAmount.selector);
        vm.prank(alice);
        staking.requestUnstake(0);

        _stake(alice, 10e18);
        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.InsufficientAvailable.selector, 10e18, 11e18));
        vm.prank(alice);
        staking.requestUnstake(11e18);
    }

    function test_lockedStakeCannotBeUnstaked() public {
        _stake(alice, 100e18);
        vm.prank(locker);
        staking.lock(alice, LOCK_A, 80e18);
        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.InsufficientAvailable.selector, 20e18, 21e18));
        vm.prank(alice);
        staking.requestUnstake(21e18);
        vm.prank(alice);
        staking.requestUnstake(20e18);
        assertEq(staking.availableOf(alice), 0);
    }

    function test_cancelUnstake() public {
        _stake(alice, 10e18);
        vm.prank(alice);
        staking.requestUnstake(4e18);
        vm.expectEmit(true, false, false, true, address(staking));
        emit BkrnStaking.UnstakeCancelled(alice, 4e18);
        vm.prank(alice);
        assertEq(staking.cancelUnstake(), 4e18);
        assertEq(staking.availableOf(alice), 10e18);

        vm.expectRevert(BkrnStaking.NothingPending.selector);
        vm.prank(alice);
        staking.cancelUnstake();
    }

    function test_unstake_revertsNothingPending() public {
        vm.expectRevert(BkrnStaking.NothingPending.selector);
        vm.prank(alice);
        staking.unstake();
    }

    // ---------------------------------------------------------------- lockers

    function test_setLocker_byAdminAndFactory() public {
        address l = makeAddr("newLocker");
        vm.expectEmit(true, true, false, true, address(staking));
        emit BkrnStaking.LockerSet(l, true, admin);
        vm.prank(admin);
        staking.setLocker(l, true);
        assertTrue(staking.isLocker(l));

        address mandate = makeAddr("mandateClone");
        vm.prank(address(factory));
        staking.setLocker(mandate, true);
        assertTrue(staking.isLocker(mandate));

        vm.prank(admin);
        staking.setLocker(l, false);
        assertFalse(staking.isLocker(l));
    }

    function test_setLocker_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.NotAdminOrFactory.selector, alice));
        vm.prank(alice);
        staking.setLocker(alice, true);

        vm.expectRevert(BkrnStaking.ZeroAddress.selector);
        vm.prank(admin);
        staking.setLocker(address(0), true);
    }

    // ---------------------------------------------------------------- lock / unlock

    function test_lock() public {
        _stake(alice, 100e18);
        vm.expectEmit(true, true, true, true, address(staking));
        emit IBkrnStaking.Locked(alice, LOCK_A, locker, 40e18);
        vm.prank(locker);
        staking.lock(alice, LOCK_A, 40e18);
        assertEq(staking.lockOf(alice, LOCK_A), 40e18);
        assertEq(staking.lockedOf(alice), 40e18);
        assertEq(staking.availableOf(alice), 60e18);
        (uint256 amt, address owner) = staking.lockInfo(alice, LOCK_A);
        assertEq(amt, 40e18);
        assertEq(owner, locker);

        // top-up by the same locker
        vm.prank(locker);
        staking.lock(alice, LOCK_A, 10e18);
        assertEq(staking.lockOf(alice, LOCK_A), 50e18);
        assertEq(staking.lockedOf(alice), 50e18);

        // another lock id by another locker
        vm.prank(locker2);
        staking.lock(alice, LOCK_B, 50e18);
        assertEq(staking.lockedOf(alice), 100e18);
        assertEq(staking.availableOf(alice), 0);
    }

    function test_lock_zeroAmountRecordsOwnership() public {
        vm.prank(locker);
        staking.lock(alice, LOCK_A, 0);
        (uint256 amt, address owner) = staking.lockInfo(alice, LOCK_A);
        assertEq(amt, 0);
        assertEq(owner, locker);
        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.NotLockOwner.selector, locker, locker2));
        vm.prank(locker2);
        staking.lock(alice, LOCK_A, 0);
    }

    function test_lock_reverts() public {
        _stake(alice, 10e18);
        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.NotLocker.selector, alice));
        vm.prank(alice);
        staking.lock(alice, LOCK_A, 1);

        vm.expectRevert(BkrnStaking.ZeroAddress.selector);
        vm.prank(locker);
        staking.lock(address(0), LOCK_A, 0);

        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.InsufficientAvailable.selector, 10e18, 10e18 + 1));
        vm.prank(locker);
        staking.lock(alice, LOCK_A, 10e18 + 1);

        vm.prank(locker);
        staking.lock(alice, LOCK_A, 1e18);
        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.NotLockOwner.selector, locker, locker2));
        vm.prank(locker2);
        staking.lock(alice, LOCK_A, 1e18);
    }

    function test_lock_excludesPendingUnstake() public {
        _stake(alice, 10e18);
        vm.prank(alice);
        staking.requestUnstake(6e18);
        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.InsufficientAvailable.selector, 4e18, 5e18));
        vm.prank(locker);
        staking.lock(alice, LOCK_A, 5e18);
    }

    function test_unlock() public {
        _stake(alice, 10e18);
        vm.prank(locker);
        staking.lock(alice, LOCK_A, 7e18);

        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.NotLockOwner.selector, locker, locker2));
        vm.prank(locker2);
        staking.unlock(alice, LOCK_A);

        vm.expectEmit(true, true, false, true, address(staking));
        emit IBkrnStaking.Unlocked(alice, LOCK_A, 7e18);
        vm.prank(locker);
        assertEq(staking.unlock(alice, LOCK_A), 7e18);
        assertEq(staking.lockedOf(alice), 0);
        assertEq(staking.availableOf(alice), 10e18);
        (, address owner) = staking.lockInfo(alice, LOCK_A);
        assertEq(owner, address(0));

        // the id can now be taken by another locker
        vm.prank(locker2);
        staking.lock(alice, LOCK_A, 1e18);
    }

    function test_unlock_nonexistentIsNoop() public {
        vm.prank(alice);
        assertEq(staking.unlock(alice, LOCK_A), 0);
    }

    function test_unlock_byRemovedLockerStillWorks() public {
        _stake(alice, 10e18);
        vm.prank(locker);
        staking.lock(alice, LOCK_A, 5e18);
        vm.prank(admin);
        staking.setLocker(locker, false);
        vm.prank(locker);
        assertEq(staking.unlock(alice, LOCK_A), 5e18);
    }

    // ---------------------------------------------------------------- slash

    function test_slash() public {
        _stake(alice, 100e18);
        vm.prank(locker);
        staking.lock(alice, LOCK_A, 40e18);
        vm.prank(alice);
        staking.requestUnstake(50e18);

        vm.expectEmit(true, true, false, true, address(staking));
        emit IBkrnStaking.Slashed(alice, LOCK_A, 25e18, slashRecipient);
        vm.prank(locker);
        uint256 slashed = staking.slash(alice, LOCK_A, 25e18);
        assertEq(slashed, 25e18);
        assertEq(staking.stakedOf(alice), 75e18);
        assertEq(staking.lockedOf(alice), 15e18);
        assertEq(staking.lockOf(alice, LOCK_A), 15e18);
        assertEq(staking.totalStaked(), 75e18);
        assertEq(bkrn.balanceOf(slashRecipient), 25e18);
        // pending unstake untouched and still withdrawable
        (uint256 pending,) = staking.pendingUnstakeOf(alice);
        assertEq(pending, 50e18);
        assertEq(staking.availableOf(alice), 10e18);
        vm.warp(block.timestamp + 7 days);
        vm.prank(alice);
        assertEq(staking.unstake(), 50e18);
    }

    function test_slash_clampsToLock() public {
        _stake(alice, 100e18);
        vm.prank(locker);
        staking.lock(alice, LOCK_A, 10e18);
        vm.prank(locker);
        assertEq(staking.slash(alice, LOCK_A, 1000e18), 10e18);
        assertEq(staking.lockOf(alice, LOCK_A), 0);
        assertEq(staking.stakedOf(alice), 90e18);
        // empty lock: slash returns 0, unlock returns 0
        vm.prank(locker);
        assertEq(staking.slash(alice, LOCK_A, 1), 0);
        vm.prank(locker);
        assertEq(staking.unlock(alice, LOCK_A), 0);
    }

    function test_slash_reverts() public {
        _stake(alice, 100e18);
        vm.prank(locker);
        staking.lock(alice, LOCK_A, 10e18);

        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.NotLocker.selector, alice));
        vm.prank(alice);
        staking.slash(alice, LOCK_A, 1);

        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.NotLockOwner.selector, locker, locker2));
        vm.prank(locker2);
        staking.slash(alice, LOCK_A, 1);

        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.NotLockOwner.selector, address(0), locker));
        vm.prank(locker);
        staking.slash(alice, LOCK_B, 1);

        // a removed locker can no longer slash
        vm.prank(admin);
        staking.setLocker(locker, false);
        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.NotLocker.selector, locker));
        vm.prank(locker);
        staking.slash(alice, LOCK_A, 1);
    }

    function test_slash_revertsWithoutRecipient() public {
        BookrunnerConfig c2 = new BookrunnerConfig(admin);
        vm.prank(admin);
        c2.setAddress("bkrn", address(bkrn));
        BkrnStaking s2 = new BkrnStaking(address(c2));
        vm.prank(admin);
        s2.setLocker(locker, true);
        _giveBkrn(alice, 1e18);
        vm.startPrank(alice);
        bkrn.approve(address(s2), 1e18);
        s2.stake(1e18);
        vm.stopPrank();
        vm.prank(locker);
        s2.lock(alice, LOCK_A, 1e18);
        vm.expectRevert(BkrnStaking.SlashRecipientUnset.selector);
        vm.prank(locker);
        s2.slash(alice, LOCK_A, 1);
    }

    // ---------------------------------------------------------------- rewards

    function _notify(uint256 amount) internal {
        _giveBkrn(address(feeRouter), amount);
        vm.startPrank(address(feeRouter));
        bkrn.transfer(address(staking), amount);
        staking.notifyReward(amount);
        vm.stopPrank();
    }

    function test_notifyReward_proRata() public {
        _stake(alice, 100e18);
        _stake(bob, 300e18);
        _giveBkrn(address(staking), 40e18);
        vm.expectEmit(false, false, false, true, address(staking));
        emit IBkrnStaking.RewardNotified(40e18);
        vm.prank(address(feeRouter));
        staking.notifyReward(40e18);
        assertEq(staking.earned(alice), 10e18);
        assertEq(staking.earned(bob), 30e18);
        assertEq(staking.rewardReserve(), 40e18);

        vm.expectEmit(true, false, false, true, address(staking));
        emit IBkrnStaking.RewardClaimed(alice, 10e18);
        vm.prank(alice);
        assertEq(staking.claimReward(), 10e18);
        assertEq(bkrn.balanceOf(alice), 10e18);
        assertEq(staking.earned(alice), 0);
        assertEq(staking.rewardReserve(), 30e18);
    }

    function test_rewards_lockedStakeEarns_andLateStakerDoesNot() public {
        _stake(alice, 100e18);
        vm.prank(locker);
        staking.lock(alice, LOCK_A, 100e18);
        _notify(10e18);
        _stake(bob, 100e18);
        assertEq(staking.earned(alice), 10e18);
        assertEq(staking.earned(bob), 0);
        _notify(10e18);
        assertEq(staking.earned(alice), 15e18);
        assertEq(staking.earned(bob), 5e18);
    }

    function test_rewards_queuedWhenNothingStaked() public {
        _notify(9e18);
        assertEq(staking.queuedReward(), 9e18);
        assertEq(staking.rewardPerTokenStored(), 0);
        _stake(alice, 1e18);
        _notify(1e18);
        assertEq(staking.queuedReward(), 0);
        assertEq(staking.earned(alice), 10e18);
    }

    function test_rewards_roundingRemainderCarried() public {
        _stake(alice, 3);
        _notify(10); // 10e18 / 3 per token: alice floors to 9, the scaled remainder is carried
        assertEq(staking.earned(alice), 9);
        assertEq(staking.queuedReward(), 0);
        _notify(2); // (2e18 + 1) / 3 -> cumulative 4e18 per token: exactly 12 for 12 notified
        assertEq(staking.earned(alice), 12);
    }

    function test_rewards_survivePartialSlashAndUnstake() public {
        _stake(alice, 100e18);
        vm.prank(locker);
        staking.lock(alice, LOCK_A, 50e18);
        _notify(10e18);
        vm.prank(locker);
        staking.slash(alice, LOCK_A, 50e18);
        assertEq(staking.earned(alice), 10e18);
        vm.prank(alice);
        staking.requestUnstake(50e18);
        vm.warp(block.timestamp + 7 days);
        vm.prank(alice);
        staking.unstake();
        assertEq(staking.earned(alice), 10e18);
        vm.prank(alice);
        assertEq(staking.claimReward(), 10e18);
    }

    function test_claimReward_nothing() public {
        vm.prank(alice);
        assertEq(staking.claimReward(), 0);
    }

    function test_notifyReward_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.NotFeeRouter.selector, alice));
        vm.prank(alice);
        staking.notifyReward(1);

        _stake(alice, 5e18);
        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.RewardNotReceived.selector, 6e18, 5e18));
        vm.prank(address(feeRouter));
        staking.notifyReward(1e18);
    }

    function test_notifyReward_zeroIsNoop() public {
        vm.prank(address(feeRouter));
        staking.notifyReward(0);
        assertEq(staking.rewardReserve(), 0);
    }

    function test_notifyReward_cannotReuseStakedTokens() public {
        _stake(alice, 100e18);
        _notify(1e18);
        // staked BKRN + reserve already fully accounted: a second notify without transfer fails
        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.RewardNotReceived.selector, 102e18, 101e18));
        vm.prank(address(feeRouter));
        staking.notifyReward(1e18);
    }

    // ---------------------------------------------------------------- admin

    function test_setCooldown() public {
        vm.expectEmit(false, false, false, true, address(staking));
        emit BkrnStaking.CooldownSet(1 days);
        vm.prank(admin);
        staking.setCooldown(1 days);
        assertEq(staking.cooldown(), 1 days);
        _stake(alice, 1e18);
        vm.prank(alice);
        staking.requestUnstake(1e18);
        (, uint64 at) = staking.pendingUnstakeOf(alice);
        assertEq(at, block.timestamp + 1 days);

        vm.prank(admin);
        staking.setCooldown(0);
        vm.prank(alice);
        staking.cancelUnstake();
        vm.prank(alice);
        staking.requestUnstake(1e18);
        vm.prank(alice);
        assertEq(staking.unstake(), 1e18);
    }

    function test_setCooldown_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.NotAdmin.selector, alice));
        vm.prank(alice);
        staking.setCooldown(1);
        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.CooldownTooLong.selector, 91 days, 90 days));
        vm.prank(admin);
        staking.setCooldown(91 days);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_rewardsProportional(uint256 a, uint256 b, uint256 reward) public {
        a = bound(a, 1, 100_000_000e18);
        b = bound(b, 1, 100_000_000e18);
        reward = bound(reward, 0, 50_000_000e18);
        _stake(alice, a);
        _stake(bob, b);
        _notify(reward);
        uint256 ea = staking.earned(alice);
        uint256 eb = staking.earned(bob);
        assertLe(ea + eb + staking.queuedReward(), reward);
        assertEq(staking.rewardReserve(), reward);
        // floor error of the accumulator: at most a / 1e18 + 1 below the exact pro-rata share
        uint256 exact = (reward * a) / (a + b);
        assertLe(ea, exact);
        assertApproxEqAbs(ea, exact, a / 1e18 + 2);
        vm.prank(alice);
        staking.claimReward();
        vm.prank(bob);
        staking.claimReward();
        assertGe(bkrn.balanceOf(address(staking)), staking.totalStaked() + staking.rewardReserve());
    }

    function testFuzz_slashKeepsInvariant(
        uint256 stakeAmt,
        uint256 lockAmt,
        uint256 pending,
        uint256 slashAmt
    ) public {
        stakeAmt = bound(stakeAmt, 1, 100_000_000e18);
        lockAmt = bound(lockAmt, 0, stakeAmt);
        pending = bound(pending, 0, stakeAmt - lockAmt);
        _stake(alice, stakeAmt);
        vm.prank(locker);
        staking.lock(alice, LOCK_A, lockAmt);
        if (pending > 0) {
            vm.prank(alice);
            staking.requestUnstake(pending);
        }
        vm.prank(locker);
        uint256 slashed = staking.slash(alice, LOCK_A, slashAmt);
        assertEq(slashed, slashAmt < lockAmt ? slashAmt : lockAmt);
        assertEq(staking.stakedOf(alice), stakeAmt - slashed);
        assertEq(staking.lockedOf(alice), lockAmt - slashed);
        assertEq(staking.availableOf(alice), stakeAmt - lockAmt - pending);
        assertEq(bkrn.balanceOf(slashRecipient), slashed);
    }
}
