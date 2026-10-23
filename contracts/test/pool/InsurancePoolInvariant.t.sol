// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {InsurancePool} from "../../src/InsurancePool.sol";
import {IInsurancePool} from "../../src/interfaces/IInsurancePool.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {CoreMockFactory} from "../core/utils/CoreMocks.sol";
import {PoolFixture} from "./utils/PoolFixture.sol";

/// @notice Drives the pool through random queued deposits (and cancellations), queued exits, epoch processing (with
///         and without fresh book marks), claims, allocations, premiums, book marks (losses / recoveries),
///         repayments, first-loss deposits, pauses and time. Records any broken rule in ghosts the invariants assert.
contract PoolHandler is StdUtils, Test {
    uint256 internal constant U = 1e6;
    uint256 internal constant BOOKS = 4;

    InsurancePool public pool;
    MockERC20 public usdc;
    CoreMockFactory public factory;
    address public timelock;
    address[3] public actors;

    // ghosts
    uint256 public ghostIn; // deposits requested - cancelled + first-loss deposits + premiums
    uint256 public ghostLossesNet;
    uint256 public ghostClaimed;
    uint256[] public requestIds;
    uint256[] public depositIds;
    bool public exitBlocked;
    bool public firstLossOrderBroken;
    bool public priceMovedOnProcessing;
    bool public overCap;
    bool public processedTooEarly;
    bool public exitLiquidityTaken; // A-L3: an allocation / slice withdrawal left less than the queued exits need
    mapping(uint256 => bool) public allocated;

    constructor(InsurancePool pool_, MockERC20 usdc_, CoreMockFactory factory_, address timelock_) {
        pool = pool_;
        usdc = usdc_;
        factory = factory_;
        timelock = timelock_;
        actors = [makeAddr("dep0"), makeAddr("dep1"), makeAddr("dep2")];
    }

    function _book(uint256 seed) internal pure returns (uint256) {
        return (seed % BOOKS) + 1;
    }

    function _market(uint256 id) internal pure returns (bytes32) {
        return id % 2 == 0 ? bytes32("EVEN") : bytes32("ODD"); // two books per market
    }

    function _price() internal view returns (uint256) {
        return pool.convertToAssets(1e12);
    }

    // ---------------------------------------------------------------- depositors

    function requestDeposit(uint256 who, uint256 amount) external {
        (bool d,) = pool.paused();
        if (d) return;
        address a = actors[who % 3];
        amount = bound(amount, 1 * U, 2_000_000 * U);
        usdc.mint(a, amount);
        vm.startPrank(a);
        usdc.approve(address(pool), amount);
        depositIds.push(pool.requestDeposit(amount));
        vm.stopPrank();
        ghostIn += amount;
    }

    function cancelDeposit(uint256 seed) external {
        if (depositIds.length == 0) return;
        uint256 id = depositIds[seed % depositIds.length];
        InsurancePool.DepositRequest memory d = pool.depositInfo(id);
        if (d.done || pool.epochInfo(d.epoch).processed || block.timestamp >= pool.epochEnd(d.epoch)) return;
        vm.prank(d.owner);
        pool.cancelDeposit(id);
        ghostIn -= d.assets;
    }

    function claimDeposit(uint256 seed) external {
        if (depositIds.length == 0) return;
        uint256 id = depositIds[seed % depositIds.length];
        InsurancePool.DepositRequest memory d = pool.depositInfo(id);
        if (d.done || !pool.epochInfo(d.epoch).processed) return;
        _claimDeposit(id, d);
    }

    /// @dev A deposit of an epoch processed without minting (deposits paused) is refunded: it leaves the pool.
    function _claimDeposit(uint256 id, InsurancePool.DepositRequest memory d) internal {
        bool refunded = pool.epochInfo(d.epoch).depositShares == 0;
        vm.prank(d.owner);
        pool.claimDeposit(id);
        if (refunded) ghostIn -= d.assets;
    }

    function requestWithdraw(uint256 who, uint256 fraction) external {
        address a = actors[who % 3];
        // claim the actor's processed deposits first (more exits per sequence)
        for (uint256 k; k < depositIds.length && k < 16; ++k) {
            InsurancePool.DepositRequest memory d = pool.depositInfo(depositIds[k]);
            if (d.owner == a && !d.done && pool.epochInfo(d.epoch).processed) _claimDeposit(depositIds[k], d);
        }
        uint256 bal = pool.balanceOf(a);
        if (bal == 0) return;
        uint256 shares = bound(fraction, 1, bal);
        vm.prank(a);
        try pool.requestWithdraw(shares) returns (uint256 id) {
            requestIds.push(id);
        } catch {
            exitBlocked = true; // never refused, whatever the pause / cooldown
        }
    }

    /// @dev Claims every request with something filled (from a random start, at most 16).
    function claim(uint256 seed) external {
        uint256 n = requestIds.length;
        if (n == 0) return;
        for (uint256 k; k < n && k < 16; ++k) {
            uint256 id = requestIds[(seed + k) % n];
            uint256 c = pool.claimable(id);
            if (c == 0) continue;
            try pool.claim(id) returns (uint256 got) {
                ghostClaimed += got;
                if (got < c) exitBlocked = true;
            } catch {
                exitBlocked = true; // a filled request is always claimable
            }
        }
    }

    /// @dev Processes up to `n` epochs (1..4), each with or without fresh marks.
    function processEpochs(uint256 n, bool fresh) external {
        n = bound(n, 1, 4);
        for (uint256 i; i < n; ++i) {
            processEpoch(fresh);
        }
    }

    /// @dev Processes the oldest epoch: with `fresh` every active book marks first; otherwise it waits out the grace.
    function processEpoch(bool fresh) public {
        (,, uint256 pendingDeposits,,) = pool.ledger();
        (, uint64 ends,, uint256 pendingShares,) = pool.queue();
        if (pendingShares == 0 && pendingDeposits == 0) return; // idle: nothing to process
        if (block.timestamp < ends) vm.warp(ends);
        if (fresh) {
            uint256[] memory ids = pool.activeBooks();
            for (uint256 i; i < ids.length; ++i) {
                IInsurancePool.BookPosition memory p = pool.bookPosition(ids[i]);
                vm.prank(p.book);
                pool.markBook(ids[i], p.claim, uint64(block.timestamp), false, false);
            }
        }
        uint256 p0 = _price();
        uint256 stale = pool.staleBooks(ends);
        // the gate applies to an epoch that prices something (its deposits, its withdrawals or older unfilled ones);
        // an empty epoch between two queued ones only advances the queue and prices nothing, marks or not
        (uint64 e,, uint64 fillE,,) = pool.queue();
        InsurancePool.Epoch memory ep = pool.epochInfo(e);
        bool prices = ep.depositAssets != 0 || ep.shares != 0 || fillE < e;
        try pool.processEpoch() {
            if (prices && stale != 0 && block.timestamp < uint256(ends) + 1 days) processedTooEarly = true;
            if (_price() + 1 < p0) priceMovedOnProcessing = true;
        } catch {
            if (stale == 0) exitBlocked = true; // every book marked: nothing may hold it back
            vm.warp(uint256(ends) + 1 days); // exits are never blocked: past the grace it must go through
            try pool.processEpoch() {}
            catch {
                exitBlocked = true;
            }
        }
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1 hours, 10 days));
    }

    function firstLossDeposit(uint256 amount) external {
        amount = bound(amount, 1, 400_000 * U);
        address t = makeAddr("treasury");
        usdc.mint(t, amount);
        vm.startPrank(t);
        usdc.approve(address(pool), amount);
        pool.depositFirstLoss(amount);
        vm.stopPrank();
        ghostIn += amount;
    }

    /// @dev Timelock: a first-loss withdrawal within its rules (audit 2026-10-23 A-I9: no handler before).
    function firstLossWithdraw(uint256 amount) external {
        uint256 fl = pool.firstLossAssets();
        if (fl == 0) return;
        amount = bound(amount, 1, fl);
        vm.prank(timelock);
        try pool.withdrawFirstLoss(amount, makeAddr("treasury")) {
            ghostIn -= amount;
            _checkExitLiquidity();
        } catch {}
    }

    /// @dev Free liquidity still covers every queued withdrawal at the current price (A-L3).
    function _checkExitLiquidity() internal {
        (uint256 cash, uint256 reserved,,,) = pool.ledger();
        (,,, uint256 pendingShares,) = pool.queue();
        if (cash - reserved < pool.convertToAssets(pendingShares)) exitLiquidityTaken = true;
    }

    function pause(bool deposits, bool allocations) external {
        vm.prank(timelock);
        pool.setPaused(deposits, allocations);
    }

    // ---------------------------------------------------------------- books

    function allocate(uint256 seed, uint256 amount) external {
        uint256 id = _book(seed);
        bytes32 m = _market(id);
        uint256 maxA = pool.maxAllocation(id, m);
        if (maxA == 0) return;
        uint256 room = (pool.poolAssets() * 3000) / 10_000 - pool.marketAllocated(m);
        amount = bound(amount, 1, maxA);
        vm.prank(factory.bookOf(id));
        pool.allocate(id, amount, m);
        allocated[id] = true;
        _checkExitLiquidity();
        if (amount > room) overCap = true;
    }

    function premium(uint256 seed, uint256 amount) external {
        uint256 id = _book(seed);
        if (!allocated[id]) return;
        amount = bound(amount, 0, 50_000 * U);
        address router = factory.componentsOf(id).router;
        usdc.mint(router, amount);
        vm.startPrank(router);
        usdc.approve(address(pool), amount);
        pool.notifyPremium(id, amount);
        vm.stopPrank();
        ghostIn += amount;
    }

    /// @dev The book reports what it can repay: any value up to the allocation (a loss or a recovery).
    function mark(uint256 seed, uint256 value) external {
        uint256 id = _book(seed);
        IInsurancePool.BookPosition memory p = pool.bookPosition(id);
        if (p.book == address(0)) return;
        value = bound(value, 0, p.allocation);
        uint256 fl0 = pool.firstLossAssets();
        uint256 d0 = pool.totalAssets();
        uint256 dl0 = pool.depositorLoss();
        vm.prank(p.book);
        pool.markBook(id, value, uint64(block.timestamp), false, false);
        if (value > p.claim && pool.totalSupply() >= 1e6) {
            // audit 2026-10-23 A-M1: a recovery, from whichever book, restores the depositors' net loss first
            uint256 rec = value - p.claim;
            uint256 d = rec < dl0 ? rec : dl0;
            if (pool.firstLossAssets() != fl0 + rec - d || pool.totalAssets() != d0 + d) firstLossOrderBroken = true;
        }
        if (value < p.claim) {
            uint256 loss = p.claim - value;
            uint256 fl1 = pool.firstLossAssets();
            uint256 d1 = pool.totalAssets();
            if (loss <= fl0) {
                if (d1 != d0 || fl1 != fl0 - loss) firstLossOrderBroken = true;
            } else if (fl1 != 0 || d1 != d0 - (loss - fl0)) {
                firstLossOrderBroken = true;
            }
            ghostLossesNet += loss;
        } else if (value > p.claim) {
            ghostLossesNet -= value - p.claim;
        }
    }

    function repay(uint256 seed, uint256 amount) external {
        uint256 id = _book(seed);
        IInsurancePool.BookPosition memory p = pool.bookPosition(id);
        uint256 bal = usdc.balanceOf(p.vault);
        uint256 maxR = p.allocation < bal ? p.allocation : bal;
        if (p.vault == address(0) || maxR == 0) return;
        amount = bound(amount, 1, maxR);
        // paying above the pool's claim is a recovery first
        if (amount > p.claim) ghostLossesNet -= amount - p.claim;
        vm.startPrank(p.vault);
        usdc.approve(address(pool), amount);
        pool.repay(id, amount);
        vm.stopPrank();
    }

    function requestCount() external view returns (uint256) {
        return requestIds.length;
    }
}

