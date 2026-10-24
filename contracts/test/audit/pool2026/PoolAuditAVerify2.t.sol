// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {InsurancePool} from "../../../src/InsurancePool.sol";
import {PoolLogic} from "../../../src/libraries/PoolLogic.sol";
import {PoolFixture} from "../../pool/utils/PoolFixture.sol";

/// @title Pool audit 2026-10-23 (scope A), fix round 2 verification (audit-A-verify2.md).
/// @notice Run: FORGE_DOCKER_ARGS="--cpus=2 --memory=3g" bash scripts/forge.sh test --match-path test/audit/pool2026/PoolAuditAVerify2.t.sol
contract PoolAuditAVerify2Test is PoolFixture {
    bytes32 internal constant M1 = bytes32("NVDA");
    bytes32 internal constant M2 = bytes32("TSLA");

    function setUp() public {
        _deployPool();
        _registerBook(1);
        _registerBook(2);
    }

    function _heldMark(uint256 id, uint256 value) internal {
        (address book,,) = _bookAddrs(id);
        vm.prank(book);
        pool.markBook(id, value, uint64(block.timestamp), false, true);
    }

    /// @dev Slice 10k, Alice 45k, Bob 45k, books 25k + 25k; Alice queues her full exit; warp to that epoch's end.
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

    /// @notice Residual of NEW-1 (Low): the fresh-backed fill pays Alice out of the fresh assets, so the stale book's
    ///         later loss falls more on Bob than his share. Book 2 stale (no fresh mark), then written down to 0.
    ///         Fair (pro-rata of the true values): Alice 50% of (90k - 15k) = 37.5k, Bob 37.5k.
    function test_v2_NEW1_residual_staleLossShiftsToStayers() public {
        uint256 rid = _setupExit();
        vm.warp(block.timestamp + 1 hours);
        _markValue(1, 25_000 * U); // book 1 fresh
        _heldMark(2, 25_000 * U); // book 2 only held
        vm.warp(block.timestamp + 1 days);
        pool.processEpoch(); // stale: Alice gets the fresh-backed part (exposure 25k - 10k slice = 15k)
        uint256 first = pool.claim(rid);
        assertApproxEqAbs(first, 37_500 * U, 2 * U, "75/90 of 45k");
        // book 2 then marks fresh at 0 (its whole 25k lost: slice 10k, depositors 15k)
        _markValue(2, 0);
        _process();
        uint256 total = first + pool.claim(rid);
        uint256 bobValue = pool.convertToAssets(pool.balanceOf(bob));
        // Alice ends above her fair 37.5k, Bob below
        assertGt(total, 37_500 * U + 1_000 * U, "alice dodges part of the stale loss");
        assertLt(bobValue, 37_500 * U - 1_000 * U, "bob carries more than his share");
        assertApproxEqAbs(total + bobValue, 75_000 * U, 4 * U, "conservation");
        emit log_named_decimal_uint("alice total", total, 6);
        emit log_named_decimal_uint("bob value", bobValue, 6);
    }

    /// @notice Exits are never blocked for good: still stale 30 days after the epoch end, the rest fills at a 50%
    ///         haircut on the exposure; a deposit queued meanwhile is deferred, then refunded (never minted stale).
    function test_v2_NEW1_pastTheBound_exitCompletes_depositRefunded() public {
        uint256 rid = _setupExit();
        uint256 did = _requestDeposit(carol, 1_000 * U); // lands in the next epoch
        vm.warp(block.timestamp + 1 days);
        pool.processEpoch(); // stale (no book marked): exposure 50k - 10k = 40k, Alice gets 50/90
        uint256 got = pool.claim(rid);
        assertApproxEqAbs(got, 25_000 * U, 2 * U);
        // nobody marks fresh for 30+ days; every epoch is processed at its grace end
        for (uint256 i; i < 6; ++i) {
            (, uint64 ends,,,) = pool.queue();
            vm.warp(uint256(ends) + 1 days);
            pool.processEpoch();
        }
        got += pool.claim(rid);
        // rest 20k of Alice's value (40k exposure x 1/2), filled at D - 20k: (90k - 25k - 20k) x 20/65 ~ 13.85k
        assertGt(got, 25_000 * U + 13_000 * U);
        assertEq(pool.requestInfo(rid).shares, pool.epochInfo(pool.requestInfo(rid).epoch).filledShares, "all filled");
        vm.prank(carol);
        assertEq(pool.claimDeposit(did), 0, "refunded");
        assertEq(usdc.balanceOf(carol), 1_000 * U);
    }

    /// @notice NEW-3 x A-M2: a large deposit changes neither the exposure gate nor the concentration gate.
    function test_v2_NEW3_depositCannotBlock() public {
        _seedFirstLoss(10_000 * U);
        _deposit(alice, 100_000 * U);
        uint256 before = pool.maxAllocation(1, M1);
        assertEq(before, 33_000 * U, "market cap 30% of 110k binds (4x slice = 40k)");
        _deposit(bob, 10_000_000 * U);
        assertEq(pool.maxAllocation(1, M1), 40_000 * U, "4x the slice; the deposit only lifts the market cap");
        _allocate(1, 40_000 * U, M1);
        assertEq(pool.maxAllocation(2, M2), 40_000 * U, "a second 40k book still fits (10% of 80k = 8k <= 10k)");
    }

    /// @notice The linked library cannot be driven directly (state-changing library functions revert outside a
    ///         DELEGATECALL), and the pool calls it in its own storage context.
    function test_v2_lib_directCallReverts() public {
        (bool ok,) = address(PoolLogic).call(
            abi.encodeWithSelector(PoolLogic.setParam.selector, uint256(0x1234), bytes32("bufferBps"), uint256(0))
        );
        assertFalse(ok, "direct call refused");
        vm.prank(timelock);
        pool.setParam("bufferBps", 3000);
        (,, uint16 buffer,,,,,) = pool.params();
        assertEq(buffer, 3000, "delegatecall writes the proxy's storage");
    }
}
