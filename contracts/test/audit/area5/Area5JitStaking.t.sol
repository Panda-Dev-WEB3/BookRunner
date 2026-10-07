// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoreFixture} from "../../core/utils/CoreFixture.sol";
import {BkrnStaking} from "../../../src/BkrnStaking.sol";

/// @notice AUDIT area 5 (A5-03) — buyback rewards used to be allocated instantly (no streaming) to whoever
///         was staked at the moment `executeBuyback` landed, so stake placed right before a buyback (a
///         mempool front-run of the keeper tx, or simply before a large accumulated buyback) took a full
///         pro-rata share of carry that accrued while it was not staked; with the cooldown at 0 (no lower
///         bound) the same was capital-free via a flash loan.
///         FIXED: rewards stream over `rewardsDuration` (7 days), stake in its unstake cooldown does not
///         earn, and the cooldown is at least 1 day. Kept as regression tests.
contract Area5JitStakingTest is CoreFixture {
    function setUp() public override {
        super.setUp();
        _stake(alice, 1_000_000e18); // long-term staker
    }

    function _carry(uint256 amount) internal {
        usdc.mint(address(feeRouter), amount);
        vm.prank(address(router));
        feeRouter.notifyCarry(BOOK_ID, amount);
    }

    /// Secure behaviour: stake that was not present while the buyback USDC accrued earns (almost)
    /// nothing from it.
    function test_audit_jitStakeCapturesAccruedBuyback() public {
        // 30 days of carry accrue while only alice is staked (buyback not yet executed)
        vm.warp(block.timestamp + 30 days);
        _carry(200_000e6); // 100k USDC buyback pending
        uint256 pending = feeRouter.buybackPending();

        // bob front-runs the keeper's executeBuyback
        _stake(bob, 1_000_000e18);
        vm.prank(keeper);
        uint256 out = feeRouter.executeBuyback(pending, 1);
        vm.prank(bob);
        staking.requestUnstake(1_000_000e18);

        // bob was staked for 0 seconds of the 30-day accrual period yet earned half of it
        assertLe(staking.earned(bob), out / 100, "JIT staker captured accrued buyback rewards");
        // ... and his stake earns nothing while it cools down, even once the stream has completed
        vm.warp(block.timestamp + staking.cooldown());
        vm.prank(bob);
        staking.unstake();
        vm.prank(bob);
        assertLe(staking.claimReward(), out / 100, "JIT staker earned during the cooldown");
        vm.warp(block.timestamp + staking.rewardsDuration());
        assertApproxEqAbs(staking.earned(alice), out, 1e7, "the long-term staker keeps the buyback");
    }

    /// Same with the cooldown set to 0 (was allowed: setCooldown had no lower bound): in/out within one
    /// block, i.e. flash-loanable. Now the cooldown cannot go below 1 day, and a stake/unstake round trip
    /// at the minimum cooldown still earns nothing from the buyback.
    function test_audit_zeroCooldownFlashStake() public {
        uint64 minCooldown = staking.MIN_COOLDOWN();
        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.CooldownTooShort.selector, 0, 1 days));
        vm.prank(admin);
        staking.setCooldown(0);
        vm.prank(admin);
        staking.setCooldown(minCooldown);
        _carry(200_000e6);
        uint256 pending = feeRouter.buybackPending();

        _stake(bob, 9_000_000e18); // flash-borrowed
        vm.prank(keeper);
        uint256 out = feeRouter.executeBuyback(pending, 1);
        vm.startPrank(bob);
        staking.requestUnstake(9_000_000e18);
        vm.expectRevert(abi.encodeWithSelector(BkrnStaking.CooldownActive.selector, uint64(block.timestamp + 1 days)));
        staking.unstake(); // no same-block exit: the flash loan cannot be repaid
        vm.warp(block.timestamp + 1 days);
        staking.unstake();
        uint256 reward = staking.claimReward();
        vm.stopPrank();

        assertLe(reward, out / 100, "flash-staker took the buyback in a single block");
    }
}