/// @notice POOL-1..POOL-7, POOL-10 (docs/INVARIANTS.md): value conservation, no market over its cap at allocation, exits
///         never blocked, first-loss absorbs first, the share price never moves on deposit / withdrawal processing,
///         position identities, processing gated on book marks (or the grace period).
contract InsurancePoolInvariantTest is PoolFixture {
    PoolHandler internal handler;

    function setUp() public {
        _deployPool();
        for (uint256 i = 1; i <= 4; i++) {
            _registerBook(i);
        }
        // daily epochs and a 1-day cooldown so a 64-call sequence sees whole deposit -> exit cycles (the 7-day
        // defaults are covered by the unit tests)
        vm.startPrank(timelock);
        pool.setParam("epochLength", 1 days);
        pool.setParam("cooldown", 1 days);
        vm.stopPrank();
        handler = new PoolHandler(pool, usdc, factory, timelock);
        targetContract(address(handler));
    }

    /// @notice Every unit in is in the pool (free + claims), reserved for a filled withdrawal, queued as a deposit,
    ///         claimed, or a reported loss.
    function invariant_valueConserved() public view {
        (, uint256 reserved, uint256 pendingDeposits,, uint256 losses) = pool.ledger();
        assertEq(
            handler.ghostIn() - handler.ghostLossesNet() - handler.ghostClaimed(),
            pool.poolAssets() + reserved + pendingDeposits + pool.refundsPending()
        );
        assertEq(losses, handler.ghostLossesNet(), "net losses");
    }

    function invariant_ledger() public view {
        _checkLedger();
        uint256 sum;
        for (uint256 i = 1; i <= 4; i++) {
            IInsurancePool.BookPosition memory p = pool.bookPosition(i);
            assertEq(p.allocation - p.claim, p.lossFirstLoss + p.lossDepositors, "allocation - claim == losses");
            sum += p.claim;
        }
        assertEq(sum, pool.claimsTotal(), "claims add up");
    }

    function invariant_noMarketOverItsCap() public view {
        assertFalse(handler.overCap(), "an allocation above 30% of the pool for its market");
    }

    function invariant_exitsNeverBlocked() public view {
        assertFalse(handler.exitBlocked(), "a withdrawal refused, a filled claim failed, or processing blocked past grace");
    }

    /// @notice POOL-4, pool-wide and through recoveries (audit 2026-10-23 A-M1): the slice is the pool's junior tranche,
    ///         so the depositors never carry a net loss while it holds assets, whatever the order of losses, recoveries,
    ///         premiums, slice deposits / withdrawals and exits.
    function invariant_firstLossAbsorbsFirst() public view {
        assertFalse(handler.firstLossOrderBroken(), "a loss reached depositors while the slice had assets");
        assertTrue(pool.depositorLoss() == 0 || pool.firstLossAssets() == 0, "depositors impaired while the slice holds");
    }

    /// @notice Audit 2026-10-23 A-L3: an allocation or a slice withdrawal never takes the liquidity queued exits need.
    function invariant_queuedExitsKeepTheirLiquidity() public view {
        assertFalse(handler.exitLiquidityTaken(), "an allocation or slice withdrawal took queued exits' liquidity");
    }

    function invariant_priceStableOnDepositAndWithdraw() public view {
        assertFalse(handler.priceMovedOnProcessing(), "deposit / withdrawal processing lowered the share price");
    }

    function invariant_processingWaitsForMarks() public view {
        assertFalse(handler.processedTooEarly(), "an epoch processed before every book marked, inside the grace");
    }
}
