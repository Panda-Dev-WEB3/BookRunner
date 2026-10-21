// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {InsurancePool} from "../../src/InsurancePool.sol";
import {IInsurancePool} from "../../src/interfaces/IInsurancePool.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {CoreMockFactory} from "../core/utils/CoreMocks.sol";
import {PoolFixture} from "./utils/PoolFixture.sol";

/// @notice Drives the pool through random deposits, queued exits, fills, claims, allocations, premiums, losses,
///         recoveries, repayments, first-loss deposits, pauses and time. Records any broken rule in ghosts that the
///         invariants assert (exits never blocked, first-loss first, price stable on deposit / fill, cap at allocation).
contract PoolHandler is StdUtils, Test {
    uint256 internal constant U = 1e6;
    uint256 internal constant BOOKS = 4;

    InsurancePool public pool;
    MockERC20 public usdc;
    CoreMockFactory public factory;
    address public guardian;
    address public timelock;
    address[3] public actors;

    // ghosts
    uint256 public ghostIn; // deposits + first-loss deposits + premiums
    uint256 public ghostLossesNet; // losses - recoveries
    uint256 public ghostClaimed;
    uint256[] public requestIds;
    bool public exitBlocked;
    bool public firstLossOrderBroken;
    bool public priceMovedOnDeposit;
    bool public priceMovedOnFill;
    bool public overCap;
    bool public doubleAllocation;
    mapping(uint256 => bool) public allocated;

    constructor(InsurancePool pool_, MockERC20 usdc_, CoreMockFactory factory_, address guardian_, address timelock_) {
        pool = pool_;
        usdc = usdc_;
        factory = factory_;
        guardian = guardian_;
        timelock = timelock_;
        actors = [makeAddr("dep0"), makeAddr("dep1"), makeAddr("dep2")];
    }

    function _book(uint256 seed) internal pure returns (uint256) {
        return (seed % BOOKS) + 1;
    }

    function _price() internal view returns (uint256) {
        return pool.convertToAssets(1e12);
    }

    // ---------------------------------------------------------------- depositors

    function deposit(uint256 who, uint256 amount) external {
        (bool d,) = pool.paused();
        if (d) return;
        address a = actors[who % 3];
        amount = bound(amount, 1 * U, 2_000_000 * U);
        if (pool.previewDeposit(amount) == 0) return;
        usdc.mint(a, amount);
        uint256 p0 = _price();
        vm.startPrank(a);
        usdc.approve(address(pool), amount);
        pool.deposit(amount, a);
        vm.stopPrank();
        uint256 p1 = _price();
        if (p1 + 1 < p0 || p1 > p0 + 1 + p0 / 1e6) priceMovedOnDeposit = true;
        ghostIn += amount;
    }

    function requestWithdraw(uint256 who, uint256 fraction) external {
        address a = actors[who % 3];
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

    function claim(uint256 seed) external {
        if (requestIds.length == 0) return;
        uint256 id = requestIds[seed % requestIds.length];
        pool.processQueue(8);
        uint256 c = pool.claimable(id);
        if (c == 0) return;
        try pool.claim(id) returns (uint256 got) {
            ghostClaimed += got;
            if (got < c) exitBlocked = true;
        } catch {
            exitBlocked = true; // a filled request is always claimable
        }
    }

    function processQueue(uint256 n) external {
        uint256 p0 = _price();
        pool.processQueue(bound(n, 1, 16));
        if (_price() + 1 < p0) priceMovedOnFill = true;
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1 hours, 10 days));
    }

    function firstLossDeposit(uint256 amount) external {
        amount = bound(amount, 1, 200_000 * U);
        address t = makeAddr("treasury");
        usdc.mint(t, amount);
        vm.startPrank(t);
        usdc.approve(address(pool), amount);
        pool.depositFirstLoss(amount);
        vm.stopPrank();
        ghostIn += amount;
    }

    function pause(bool deposits, bool allocations) external {
        vm.prank(timelock);
        pool.setPaused(deposits, allocations);
    }

    // ---------------------------------------------------------------- books

    function allocate(uint256 seed, uint256 amount) external {
        uint256 id = _book(seed);
        uint256 cap = (pool.poolAssets() * 3000) / 10_000;
        uint256 maxA = pool.maxAllocation(id);
        if (maxA == 0) return;
        amount = bound(amount, 1, maxA);
        vm.prank(factory.bookOf(id));
        try pool.allocate(id, amount) {
            if (allocated[id]) doubleAllocation = true;
            allocated[id] = true;
            if (amount > cap) overCap = true;
        } catch {}
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

    function loss(uint256 seed, uint256 amount) external {
        uint256 id = _book(seed);
        uint256 c = pool.bookPosition(id).claim;
        if (c == 0) return;
        amount = bound(amount, 1, c);
        uint256 fl0 = pool.firstLossAssets();
        uint256 d0 = pool.totalAssets();
        vm.prank(factory.bookOf(id));
        pool.reportLoss(id, amount);
        uint256 fl1 = pool.firstLossAssets();
        uint256 d1 = pool.totalAssets();
        if (amount <= fl0) {
            if (d1 != d0 || fl1 != fl0 - amount) firstLossOrderBroken = true;
        } else if (fl1 != 0 || d1 != d0 - (amount - fl0)) {
            firstLossOrderBroken = true;
        }
        ghostLossesNet += amount;
    }

    function recover(uint256 seed, uint256 amount) external {
        uint256 id = _book(seed);
        IInsurancePool.BookPosition memory p = pool.bookPosition(id);
        uint256 room = p.lossFirstLoss + p.lossDepositors;
        if (room == 0) return;
        amount = bound(amount, 1, room);
        vm.prank(p.book);
        pool.reportRecovery(id, amount);
        ghostLossesNet -= amount;
    }

    function repay(uint256 seed, uint256 amount) external {
        uint256 id = _book(seed);
        IInsurancePool.BookPosition memory p = pool.bookPosition(id);
        uint256 maxR = p.claim < usdc.balanceOf(p.vault) ? p.claim : usdc.balanceOf(p.vault);
        if (maxR == 0) return;
        amount = bound(amount, 1, maxR);
        vm.startPrank(p.vault);
        usdc.approve(address(pool), amount);
        pool.repay(id, amount);
        vm.stopPrank();
    }

    function requestCount() external view returns (uint256) {
        return requestIds.length;
    }
}

