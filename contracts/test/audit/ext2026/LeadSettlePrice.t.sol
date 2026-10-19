// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {EngineBase} from "../../engine/utils/EngineBase.sol";
import {AttestedOracle} from "../../../src/AttestedOracle.sol";
import {PoolEngine} from "../../../src/PoolEngine.sol";
import {IPoolEngine} from "../../../src/interfaces/IPoolEngine.sol";
import {IAttestedOracle} from "../../../src/interfaces/IAttestedOracle.sol";
import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {Book} from "../../../src/Book.sol";
import {BookLogic} from "../../../src/libraries/BookLogic.sol";
import {BookFixture} from "../../book/utils/BookFixture.sol";

/// @title External audit 2026-10, lead "no settle path for a delisted / permanently held market".
/// @notice Finding: nothing on-chain could settle a market whose oracle never publishes a live price again
///         (delisting, permanent halt). Engine: every voluntary trade and the wind-down close-out need a live, fresh
///         price, and `withdrawInsurance` needs no open interest, so open positions, their margin and the market's
///         insurance fund stay locked until the oracle publishes a final live price. Book (audit M-1 x Task 7 hook):
///         held marks defer settlement for up to 30 days, then settle at the held valuation.
///         Fix: a timelocked settle price per oracle price id (AttestedOracle): proposed by the timelock, only for a
///         market whose stored price is held or stale, within SETTLE_PRICE_BAND_BPS (50%) of the stored price, in
///         force SETTLE_PRICE_DELAY (3 days) later and void once a live print published after the proposal lands.
///         In force, the engine prices the market at it as held (no voluntary trade) and anyone may close any
///         position at it, fee-free, without waiting for a close-out; the mark service values the book at it and
///         signs non-held marks, which settle. While PENDING, a book's held marks do not fall back to the held
///         valuation at 30 days (that fallback would settle just before the governance price); the pending window
///         is bounded (the delay), and on-chain past 60 days of hold the fallback returns whatever governance does.
contract LeadSettlePriceEngineTest is EngineBase {
    address internal ad = makeAddr("adapter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");
    uint128 internal constant MAX_NET = 75_000e6;
    uint256 internal constant POOL = 100_000e6;
    uint256 internal constant IF = 25_000e6;
    uint256 internal mid;

    function setUp() public {
        _deployCore();
        IPoolEngine.MarketConfig memory c = _defaultCfg(PID_A, MAX_NET);
        c.fundingVelocityBps = 0;
        mid = _createMarket(ad, c);
        _fundPool(ad, mid, POOL, IF);
        _setQuote(ad, mid, 10, 0, MAX_NET);
        _price(PID_A, PX);
        _deposit(alice, mid, 2_000e6);
        _trade(alice, mid, 100e18); // long 100 @ 100.05
        _deposit(bob, mid, 2_000e6);
        _trade(bob, mid, -50e18); // short 50 @ 99.95
        // the market halts for good: the oracle signs held, then nothing live ever again
        _push(PID_A, PX, true);
    }

    function _propose(uint256 price) internal {
        vm.prank(timelock);
        oracle.proposeSettlePrice(PID_A, price);
    }

    function _effective(uint256 price) internal {
        _propose(price);
        vm.warp(block.timestamp + oracle.SETTLE_PRICE_DELAY());
    }

    /// @notice PoC: a permanently held market. Without a settle price nothing can close the positions or release the
    ///         IF, even with the wind-down close-out open. With the governance price in force, anyone closes every
    ///         position at it and the IF is withdrawable.
    function test_lead_settle_poc_heldMarketClosesAtSettlePriceAndReleasesIf() public {
        vm.prank(ad);
        engine.startCloseOut(mid, 1 days);
        vm.warp(block.timestamp + 40 days);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mid));
        engine.forceClose(mid, alice);
        vm.prank(ad);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OpenInterest.selector, mid));
        engine.withdrawInsurance(mid, IF, ad);

        _effective(80e18); // delisted: governance settles at $80 (within 50% of the held $100)
        vm.startPrank(keeper);
        engine.forceClose(mid, alice);
        engine.forceClose(mid, bob);
        vm.stopPrank();
        assertEq(engine.positionOf(mid, alice).size, 0);
        assertEq(engine.positionOf(mid, bob).size, 0);
        // alice: 100 x (80 - 100.05) = -2,005 > her 1,989.995 margin: bad debt from the IF; bob: 50 x 19.95 = +997.5
        assertEq(engine.positionOf(mid, alice).marginUsd, 0);
        assertEq(engine.positionOf(mid, bob).marginUsd, 2_000e6 - 4_997_500 + 997_500_000);
        uint256 bobMargin = engine.positionOf(mid, bob).marginUsd;
        vm.prank(bob);
        engine.withdrawMargin(mid, bobMargin);
        uint256 ins = engine.state(mid).insuranceUsd;
        vm.prank(ad);
        engine.withdrawInsurance(mid, ins, ad);
        assertEq(usdc.balanceOf(address(engine)), _ledger(mid), "conservation");
    }

    function test_lead_settle_forceCloseNeedsNoCloseOut() public {
        _effective(90e18);
        vm.prank(keeper);
        engine.forceClose(mid, bob); // no startCloseOut: the market is settled
        assertEq(engine.positionOf(mid, bob).size, 0);
    }

    function test_lead_settle_pendingDoesNotSettle() public {
        _propose(90e18);
        (uint256 p, uint64 proposedAt, uint64 eff, bool pending, bool effective) = oracle.settlePrice(PID_A);
        assertEq(p, 90e18);
        assertEq(proposedAt, block.timestamp);
        assertEq(eff, block.timestamp + 3 days);
        assertTrue(pending);
        assertFalse(effective);
        vm.warp(eff - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.CloseOutNotOpen.selector, mid, uint64(0)));
        engine.forceClose(mid, bob);
        vm.warp(eff);
        (,,, pending, effective) = oracle.settlePrice(PID_A);
        assertFalse(pending);
        assertTrue(effective);
        vm.prank(keeper);
        engine.forceClose(mid, bob);
    }

    /// @notice In force, the market is priced at the settle price as held: views follow it, voluntary trades and
    ///         margin withdrawals with a position stay closed.
    function test_lead_settle_tradesStayClosed_viewsAtSettlePrice() public {
        _effective(90e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mid));
        engine.trade(mid, -10e18, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mid));
        engine.withdrawMargin(mid, 1e6);
        // trader equity at the settle price: margin + 100 x (90 - 100.05)
        assertEq(engine.traderEquityUsd(mid, alice), int256(1_989_995_000) - 1_005e6);
    }

    /// @notice The market trades again (a live print published after the proposal): the settle price is void.
    function test_lead_settle_voidedByLivePrint() public {
        _effective(90e18);
        _price(PID_A, 101e18);
        (,,, bool pending, bool effective) = oracle.settlePrice(PID_A);
        assertFalse(pending);
        assertFalse(effective);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.CloseOutNotOpen.selector, mid, uint64(0)));
        engine.forceClose(mid, bob);
        _trade(alice, mid, -10e18); // live trading resumes at the oracle
    }

    function test_lead_settle_cancel() public {
        _effective(90e18);
        vm.expectEmit(true, false, false, false, address(oracle));
        emit IAttestedOracle.SettlePriceCancelled(PID_A);
        vm.prank(timelock);
        oracle.cancelSettlePrice(PID_A);
        (uint256 p,,, bool pending, bool effective) = oracle.settlePrice(PID_A);
        assertEq(p, 0);
        assertFalse(pending || effective);
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.NoSettlePrice.selector, PID_A));
        oracle.cancelSettlePrice(PID_A);
    }

    function test_lead_settle_onlyTimelock() public {
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.NotTimelock.selector, address(this)));
        oracle.proposeSettlePrice(PID_A, 90e18);
        vm.prank(timelock);
        oracle.proposeSettlePrice(PID_A, 90e18);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.NotTimelock.selector, address(this)));
        oracle.cancelSettlePrice(PID_A);
    }

    /// @notice Bounded: within 50% of the stored (last attested / held) price, never 0.
    function test_lead_settle_band() public {
        vm.startPrank(timelock);
        oracle.proposeSettlePrice(PID_A, 50e18);
        oracle.proposeSettlePrice(PID_A, 150e18);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.SettlePriceOutOfBand.selector, PID_A, 50e18 - 1, PX));
        oracle.proposeSettlePrice(PID_A, 50e18 - 1);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.SettlePriceOutOfBand.selector, PID_A, 150e18 + 1, PX));
        oracle.proposeSettlePrice(PID_A, 150e18 + 1);
        vm.stopPrank();
    }

    /// @notice Only a market that stopped trading: a live, fresh stored price refuses it; a stale live one (the
    ///         feed stopped) or a held one accepts it; an unpriced id refuses it.
    function test_lead_settle_onlyStoppedMarkets() public {
        _price(PID_B, PX);
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.MarketTrading.selector, PID_B));
        oracle.proposeSettlePrice(PID_B, PX);
        vm.warp(block.timestamp + cfg.maxPriceAge() + 1);
        vm.prank(timelock);
        oracle.proposeSettlePrice(PID_B, PX);
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.StalePrice.selector, bytes32("NONE"), uint64(0)));
        oracle.proposeSettlePrice(bytes32("NONE"), PX);
    }

    /// @notice A re-proposal replaces the price and restarts the delay.
    function test_lead_settle_reproposalRestartsDelay() public {
        _propose(90e18);
        vm.warp(block.timestamp + 2 days);
        vm.expectEmit(true, false, false, true, address(oracle));
        emit IAttestedOracle.SettlePriceProposed(PID_A, 95e18, PX, uint64(block.timestamp + 3 days));
        _propose(95e18);
        vm.warp(block.timestamp + 2 days);
        (,,, bool pending,) = oracle.settlePrice(PID_A);
        assertTrue(pending);
    }

    /// @notice The delay keeps the governance path inside Book's 30-day deferral.
    function test_lead_settle_delayInsideMaxHeldDeferral() public view {
        assertLt(uint256(oracle.SETTLE_PRICE_DELAY()) + 21 days, BookLogic.MAX_HELD_DEFERRAL);
        assertEq(BookLogic.MAX_SETTLE_PRICE_DEFERRAL, 2 * BookLogic.MAX_HELD_DEFERRAL);
    }
}

