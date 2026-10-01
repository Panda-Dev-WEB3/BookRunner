// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoreFixture} from "./utils/CoreFixture.sol";
import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IRevenueRouter} from "../../src/interfaces/IRevenueRouter.sol";

/// @notice End-to-end A-core flow: fee flow -> waterfall -> carry split -> buyback -> stakers; backstop
///         cover to a book's vault; mark commit + apply.
contract CoreFlowTest is CoreFixture {
    function test_feeFlowToStakersAndBackstop() public {
        senior.mint(address(senior), 700_000e6);
        junior.mint(address(junior), 300_000e6);
        _stake(alice, 1_000_000e18);
        _stake(bob, 3_000_000e18);

        // a period of fee flow from the venue adapter
        _settle(router, 10_000e6);
        vm.prank(keeper);
        IRevenueRouter.Amounts memory a = router.distribute(86_400, 100e6);
        // expenses 100, net 9900, carry 990, rest 8910 -> senior 5346, junior 3564
        assertEq(a.expenses, 100e6);
        assertEq(a.carry, 990e6);
        assertEq(a.senior, 5346e6);
        assertEq(a.junior, 3564e6);
        assertEq(feeRouter.buybackPending(), 495e6);
        assertEq(backstop.balance(), 495e6);

        // keeper buys back BKRN with the buyback half: 495 USDC * 20 = 9900 BKRN to stakers
        vm.prank(keeper);
        uint256 out = feeRouter.executeBuyback(495e6, 9900e18, 3000);
        assertEq(out, 9900e18);
        assertEq(staking.earned(alice), 2475e18);
        assertEq(staking.earned(bob), 7425e18);
        vm.prank(bob);
        staking.claimReward();
        assertEq(bkrn.balanceOf(bob), 7425e18);

        // the book's Senior is impaired after Junior is exhausted: backstop covers up to the pool
        uint256 covered = book.coverFrom(address(backstop), BOOK_ID, 1000e6);
        assertEq(covered, 495e6);
        assertEq(usdc.balanceOf(vault), 5346e6 + 3564e6 + 495e6);
    }

    function test_markLifecycle() public {
        vm.startPrank(admin);
        config.setParam("markInterval", 300);
        config.setParam("maxMarkAge", 3600);
        vm.stopPrank();
        uint64 periodEnd = uint64((block.timestamp / 300) * 300);
        BRTypes.MarkInput memory m = BRTypes.MarkInput({
            bookId: BOOK_ID,
            periodEnd: periodEnd,
            navUsd: 100_000e6,
            deployedValueUsd: 100_000e6,
            flowNonce: 1,
            inventoryRoot: bytes32(uint256(1)),
            pnlJsonHash: bytes32(uint256(2)),
            receiptsRoot: bytes32(uint256(3))
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(markSignerPk, registry.hashMark(m));
        uint256 id = registry.commit(m, abi.encodePacked(r, s, v));
        assertEq(registry.latestMarkId(BOOK_ID), id);
        book.applyMark(address(registry), id);
        assertTrue(registry.getMark(id).applied);
    }
}