/// @notice POOL-1..POOL-6 (docs/INVARIANTS.md): pool value conservation, no market over its cap at allocation, exits
///         never blocked, first-loss absorbs first, share price stable on deposit / fill, position identities.
contract InsurancePoolInvariantTest is PoolFixture {
    PoolHandler internal handler;

    function setUp() public {
        _deployPool();
        for (uint256 i = 1; i <= 4; i++) {
            _registerBook(i);
        }
        handler = new PoolHandler(pool, usdc, factory, guardian, timelock);
        targetContract(address(handler));
    }

    /// @notice Every unit in is in the pool (free + claims), reserved for a filled withdrawal, claimed, or a
    ///         reported loss: deposits + slice + premiums - net losses - claimed == pool assets + reserved.
    function invariant_valueConserved() public view {
        (, uint256 reserved,, uint256 losses) = pool.ledger();
        assertEq(handler.ghostIn() - handler.ghostLossesNet() - handler.ghostClaimed(), pool.poolAssets() + reserved);
        assertEq(losses, handler.ghostLossesNet(), "net losses");
    }

    /// @notice pool assets == free + allocated - reported losses (+ premiums, in free): the book claims add up.
    function invariant_ledger() public view {
        _checkLedger();
        uint256 sum;
        for (uint256 i = 1; i <= 4; i++) {
            IInsurancePool.BookPosition memory p = pool.bookPosition(i);
            assertEq(p.allocation - p.claim, p.lossFirstLoss + p.lossDepositors, "allocation - claim == losses");
            assertLe(p.claim, p.allocation, "claim <= allocation");
            sum += p.claim;
        }
        assertEq(sum, pool.claimsTotal(), "claims add up");
    }

    function invariant_noMarketOverItsCap() public view {
        assertFalse(handler.overCap(), "allocation above 30% of the pool");
        assertFalse(handler.doubleAllocation(), "a book allocated twice");
    }

    function invariant_exitsNeverBlocked() public view {
        assertFalse(handler.exitBlocked(), "requestWithdraw refused or a filled claim failed");
    }

    function invariant_firstLossAbsorbsFirst() public view {
        assertFalse(handler.firstLossOrderBroken(), "a loss reached depositors while the slice had assets");
    }

    function invariant_priceStableOnDepositAndWithdraw() public view {
        assertFalse(handler.priceMovedOnDeposit(), "deposit moved the share price");
        assertFalse(handler.priceMovedOnFill(), "a withdrawal fill lowered the share price");
    }

    /// @notice Escrowed shares are exactly the unfilled part of the queue.
    function invariant_escrowMatchesQueue() public view {
        (,, uint256 pending,) = pool.queue();
        assertEq(pool.balanceOf(address(pool)), pending);
    }
}