/// @notice Minimal registry: the charter underlying's oracle price id.
contract PriceIdRegistry {
    bytes32 public pid;

    constructor(bytes32 p) {
        pid = p;
    }

    function priceIdOf(bytes32) external view returns (bytes32) {
        return pid;
    }
}

/// @notice An oracle from before the settle path (no settlePrice): the Book must fall back, never revert.
contract OldOracle {
    function latest(bytes32) external pure returns (IAttestedOracle.PriceData memory d) {
        return d;
    }
}

/// @notice Book side: the M-1 hold deferral with a governance settle price.
contract LeadSettlePriceBookTest is BookFixture {
    bytes32 internal constant PID = bytes32("NVDA");
    uint256 internal constant SIGNER_PK = 0xA11CE;
    AttestedOracle internal oracle;

    function setUp() public {
        _setUpBook();
        oracle = new AttestedOracle(address(cfg), vm.addr(SIGNER_PK), bytes32(0));
        cfg.setOracle(address(oracle));
        cfg.setStockRegistry(address(new PriceIdRegistry(PID)));
        cfg.grantRole(cfg.KEEPER_ROLE(), address(this));
        _goLive();
        _markWithPnl(0);
        _pushPrice(100e18, true); // the market is held from here on
    }

    function _pushPrice(uint256 price, bool held) internal {
        IAttestedOracle.PriceUpdate memory u = IAttestedOracle.PriceUpdate({
            underlying: PID,
            priceWad: price,
            publishedAt: uint64(block.timestamp),
            held: held,
            sourceCount: 3,
            sourcesHash: bytes32(0)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, oracle.hashPrice(u));
        oracle.push(u, abi.encodePacked(r, s, v));
    }

    function _heldMarkAt(uint256 ts) internal returns (uint256 id) {
        vm.warp(ts);
        id = _commitMark(uint64(block.timestamp), adapter.value(), book.flowNonce(), true);
    }

    /// @notice A settle price proposed at day 28 (in force at day 31): the held mark at day 30 does NOT settle at the
    ///         held valuation (the audited hook always let it), the first mark valued at the governance price
    ///         (non-held) settles. Liveness: the deferral ends with the delay.
    function test_lead_settle_book_pendingDefersTheThirtyDayFallback() public {
        vm.prank(carol);
        uint256 rid = junior.requestRedeem(5000e6, carol, carol);
        _heldMarkWithPnl(0);
        uint64 since = book.heldSince();
        vm.warp(since + 28 days);
        vm.prank(timelock);
        oracle.proposeSettlePrice(PID, 80e18);

        uint256 id = _heldMarkAt(since + BookLogic.MAX_HELD_DEFERRAL);
        vm.expectEmit(true, true, false, true, address(book));
        emit Book.MarkHeld(BOOK_ID, id, since, false);
        book.applyMark(id);
        assertEq(junior.pendingRedeemRequest(rid, carol), 5000e6, "pending settle price: no held-valuation fallback");

        // in force at day 31: the mark service values at $80 and signs a non-held mark; it settles
        vm.warp(since + 31 days);
        (,,,, bool effective) = oracle.settlePrice(PID);
        assertTrue(effective);
        _recall(20_000e6);
        _markWithPnl(-3000e6);
        assertEq(junior.pendingRedeemRequest(rid, carol), 0);
        assertEq(junior.claimableAssets(carol), 4500e6, "settled at the governance valuation");
    }

    /// @notice In force but the marks stay held (an old mark service): the 30-day fallback applies again (liveness).
    function test_lead_settle_book_effectiveButHeldMarks_fallbackSettles() public {
        vm.prank(carol);
        uint256 rid = junior.requestRedeem(5000e6, carol, carol);
        _heldMarkWithPnl(0);
        uint64 since = book.heldSince();
        vm.warp(since + 20 days);
        vm.prank(timelock);
        oracle.proposeSettlePrice(PID, 80e18);
        uint256 id = _heldMarkAt(since + BookLogic.MAX_HELD_DEFERRAL);
        vm.expectEmit(true, true, false, true, address(book));
        emit Book.MarkHeld(BOOK_ID, id, since, true);
        book.applyMark(id);
        assertEq(junior.claimableRedeemRequest(rid, carol), 5000e6);
    }

    /// @notice Hard bound: governance re-proposing every few days cannot defer settlement past 60 days of hold.
    function test_lead_settle_book_pendingCappedAtSixtyDays() public {
        vm.prank(carol);
        uint256 rid = junior.requestRedeem(5000e6, carol, carol);
        _heldMarkWithPnl(0);
        uint64 since = book.heldSince();
        uint256 t = since + 25 days;
        while (t < since + BookLogic.MAX_SETTLE_PRICE_DEFERRAL) {
            vm.warp(t);
            vm.prank(timelock);
            oracle.proposeSettlePrice(PID, 80e18); // pending again, for 3 more days
            if (t >= since + BookLogic.MAX_HELD_DEFERRAL) {
                book.applyMark(_heldMarkAt(t + INTERVAL));
                assertEq(junior.pendingRedeemRequest(rid, carol), 5000e6);
            }
            t += 2 days;
        }
        vm.warp(since + BookLogic.MAX_SETTLE_PRICE_DEFERRAL - 1 hours);
        vm.prank(timelock);
        oracle.proposeSettlePrice(PID, 80e18);
        uint256 id = _heldMarkAt(since + BookLogic.MAX_SETTLE_PRICE_DEFERRAL);
        vm.expectEmit(true, true, false, true, address(book));
        emit Book.MarkHeld(BOOK_ID, id, since, true);
        book.applyMark(id);
        assertEq(junior.claimableRedeemRequest(rid, carol), 5000e6);
    }

    /// @notice A live print voids the proposal: the market trades again, the next non-held mark settles.
    function test_lead_settle_book_voidedProposalFallsBack() public {
        _heldMarkWithPnl(0);
        uint64 since = book.heldSince();
        vm.warp(since + 29 days);
        vm.prank(timelock);
        oracle.proposeSettlePrice(PID, 80e18);
        vm.warp(since + 29 days + 1 hours);
        _pushPrice(101e18, false);
        vm.warp(block.timestamp + 1);
        _pushPrice(101e18, true); // held again right after
        uint256 id = _heldMarkAt(since + BookLogic.MAX_HELD_DEFERRAL);
        vm.expectEmit(true, true, false, true, address(book));
        emit Book.MarkHeld(BOOK_ID, id, since, true);
        book.applyMark(id);
    }

    /// @notice An oracle without the settle path, or none configured: the hook is false and the fallback runs.
    function test_lead_settle_book_oldOrMissingOracle_fallback() public {
        _heldMarkWithPnl(0);
        uint64 since = book.heldSince();
        vm.prank(timelock);
        oracle.proposeSettlePrice(PID, 80e18);
        cfg.setOracle(address(new OldOracle()));
        uint256 id = _heldMarkAt(since + BookLogic.MAX_HELD_DEFERRAL);
        vm.expectEmit(true, true, false, true, address(book));
        emit Book.MarkHeld(BOOK_ID, id, since, true);
        book.applyMark(id);
        cfg.setOracle(address(0));
        cfg.setStockRegistry(address(0));
        book.applyMark(_heldMarkAt(since + BookLogic.MAX_HELD_DEFERRAL + INTERVAL));
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live));
    }
}
