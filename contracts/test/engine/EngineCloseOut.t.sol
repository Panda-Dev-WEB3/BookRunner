// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EngineBase} from "./utils/EngineBase.sol";
import {
    EngineMockBook,
    EngineMockMandate,
    EngineMockRegistry,
    EngineMockRevenueRouter,
    EngineMockVault,
    EngineLazyProxy
} from "./utils/EngineMocks.sol";
import {PoolEngine} from "../../src/PoolEngine.sol";
import {PoolEngineAdapter} from "../../src/PoolEngineAdapter.sol";
import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IPoolEngine} from "../../src/interfaces/IPoolEngine.sol";

/// @notice Wind-down close-out (PoolEngine.startCloseOut / forceClose, adapter.startCloseOut), the re-mandate
///         hook (adapter.applyMandate + lift on the next in-mandate quote), the inventory cap and the new views.
contract EngineCloseOutTest is EngineBase {
    event CloseOutScheduled(uint256 indexed marketId, uint64 closeOutAfter);
    event ClosedOut(
        uint256 indexed marketId,
        address indexed trader,
        address indexed by,
        int256 size,
        uint256 priceWad,
        uint256 badDebtUsd
    );
    event InventoryCapSet(uint256 indexed marketId, uint128 inventoryCapUsd);
    event MandateApplied(uint16 spreadBps, int16 skewBps, uint128 maxNetExposureUsd, uint128 inventoryCapUsd);

    uint256 internal constant BOOK_ID = 7;
    bytes32 internal constant UNDERLYING = bytes32("RHX5-INDEX");
    uint128 internal constant MAX_INV = 75_000e6;
    uint256 internal constant IF = 25_000e6;
    uint256 internal constant MM = 100_000e6;

    EngineMockRegistry internal registry;
    EngineMockBook internal bookMock;
    EngineMockMandate internal mandate;
    EngineMockRevenueRouter internal router;
    EngineMockVault internal vault;
    address internal desk = makeAddr("desk");
    address internal risk = makeAddr("risk");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");

    PoolEngineAdapter internal adapter;
    uint256 internal mid;

    function setUp() public {
        _deployCore();
        registry = new EngineMockRegistry();
        registry.setPriceId(UNDERLYING, PID_A);
        cfg.setStockRegistry(address(registry));
        cfg.grantRole(cfg.RISK_ROLE(), risk);
        mandate = new EngineMockMandate();
        mandate.setMandate(_mandate(MAX_INV, 10, 25));
        router = new EngineMockRevenueRouter(address(usdc));
        vault = new EngineMockVault(address(usdc));
        PoolEngineAdapter impl = new PoolEngineAdapter(address(cfg));
        adapter = PoolEngineAdapter(address(new EngineLazyProxy(address(impl))));
        bookMock = new EngineMockBook(BOOK_ID);
        BRTypes.Charter memory c;
        c.underlying = UNDERLYING;
        c.venue = BRTypes.VENUE_POOL_ENGINE;
        c.mandate = _mandate(MAX_INV, 10, 25);
        c.symbol = bytes32("RHX5-PERP");
        c.takerFeeBps = 10;
        bookMock.setCharter(c);
        bookMock.setComponents(
            BRTypes.BookComponents({
                book: address(bookMock),
                senior: makeAddr("senior"),
                junior: makeAddr("junior"),
                vault: address(vault),
                mandate: address(mandate),
                router: address(router),
                desk: desk,
                adapter: address(adapter)
            })
        );
        factory.setComponent(address(adapter), true);
        vault.setAdapter(address(adapter));
        vm.prank(address(factory));
        adapter.initialize(address(cfg), BOOK_ID, address(bookMock));
        mid = adapter.marketId();
        _price(PID_A, PX);
        usdc.mint(address(vault), IF + MM);
        vault.deployToVenue(BRTypes.ACCOUNT_IF, IF);
        vault.deployToVenue(BRTypes.ACCOUNT_MM, MM);
    }

    function _mandate(uint128 maxInv, uint16 minWidth, int16 maxSkew) internal pure returns (BRTypes.Mandate memory) {
        return BRTypes.Mandate({
            maxInventoryUsd: maxInv,
            maxSkewBps: maxSkew,
            minQuoteWidthBps: minWidth,
            maxHedgeLeverage: 100,
            hedgeRatioMinBps: 4000,
            hedgeRatioMaxBps: 12_000,
            noNewRiskOffHours: true,
            killAtDrawdownBps: -800,
            hedgeAllowRoot: bytes32(0)
        });
    }

    function _retire() internal {
        bookMock.setState(BRTypes.BookState.Retiring);
        mandate.forceReduceOnly(address(adapter), true);
    }

    // =================================================================== close-out scheduling

    function test_closeOut_scheduledByRetireKill() public {
        assertEq(engine.closeOutAfter(mid), 0);
        bookMock.setState(BRTypes.BookState.Retiring);
        vm.expectEmit(true, false, false, true, address(engine));
        emit CloseOutScheduled(mid, uint64(block.timestamp + 600));
        mandate.forceReduceOnly(address(adapter), true);
        assertEq(engine.closeOutAfter(mid), block.timestamp + 600);
        assertTrue(engine.state(mid).reduceOnly);
    }

    function test_closeOut_notScheduledByLiveKillOrRisk() public {
        mandate.forceReduceOnly(address(adapter), true);
        vm.prank(risk);
        adapter.setReduceOnly(true);
        assertEq(engine.closeOutAfter(mid), 0);
    }

    function test_startCloseOut_permissionlessOnceWindingDown_idempotent() public {
        vm.expectRevert(PoolEngineAdapter.BookNotWindingDown.selector);
        adapter.startCloseOut();
        // killed earlier while Live (reduce-only already): Book.retire does not re-kill, so nothing schedules
        mandate.forceReduceOnly(address(adapter), true);
        mandate.setKilled(true);
        bookMock.setState(BRTypes.BookState.Retiring);
        assertEq(engine.closeOutAfter(mid), 0);
        vm.prank(keeper);
        adapter.startCloseOut();
        uint64 at = engine.closeOutAfter(mid);
        assertEq(at, block.timestamp + 600);
        vm.warp(block.timestamp + 100);
        adapter.startCloseOut(); // first schedule sticks
        assertEq(engine.closeOutAfter(mid), at);
        bookMock.setState(BRTypes.BookState.Retired);
        adapter.startCloseOut();
        assertEq(engine.closeOutAfter(mid), at);
    }

    function test_closeOut_reduceOnlyCannotBeLifted() public {
        _retire();
        // the adapter refuses (winding down) and the engine refuses even its adapter
        bookMock.setState(BRTypes.BookState.Live);
        vm.prank(address(adapter));
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.CloseOutActive.selector, mid));
        engine.setReduceOnly(mid, false);
        vm.prank(address(adapter));
        engine.setReduceOnly(mid, true); // enabling is fine
    }

    function test_startCloseOut_onlyAdapterOnEngine() public {
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotAdapter.selector, address(this)));
        engine.startCloseOut(mid, 1);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotAdapter.selector, address(this)));
        engine.setInventoryCap(mid, 1);
    }

    // =================================================================== forceClose

    function test_forceClose_rejections() public {
        _deposit(alice, mid, 1000e6);
        _trade(alice, mid, 5e18);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.CloseOutNotOpen.selector, mid, uint64(0)));
        engine.forceClose(mid, alice);
        _retire();
        uint64 at = engine.closeOutAfter(mid);
        vm.warp(at - 1);
        _price(PID_A, PX);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.CloseOutNotOpen.selector, mid, at));
        engine.forceClose(mid, alice);
        vm.warp(at);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NoPosition.selector, bob));
        engine.forceClose(mid, bob);
        // a stale price never closes positions (maxTradePriceAge, like a trade)
        vm.warp(block.timestamp + 16);
        vm.expectPartialRevert(PoolEngine.StalePrice.selector);
        engine.forceClose(mid, alice);
        // nor a held (off-hours) one, stored or carried
        _push(PID_A, PX, true);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mid));
        engine.forceClose(mid, alice);
        vm.warp(block.timestamp + 1);
        bytes memory heldPd = _priceData(PID_A, PX, uint64(block.timestamp), true);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mid));
        engine.forceClose(mid, alice, heldPd);
        // the session reopens: a carried live price closes it
        vm.warp(block.timestamp + 1 hours);
        bytes memory livePd = _priceData(PID_A, PX, uint64(block.timestamp), false);
        engine.forceClose(mid, alice, livePd);
        assertEq(engine.positionOf(mid, alice).size, 0);
    }

    /// @dev Regression (forceClose free option): an attacker pair is held into the close of a Retiring market
    ///      whose close-out is open. After-hours news moves the real price to 90 while the feed holds 100. The
    ///      long owner force-closes its own losing leg (fee-free) at the held 100 and the short rides the
    ///      reopen at 90 -> riskless profit from the pool. forceClose must refuse a held price, so both legs
    ///      settle at the reopen price and the pair extracts nothing.
    function test_regression_forceCloseHeldPriceNoFreeOption() public {
        address longAcct = makeAddr("pairLong");
        address shortAcct = makeAddr("pairShort");
        uint256 dep = 2_000e6;
        _deposit(longAcct, mid, dep);
        _deposit(shortAcct, mid, dep);
        _trade(longAcct, mid, 10e18);
        _trade(shortAcct, mid, -10e18);
        _retire();
        vm.warp(engine.closeOutAfter(mid));
        _push(PID_A, PX, true); // session closed: the feed holds 100

        vm.warp(block.timestamp + 2 hours); // after-hours: real price 90, the feed still holds 100
        bytes memory heldNow = _priceData(PID_A, PX, uint64(block.timestamp), true);
        vm.prank(longAcct);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mid));
        engine.forceClose(mid, longAcct, heldNow);
        vm.prank(longAcct);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mid));
        engine.forceClose(mid, longAcct);

        vm.warp(block.timestamp + 14 hours); // reopen at 90: both legs at the same price
        bytes memory open = _priceData(PID_A, 90e18, uint64(block.timestamp), false);
        engine.forceClose(mid, shortAcct, open);
        engine.forceClose(mid, longAcct);
        uint256 out = engine.positionOf(mid, longAcct).marginUsd + engine.positionOf(mid, shortAcct).marginUsd;
        assertLe(out, 2 * dep, "pair extracted the after-hours move via a held-price forceClose");
    }

    function test_forceClose_winnerPaidLoserCharged_noFee() public {
        _deposit(alice, mid, 2000e6);
        _deposit(bob, mid, 2000e6);
        _trade(alice, mid, 10e18); // long @100.05
        _trade(bob, mid, -10e18); // short @99.95
        _retire();
        vm.warp(engine.closeOutAfter(mid));
        _price(PID_A, 110e18);
        uint256 ma = engine.positionOf(mid, alice).marginUsd;
        uint256 mb = engine.positionOf(mid, bob).marginUsd;
        uint256 fees = engine.state(mid).feesAccruedUsd;
        vm.expectEmit(true, true, true, true, address(engine));
        emit ClosedOut(mid, alice, keeper, 10e18, 110e18, 0);
        vm.prank(keeper);
        engine.forceClose(mid, alice);
        vm.prank(keeper);
        engine.forceClose(mid, bob);
        // at the oracle (no spread), no fee; funding over the notice is owed by the crowded side
        int256 fa = int256(engine.positionOf(mid, alice).marginUsd) - int256(ma);
        int256 fb = int256(engine.positionOf(mid, bob).marginUsd) - int256(mb);
        assertEq(fa, 99.5e6); // 10 * (110 - 100.05), net flat -> no funding
        assertEq(fb, -100.5e6); // 10 * (99.95 - 110)
        assertEq(engine.state(mid).feesAccruedUsd, fees);
        IPoolEngine.MarketState memory s = engine.state(mid);
        assertEq(s.longSize, 0);
        assertEq(s.shortSize, 0);
        assertEq(engine.poolEquityUsd(mid), int256(s.poolCashUsd));
        assertEq(usdc.balanceOf(address(engine)), _ledger(mid));
    }

    function test_forceClose_underwaterIsBadDebtCoveredByInsurance() public {
        _deposit(alice, mid, 110e6);
        _trade(alice, mid, 10e18); // 1000 notional, margin ~109
        _retire();
        vm.warp(engine.closeOutAfter(mid));
        _price(PID_A, 80e18); // loss ~200 > margin
        uint256 if0 = engine.state(mid).insuranceUsd;
        uint256 m = engine.positionOf(mid, alice).marginUsd;
        engine.forceClose(mid, alice);
        uint256 loss = 200.5e6; // 10 * (100.05 - 80), plus a few cents of funding over the notice
        assertEq(engine.positionOf(mid, alice).marginUsd, 0);
        assertApproxEqAbs(engine.state(mid).insuranceUsd, if0 - (loss - m), 0.01e6);
        assertLe(engine.state(mid).insuranceUsd, if0 - (loss - m));
        assertEq(usdc.balanceOf(address(engine)), _ledger(mid));
    }

    // =================================================================== views

    function test_withdrawableLiquidity_matchesGrossRequirement() public {
        _deposit(alice, mid, 15_000e6);
        _deposit(bob, mid, 15_000e6);
        _trade(alice, mid, 300e18);
        _trade(bob, mid, -300e18);
        uint256 w = engine.withdrawableLiquidityUsd(mid);
        // equity - 10% of the 30k side
        assertEq(w, uint256(engine.poolEquityUsd(mid)) - 3000e6);
        vm.expectRevert();
        vault.recall(BRTypes.ACCOUNT_MM, w + 1);
        vault.recall(BRTypes.ACCOUNT_MM, w);
        assertEq(engine.withdrawableLiquidityUsd(mid), 0);
        // flat book: the whole cash
        _trade(alice, mid, -300e18);
        _trade(bob, mid, 300e18);
        assertEq(engine.withdrawableLiquidityUsd(mid), engine.state(mid).poolCashUsd);
    }

    function test_inventoryCap_initialAndSideCap() public {
        assertEq(engine.inventoryCapUsd(mid), MAX_INV);
        _deposit(alice, mid, 20_000e6);
        _deposit(bob, mid, 20_000e6);
        _trade(alice, mid, 700e18);
        _trade(bob, mid, -700e18);
        // the long side is at 70k: +60 units (6k) would take it to 76k > 75k
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.ExposureCap.selector, 76_000e6, MAX_INV));
        engine.trade(mid, 60e18, type(uint256).max);
        // a new short on the other side is fine while that side stays within the cap
        _trade(bob, mid, -40e18);
    }

    // =================================================================== applyMandate (re-mandate hook)

    function test_applyMandate_onlyMandate() public {
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.Unauthorized.selector, address(this)));
        adapter.applyMandate();
        vm.prank(desk);
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.Unauthorized.selector, desk));
        adapter.applyMandate();
    }

    function test_applyMandate_clampsQuoteAndHoldsReduceOnlyUntilRequote() public {
        vm.prank(desk);
        adapter.setQuote(12, 20, MAX_INV);
        mandate.setMandate(_mandate(30_000e6, 15, 10));
        vm.expectEmit(false, false, false, true, address(adapter));
        emit MandateApplied(15, 10, 30_000e6, 30_000e6);
        mandate.callAdapter(address(adapter), abi.encodeWithSignature("applyMandate()"));
        IPoolEngine.MarketState memory s = engine.state(mid);
        assertEq(s.spreadBps, 15);
        assertEq(s.skewBps, 10);
        assertTrue(s.reduceOnly);
        assertEq(engine.config(mid).maxNetExposureUsd, 30_000e6);
        assertEq(engine.inventoryCapUsd(mid), 30_000e6);
        _deposit(alice, mid, 5000e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.MarketReduceOnly.selector, mid));
        engine.trade(mid, 1e18, type(uint256).max);
        // the first in-mandate quote (fresh key via the desk) re-opens the market under the new terms
        vm.prank(desk);
        adapter.setQuote(15, 0, 30_000e6);
        assertFalse(engine.state(mid).reduceOnly);
        _trade(alice, mid, 1e18);
        // widening skews stay clamped to the side cap
        vm.prank(alice);
        vm.expectPartialRevert(PoolEngine.ExposureCap.selector);
        engine.trade(mid, 300e18, type(uint256).max);
    }

    function test_applyMandate_negativeSkewClampedAndWiderSpreadKept() public {
        vm.prank(desk);
        adapter.setQuote(40, -25, 50_000e6);
        mandate.setMandate(_mandate(60_000e6, 10, 5));
        mandate.callAdapter(address(adapter), abi.encodeWithSignature("applyMandate()"));
        IPoolEngine.MarketState memory s = engine.state(mid);
        assertEq(s.spreadBps, 40);
        assertEq(s.skewBps, -5);
        assertEq(engine.config(mid).maxNetExposureUsd, 50_000e6);
        assertEq(engine.inventoryCapUsd(mid), 60_000e6);
    }

    function test_applyMandate_riskReduceOnlyAfterwardsIsNotLiftedByQuote() public {
        mandate.callAdapter(address(adapter), abi.encodeWithSignature("applyMandate()"));
        vm.prank(risk); // kill sequence step 2: RISK sets reduce-only before mandate.kill lands
        adapter.setReduceOnly(true);
        vm.prank(desk);
        adapter.setQuote(10, 0, MAX_INV);
        assertTrue(engine.state(mid).reduceOnly, "a quote must never undo a RISK reduce-only");
    }

    function test_applyMandate_onWindingDownBookNeverLifts() public {
        _retire();
        mandate.callAdapter(address(adapter), abi.encodeWithSignature("applyMandate()"));
        bookMock.setState(BRTypes.BookState.Live); // even if state reads Live later
        vm.prank(desk);
        adapter.setQuote(10, 0, MAX_INV);
        assertTrue(engine.state(mid).reduceOnly);
    }

    function test_applyMandate_liftOnlyOnce() public {
        mandate.callAdapter(address(adapter), abi.encodeWithSignature("applyMandate()"));
        vm.prank(desk);
        adapter.setQuote(10, 0, MAX_INV);
        assertFalse(engine.state(mid).reduceOnly);
        mandate.forceReduceOnly(address(adapter), true); // a later kill
        vm.prank(desk);
        adapter.setQuote(10, 0, MAX_INV);
        assertTrue(engine.state(mid).reduceOnly);
    }

    function test_oracle_canRelay() public view {
        assertTrue(oracle.canRelay(signer));
        assertTrue(oracle.canRelay(timelock));
        assertTrue(oracle.canRelay(address(this))); // KEEPER in the fixture
        assertFalse(oracle.canRelay(alice));
    }

    function test_setInventoryCap_accruesFundingFirst() public {
        _deposit(alice, mid, 5000e6);
        _trade(alice, mid, 100e18); // 10k skew
        vm.warp(block.timestamp + 1 days);
        _price(PID_A, PX);
        int256 pending = engine.state(mid).fundingIndex;
        vm.expectEmit(true, false, false, true, address(engine));
        emit InventoryCapSet(mid, 10_000e6);
        vm.prank(address(adapter));
        engine.setInventoryCap(mid, 10_000e6);
        assertEq(engine.state(mid).fundingIndex, pending);
        assertEq(engine.lastFundingTime(mid), block.timestamp);
        assertEq(engine.fundingRatePerDayWad(mid), int256(1e18 * uint256(100) / 1e4)); // 10k/10k: full
    }
}
