// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

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

contract PoolEngineAdapterV2 is PoolEngineAdapter {
    constructor(address config_) PoolEngineAdapter(config_) {}

    function version() external pure returns (uint256) {
        return 2;
    }
}

contract PoolEngineAdapterTest is EngineBase {
    event VenueDeposit(uint8 indexed account, uint256 amount);
    event WithdrawRequested(uint8 indexed account, uint256 amount, uint256 indexed requestNonce);
    event SweptToVault(uint256 amount);
    event FeesSwept(uint64 indexed period, uint256 amount);
    event AdapterInitialized(
        uint256 indexed bookId, address indexed book, address engine, uint256 marketId, bytes32 priceId
    );
    event WithdrawSettled(uint8 indexed account, uint256 amount, uint256 indexed requestNonce);
    event ReduceOnlySet(uint256 indexed marketId, bool reduceOnly);

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

    PoolEngineAdapter internal impl;
    PoolEngineAdapter internal adapter;
    uint256 internal mid;

    function setUp() public {
        _deployCore();
        registry = new EngineMockRegistry();
        registry.setPriceId(UNDERLYING, PID_A);
        cfg.setStockRegistry(address(registry));
        cfg.grantRole(cfg.RISK_ROLE(), risk);
        mandate = new EngineMockMandate();
        mandate.setMandate(_mandate(MAX_INV, 10));
        router = new EngineMockRevenueRouter(address(usdc));
        vault = new EngineMockVault(address(usdc));
        impl = new PoolEngineAdapter(address(cfg));
        (adapter, bookMock) = _newAdapter(BOOK_ID, _charter(BRTypes.VENUE_POOL_ENGINE, 10));
        vault.setAdapter(address(adapter));
        vm.expectEmit(true, true, false, true, address(adapter));
        emit AdapterInitialized(BOOK_ID, address(bookMock), address(engine), 1, PID_A);
        vm.prank(address(factory));
        adapter.initialize(address(cfg), BOOK_ID, address(bookMock));
        mid = adapter.marketId();
        _price(PID_A, PX);
    }

    // ------------------------------------------------------------------ fixtures

    function _mandate(uint128 maxInv, uint16 minWidth) internal pure returns (BRTypes.Mandate memory) {
        return BRTypes.Mandate({
            maxInventoryUsd: maxInv,
            maxSkewBps: 25,
            minQuoteWidthBps: minWidth,
            maxHedgeLeverage: 100,
            hedgeRatioMinBps: 4000,
            hedgeRatioMaxBps: 12_000,
            noNewRiskOffHours: true,
            killAtDrawdownBps: -800,
            hedgeAllowRoot: bytes32(0)
        });
    }

    function _charter(uint8 venue, uint16 minWidth) internal pure returns (BRTypes.Charter memory c) {
        c.underlying = UNDERLYING;
        c.venue = venue;
        c.oracle = BRTypes.ORACLE_ATTESTED;
        c.ifTargetUsd = uint128(IF);
        c.mmInventoryUsd = uint128(MM);
        c.mandate = _mandate(MAX_INV, minWidth);
        c.seniorHurdleBps = 6000;
        c.seniorCapBps = 7000;
        c.subscriptionWindow = 600;
        c.juniorNoticeSeconds = 900;
        c.sponsor = address(0x5905);
        c.symbol = bytes32("RHX5-PERP");
        c.takerFeeBps = 10;
        c.makerFeeBps = 0;
    }

    /// @dev Deploys a proxy + book mock wired to it (not initialised); registers it as a factory component.
    function _newAdapter(uint256 bookId, BRTypes.Charter memory c)
        internal
        returns (PoolEngineAdapter a, EngineMockBook b)
    {
        a = PoolEngineAdapter(address(new EngineLazyProxy(address(impl))));
        b = new EngineMockBook(bookId);
        b.setCharter(c);
        b.setComponents(
            BRTypes.BookComponents({
                book: address(b),
                senior: makeAddr("senior"),
                junior: makeAddr("junior"),
                vault: address(vault),
                mandate: address(mandate),
                router: address(router),
                desk: desk,
                adapter: address(a)
            })
        );
        factory.setComponent(address(a), true);
    }

    function _fundVenue() internal {
        usdc.mint(address(vault), IF + MM);
        vault.deployToVenue(BRTypes.ACCOUNT_IF, IF);
        vault.deployToVenue(BRTypes.ACCOUNT_MM, MM);
    }

    // ------------------------------------------------------------------ initialisation

    function test_initialize_createsMarketWithDefaults() public view {
        assertEq(mid, 1);
        assertEq(engine.adapterOf(mid), address(adapter));
        assertEq(engine.marketOf(address(adapter)), mid);
        IPoolEngine.MarketConfig memory c = engine.config(mid);
        assertEq(c.underlying, PID_A);
        assertEq(c.symbol, bytes32("RHX5-PERP"));
        assertEq(c.takerFeeBps, 10);
        assertEq(c.makerFeeBps, 0);
        assertEq(c.initialMarginBps, 1000);
        assertEq(c.maintenanceMarginBps, 500);
        assertEq(c.liquidationFeeBps, 50);
        assertEq(c.fundingVelocityBps, 100);
        assertEq(c.maxNetExposureUsd, MAX_INV);
        IPoolEngine.MarketState memory s = engine.state(mid);
        assertEq(s.spreadBps, 10); // mandate.minQuoteWidthBps
        assertEq(s.skewBps, 0);
        assertFalse(s.reduceOnly);

        assertEq(adapter.book(), address(bookMock));
        assertEq(adapter.bookId(), BOOK_ID);
        assertEq(adapter.config(), address(cfg));
        assertEq(adapter.engine(), address(engine));
        assertEq(adapter.priceId(), PID_A);
        assertEq(adapter.venueKind(), BRTypes.VENUE_POOL_ENGINE);
        (address v, address d, address m, address r) = adapter.wiring();
        assertEq(v, address(vault));
        assertEq(d, desk);
        assertEq(m, address(mandate));
        assertEq(r, address(router));
    }

    function test_initialize_onlyOnce() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        adapter.initialize(address(cfg), BOOK_ID, address(bookMock));
    }

    function test_constructor_zeroConfigReverts() public {
        vm.expectRevert(PoolEngineAdapter.ZeroAddress.selector);
        new PoolEngineAdapter(address(0));
        assertEq(address(impl.EXPECTED_CONFIG()), address(cfg));
    }

    function test_implementation_initializersDisabled() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(cfg), BOOK_ID, address(bookMock));
    }

    function test_initialize_reverts() public {
        BRTypes.Charter memory c = _charter(BRTypes.VENUE_POOL_ENGINE, 10);
        (PoolEngineAdapter a, EngineMockBook b) = _newAdapter(8, c);

        // only the config's factory, only with the bound config
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.NotFactory.selector, address(this)));
        a.initialize(address(cfg), 8, address(b));
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.ConfigMismatch.selector, address(0xC0FF)));
        a.initialize(address(0xC0FF), 8, address(b));

        vm.expectRevert(PoolEngineAdapter.ZeroAddress.selector);
        vm.prank(address(factory));
        a.initialize(address(0), 8, address(b));
        vm.expectRevert(PoolEngineAdapter.ZeroAddress.selector);
        vm.prank(address(factory));
        a.initialize(address(cfg), 8, address(0));
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.BookIdMismatch.selector, 9, 8));
        vm.prank(address(factory));
        a.initialize(address(cfg), 9, address(b));

        b.setCharter(_charter(BRTypes.VENUE_ORDERLY, 10));
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.WrongVenue.selector, BRTypes.VENUE_ORDERLY));
        vm.prank(address(factory));
        a.initialize(address(cfg), 8, address(b));
        b.setCharter(c);

        // the book must name this proxy as its adapter
        BRTypes.BookComponents memory comps = b.components();
        comps.adapter = address(0xBEEF);
        b.setComponents(comps);
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.NotBookAdapter.selector, address(0xBEEF)));
        vm.prank(address(factory));
        a.initialize(address(cfg), 8, address(b));
        comps.adapter = address(a);
        comps.router = address(0);
        b.setComponents(comps);
        vm.expectRevert(PoolEngineAdapter.ZeroAddress.selector);
        vm.prank(address(factory));
        a.initialize(address(cfg), 8, address(b));
        comps.router = address(router);
        b.setComponents(comps);

        registry.setPriceId(UNDERLYING, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.NoPriceId.selector, UNDERLYING));
        vm.prank(address(factory));
        a.initialize(address(cfg), 8, address(b));
        registry.setPriceId(UNDERLYING, PID_A);

        cfg.setPoolEngine(address(0));
        vm.expectRevert(PoolEngineAdapter.ZeroAddress.selector);
        vm.prank(address(factory));
        a.initialize(address(cfg), 8, address(b));
        cfg.setPoolEngine(address(engine));

        factory.setComponent(address(a), false);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotFactoryComponent.selector, address(a)));
        vm.prank(address(factory));
        a.initialize(address(cfg), 8, address(b));
        factory.setComponent(address(a), true);

        vm.prank(address(factory));
        a.initialize(address(cfg), 8, address(b));
        assertEq(a.marketId(), 2);
    }

    /// @dev Alternative factory flow: the stock OZ proxy deployed WITH init data at a pre-computed address
    ///      (components + factory registration done first, book already initialised).
    function test_initialize_viaProxyConstructorData() public {
        EngineMockBook b = new EngineMockBook(9);
        bytes memory initData = abi.encodeCall(PoolEngineAdapter.initialize, (address(cfg), 9, address(b)));
        bytes32 salt = keccak256("book-9-adapter");
        address predicted = vm.computeCreate2Address(
            salt,
            keccak256(abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(address(impl), initData))),
            address(factory)
        );
        b.setCharter(_charter(BRTypes.VENUE_POOL_ENGINE, 10));
        b.setComponents(
            BRTypes.BookComponents({
                book: address(b),
                senior: address(0x51),
                junior: address(0x52),
                vault: address(vault),
                mandate: address(mandate),
                router: address(router),
                desk: desk,
                adapter: predicted
            })
        );
        factory.setComponent(predicted, true);
        PoolEngineAdapter a = PoolEngineAdapter(
            factory.deploy2(
                salt, abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(address(impl), initData))
            )
        );
        assertEq(address(a), predicted);
        assertEq(engine.adapterOf(a.marketId()), predicted);
        assertEq(a.book(), address(b));
    }

    function test_initialize_initialSpreadClamped() public {
        BRTypes.Charter memory c = _charter(BRTypes.VENUE_POOL_ENGINE, 6000);
        (PoolEngineAdapter a, EngineMockBook b) = _newAdapter(8, c);
        vm.prank(address(factory));
        a.initialize(address(cfg), 8, address(b));
        assertEq(engine.state(a.marketId()).spreadBps, 5000);
    }

    // ------------------------------------------------------------------ capital movements

    function test_depositToVenue() public {
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.NotVault.selector, address(this)));
        adapter.depositToVenue(BRTypes.ACCOUNT_IF, 1);
        vm.startPrank(address(vault));
        vm.expectRevert(PoolEngineAdapter.ZeroAmount.selector);
        adapter.depositToVenue(BRTypes.ACCOUNT_IF, 0);
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.BadAccount.selector, 2));
        adapter.depositToVenue(2, 1);
        vm.stopPrank();

        usdc.mint(address(vault), IF + MM);
        vm.expectEmit(true, false, false, true, address(adapter));
        emit VenueDeposit(BRTypes.ACCOUNT_IF, IF);
        vault.deployToVenue(BRTypes.ACCOUNT_IF, IF);
        vm.expectEmit(true, false, false, true, address(adapter));
        emit VenueDeposit(BRTypes.ACCOUNT_MM, MM);
        vault.deployToVenue(BRTypes.ACCOUNT_MM, MM);

        IPoolEngine.MarketState memory s = engine.state(mid);
        assertEq(s.insuranceUsd, IF);
        assertEq(s.poolCashUsd, MM);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(usdc.allowance(address(adapter), address(engine)), 0);
        assertEq(adapter.insuranceEquityUsd(), IF);
        assertEq(adapter.marginEquityUsd(), int256(MM));
        assertEq(adapter.deployedValueUsd(), IF + MM);
    }

    function test_requestWithdraw_synchronous() public {
        _fundVenue();
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.NotVault.selector, address(this)));
        adapter.requestWithdraw(BRTypes.ACCOUNT_IF, 1);
        vm.startPrank(address(vault));
        vm.expectRevert(PoolEngineAdapter.ZeroAmount.selector);
        adapter.requestWithdraw(BRTypes.ACCOUNT_IF, 0);
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.BadAccount.selector, 5));
        adapter.requestWithdraw(5, 1);
        vm.stopPrank();

        vm.expectEmit(true, true, false, true, address(adapter));
        emit WithdrawRequested(BRTypes.ACCOUNT_IF, 5000e6, 1);
        vm.expectEmit(true, true, false, true, address(adapter));
        emit WithdrawSettled(BRTypes.ACCOUNT_IF, 5000e6, 1);
        vault.recall(BRTypes.ACCOUNT_IF, 5000e6);
        assertEq(usdc.balanceOf(address(vault)), 5000e6);
        vm.expectEmit(true, true, false, true, address(adapter));
        emit WithdrawRequested(BRTypes.ACCOUNT_MM, 7000e6, 2);
        vault.recall(BRTypes.ACCOUNT_MM, 7000e6);
        assertEq(usdc.balanceOf(address(vault)), 12_000e6);
        assertEq(adapter.withdrawNonce(), 2);
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(adapter.deployedValueUsd(), IF + MM - 12_000e6);
        assertEq(usdc.balanceOf(address(adapter)), 0);
    }

    function test_requestWithdraw_poolSolvencyEnforced() public {
        _fundVenue();
        _deposit(alice, mid, 20_000e6);
        _trade(alice, mid, 500e18); // pool short 50k -> pool margin 5k
        int256 eq = adapter.marginEquityUsd();
        uint256 req = engine.requiredPoolMarginUsd(mid);
        vm.expectPartialRevert(PoolEngine.PoolUndercollateralized.selector);
        vault.recall(BRTypes.ACCOUNT_MM, uint256(eq) - req + 1);
        vault.recall(BRTypes.ACCOUNT_MM, uint256(eq) - req);
        // the IF backs open positions: not withdrawable while any open interest remains
        vm.expectRevert(abi.encodeWithSignature("OpenInterest(uint256)", mid));
        vault.recall(BRTypes.ACCOUNT_IF, IF);
        _trade(alice, mid, -500e18);
        vault.recall(BRTypes.ACCOUNT_IF, IF);
        assertEq(adapter.insuranceEquityUsd(), 0);
    }

    function test_sweepToVault() public {
        assertEq(adapter.sweepToVault(), 0);
        usdc.mint(address(adapter), 123e6);
        vm.expectEmit(false, false, false, true, address(adapter));
        emit SweptToVault(123e6);
        vm.prank(makeAddr("anyone"));
        assertEq(adapter.sweepToVault(), 123e6);
        assertEq(usdc.balanceOf(address(vault)), 123e6);
    }

    function test_sweepFees_toRouter() public {
        _fundVenue();
        _deposit(alice, mid, 5000e6);
        (, uint256 fee1) = _trade(alice, mid, 100e18);
        (, uint256 fee2) = _trade(alice, mid, -40e18);
        uint256 fees = fee1 + fee2;
        assertGt(fees, 0);
        vm.expectEmit(true, false, false, true, address(adapter));
        emit FeesSwept(42, fees);
        vm.prank(makeAddr("anyone"));
        assertEq(adapter.sweepFees(42, 1), fees); // amount ignored
        assertEq(usdc.balanceOf(address(router)), fees);
        assertEq(router.calls(), 1);
        assertEq(router.lastSource(), BRTypes.SRC_ENGINE_FEES);
        assertEq(router.lastAmount(), fees);
        assertEq(router.pendingGross(), fees);
        assertEq(engine.state(mid).feesAccruedUsd, 0);
        // nothing accrued -> no notification
        assertEq(adapter.sweepFees(43, 0), 0);
        assertEq(router.calls(), 1);
    }

    // ------------------------------------------------------------------ quote / reduce-only

    function test_setQuote_onlyDeskWithinMandate() public {
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.NotDesk.selector, address(this)));
        adapter.setQuote(12, 3, MAX_INV);
        vm.prank(desk);
        vm.expectRevert(
            abi.encodeWithSelector(PoolEngineAdapter.ExposureAboveMandate.selector, MAX_INV + 1, MAX_INV)
        );
        adapter.setQuote(12, 3, MAX_INV + 1);
        vm.prank(desk);
        adapter.setQuote(12, -3, 40_000e6);
        IPoolEngine.MarketState memory s = engine.state(mid);
        assertEq(s.spreadBps, 12);
        assertEq(s.skewBps, -3);
        assertEq(engine.config(mid).maxNetExposureUsd, 40_000e6);
        // re-mandate to a smaller inventory: quotes above it are rejected
        mandate.setMandate(_mandate(10_000e6, 10));
        vm.prank(desk);
        vm.expectRevert(
            abi.encodeWithSelector(
                PoolEngineAdapter.ExposureAboveMandate.selector, 40_000e6, uint128(10_000e6)
            )
        );
        adapter.setQuote(12, 0, 40_000e6);
        mandate.setKilled(true);
        vm.prank(desk);
        vm.expectRevert(PoolEngineAdapter.MandateKilled.selector);
        adapter.setQuote(12, 0, 1);
    }

    function test_setQuote_engineBoundsPropagate() public {
        vm.prank(desk);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.InvalidQuote.selector, 5001, 0));
        adapter.setQuote(5001, 0, MAX_INV);
    }

    function test_setReduceOnly_access() public {
        vm.prank(makeAddr("rando"));
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.Unauthorized.selector, makeAddr("rando")));
        adapter.setReduceOnly(true);

        // RISK may enable, never disable
        vm.expectEmit(true, false, false, true, address(engine));
        emit ReduceOnlySet(mid, true);
        vm.prank(risk);
        adapter.setReduceOnly(true);
        assertTrue(engine.state(mid).reduceOnly);
        vm.prank(risk);
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.Unauthorized.selector, risk));
        adapter.setReduceOnly(false);

        // desk, book and mandate may toggle
        vm.prank(desk);
        adapter.setReduceOnly(false);
        assertFalse(engine.state(mid).reduceOnly);
        vm.prank(address(bookMock));
        adapter.setReduceOnly(true);
        vm.prank(address(bookMock));
        adapter.setReduceOnly(false);
        mandate.forceReduceOnly(address(adapter), true);
        assertTrue(engine.state(mid).reduceOnly);
        mandate.forceReduceOnly(address(adapter), false);
        assertFalse(engine.state(mid).reduceOnly);
    }

    function test_setReduceOnly_cannotClearWhenKilledOrWindingDown() public {
        mandate.forceReduceOnly(address(adapter), true);
        mandate.setKilled(true);
        vm.prank(desk);
        vm.expectRevert(PoolEngineAdapter.MandateKilled.selector);
        adapter.setReduceOnly(false);
        // enabling is still fine while killed
        vm.prank(desk);
        adapter.setReduceOnly(true);
        mandate.setKilled(false);

        bookMock.setState(BRTypes.BookState.Retiring);
        vm.prank(desk);
        vm.expectRevert(PoolEngineAdapter.BookWindingDown.selector);
        adapter.setReduceOnly(false);
        bookMock.setState(BRTypes.BookState.Retired);
        vm.prank(address(bookMock));
        vm.expectRevert(PoolEngineAdapter.BookWindingDown.selector);
        adapter.setReduceOnly(false);
        bookMock.setState(BRTypes.BookState.Live);
        vm.prank(desk);
        adapter.setReduceOnly(false);
    }

    function test_killFlow_reduceOnlyThenReduceAndLiquidateStillWork() public {
        _fundVenue();
        _deposit(alice, mid, 1100e6);
        _trade(alice, mid, 100e18);
        mandate.forceReduceOnly(address(adapter), true); // mandate.kill()
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.MarketReduceOnly.selector, mid));
        engine.trade(mid, 1e18, type(uint256).max);
        _trade(alice, mid, -10e18);
        _price(PID_A, 90e18);
        assertTrue(engine.isLiquidatable(mid, alice));
        engine.liquidate(mid, alice);
    }

    // ------------------------------------------------------------------ regression: retirement finalizes

    function _forceClose(address trader) internal returns (bool ok) {
        (ok,) = address(engine).call(abi.encodeWithSignature("forceClose(uint256,address)", mid, trader));
    }

    /// @dev PoC (engine-retire-never-finalizes): Eve ($50 margin, 0.01 unit long, 50x collateralised) kept
    ///      poolEquity > 0 forever, so no final mark could carry deployedValueUsd == 0. The retire kill now
    ///      schedules a close-out CLOSE_OUT_NOTICE_MARKS mark intervals out; after it anyone closes the
    ///      remaining positions at the oracle, the keeper recalls MM + IF and the final mark sees 0.
    function test_regression_retiringBookClosesOutPositionsAndFinalizes() public {
        _fundVenue();
        address eve = makeAddr("eve");
        _deposit(eve, mid, 50e6);
        _trade(eve, mid, 0.01e18);
        _deposit(bob, mid, 5000e6);
        _trade(bob, mid, -100e18);
        bookMock.setState(BRTypes.BookState.Retiring);
        mandate.forceReduceOnly(address(adapter), true); // Book.retire -> mandate.kill -> reduce-only
        assertTrue(engine.state(mid).reduceOnly);
        assertFalse(_forceClose(eve), "close-out before the notice");
        // positions open: the IF stays, MM keeps the gross pool margin
        vm.expectRevert();
        vault.recall(BRTypes.ACCOUNT_IF, IF);

        vm.warp(block.timestamp + 2 * 300); // 2 x markInterval (300 in the mock config)
        _price(PID_A, 101e18);
        assertTrue(_forceClose(eve), "eve closed out at the oracle");
        assertTrue(_forceClose(bob), "bob closed out at the oracle");
        assertEq(engine.positionOf(mid, eve).size, 0);
        assertEq(engine.positionOf(mid, bob).size, 0);
        assertTrue(engine.state(mid).reduceOnly);

        // flat: the keeper recalls everything and the final mark reads zero
        vault.recall(BRTypes.ACCOUNT_MM, uint256(adapter.marginEquityUsd()));
        vault.recall(BRTypes.ACCOUNT_IF, adapter.insuranceEquityUsd());
        assertEq(adapter.deployedValueUsd(), 0);
        // traders keep their leftover margin
        uint256 m = engine.positionOf(mid, eve).marginUsd;
        assertGt(m, 49e6);
        vm.prank(eve);
        engine.withdrawMargin(mid, m);
        assertEq(usdc.balanceOf(address(engine)), _ledger(mid));
    }

    // ------------------------------------------------------------------ views

    function test_views_basic() public view {
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(adapter.valuationAt(), uint64(block.timestamp));
        assertEq(adapter.netExposureUsd(), 0);
        assertEq(adapter.deployedValueUsd(), 0);
    }

    function test_views_exposureAndEquity() public {
        _fundVenue();
        _deposit(alice, mid, 5000e6);
        _trade(alice, mid, 100e18); // traders long 100 -> pool (book) short 10k
        assertEq(adapter.netExposureUsd(), -10_000e6);
        assertEq(adapter.netExposureUsd(), engine.netExposureUsd(mid));
        assertEq(adapter.marginEquityUsd(), engine.poolEquityUsd(mid));
        assertEq(adapter.deployedValueUsd(), IF + uint256(engine.poolEquityUsd(mid)));
    }

    /// @dev Regression (engine-nav-overstated): a negative pool equity is a claim on the IF (winners are paid
    ///      pool -> IF -> ADL), so NAV nets it: deployedValueUsd = max(IF + poolEquity, 0), not IF + 0.
    function test_views_negativePoolEquityNettedAgainstInsurance() public {
        usdc.mint(address(vault), IF + 1000e6);
        vault.deployToVenue(BRTypes.ACCOUNT_IF, IF);
        vault.deployToVenue(BRTypes.ACCOUNT_MM, 1000e6);
        _deposit(alice, mid, 2000e6);
        _trade(alice, mid, 99e18); // pool margin 990 <= equity ~1000
        _price(PID_A, 125e18); // trader +~2475 > pool cash 1000
        int256 eq = adapter.marginEquityUsd();
        assertLt(eq, 0);
        assertEq(adapter.deployedValueUsd(), uint256(int256(IF) + eq));
        assertLt(adapter.deployedValueUsd(), IF);
        // the mark is what actually remains once the winner is paid (pool cash, then IF): closing at the
        // bid only adds the half-spread the pool earns (99 * 125 * 5 bps ~ 6.2 USDC)
        uint256 before = adapter.deployedValueUsd();
        _trade(alice, mid, -99e18);
        uint256 afterClose = adapter.deployedValueUsd();
        assertGe(afterClose, before);
        assertLe(afterClose, before + 7e6);
    }

    function test_views_poolDeficitBeyondInsuranceClampsToZero() public {
        usdc.mint(address(vault), 100e6 + 1000e6);
        vault.deployToVenue(BRTypes.ACCOUNT_IF, 100e6);
        vault.deployToVenue(BRTypes.ACCOUNT_MM, 1000e6);
        _deposit(alice, mid, 2000e6);
        _trade(alice, mid, 99e18);
        _price(PID_A, 125e18); // trader +~2475: pool -1475, IF 100
        assertLt(int256(adapter.insuranceEquityUsd()) + adapter.marginEquityUsd(), 0);
        assertEq(adapter.deployedValueUsd(), 0);
    }

    // ------------------------------------------------------------------ red-team: mandate bound + regimes

    function testFuzz_poolExposureNeverAboveMaxInventory(int256 s1, int256 s2, uint128 quoteMax) public {
        _fundVenue();
        quoteMax = uint128(bound(quoteMax, 0, MAX_INV));
        vm.prank(desk);
        adapter.setQuote(10, 0, quoteMax);
        s1 = bound(s1, -2000e18, 2000e18);
        s2 = bound(s2, -2000e18, 2000e18);
        _deposit(alice, mid, 100_000e6);
        _deposit(bob, mid, 100_000e6);
        if (s1 != 0) {
            vm.prank(alice);
            try engine.trade(mid, s1, s1 > 0 ? type(uint256).max : 0) {} catch {}
        }
        if (s2 != 0) {
            vm.prank(bob);
            try engine.trade(mid, s2, s2 > 0 ? type(uint256).max : 0) {} catch {}
        }
        assertLe(_abs(adapter.netExposureUsd()), quoteMax);
        assertLe(_abs(adapter.netExposureUsd()), MAX_INV);
    }

    function test_offHours_viaAdapterMarket() public {
        _fundVenue();
        _deposit(alice, mid, 1100e6);
        _deposit(bob, mid, 5000e6);
        _trade(alice, mid, 100e18);
        _trade(bob, mid, -20e18);
        _push(PID_A, 93e18, true); // held
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mid));
        engine.trade(mid, -1e18, 0);
        vm.prank(bob); // reductions wait for the session too (audit A2-03)
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mid));
        engine.trade(mid, 20e18, type(uint256).max);
        engine.liquidate(mid, alice); // liquidation on margin at the held price
        assertEq(engine.positionOf(mid, alice).size, 0);
        // the book can still recall its capital off-hours
        vault.recall(BRTypes.ACCOUNT_MM, 1000e6);
    }

    // ------------------------------------------------------------------ upgrades

    function test_upgrade_onlyTimelock() public {
        PoolEngineAdapterV2 v2 = new PoolEngineAdapterV2(address(cfg));
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.NotTimelock.selector, address(this)));
        adapter.upgradeToAndCall(address(v2), "");
        vm.prank(desk);
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.NotTimelock.selector, desk));
        adapter.upgradeToAndCall(address(v2), "");

        _fundVenue();
        vm.prank(timelock);
        adapter.upgradeToAndCall(address(v2), "");
        assertEq(PoolEngineAdapterV2(address(adapter)).version(), 2);
        // storage preserved
        assertEq(adapter.marketId(), mid);
        assertEq(adapter.book(), address(bookMock));
        assertEq(adapter.insuranceEquityUsd(), IF);
        (address v,,,) = adapter.wiring();
        assertEq(v, address(vault));
    }

    function test_upgrade_followsConfigTimelock() public {
        PoolEngineAdapterV2 v2 = new PoolEngineAdapterV2(address(cfg));
        address tl2 = makeAddr("timelock2");
        cfg.setTimelock(tl2);
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(PoolEngineAdapter.NotTimelock.selector, timelock));
        adapter.upgradeToAndCall(address(v2), "");
        vm.prank(tl2);
        adapter.upgradeToAndCall(address(v2), "");
    }

    function test_implementation_cannotBeUpgradedDirectly() public {
        PoolEngineAdapterV2 v2 = new PoolEngineAdapterV2(address(cfg));
        vm.prank(timelock);
        vm.expectRevert();
        impl.upgradeToAndCall(address(v2), "");
    }
}
