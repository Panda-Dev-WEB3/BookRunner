// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {InsurancePool} from "../../../src/InsurancePool.sol";
import {PoolFixture} from "../../pool/utils/PoolFixture.sol";

/// @title Pool audit 2026-10-23 (scope A): the PoCs of .superpowers/sdd/2026-10-23-pool-audit/audit-A.md turned into
///        regression tests: each failed on the audited code (main 3099919, where the PoC assertions held) and passes
///        on the fix.
/// @notice Run: FORGE_DOCKER_ARGS="--cpus=2 --memory=3g" bash scripts/forge.sh test --match-path test/audit/pool2026/PoolAuditA.t.sol
contract PoolAuditATest is PoolFixture {
    bytes32 internal constant NVDA = bytes32("NVDA");
    bytes32 internal constant TSLA = bytes32("TSLA");

    function setUp() public {
        _deployPool();
        _registerBook(1);
        _registerBook(2);
    }

    /// @dev T = 100k: slice 10k (at its 10% target), depositors 90k; two books on two markets, 20k each.
    function _twoBooks() internal {
        _seedFirstLoss(10_000 * U);
        _deposit(alice, 90_000 * U);
        _allocate(1, 20_000 * U, NVDA);
        _allocate(2, 20_000 * U, TSLA);
        assertEq(pool.totalAssets(), 90_000 * U);
        assertEq(pool.firstLossAssets(), 10_000 * U);
    }

    // =====================================================================================================
    // A-M1: the first-loss slice is the pool's junior tranche, accounted pool-wide (depositorLoss). A recovery, from
    //       whichever book, restores the depositors' net loss first, so the order of the marks never moves value
    //       between the depositors and the treasury (POOL-4 in net terms, recoveries included).
    // =====================================================================================================

    /// @notice Was: book 1's recovery refilled the slice (10k) while the depositors still carried book 2's loss, and the
    ///         treasury could withdraw from it. Now the recovery goes to the depositors first: same end state as the
    ///         other order, and the treasury has nothing to withdraw.
    function test_A_M1_recoveryRestoresTheDepositorsFirst_whicheverBookItComesFrom() public {
        _twoBooks();
        _markValue(1, 10_000 * U); // book 1: -10k, the slice absorbs it all
        assertEq(pool.firstLossAssets(), 0);
        _markValue(2, 10_000 * U); // book 2: -10k, the slice is empty, depositors absorb it
        assertEq(pool.totalAssets(), 80_000 * U);
        assertEq(pool.depositorLoss(), 10_000 * U);
        _markValue(1, 20_000 * U); // book 1 recovers in full

        assertEq(pool.firstLossAssets(), 0, "the slice carries the net loss (book 2's)");
        assertEq(pool.totalAssets(), 90_000 * U, "depositors whole");
        assertEq(pool.depositorLoss(), 0);
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.InsufficientFreeLiquidity.selector, 1_111 * U, 0));
        pool.withdrawFirstLoss(1_111 * U, treasury);
    }

    /// @notice Same marks, other order: identical end state (it was already this one).
    function test_A_M1_sameNetMarks_otherOrder_sameEndState() public {
        _twoBooks();
        _markValue(2, 10_000 * U);
        _markValue(1, 10_000 * U);
        _markValue(1, 20_000 * U);
        assertEq(pool.firstLossAssets(), 0, "slice carries book 2's loss");
        assertEq(pool.totalAssets(), 90_000 * U, "depositors whole");
        assertEq(pool.depositorLoss(), 0);
    }

    /// @notice Was: Alice exited with 80k while the slice held 10k. Now she exits whole; the slice carries the loss.
    function test_A_M1_depositorExitsWhole_sliceCarriesTheNetLoss() public {
        _twoBooks();
        _markValue(1, 10_000 * U);
        _markValue(2, 10_000 * U);
        _markValue(1, 20_000 * U);
        _repay(1, 20_000 * U); // book 1 retires whole
        _repay(2, 10_000 * U); // book 2 repays what it can (its 10k loss stands): free cash for Alice's full exit
        uint256 rid = _request(alice, pool.balanceOf(alice));
        _processThrough(rid);
        uint256 got = pool.claim(rid);
        assertApproxEqAbs(got, 90_000 * U, 1, "alice whole");
        assertEq(pool.firstLossAssets(), 0, "the treasury slice took the net loss");
    }

    /// @notice A slice top-up while the depositors carry a net loss restores them first (junior tranche).
    function test_A_M1_sliceTopUp_restoresTheDepositorsFirst() public {
        _twoBooks();
        _markValue(1, 0); // -20k: slice 10k, depositors 10k
        assertEq(pool.depositorLoss(), 10_000 * U);
        _seedFirstLoss(15_000 * U);
        assertEq(pool.depositorLoss(), 0);
        assertEq(pool.totalAssets(), 90_000 * U, "depositors restored first");
        assertEq(pool.firstLossAssets(), 5_000 * U, "the rest to the slice");
    }

    // =====================================================================================================
    // A-M2: the first-loss gate covers the exposure (book claims), not the pool's idle depositor cash, so no deposit can
    //       block an allocation; and a deposit queued before a guardian pause is refunded, not minted (A-L5).
    // =====================================================================================================

    /// @notice Was: 9x the slice queued, then the guardian pause did not stop its minting, and every allocation reverted.
    ///         Now the paused processing refunds it, and the launch book allocates.
    function test_A_M2_queuedDilution_refundedOnPause_allocationGoesThrough() public {
        uint256 seed = 91_671 * U; // RUNBOOK 13b launch seed (NVDA / TSLA 25,001 + RHX5 10,000)
        _seedFirstLoss(seed);
        uint256 big = 9 * seed + 1 * U;
        uint256 id = _requestDeposit(bob, big);
        vm.prank(guardian);
        pool.setPaused(true, false);
        _process();
        assertEq(pool.totalSupply(), 0, "nothing minted while deposits are paused");
        assertEq(pool.refundsPending(), big);
        assertEq(_claimDeposit(id), 0, "refunded");
        assertEq(usdc.balanceOf(bob), big);
        assertGe(pool.maxAllocation(1, NVDA), 25_001 * U, "launch book fits");
        _allocate(1, 25_001 * U, NVDA);
    }

    /// @notice Without a pause the dilution is minted, and still blocks nothing: the slice covers the exposure, and the
    ///         diluter's capital now funds the allocations (it is no longer risk-free).
    function test_A_M2_dilutionMinted_blocksNoAllocation() public {
        uint256 seed = 91_671 * U;
        _seedFirstLoss(seed);
        _deposit(bob, 9 * seed + 1 * U);
        assertLt(pool.firstLossAssets(), pool.poolAssets() / 10, "slice below 10% of the pool");
        assertGe(pool.maxAllocation(1, NVDA), 25_001 * U, "still fits: 10% of the exposure is covered");
        _allocate(1, 25_001 * U, NVDA);
        _allocate(2, 25_001 * U, TSLA);
    }

    /// @notice Was: 10 units blocked every allocation once the slice sat at its target. Now they change nothing.
    function test_A_M2_dustDeposit_blocksNothing() public {
        _seedFirstLoss(10_000 * U);
        _deposit(alice, 90_000 * U);
        uint256 before = pool.maxAllocation(1, NVDA);
        assertGt(before, 0);
        _deposit(bob, 10);
        assertGe(pool.maxAllocation(1, NVDA), before, "0.00001 USDG blocks nothing");
    }
}
