// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoreFixture} from "../../core/utils/CoreFixture.sol";

/// @notice AUDIT area 5 — buyback rewards are allocated instantly (no streaming) to whoever is staked at
///         the moment `executeBuyback` lands, so stake placed right before a buyback (a mempool front-run
///         of the keeper tx, or simply before a large accumulated buyback) takes a full pro-rata share of
///         carry that accrued while it was not staked. With the admin-settable cooldown at 0 (no lower
///         bound) the same is capital-free via a flash loan.
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
        uint256 out = feeRouter.executeBuyback(pending, 1, 3000);
        vm.prank(bob);
        staking.requestUnstake(1_000_000e18);

        // bob was staked for 0 seconds of the 30-day accrual period yet earned half of it
        assertLe(staking.earned(bob), out / 100, "JIT staker captured accrued buyback rewards");
    }

    /// Same with the cooldown set to 0 (allowed: setCooldown has no lower bound): in/out within one
    /// block, i.e. flash-loanable.
    function test_audit_zeroCooldownFlashStake() public {
        vm.prank(admin);
        staking.setCooldown(0);
        _carry(200_000e6);
        uint256 pending = feeRouter.buybackPending();

        _stake(bob, 9_000_000e18); // flash-borrowed
        vm.prank(keeper);
        uint256 out = feeRouter.executeBuyback(pending, 1, 3000);
        vm.startPrank(bob);
        staking.requestUnstake(9_000_000e18);
        staking.unstake();
        uint256 reward = staking.claimReward();
        vm.stopPrank();

        assertLe(reward, out / 100, "flash-staker took the buyback in a single block");
    }
}
