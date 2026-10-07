// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EngineBase} from "./utils/EngineBase.sol";
import {EngineMockConfig, EngineMockFactory} from "./utils/EngineMocks.sol";
import {ReentrantToken} from "./utils/ReentrantToken.sol";
import {PoolEngine} from "../../src/PoolEngine.sol";
import {AttestedOracle} from "../../src/AttestedOracle.sol";
import {IPoolEngine} from "../../src/interfaces/IPoolEngine.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

contract PoolEngineTest is EngineBase {
    event MarketCreated(
        uint256 indexed marketId, address indexed adapter, bytes32 underlying, bytes32 symbol
    );
    event QuoteSet(uint256 indexed marketId, uint16 spreadBps, int16 skewBps, uint128 maxNetExposureUsd);
    event Trade(
        uint256 indexed marketId,
        address indexed trader,
        int256 sizeDelta,
        uint256 fillPriceWad,
        uint256 feeUsd,
        int256 realizedPnlUsd,
        int256 newSize
    );
    event Liquidation(
        uint256 indexed marketId,
        address indexed trader,
        address indexed liquidator,
        int256 size,
        uint256 priceWad,
        uint256 feeUsd,
        uint256 badDebtUsd
    );
    event ADL(uint256 indexed marketId, uint256 shortfallUsd);
    event MarginChanged(uint256 indexed marketId, address indexed trader, int256 delta);
    event LiquidityChanged(uint256 indexed marketId, int256 liquidityDelta, int256 insuranceDelta);
    event FeesClaimed(uint256 indexed marketId, address to, uint256 amount);
    event ReduceOnlySet(uint256 indexed marketId, bool reduceOnly);
    event FundingSettled(uint256 indexed marketId, address indexed trader, int256 owedUsd);
    event InsuranceDrawn(uint256 indexed marketId, uint256 amountUsd);

    address internal adA = makeAddr("adapterA");
    address internal adB = makeAddr("adapterB");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");

    uint128 internal constant MAX_NET = 75_000e6;
    uint256 internal constant POOL = 100_000e6;
    uint256 internal constant IF = 25_000e6;

    uint256 internal mA; // velocity 0 (exact PnL math)
    uint256 internal mB; // second market, other underlying

    function setUp() public {
        _deployCore();
        IPoolEngine.MarketConfig memory c = _defaultCfg(PID_A, MAX_NET);
        c.fundingVelocityBps = 0;
        mA = _createMarket(adA, c);
        mB = _createMarket(adB, _defaultCfg(PID_B, MAX_NET));
        _fundPool(adA, mA, POOL, IF);
        _fundPool(adB, mB, POOL, IF);
        _setQuote(adA, mA, 10, 0, MAX_NET);
        _setQuote(adB, mB, 10, 0, MAX_NET);
        _price(PID_A, PX);
        _price(PID_B, PX);
    }

    // =================================================================== construction / createMarket

    function test_constructor() public view {
        assertEq(address(engine.protocolConfig()), address(cfg));
        assertEq(address(engine.usdc()), address(usdc));
        assertEq(engine.marketCount(), 2);
        assertEq(engine.marketOf(adA), mA);
        assertEq(engine.adapterOf(mA), adA);
    }

    function test_constructor_reverts() public {
        vm.expectRevert(PoolEngine.ZeroAddress.selector);
        new PoolEngine(address(0));
        EngineMockConfig c2 = new EngineMockConfig(timelock);
        vm.expectRevert(PoolEngine.ZeroAddress.selector);
        new PoolEngine(address(c2));
    }

    function test_createMarket_onlyFactoryComponent() public {
        address rogue = makeAddr("rogue");
        vm.prank(rogue);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotFactoryComponent.selector, rogue));
        engine.createMarket(_defaultCfg(PID_A, MAX_NET));
    }

    function test_createMarket_oneMarketPerAdapter() public {
        vm.prank(adA);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.AdapterHasMarket.selector, adA, mA));
        engine.createMarket(_defaultCfg(PID_A, MAX_NET));
    }

    function test_createMarket_eventsAndConfig() public {
        address ad = makeAddr("adapterC");
        factory.setComponent(ad, true);
        IPoolEngine.MarketConfig memory c = _defaultCfg(PID_A, 1234e6);
        vm.expectEmit(true, true, false, true, address(engine));
        emit MarketCreated(3, ad, PID_A, c.symbol);
        vm.expectEmit(true, false, false, true, address(engine));
        emit QuoteSet(3, 0, 0, 1234e6);
        vm.prank(ad);
        uint256 id = engine.createMarket(c);
        assertEq(id, 3);
        IPoolEngine.MarketConfig memory got = engine.config(id);
        assertEq(got.underlying, PID_A);
        assertEq(got.initialMarginBps, 1000);
        assertEq(got.maintenanceMarginBps, 500);
        assertEq(got.liquidationFeeBps, 50);
        assertEq(got.fundingVelocityBps, 100);
        assertEq(got.maxNetExposureUsd, 1234e6);
        assertEq(engine.lastFundingTime(id), block.timestamp);
    }

    function test_createMarket_invalidConfigs() public {
        address ad = makeAddr("adapterC");
        factory.setComponent(ad, true);
        IPoolEngine.MarketConfig[] memory bad = new IPoolEngine.MarketConfig[](8);
        for (uint256 i; i < bad.length; ++i) {
            bad[i] = _defaultCfg(PID_A, MAX_NET);
        }
        bad[0].underlying = bytes32(0);
        bad[1].maintenanceMarginBps = 0;
        bad[2].initialMarginBps = 500; // == maintenance
        bad[3].initialMarginBps = 10_001;
        bad[4].liquidationFeeBps = 501; // > maintenance
        bad[5].takerFeeBps = 501;
        bad[6].makerFeeBps = 501;
        bad[7].fundingVelocityBps = 10_001;
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(ad);
            vm.expectRevert(PoolEngine.InvalidMarketConfig.selector);
            engine.createMarket(bad[i]);
        }
    }

    function test_unknownMarket() public {
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.UnknownMarket.selector, 99));
        engine.depositMargin(99, 1);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.UnknownMarket.selector, 99));
        engine.config(99);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.UnknownMarket.selector, 99));
        engine.state(99);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.UnknownMarket.selector, 99));
        engine.trade(99, 1, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.UnknownMarket.selector, 99));
        engine.liquidate(99, alice);
    }

    // =================================================================== admin access control

    function test_adminFunctions_onlyAdapter() public {
        vm.startPrank(adB); // adapter of another market
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotAdapter.selector, adB));
        engine.setQuote(mA, 10, 0, MAX_NET);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotAdapter.selector, adB));
        engine.setReduceOnly(mA, true);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotAdapter.selector, adB));
        engine.depositInsurance(mA, 1);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotAdapter.selector, adB));
        engine.depositLiquidity(mA, 1);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotAdapter.selector, adB));
        engine.withdrawLiquidity(mA, 1, adB);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotAdapter.selector, adB));
        engine.withdrawInsurance(mA, 1, adB);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotAdapter.selector, adB));
        engine.claimFees(mA, adB);
        vm.stopPrank();
        // unknown market: no adapter can match
        vm.prank(adA);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotAdapter.selector, adA));
        engine.setReduceOnly(42, true);
    }

    function test_admin_zeroAmountsAndAddresses() public {
        vm.startPrank(adA);
        vm.expectRevert(PoolEngine.ZeroAmount.selector);
        engine.depositInsurance(mA, 0);
        vm.expectRevert(PoolEngine.ZeroAmount.selector);
        engine.depositLiquidity(mA, 0);
        vm.expectRevert(PoolEngine.ZeroAmount.selector);
        engine.withdrawLiquidity(mA, 0, adA);
        vm.expectRevert(PoolEngine.ZeroAddress.selector);
        engine.withdrawLiquidity(mA, 1, address(0));
        vm.expectRevert(PoolEngine.ZeroAmount.selector);
        engine.withdrawInsurance(mA, 0, adA);
        vm.expectRevert(PoolEngine.ZeroAddress.selector);
        engine.withdrawInsurance(mA, 1, address(0));
        vm.expectRevert(PoolEngine.ZeroAddress.selector);
        engine.claimFees(mA, address(0));
        vm.stopPrank();
    }

    function test_setQuote_boundsAndEvent() public {
        vm.startPrank(adA);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.InvalidQuote.selector, 5001, 0));
        engine.setQuote(mA, 5001, 0, MAX_NET);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.InvalidQuote.selector, 10, 2501));
        engine.setQuote(mA, 10, 2501, MAX_NET);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.InvalidQuote.selector, 10, -2501));
        engine.setQuote(mA, 10, -2501, MAX_NET);
        vm.expectEmit(true, false, false, true, address(engine));
        emit QuoteSet(mA, 5000, -2500, 1e6);
        engine.setQuote(mA, 5000, -2500, 1e6);
        vm.stopPrank();
        IPoolEngine.MarketState memory s = engine.state(mA);
        assertEq(s.spreadBps, 5000);
        assertEq(s.skewBps, -2500);
        assertEq(engine.config(mA).maxNetExposureUsd, 1e6);
    }

    function test_setReduceOnly_event() public {
        vm.expectEmit(true, false, false, true, address(engine));
        emit ReduceOnlySet(mA, true);
        vm.prank(adA);
        engine.setReduceOnly(mA, true);
        assertTrue(engine.state(mA).reduceOnly);
    }

    function test_liquidityAndInsurance_depositWithdraw() public {
        usdc.mint(adA, 10e6);
        vm.startPrank(adA);
        usdc.approve(address(engine), 10e6);
        vm.expectEmit(true, false, false, true, address(engine));
        emit LiquidityChanged(mA, 4e6, 0);
        engine.depositLiquidity(mA, 4e6);
        vm.expectEmit(true, false, false, true, address(engine));
        emit LiquidityChanged(mA, 0, 6e6);
        engine.depositInsurance(mA, 6e6);
        assertEq(engine.state(mA).poolCashUsd, POOL + 4e6);
        assertEq(engine.state(mA).insuranceUsd, IF + 6e6);

        address to = makeAddr("vault");
        vm.expectEmit(true, false, false, true, address(engine));
        emit LiquidityChanged(mA, -int256(POOL + 4e6), 0);
        engine.withdrawLiquidity(mA, POOL + 4e6, to);
        vm.expectEmit(true, false, false, true, address(engine));
        emit LiquidityChanged(mA, 0, -int256(IF + 6e6));
        engine.withdrawInsurance(mA, IF + 6e6, to);
        vm.stopPrank();
        assertEq(usdc.balanceOf(to), POOL + IF + 10e6);
        assertEq(_ledger(mA), 0);
    }

    function test_withdrawLiquidity_insufficient() public {
        vm.prank(adA);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.InsufficientLiquidity.selector, POOL + 1, POOL));
        engine.withdrawLiquidity(mA, POOL + 1, adA);
    }

    function test_withdrawInsurance_insufficient() public {
        vm.prank(adA);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.InsufficientInsurance.selector, IF + 1, IF));
        engine.withdrawInsurance(mA, IF + 1, adA);
    }

    function test_withdrawLiquidity_solvencyCheck() public {
        _deposit(alice, mA, 2000e6);
        _trade(alice, mA, 100e18); // pool short 10,000 USD -> pool margin 1,000 USD
        uint256 req = engine.requiredPoolMarginUsd(mA);
        assertEq(req, 1000e6);
        int256 eq = engine.poolEquityUsd(mA);
        // pool equity = cash + spread captured (alice entry 100.05 vs oracle 100)
        assertEq(eq, int256(POOL) + 5e6);
        uint256 maxOut = uint256(eq) - req;
        vm.prank(adA);
        vm.expectRevert(
            abi.encodeWithSelector(PoolEngine.PoolUndercollateralized.selector, int256(req) - 1, req)
        );
        engine.withdrawLiquidity(mA, maxOut + 1, adA);
        vm.prank(adA);
        engine.withdrawLiquidity(mA, maxOut, adA);
        assertEq(engine.poolEquityUsd(mA), int256(req));
    }

    function test_withdrawLiquidity_staleWithExposureReverts() public {
        _deposit(alice, mA, 2000e6);
        _trade(alice, mA, 10e18);
        uint64 t = oracle.latest(PID_A).publishedAt;
        vm.warp(block.timestamp + 301);
        vm.prank(adA);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, t));
        engine.withdrawLiquidity(mA, 1e6, adA);
        // held (but fresh) prices are fine
        _push(PID_A, PX, true);
        vm.prank(adA);
        engine.withdrawLiquidity(mA, 1e6, adA);
    }

    function test_withdrawLiquidity_flatNeedsNoPrice() public {
        address ad = makeAddr("adapterC");
        uint256 id = _createMarket(ad, _defaultCfg(bytes32("NOPRICE"), MAX_NET));
        _fundPool(ad, id, 1000e6, 0);
        vm.prank(ad);
        engine.withdrawLiquidity(id, 1000e6, ad);
        assertEq(engine.poolEquityUsd(id), 0);
        assertEq(engine.netExposureUsd(id), 0);
    }

    function test_claimFees() public {
        _deposit(alice, mA, 1000e6);
        (, uint256 fee) = _trade(alice, mA, 10e18);
        assertEq(fee, 1_000_500);
        address router = makeAddr("router");
        vm.expectEmit(true, false, false, true, address(engine));
        emit FeesClaimed(mA, router, fee);
        vm.prank(adA);
        assertEq(engine.claimFees(mA, router), fee);
        assertEq(usdc.balanceOf(router), fee);
        assertEq(engine.state(mA).feesAccruedUsd, 0);
        vm.prank(adA);
        assertEq(engine.claimFees(mA, router), 0);
    }

    // =================================================================== margin

    function test_depositWithdrawMargin_flat() public {
        vm.expectRevert(PoolEngine.ZeroAmount.selector);
        engine.depositMargin(mA, 0);
        usdc.mint(alice, 100e6);
        vm.startPrank(alice);
        usdc.approve(address(engine), 100e6);
        vm.expectEmit(true, true, false, true, address(engine));
        emit MarginChanged(mA, alice, 100e6);
        engine.depositMargin(mA, 100e6);
        assertEq(engine.positionOf(mA, alice).marginUsd, 100e6);
        assertEq(engine.totalMarginUsd(mA), 100e6);
        vm.expectRevert(PoolEngine.ZeroAmount.selector);
        engine.withdrawMargin(mA, 0);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.InsufficientMargin.selector, 101e6, int256(100e6)));
        engine.withdrawMargin(mA, 101e6);
        vm.stopPrank();

        // a flat trader can always withdraw: off-hours, stale, reduce-only
        _push(PID_A, PX, true);
        vm.warp(block.timestamp + 10_000);
        vm.prank(adA);
        engine.setReduceOnly(mA, true);
        vm.expectEmit(true, true, false, true, address(engine));
        emit MarginChanged(mA, alice, -100e6);
        vm.prank(alice);
        engine.withdrawMargin(mA, 100e6);
        assertEq(usdc.balanceOf(alice), 100e6);
        assertEq(engine.totalMarginUsd(mA), 0);
    }

    function test_withdrawMargin_withPosition_initialMargin() public {
        _deposit(alice, mA, 200e6);
        _trade(alice, mA, 10e18); // notional 1000 -> IM 100
        // margin 198.9995, equity 198.4995 -> max withdraw 98.4995
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PoolEngine.InsufficientMargin.selector, 100e6, int256(100e6 - 1))
        );
        engine.withdrawMargin(mA, 98_499_501);
        vm.prank(alice);
        engine.withdrawMargin(mA, 98_499_500);
        assertEq(engine.traderEquityUsd(mA, alice), 100e6);
    }

    function test_withdrawMargin_withPosition_offHoursAndStale() public {
        _deposit(alice, mA, 200e6);
        _trade(alice, mA, 10e18);
        _push(PID_A, PX, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mA));
        engine.withdrawMargin(mA, 1e6);
        _push(PID_A, PX, false);
        uint64 t = oracle.latest(PID_A).publishedAt;
        vm.warp(block.timestamp + 301);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, t));
        engine.withdrawMargin(mA, 1e6);
        // depositing margin is always allowed
        _deposit(alice, mA, 1e6);
    }

    // =================================================================== pricing

    function test_fillPrice_spreadAndSkew() public {
        // buy = oracle * (1e4 + spread/2 + skew)/1e4, sell = oracle * (1e4 - spread/2 + skew)/1e4
        assertEq(engine.quotePrice(mA, 1), 100.05e18);
        assertEq(engine.quotePrice(mA, -1), 99.95e18);
        _setQuote(adA, mA, 25, 7, MAX_NET); // odd spread: half-bps precision kept
        assertEq(engine.quotePrice(mA, 1), 100e18 * (20_000 + 25 + 14) / 20_000);
        assertEq(engine.quotePrice(mA, -1), 100e18 * (20_000 - 25 + 14) / 20_000);
        _setQuote(adA, mA, 20, -15, MAX_NET);
        assertEq(engine.quotePrice(mA, 1), 99.95e18);
        assertEq(engine.quotePrice(mA, -1), 99.75e18);
        vm.expectRevert(PoolEngine.ZeroSize.selector);
        engine.quotePrice(mA, 0);
    }

    function test_fillPrice_roundsAgainstTrader() public {
        _price(PID_A, 3); // 3 wei price
        _setQuote(adA, mA, 1, 0, MAX_NET);
        assertEq(engine.quotePrice(mA, 1), 4); // ceil(3 * 20001 / 20000)
        assertEq(engine.quotePrice(mA, -1), 2); // floor(3 * 19999 / 20000)
    }

    function test_trade_acceptablePrice() public {
        _deposit(alice, mA, 1000e6);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.PriceNotAcceptable.selector, 100.05e18, 100.04e18));
        engine.trade(mA, 1e18, 100.04e18);
        engine.trade(mA, 1e18, 100.05e18);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.PriceNotAcceptable.selector, 99.95e18, 99.96e18));
        engine.trade(mA, -1e18, 99.96e18);
        engine.trade(mA, -1e18, 99.95e18);
        vm.expectRevert(PoolEngine.ZeroSize.selector);
        engine.trade(mA, 0, 0);
        vm.stopPrank();
    }

    // =================================================================== trading

    function test_trade_openLong_exactAccounting() public {
        _deposit(alice, mA, 200e6);
        vm.expectEmit(true, true, false, true, address(engine));
        emit Trade(mA, alice, 10e18, 100.05e18, 1_000_500, 0, 10e18);
        (uint256 fill, uint256 fee) = _trade(alice, mA, 10e18);
        assertEq(fill, 100.05e18);
        assertEq(fee, 1_000_500);
        IPoolEngine.Position memory p = engine.positionOf(mA, alice);
        assertEq(p.size, 10e18);
        assertEq(p.entryPriceWad, 100.05e18);
        assertEq(p.marginUsd, 200e6 - 1_000_500);
        IPoolEngine.MarketState memory s = engine.state(mA);
        assertEq(s.longSize, 10e18);
        assertEq(s.shortSize, 0);
        assertEq(s.feesAccruedUsd, 1_000_500);
        assertEq(s.poolCashUsd, POOL);
        assertEq(engine.netExposureUsd(mA), -1000e6);
        assertEq(engine.poolEquityUsd(mA), int256(POOL) + 500_000);
        assertEq(engine.traderEquityUsd(mA, alice), int256(200e6 - 1_000_500 - 500_000));
        assertEq(engine.marginRatioBps(mA, alice), uint256(200e6 - 1_500_500) * 1e4 / 1000e6);
        assertEq(usdc.balanceOf(address(engine)), _ledger(mA) + _ledger(mB));
    }

    function test_trade_increaseReduceClose_realisedPnl() public {
        _deposit(alice, mA, 1000e6);
        _trade(alice, mA, 10e18); // @100.05
        _price(PID_A, 110e18);
        _trade(alice, mA, 10e18); // @110.055
        IPoolEngine.Position memory p = engine.positionOf(mA, alice);
        assertEq(p.size, 20e18);
        assertEq(p.entryPriceWad, 105.0525e18);
        uint256 entry = p.entryPriceWad;

        // reduce 5 at 120 sell fill 119.94
        _price(PID_A, 120e18);
        uint256 cashBefore = engine.state(mA).poolCashUsd;
        int256 expPnl = _floorDiv(int256(5e18) * (int256(119.94e18) - int256(entry)), 1e30);
        vm.expectEmit(true, true, false, true, address(engine));
        emit Trade(mA, alice, -5e18, 119.94e18, 599_700, expPnl, 15e18);
        _trade(alice, mA, -5e18);
        p = engine.positionOf(mA, alice);
        assertEq(p.size, 15e18);
        assertEq(p.entryPriceWad, entry); // reductions keep the entry
        assertEq(engine.state(mA).poolCashUsd, cashBefore - uint256(expPnl));

        // full close
        _trade(alice, mA, -15e18);
        p = engine.positionOf(mA, alice);
        assertEq(p.size, 0);
        assertEq(p.entryPriceWad, 0);
        assertEq(engine.state(mA).longSize, 0);
        assertEq(engine.netExposureUsd(mA), 0);
        // flat market: pool equity == pool cash
        assertEq(engine.poolEquityUsd(mA), int256(engine.state(mA).poolCashUsd));
        assertEq(usdc.balanceOf(address(engine)), _ledger(mA) + _ledger(mB));
    }

    function test_trade_flip() public {
        _deposit(alice, mA, 1000e6);
        _trade(alice, mA, 10e18); // long 10 @100.05
        _price(PID_A, 90e18);
        // sell 25 @ 89.955 -> closes 10 (pnl -100.95), opens short 15 @ 89.955
        int256 expPnl = _floorDiv(int256(10e18) * (int256(89.955e18) - int256(100.05e18)), 1e30);
        assertEq(expPnl, -100_950_000);
        _trade(alice, mA, -25e18);
        IPoolEngine.Position memory p = engine.positionOf(mA, alice);
        assertEq(p.size, -15e18);
        assertEq(p.entryPriceWad, 89.955e18);
        IPoolEngine.MarketState memory s = engine.state(mA);
        assertEq(s.longSize, 0);
        assertEq(s.shortSize, -15e18);
        assertEq(s.poolCashUsd, POOL + 100_950_000);
        assertEq(engine.netExposureUsd(mA), 1350e6); // pool long 15 * 90
    }

    function test_trade_shortAverageEntryRoundsDown() public {
        _deposit(alice, mA, 1000e6);
        _trade(alice, mA, -10e18); // @99.95
        _price(PID_A, 90e18 + 1);
        _trade(alice, mA, -10e18);
        uint256 fill2 = uint256(90e18 + 1) * 19_990 / 20_000;
        assertEq(engine.positionOf(mA, alice).entryPriceWad, (99.95e18 + fill2) / 2);
    }

    function test_trade_longAverageEntryRoundsUp() public {
        _deposit(alice, mA, 1000e6);
        _trade(alice, mA, 10e18); // @100.05
        _price(PID_A, 90e18 + 1);
        _trade(alice, mA, 10e18);
        uint256 fill2 = (uint256(90e18 + 1) * 20_010 + 19_999) / 20_000; // buy fill, rounded up
        uint256 num = 10e18 * uint256(100.05e18) + 10e18 * fill2;
        assertEq(engine.positionOf(mA, alice).entryPriceWad, (num + 20e18 - 1) / 20e18);
    }

    function test_trade_initialMarginRequired() public {
        _deposit(alice, mA, 100e6);
        // margin after fee 98.9995, equity 98.4995 < IM 100
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PoolEngine.InsufficientMargin.selector, 100e6, int256(98_499_500))
        );
        engine.trade(mA, 10e18, type(uint256).max);
        _deposit(alice, mA, 10e6);
        _trade(alice, mA, 10e18);
    }

    function test_trade_feeExceedsMargin() public {
        _deposit(alice, mA, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.InsufficientMargin.selector, 100_050, int256(1)));
        engine.trade(mA, 1e18, type(uint256).max);
    }

    function test_trade_exposureCap() public {
        _setQuote(adA, mA, 10, 0, 1000e6);
        _deposit(alice, mA, 1000e6);
        _deposit(bob, mA, 1000e6);
        _trade(alice, mA, 10e18); // pool exposure exactly -1000
        assertEq(engine.netExposureUsd(mA), -1000e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.ExposureCap.selector, 1_000_000_100, 1000e6));
        engine.trade(mA, 1e12, type(uint256).max);
        // offsetting new risk that lands inside the cap is fine
        _trade(bob, mA, -5e18);
        assertEq(engine.netExposureUsd(mA), -500e6);
        // new risk that lands beyond the cap on the other side is not
        vm.prank(bob);
        vm.expectPartialRevert(PoolEngine.ExposureCap.selector);
        engine.trade(mA, -16e18, 0);
    }

    function test_trade_exposureCap_afterPriceMoveOnlyReductions() public {
        _setQuote(adA, mA, 10, 0, 1000e6);
        _deposit(alice, mA, 1000e6);
        _deposit(bob, mA, 1000e6);
        _trade(alice, mA, 10e18);
        _price(PID_A, 150e18); // pool exposure now -1500 > cap
        vm.prank(bob);
        vm.expectPartialRevert(PoolEngine.ExposureCap.selector);
        engine.trade(mA, 1e18, type(uint256).max);
        // reductions are always fine
        _trade(alice, mA, -5e18);
        assertEq(engine.netExposureUsd(mA), -750e6);
    }

    function test_trade_maxNetZeroBlocksNewRisk() public {
        _setQuote(adA, mA, 10, 0, 0);
        _deposit(alice, mA, 1000e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.ExposureCap.selector, 1000e6, 0));
        engine.trade(mA, 10e18, type(uint256).max);
    }

    function test_trade_emptyPoolBlocksNewRisk() public {
        address ad = makeAddr("adapterC");
        uint256 id = _createMarket(ad, _defaultCfg(PID_A, MAX_NET));
        _deposit(alice, id, 1000e6);
        vm.prank(alice);
        vm.expectPartialRevert(PoolEngine.PoolUndercollateralized.selector);
        engine.trade(id, 1e18, type(uint256).max);
    }

    function test_trade_sizeTooLarge() public {
        _deposit(alice, mA, 1000e6);
        int256 tooBig = int256(engine.MAX_SIZE()) + 1;
        vm.prank(alice);
        vm.expectRevert(PoolEngine.SizeTooLarge.selector);
        engine.trade(mA, tooBig, type(uint256).max);
    }

    function test_trade_noPrice() public {
        address ad = makeAddr("adapterC");
        uint256 id = _createMarket(ad, _defaultCfg(bytes32("NOPRICE"), MAX_NET));
        _deposit(alice, id, 1000e6); // deposits never need a price
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NoPrice.selector, bytes32("NOPRICE")));
        engine.trade(id, 1e18, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NoPrice.selector, bytes32("NOPRICE")));
        engine.quotePrice(id, 1);
    }

    function test_trade_priceOutOfRange() public {
        _price(PID_A, 1e36 + 1);
        _deposit(alice, mA, 1000e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.PriceOutOfRange.selector, 1e36 + 1));
        engine.trade(mA, 1, type(uint256).max);
    }

    function test_trade_reduceMustNotLeaveLiquidatable() public {
        _deposit(alice, mA, 110e6);
        _trade(alice, mA, 10e18); // margin 108.9995
        _price(PID_A, 94e18); // equity 48.4995 > maintenance 47
        assertFalse(engine.isLiquidatable(mA, alice));
        _setQuote(adA, mA, 5000, 0, MAX_NET); // a 50% spread makes the partial close realise a big loss
        vm.prank(alice);
        vm.expectRevert(PoolEngine.WouldBeLiquidatable.selector);
        engine.trade(mA, -1e18, 0);
    }

    function test_trade_fullCloseUnderwaterReverts() public {
        _deposit(alice, mA, 110e6);
        _trade(alice, mA, 10e18); // margin 108.9995
        _price(PID_A, 80e18); // sell fill 79.96 -> loss 200.9 > margin
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PoolEngine.InsufficientMargin.selector, 200_900_000, int256(108_999_500))
        );
        engine.trade(mA, -10e18, 0);
    }

    function test_trade_profitPaidByPoolThenInsuranceThenHaircut() public {
        address ad = makeAddr("adapterC");
        IPoolEngine.MarketConfig memory c = _defaultCfg(PID_A, MAX_NET);
        c.fundingVelocityBps = 0;
        uint256 id = _createMarket(ad, c);
        _fundPool(ad, id, 100e6, 50e6);
        _setQuote(ad, id, 10, 0, MAX_NET);
        _deposit(alice, id, 200e6);
        _trade(alice, id, 10e18); // @100.05; pool margin 100 <= equity 100.5
        _price(PID_A, 150e18);
        // close: sell 149.925 -> pnl 498.75; pool pays 100, IF 50, haircut 348.75
        vm.expectEmit(true, false, false, true, address(engine));
        emit InsuranceDrawn(id, 50e6);
        vm.expectEmit(true, false, false, true, address(engine));
        emit ADL(id, 348_750_000);
        _trade(alice, id, -10e18);
        IPoolEngine.MarketState memory s = engine.state(id);
        assertEq(s.poolCashUsd, 0);
        assertEq(s.insuranceUsd, 0);
        uint256 fee2 = 10 * 149.925e6 * 10 / 1e4;
        assertEq(engine.positionOf(mA == id ? mB : id, alice).marginUsd, 200e6 - 1_000_500 + 150e6 - fee2);
        assertEq(usdc.balanceOf(address(engine)), _ledger(mA) + _ledger(mB) + _ledger(id));
    }

    // =================================================================== regimes: reduce-only / off-hours / stale

    function test_reduceOnly_blocksNewRiskOnly() public {
        _deposit(alice, mA, 1000e6);
        _trade(alice, mA, 10e18);
        vm.prank(adA);
        engine.setReduceOnly(mA, true);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.MarketReduceOnly.selector, mA));
        engine.trade(mA, 1e18, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.MarketReduceOnly.selector, mA));
        engine.trade(mA, -11e18, 0); // flip = new risk
        engine.trade(mA, -4e18, 0); // reduce ok
        engine.trade(mA, -6e18, 0); // close ok
        vm.stopPrank();
        vm.prank(adA);
        engine.setReduceOnly(mA, false);
        _trade(alice, mA, 1e18);
    }

    /// @dev Audit A2-03: while held every voluntary trade reverts (a held print is a free option on the
    ///      after-hours move); margin top-ups and liquidations keep working at the held price.
    function test_offHours_heldBlocksAllTrades_liquidateWorks() public {
        _deposit(alice, mA, 110e6);
        _deposit(bob, mA, 1000e6);
        _trade(alice, mA, 10e18);
        _trade(bob, mA, 2e18);
        _push(PID_A, 93e18, true); // session closed, held at 93 -> alice under maintenance
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mA));
        engine.trade(mA, 1e18, type(uint256).max);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mA));
        engine.trade(mA, -3e18, 0); // flip
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mA));
        engine.trade(mA, -1e18, 0); // reduce
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mA));
        engine.trade(mA, -2e18, 0); // close
        _deposit(bob, mA, 1e6); // top-up works
        assertTrue(engine.isLiquidatable(mA, alice));
        vm.prank(keeper);
        engine.liquidate(mA, alice); // liquidation works at the held price
        assertEq(engine.positionOf(mA, alice).size, 0);
    }

    /// @dev Audit A2-01: a stale stored price fills no trade (closes included); liquidations still work.
    function test_stale_blocksAllTrades_liquidateWorks() public {
        _deposit(alice, mA, 110e6);
        _deposit(bob, mA, 1000e6);
        _trade(alice, mA, 10e18);
        _trade(bob, mA, 2e18);
        _price(PID_A, 93e18);
        uint64 t = oracle.latest(PID_A).publishedAt;
        vm.warp(block.timestamp + 301);
        assertTrue(oracle.isStale(PID_A));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, t));
        engine.trade(mA, 1e18, type(uint256).max);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, t));
        engine.trade(mA, -2e18, 0); // close needs a fresh price too
        vm.prank(keeper);
        engine.liquidate(mA, alice);
        assertEq(engine.positionOf(mA, alice).size, 0);
    }

    /// @dev Audit A2-02: while held, maintenance is 2x initial margin (20 % here), so a position that cannot
    ///      absorb a reopen gap of that size is liquidated at the held (close) price instead of turning the
    ///      gap into IF bad debt. Live again, the normal 5 % maintenance applies.
    function test_offHours_maintenanceIsTwiceInitialMargin() public {
        assertEq(engine.OFF_HOURS_MARGIN_MULTIPLE(), 2);
        _deposit(alice, mA, 150e6); // ~14.8 % equity on $1000: fine live
        _deposit(bob, mA, 300e6); // ~29.8 %: survives the close
        _trade(alice, mA, 10e18);
        _trade(bob, mA, -10e18);
        assertFalse(engine.isLiquidatable(mA, alice));
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotLiquidatable.selector, alice));
        engine.liquidate(mA, alice);

        _push(PID_A, PX, true); // session closes at the same price
        assertTrue(engine.isLiquidatable(mA, alice));
        assertFalse(engine.isLiquidatable(mA, bob));
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotLiquidatable.selector, bob));
        engine.liquidate(mA, bob);
        _deposit(alice, mA, 60e6); // a top-up before a keeper acts restores the off-hours requirement
        assertFalse(engine.isLiquidatable(mA, alice));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mA));
        engine.withdrawMargin(mA, 60e6);

        // a reopen gap of 15 %: both positions are still solvent, no bad debt
        uint256 ifBefore = engine.state(mA).insuranceUsd;
        _push(PID_A, 115e18, false);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotLiquidatable.selector, bob));
        engine.liquidate(mA, bob);
        _trade(bob, mA, 10e18);
        _trade(alice, mA, -10e18);
        assertEq(engine.state(mA).insuranceUsd, ifBefore);
    }

    function test_offHours_belowRequirementLiquidatedAtHeldPrice() public {
        _deposit(alice, mA, 150e6);
        _trade(alice, mA, 10e18);
        _push(PID_A, PX, true);
        uint256 ifBefore = engine.state(mA).insuranceUsd;
        vm.prank(keeper);
        engine.liquidate(mA, alice);
        assertEq(engine.positionOf(mA, alice).size, 0);
        assertGt(engine.positionOf(mA, alice).marginUsd, 0, "closed at the held price, margin left");
        assertGe(engine.state(mA).insuranceUsd, ifBefore, "no bad debt");
    }

    function test_regimes_otherMarketUnaffected() public {
        _push(PID_A, PX, true);
        _deposit(bob, mB, 1000e6);
        _trade(bob, mB, 1e18); // market B prices on PID_B: still open
    }

    // =================================================================== liquidation

    function test_liquidate_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NoPosition.selector, alice));
        engine.liquidate(mA, alice);
        _deposit(alice, mA, 110e6);
        _trade(alice, mA, 10e18);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotLiquidatable.selector, alice));
        engine.liquidate(mA, alice);
    }

    function test_liquidate_feeSplit() public {
        _deposit(alice, mA, 110e6);
        _trade(alice, mA, 10e18); // margin 108.9995
        _price(PID_A, 93e18); // equity 38.4995 < 46.5
        assertTrue(engine.isLiquidatable(mA, alice));
        assertEq(engine.marginRatioBps(mA, alice), uint256(38_499_500) * 1e4 / 930e6);
        uint256 ifBefore = engine.state(mA).insuranceUsd;
        vm.expectEmit(true, true, true, true, address(engine));
        emit Liquidation(mA, alice, keeper, 10e18, 93e18, 4_650_000, 0);
        vm.prank(keeper);
        uint256 reward = engine.liquidate(mA, alice);
        assertEq(reward, 2_325_000);
        assertEq(usdc.balanceOf(keeper), 2_325_000);
        IPoolEngine.MarketState memory s = engine.state(mA);
        assertEq(s.insuranceUsd, ifBefore + 2_325_000);
        assertEq(s.poolCashUsd, POOL + 70_500_000);
        assertEq(s.longSize, 0);
        IPoolEngine.Position memory p = engine.positionOf(mA, alice);
        assertEq(p.size, 0);
        assertEq(p.marginUsd, 108_999_500 - 70_500_000 - 4_650_000);
        // leftover margin is withdrawable
        vm.prank(alice);
        engine.withdrawMargin(mA, p.marginUsd);
        assertEq(usdc.balanceOf(address(engine)), _ledger(mA) + _ledger(mB));
    }

    function test_liquidate_badDebtCoveredByInsurance() public {
        _deposit(alice, mA, 110e6);
        _trade(alice, mA, 10e18);
        _price(PID_A, 80e18); // loss 200.5 at oracle vs margin 108.9995 -> bad debt 91.5005
        vm.expectEmit(true, false, false, true, address(engine));
        emit InsuranceDrawn(mA, 91_500_500);
        vm.expectEmit(true, true, true, true, address(engine));
        emit Liquidation(mA, alice, keeper, 10e18, 80e18, 0, 91_500_500);
        vm.prank(keeper);
        assertEq(engine.liquidate(mA, alice), 0);
        IPoolEngine.MarketState memory s = engine.state(mA);
        assertEq(s.insuranceUsd, IF - 91_500_500);
        assertEq(s.poolCashUsd, POOL + 200_500_000); // pool made whole
        assertEq(engine.positionOf(mA, alice).marginUsd, 0);
        assertEq(engine.totalMarginUsd(mA), 0);
        assertEq(usdc.balanceOf(address(engine)), _ledger(mA) + _ledger(mB));
    }

    function test_liquidate_ADL_isolatedToMarket() public {
        // market C: tiny IF so bad debt exceeds it
        address ad = makeAddr("adapterC");
        IPoolEngine.MarketConfig memory c = _defaultCfg(PID_A, MAX_NET);
        c.fundingVelocityBps = 0;
        uint256 id = _createMarket(ad, c);
        _fundPool(ad, id, POOL, 10e6);
        _setQuote(ad, id, 10, 0, MAX_NET);
        // activity in market B on the same and other underlyings
        _deposit(bob, mB, 1000e6);
        _trade(bob, mB, 3e18);
        _deposit(bob, mA, 1000e6);
        _trade(bob, mA, -2e18);

        _deposit(alice, id, 110e6);
        _trade(alice, id, 10e18);
        _price(PID_A, 80e18);

        IPoolEngine.MarketState memory a0 = engine.state(mA);
        IPoolEngine.MarketState memory b0 = engine.state(mB);
        uint256 ledgerA = _ledger(mA);
        uint256 ledgerB = _ledger(mB);
        int256 eqA = engine.poolEquityUsd(mA);
        int256 eqB = engine.poolEquityUsd(mB);

        vm.expectEmit(true, false, false, true, address(engine));
        emit ADL(id, 81_500_500);
        vm.prank(keeper);
        engine.liquidate(id, alice);

        IPoolEngine.MarketState memory s = engine.state(id);
        assertEq(s.insuranceUsd, 0);
        assertEq(s.poolCashUsd, POOL + 108_999_500 + 10e6); // pool absorbed the 81.5005 shortfall
        // other markets untouched
        _assertSameState(engine.state(mA), a0);
        _assertSameState(engine.state(mB), b0);
        assertEq(_ledger(mA), ledgerA);
        assertEq(_ledger(mB), ledgerB);
        assertEq(engine.poolEquityUsd(mA), eqA);
        assertEq(engine.poolEquityUsd(mB), eqB);
        assertEq(usdc.balanceOf(address(engine)), _ledger(mA) + _ledger(mB) + _ledger(id));
    }

    function test_liquidate_selfAllowed() public {
        _deposit(alice, mA, 110e6);
        _trade(alice, mA, 10e18);
        _price(PID_A, 93e18);
        vm.prank(alice);
        uint256 r = engine.liquidate(mA, alice);
        assertEq(r, 2_325_000);
    }

    // =================================================================== funding

    function test_funding_longsPayWhenCrowded() public {
        _deposit(alice, mB, 2000e6);
        _trade(alice, mB, 100e18); // net long 100 @ $100 -> skew 10k / 75k
        IPoolEngine.MarketState memory s0 = engine.state(mB);
        assertEq(s0.fundingIndex, 0);
        vm.warp(block.timestamp + 1 days);
        _price(PID_B, PX);
        int256 expRate = int256(uint256(100e18) * 100e18 / (uint256(MAX_NET) * 1e12) * 100 / 1e4);
        assertEq(engine.fundingRatePerDayWad(mB), expRate);
        uint256 dt = block.timestamp - engine.lastFundingTime(mB);
        int256 expIdx = int256(PX * uint256(expRate) * dt / (1 days * 1e18));
        assertEq(engine.state(mB).fundingIndex, expIdx);
        int256 owed = _ceilDiv(int256(100e18) * expIdx, 1e30);
        // pool equity = cash + spread captured + funding owed by traders
        assertEq(
            engine.poolEquityUsd(mB), int256(POOL) + 5e6 + _floorDiv(int256(100e18) * expIdx / 1e18, 1e12)
        );
        assertEq(engine.traderEquityUsd(mB, alice), int256(2000e6 - 10_005_000 - 5e6) - owed);

        uint256 cashBefore = engine.state(mB).poolCashUsd;
        vm.expectEmit(true, true, false, true, address(engine));
        emit FundingSettled(mB, alice, owed);
        _trade(alice, mB, -100e18);
        assertEq(engine.state(mB).poolCashUsd, cashBefore + uint256(owed) + 10e6); // exit at 99.95: trader pnl -10, + funding
        assertEq(engine.positionOf(mB, alice).size, 0);
        assertEq(usdc.balanceOf(address(engine)), _ledger(mA) + _ledger(mB));
    }

    /// Regression (devnet): an eth_call executed in a block older than the last funding accrual must not
    /// underflow `block.timestamp - lastFundingTime` (PoolEngineAdapter.marginEquityUsd panicked).
    function test_funding_viewsDoNotUnderflowWhenCallBlockPredatesAccrual() public {
        _deposit(alice, mB, 2000e6);
        _trade(alice, mB, 100e18);
        vm.warp(block.timestamp + 1 hours);
        _price(PID_B, PX);
        _trade(alice, mB, 1e18); // accrues funding at the current timestamp
        int256 eqNow = engine.poolEquityUsd(mB);
        vm.warp(block.timestamp - 5); // call context older than lastFundingTime
        assertEq(engine.poolEquityUsd(mB), eqNow); // no pending delta, no panic
        engine.traderEquityUsd(mB, alice);
        engine.state(mB);
    }

    function test_funding_shortsPayWhenCrowded_longsReceive() public {
        _deposit(alice, mB, 2000e6);
        _deposit(bob, mB, 2000e6);
        _trade(alice, mB, -100e18);
        _trade(bob, mB, 20e18); // net -80
        vm.warp(block.timestamp + 1 days);
        _price(PID_B, PX);
        int256 rate = engine.fundingRatePerDayWad(mB);
        assertLt(rate, 0);
        assertLt(engine.state(mB).fundingIndex, 0);
        // bob (long) receives: equity above margin + pnl
        IPoolEngine.Position memory pb = engine.positionOf(mB, bob);
        int256 pnlB = _floorDiv(int256(20e18) * (int256(PX) - int256(pb.entryPriceWad)), 1e30);
        assertGt(engine.traderEquityUsd(mB, bob), int256(pb.marginUsd) + pnlB);
        // alice (short) pays
        IPoolEngine.Position memory pa = engine.positionOf(mB, alice);
        int256 pnlA = _floorDiv(int256(-100e18) * (int256(PX) - int256(pa.entryPriceWad)), 1e30);
        assertLt(engine.traderEquityUsd(mB, alice), int256(pa.marginUsd) + pnlA);
        uint256 bobMargin = pb.marginUsd;
        _trade(bob, mB, -20e18);
        assertGt(engine.positionOf(mB, bob).marginUsd + 2_001_000, bobMargin); // received funding (net of fee/spread)
    }

    function test_funding_clampedAtFullSkew() public {
        // the normaliser is the market's inventory cap (createMarket maxNetExposureUsd), here 1000
        address ad = makeAddr("adapterC");
        uint256 id = _createMarket(ad, _defaultCfg(PID_B, 1000e6));
        _fundPool(ad, id, POOL, IF);
        _setQuote(ad, id, 10, 0, 1000e6);
        _deposit(alice, id, 2000e6);
        _trade(alice, id, 10e18); // skew 1000 == cap
        _price(PID_B, 300e18); // skew 3000 > cap -> clamp
        assertEq(engine.fundingRatePerDayWad(id), int256(1e18 * uint256(100) / 1e4));
    }

    function test_funding_settledOnMarginWithdraw() public {
        _deposit(alice, mB, 2000e6);
        _trade(alice, mB, 100e18);
        vm.warp(block.timestamp + 1 days);
        _price(PID_B, PX);
        int256 idx = engine.state(mB).fundingIndex;
        int256 owed = _ceilDiv(int256(100e18) * idx, 1e30);
        uint256 m0 = engine.positionOf(mB, alice).marginUsd;
        vm.expectEmit(true, true, false, true, address(engine));
        emit FundingSettled(mB, alice, owed);
        vm.prank(alice);
        engine.withdrawMargin(mB, 1e6);
        IPoolEngine.Position memory p = engine.positionOf(mB, alice);
        assertEq(p.marginUsd, m0 - uint256(owed) - 1e6);
        assertEq(p.fundingIndexAtEntry, idx);
    }

    function test_funding_accruedBeforeQuoteChange() public {
        _deposit(alice, mB, 2000e6);
        _trade(alice, mB, 100e18);
        vm.warp(block.timestamp + 1 days);
        _price(PID_B, PX);
        int256 pending = engine.state(mB).fundingIndex;
        _setQuote(adB, mB, 10, 0, 1); // quote cap change: accrual is checkpointed first
        assertEq(engine.state(mB).fundingIndex, pending);
        assertEq(engine.lastFundingTime(mB), block.timestamp);
    }

    function test_funding_zeroWhenFlat() public {
        _deposit(alice, mB, 2000e6);
        _deposit(bob, mB, 2000e6);
        _trade(alice, mB, 10e18);
        _trade(bob, mB, -10e18);
        vm.warp(block.timestamp + 10 days);
        assertEq(engine.fundingRatePerDayWad(mB), 0);
        assertEq(engine.state(mB).fundingIndex, 0);
    }

    // =================================================================== views

    function test_views_flatTrader() public view {
        assertEq(engine.marginRatioBps(mA, alice), type(uint256).max);
        assertFalse(engine.isLiquidatable(mA, alice));
        assertEq(engine.traderEquityUsd(mA, alice), 0);
        assertEq(engine.requiredPoolMarginUsd(mA), 0);
    }

    function test_marginRatio_zeroWhenUnderwater() public {
        _deposit(alice, mA, 110e6);
        _trade(alice, mA, 10e18);
        _price(PID_A, 50e18);
        assertEq(engine.marginRatioBps(mA, alice), 0);
        assertLt(engine.traderEquityUsd(mA, alice), 0);
    }

    function test_poolEquity_aggregateMatchesPerPosition() public {
        _deposit(alice, mB, 5000e6);
        _deposit(bob, mB, 5000e6);
        _deposit(keeper, mB, 5000e6);
        _trade(alice, mB, 37e18);
        _price(PID_B, 103e18);
        _trade(bob, mB, -11e18);
        vm.warp(block.timestamp + 3 hours);
        _price(PID_B, 97e18);
        _trade(keeper, mB, 5e18);
        _trade(alice, mB, -7e18);
        vm.warp(block.timestamp + 5 hours);
        _price(PID_B, 101e18);
        int256 sum;
        address[3] memory ts = [alice, bob, keeper];
        for (uint256 i; i < 3; ++i) {
            IPoolEngine.Position memory p = engine.positionOf(mB, ts[i]);
            sum += engine.traderEquityUsd(mB, ts[i]) - int256(p.marginUsd);
        }
        int256 eq = engine.poolEquityUsd(mB);
        int256 cash = int256(engine.state(mB).poolCashUsd);
        // pool equity == cash - sum(trader pnl - funding owed), up to per-position rounding
        assertApproxEqAbs(eq, cash - sum, 6);
    }

    // =================================================================== reentrancy

    function test_reentrancy_blocked() public {
        ReentrantToken tok = new ReentrantToken();
        EngineMockConfig c2 = new EngineMockConfig(timelock);
        c2.setUsdc(address(tok));
        c2.setOracle(address(oracle));
        EngineMockFactory f2 = new EngineMockFactory();
        c2.setFactory(address(f2));
        PoolEngine e2 = new PoolEngine(address(c2));
        f2.setComponent(adA, true);
        vm.prank(adA);
        uint256 id = e2.createMarket(_defaultCfg(PID_A, MAX_NET));
        tok.mint(alice, 100e6);
        vm.prank(alice);
        tok.approve(address(e2), type(uint256).max);
        vm.prank(alice);
        e2.depositMargin(id, 50e6);
        // on the outgoing transfer, the token re-enters withdrawMargin
        tok.setHook(address(e2), abi.encodeCall(PoolEngine.withdrawMargin, (id, 1e6)));
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        e2.withdrawMargin(id, 1e6);
    }

    // =================================================================== helpers

    function _assertSameState(IPoolEngine.MarketState memory a, IPoolEngine.MarketState memory b)
        internal
        pure
    {
        assertEq(a.spreadBps, b.spreadBps);
        assertEq(a.skewBps, b.skewBps);
        assertEq(a.reduceOnly, b.reduceOnly);
        assertEq(a.longSize, b.longSize);
        assertEq(a.shortSize, b.shortSize);
        assertEq(a.poolCashUsd, b.poolCashUsd);
        assertEq(a.insuranceUsd, b.insuranceUsd);
        assertEq(a.feesAccruedUsd, b.feesAccruedUsd);
        assertEq(a.fundingIndex, b.fundingIndex);
    }

    function _floorDiv(int256 a, int256 b) internal pure returns (int256 q) {
        q = a / b;
        if (a % b != 0 && a < 0) q -= 1;
    }

    function _ceilDiv(int256 a, int256 b) internal pure returns (int256 q) {
        q = a / b;
        if (a % b != 0 && a > 0) q += 1;
    }
}
