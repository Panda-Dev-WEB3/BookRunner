// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {InsurancePool} from "../../../src/InsurancePool.sol";
import {PoolFixture} from "../../pool/utils/PoolFixture.sol";

/// @title Pool audit 2026-10-23 (scope A), fix verification: the auditor's own sequences on the pool-fixes branch
///        (.superpowers/sdd/2026-10-23-pool-audit/audit-A-verify.md); the NEW-x PoCs are regressions since fix round 2.
/// @notice Run: FORGE_DOCKER_ARGS="--cpus=2 --memory=3g" bash scripts/forge.sh test --match-path test/audit/pool2026/PoolAuditAVerify.t.sol
contract PoolAuditAVerifyTest is PoolFixture {
    bytes32 internal constant M1 = bytes32("NVDA");
    bytes32 internal constant M2 = bytes32("TSLA");
    bytes32 internal constant M3 = bytes32("AAPL");

    function setUp() public {
        _deployPool();
        _registerBook(1);
        _registerBook(2);
        _registerBook(3);
    }

    function _heldMark(uint256 id, uint256 value) internal {
        (address book,,) = _bookAddrs(id);
        vm.prank(book);
        pool.markBook(id, value, uint64(block.timestamp), false, true);
    }

    // ------------------------------------------------------------------ A-M1: order independence (fuzz)

    /// @notice Any sequence of marks (losses and recoveries on 3 books) and slice top-ups ends in the junior-tranche
    ///         closed form: slice = max(0, seed + top-ups - net loss), depositors = 90k - max(0, net loss - seed -
    ///         top-ups), whatever the order. (No premium / fill in between: those are path-dependent by design.)
    function testFuzz_verify_AM1_endStateIsTheJuniorTrancheClosedForm(uint256[12] memory ops) public {
        _seedFirstLoss(10_000 * U);
        _deposit(alice, 90_000 * U);
        _allocate(1, 20_000 * U, M1);
        _allocate(2, 20_000 * U, M2);
        _allocate(3, 20_000 * U, M3);
        uint256 top;
        for (uint256 i; i < ops.length; ++i) {
            uint256 op = ops[i];
            if ((op >> 200) % 5 == 0) {
                uint256 t = ((op >> 100) % 5_000 + 1) * U;
                _seedFirstLoss(t);
                top += t;
            } else {
                _markValue(op % 3 + 1, ((op >> 8) % 20_001) * U);
            }
            assertTrue(pool.depositorLoss() == 0 || pool.firstLossAssets() == 0, "junior invariant");
        }
        uint256 netLoss;
        for (uint256 id = 1; id <= 3; ++id) {
            netLoss += 20_000 * U - pool.bookPosition(id).claim;
        }
        uint256 junior = 10_000 * U + top;
        assertEq(pool.firstLossAssets(), junior > netLoss ? junior - netLoss : 0, "slice == closed form");
        assertEq(pool.totalAssets(), 90_000 * U - (netLoss > junior ? netLoss - junior : 0), "depositors == closed form");
        assertEq(pool.depositorLoss(), netLoss > junior ? netLoss - junior : 0, "depositorLoss == closed form");
    }

    /// @notice Hand-picked: three books, interleaved partial losses, a top-up and partial recoveries, two orders.
    function test_verify_AM1_threeBooks_twoOrders_sameSplit() public {
        uint256 snap = vm.snapshotState();
        uint256[2] memory fl;
        uint256[2] memory d;
        for (uint256 run; run < 2; ++run) {
            vm.revertToState(snap);
            _seedFirstLoss(10_000 * U);
            _deposit(alice, 90_000 * U);
            _allocate(1, 20_000 * U, M1);
            _allocate(2, 20_000 * U, M2);
            _allocate(3, 20_000 * U, M3);
            if (run == 0) {
                _markValue(1, 12_000 * U); // -8k
                _markValue(2, 5_000 * U); // -15k
                _seedFirstLoss(3_000 * U);
                _markValue(3, 14_000 * U); // -6k
                _markValue(1, 19_000 * U); // +7k
                _markValue(2, 11_000 * U); // +6k
            } else {
                _markValue(3, 14_000 * U);
                _markValue(2, 11_000 * U);
                _markValue(1, 19_000 * U);
                _seedFirstLoss(3_000 * U);
            }
            fl[run] = pool.firstLossAssets();
            d[run] = pool.totalAssets();
        }
        // net loss 1k + 9k + 6k = 16k against a junior of 13k: slice 0, depositors -3k, in both orders
        assertEq(fl[0], fl[1]);
        assertEq(d[0], d[1]);
        assertEq(fl[0], 0);
        assertEq(d[0], 87_000 * U);
    }

    // ------------------------------------------------------------------ NEW-1: held marks over the epoch end

    /// @dev Slice 10k, Alice 45k, Bob 45k; two books 25k each (50% lent). Alice queues her full exit.
    function _setupExit() internal returns (uint256 rid) {
        _seedFirstLoss(10_000 * U);
        _deposit(alice, 45_000 * U);
        _deposit(bob, 45_000 * U);
        _allocate(1, 25_000 * U, M1);
        _allocate(2, 25_000 * U, M2);
        rid = _request(alice, pool.balanceOf(alice));
        (, uint64 ends,,,) = pool.queue();
        uint256 target = pool.epochEnd(pool.requestInfo(rid).epoch);
        while (ends < target) {
            _process();
            (, ends,,,) = pool.queue();
        }
        vm.warp(ends);
    }

    /// @notice Regression (fix round 2, NEW-1): a market holiday over the epoch end (every mark held, B-L4: no gate
    ///         credit) makes every book stale. The PoC: at the grace end anyone processed and Alice got 25k for a 45k
    ///         position, Bob gaining her 20k. Now the stale processing fills only the part of her exit backed by fresh
    ///         books (the depositors' exposure to the stale books, 50k claims - 10k slice = 40k of D = 90k, is not
    ///         priced): 50/90 of it, at the normal price; the rest stays queued and fills at the next fresh processing.
    ///         No value moves: Alice ends with her 45k, Bob keeps his 45k.
    function test_verify_NEW1_heldMarksOverTheEpochEnd_noValueMoves() public {
        uint256 rid = _setupExit();
        vm.warp(block.timestamp + 6 hours);
        _heldMark(1, 25_000 * U); // holiday: held marks, unchanged values
        _heldMark(2, 25_000 * U);
        vm.warp(block.timestamp + 18 hours); // grace end (24 h after the epoch end)
        vm.prank(bob); // the staying holder triggers it
        pool.processEpoch();
        uint256 got = pool.claim(rid);
        assertApproxEqAbs(got, 25_000 * U, 2, "only the part backed by fresh books: 50/90 of 45k, at the normal price");
        assertGt(pool.requestInfo(rid).shares, 0);
        assertApproxEqAbs(pool.convertToAssets(pool.balanceOf(bob)), 45_000 * U, 2, "bob gains nothing");
        _process(); // the next epoch: the books mark live (unchanged), the rest fills
        got += pool.claim(rid);
        assertApproxEqAbs(got, 45_000 * U, 2, "alice whole");
        assertApproxEqAbs(pool.convertToAssets(pool.balanceOf(bob)), 45_000 * U, 2, "bob whole");
        _checkLedger();
    }

    /// @notice Same exit with live (non-held) marks after the epoch end: Alice gets her 45k at once.
    function test_verify_NEW1_control_liveMarks_exitWhole() public {
        uint256 rid = _setupExit();
        vm.warp(block.timestamp + 6 hours);
        _markValue(1, 25_000 * U);
        _markValue(2, 25_000 * U);
        pool.processEpoch();
        assertApproxEqAbs(pool.claim(rid), 45_000 * U, 1, "alice whole");
    }

    // ------------------------------------------------------------------ NEW-2: the buffer on what stays

    /// @notice Regression (fix round 2, NEW-2): the PoC deposited 250k and queued its exit, lowering the allocatable
    ///         room by 0.2 x (the 20% buffer was on T, queued exits included) and pushing a 25,001 IF out risk-free. The
    ///         buffer is now 20% of (T - queued) + queued: a deposit-and-queue no longer shrinks the room.
    function test_verify_NEW2_depositAndQueueExit_doesNotShrinkAllocatable() public {
        uint256 seed = 91_671 * U;
        _seedFirstLoss(seed);
        uint256 before = pool.maxAllocation(1, M1);
        assertGe(before, 25_001 * U, "launch book fits");
        uint256 x = 250_000 * U;
        _deposit(carol, x);
        uint256 rid = _request(carol, pool.balanceOf(carol));
        uint256 afterQ = pool.maxAllocation(1, M1);
        assertGe(afterQ, before, "the room did not fall");
        assertGe(afterQ, 25_001 * U, "the launch book still fits");
        _processThrough(rid);
        assertApproxEqAbs(pool.claim(rid), x, 1, "carol exits whole");
    }

    // ------------------------------------------------------------------ A-M2 / NEW-3: what the exposure gate allows

    /// @notice Regression (fix round 2, NEW-3): the PoC had a 10k slice fund a 100k book whose write-down put 90k on the
    ///         depositors. The slice must now also cover 25% of the largest single allocation: 10k funds at most 40k in
    ///         one book, whose full write-down puts at most 30k (75%) on the depositors.
    function test_verify_AM2_smallSlice_capsTheLargestSingleBook() public {
        _seedFirstLoss(10_000 * U);
        _deposit(alice, 10_000_000 * U);
        assertEq(pool.maxAllocation(1, M1), 40_000 * U, "4x the slice for a single book");
        (address book1,,) = _bookAddrs(1);
        vm.prank(book1);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.FirstLossBelowTarget.selector, 10_000 * U, 25_000 * U));
        pool.allocate(1, 100_000 * U, M1);
        _allocate(1, 40_000 * U, M1);
        _markValue(1, 0);
        assertEq(pool.firstLossAssets(), 0);
        assertEq(pool.depositorLoss(), 30_000 * U);
    }
}
