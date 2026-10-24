// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {PoolBookFixture} from "../../pool/utils/PoolBookFixture.sol";

/// @notice Audit 2026-10-23 scope B, verification of the pool-fixes branch: the residual issues of audit-B-verify.md
///         (V-1, V-2, V-3), turned into regression tests in fix round 2. Each PoC asserted the problem on ec6cf2c; each
///         test now asserts the fixed behaviour. Default book: S 52.5k, J 22.5k, MM 75k, IF 25k from the pool.
contract B_VerifyFixesTest is PoolBookFixture {
    function setUp() public {
        _setUpPoolBook();
    }

    /// @notice V-1: was the pool's shortfall restored first by the MM recovery (25k), the Backstop repaid only 50k of its
    ///         52.5k and Senior left whole. Now (ruling: the Backstop first, then the pool) the recovery repays the Backstop
    ///         in full, then restores the pool with Junior's counterfactual 22.5k, and Senior's deferred share of the IF
    ///         draw (2.5k) is charged once its capital is its own: after retirement Senior 50k (as in the reference IF draw
    ///         alone), the pool whole, the Backstop whole.
    function test_B_V1_exhaustedThenRecovery_backstopFirst_seniorChargedItsIfShare() public {
        _goLivePool();
        usdc.mint(address(backstop), 1_000_000e6);
        uint256 bal0 = usdc.balanceOf(address(backstop));

        venue.setMmValue(0); // mark 1: the MM loses 75k: Junior 22.5k gone, Senior 52.5k covered
        _applyPoolMark();
        venue.setIfEquity(0); // mark 2: the IF drained while Senior holds only cover: the pool's provisional loss
        _applyPoolMark();
        assertEq(book.seniorIfDeferred(), 25_000e6, "Senior's share deferred");
        venue.setMmValue(75_000e6); // mark 3: the MM recovers its 75k
        _applyPoolMark();
        (uint256 bsDebt,) = book.backstopDebt();
        assertEq(bsDebt, 0, "the Backstop repaid in full first");
        (, uint256 value,) = _debt();
        assertEq(value, 25_000e6, "the pool restored: 22.5k from the gain, 2.5k charged to Senior");
        (uint256 s,) = book.trancheNav();
        assertEq(s, 50_000e6, "Senior bears its 2.5k of the IF draw");
        assertEq(book.seniorIfDeferred(), 0);

        charterC.retire(BOOK_ID);
        vm.startPrank(keeper);
        vault.recall(BRTypes.ACCOUNT_MM, 75_000e6);
        vault.recall(BRTypes.ACCOUNT_IF, 1);
        vm.stopPrank();
        _applyPoolMark();
        book.finalizeRetirement();
        assertEq(pool.bookPosition(BOOK_ID).allocation, 0, "pool whole");
        (s,) = book.trancheNav();
        assertEq(s, 50_000e6);
        assertEq(usdc.balanceOf(address(backstop)), bal0, "the Backstop whole");
    }

    /// @dev The Book's ERC-7201 slot of `seniorIfDeferred`: the field before `poolMinCapitalBps` (alone in the last
    ///      slot of BookStorage, uint16 after a uint256); `coverHeld` is two fields before it.
    function _deferredSlot() internal view returns (bytes32) {
        bytes32 base = 0xafd306892a6154f35c973e251e6b4f2659d2ae19802986651fcc8ec3ae5c4c00;
        for (uint256 i = 1; i < 256; ++i) {
            if (uint256(vm.load(address(book), bytes32(uint256(base) + i))) == 5000) {
                return bytes32(uint256(base) + i - 1);
            }
        }
        revert("poolMinCapitalBps slot not found");
    }

    /// @notice audit-B-verify2 hygiene note: finalizeRetirement charged Senior's deferred IF share after the Retired
    ///         prices were set, so a non-zero share at finalize was counted twice (B-L1 style). Every gain charges it at
    ///         once, so only dust reaches finalize; the test forces 5k of own capital behind a deferred share (coverHeld
    ///         lowered in storage) and checks that the Senior Retired price is set after the charge.
    function test_B_verify2_finalize_chargesTheDeferredShare_beforeTheRetiredPrices() public {
        _goLivePool();
        usdc.mint(address(backstop), 1_000_000e6);
        venue.setMmValue(0); // Junior gone, Senior 52.5k covered
        _applyPoolMark();
        venue.setIfEquity(0); // the IF drained: the pool's loss, Senior's 25k share deferred
        _applyPoolMark();
        bytes32 dSlot = _deferredSlot();
        assertEq(uint256(vm.load(address(book), dSlot)), 25_000e6, "slot of seniorIfDeferred");
        bytes32 cSlot = bytes32(uint256(dSlot) - 2);
        assertEq(uint256(vm.load(address(book), cSlot)), 52_500e6, "slot of coverHeld");
        charterC.retire(BOOK_ID);
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_IF, 1);
        _applyPoolMark(); // deployed 0
        vm.store(address(book), cSlot, bytes32(uint256(47_500e6))); // 5k of Senior's NAV is now its own capital
        book.finalizeRetirement();
        (uint256 s,) = book.trancheNav();
        assertEq(s, 47_500e6, "the deferred share charged: 5k to the pool");
        (uint256 priceWad,) = book.retiredPrice(BRTypes.SENIOR);
        assertApproxEqAbs(Math.mulDiv(priceWad, senior.totalSupply(), 1e18), s, 1, "the Retired price is set after the charge");
    }

    /// @notice V-2: was the due-branch IF draw (5k) inside a larger MM gain (+10k) netted into a 5k gain, the Backstop
    ///         2.5k short for good. Now the change splits in the ledger order whatever the state, and the draw is exact
    ///         (IF deployed - IF returned to the vault - signed equity): the MM gain repays the Backstop 7.5k, then the IF
    ///         draw is charged to Junior 2.5k and Senior 2.5k.
    function test_B_V2_dueBranch_ifDrawInsideNetGain_charged_backstopRepaid() public {
        _goLivePool();
        usdc.mint(address(backstop), 1_000_000e6);
        uint256 bal0 = usdc.balanceOf(address(backstop));
        venue.setMmValue(45_000e6); // mark 1: MM -30k: Junior 22.5k gone, Senior 7.5k covered
        _applyPoolMark();
        assertEq(bal0 - usdc.balanceOf(address(backstop)), 7_500e6);

        charterC.retire(BOOK_ID);
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_IF, 1); // due (1 unit back, repaid at the next mark)
        venue.setIfEquity(20_000e6 - 1); // wind-down bad debt: 5k drawn
        venue.setMmValue(55_000e6); // the MM gains 10k in the same period
        _applyPoolMark();
        (uint256 bsDebt,) = book.backstopDebt();
        assertEq(bsDebt, 0, "the Backstop repaid its 7.5k");
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 50_000e6, "Senior bears 2.5k of the IF draw");
        assertEq(j, 0, "Junior bears the other 2.5k");
        (uint256 impIf,,,) = book.insuranceLedger();
        assertEq(impIf, 2_500e6);

        vm.startPrank(keeper);
        vault.recall(BRTypes.ACCOUNT_IF, 20_000e6 - 1);
        vault.recall(BRTypes.ACCOUNT_MM, 55_000e6);
        vm.stopPrank();
        _applyPoolMark();
        book.finalizeRetirement();
        assertEq(pool.bookPosition(BOOK_ID).allocation, 0, "pool whole");
        (s,) = book.trancheNav();
        assertEq(s, 50_000e6);
        assertEq(usdc.balanceOf(address(backstop)), bal0, "the Backstop whole");
    }

    /// @notice V-3: was a queued withdrawal just before closeWindow forcing the tranche-funded fallback at once. Now a pool
    ///         shortage makes the window wait (closeWindow reverts, retried) until the timeout; then, the charter not having
    ///         opted in, the book is cancelled and refunded 1:1: never a silent switch to a tranche-funded IF.
    function test_B_V3_queuedWithdrawal_waits_thenCancels_noSilentSwitch() public {
        vm.prank(timelock);
        pool.setParam("bufferBps", 9000); // a thin pool: the room is 10% of 1.12M = 112k, until the exits queue
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        assertGe(pool.maxAllocation(BOOK_ID, _poolCharter().underlying), 25_000e6);
        uint256 shares = pool.balanceOf(poolDepositor);
        vm.prank(poolDepositor);
        pool.requestWithdraw(shares); // every depositor exit queued just before the close
        assertLt(pool.maxAllocation(BOOK_ID, _poolCharter().underlying), 25_000e6);
        vm.expectRevert();
        book.closeWindow(); // anyone: it waits instead of deciding
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Subscription));
        vm.warp(uint256(book.subscriptionEnds()) + book.CLOSE_WINDOW_TIMEOUT());
        book.closeWindow();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Cancelled), "refundable 1:1");
        assertEq(venue.ifEquity(), 0, "no investor capital put into the IF");
    }
}
