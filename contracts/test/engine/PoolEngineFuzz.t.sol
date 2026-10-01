// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EngineBase} from "./utils/EngineBase.sol";
import {PoolEngine} from "../../src/PoolEngine.sol";
import {IPoolEngine} from "../../src/interfaces/IPoolEngine.sol";

contract PoolEngineFuzzTest is EngineBase {
    address internal adA = makeAddr("adapterA");
    address internal adB = makeAddr("adapterB");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");

    uint128 internal constant MAX_NET = 75_000e6;
    uint256 internal mA;
    uint256 internal mB;

    function setUp() public {
        _deployCore();
        IPoolEngine.MarketConfig memory c = _defaultCfg(PID_A, MAX_NET);
        c.fundingVelocityBps = 0;
        mA = _createMarket(adA, c);
        mB = _createMarket(adB, _defaultCfg(PID_B, MAX_NET));
        _fundPool(adA, mA, 1_000_000e6, 250_000e6);
        _fundPool(adB, mB, 1_000_000e6, 250_000e6);
        _setQuote(adA, mA, 10, 0, MAX_NET);
        _setQuote(adB, mB, 10, 0, MAX_NET);
        _price(PID_A, PX);
        _price(PID_B, PX);
    }

    function _conserved() internal view {
        assertEq(usdc.balanceOf(address(engine)), _ledger(mA) + _ledger(mB), "conservation");
    }

    // ------------------------------------------------------------------ pricing

    function testFuzz_fillPrice(uint256 price, uint16 spread, int16 skew) public {
        price = bound(price, 1, 1e30);
        spread = uint16(bound(spread, 0, 5000));
        skew = int16(bound(skew, -2500, 2500));
        _price(PID_A, price);
        _setQuote(adA, mA, spread, skew, MAX_NET);
        uint256 buyF = uint256(int256(20_000 + uint256(spread)) + 2 * int256(skew));
        uint256 sellF = uint256(int256(20_000) - int256(uint256(spread)) + 2 * int256(skew));
        uint256 buy = engine.quotePrice(mA, 1);
        uint256 sell = engine.quotePrice(mA, -1);
        assertEq(buy, (price * buyF + 19_999) / 20_000);
        assertEq(sell, price * sellF / 20_000);
        assertGe(buy, sell);
    }

    // ------------------------------------------------------------------ round trips

    /// @dev Opening and immediately closing never makes money for the trader (spread + fees >= 0),
    ///      and every unit the trader loses lands in pool cash or fees.
    function testFuzz_roundTripNeverProfits(uint256 price, int256 size, uint16 spread, int16 skew) public {
        price = bound(price, 1e15, 1e24);
        spread = uint16(bound(spread, 0, 500));
        skew = int16(bound(skew, -100, 100));
        uint256 maxUnits = uint256(MAX_NET) * 1e30 / price;
        size = bound(size, -int256(maxUnits), int256(maxUnits));
        vm.assume(size != 0);
        _price(PID_A, price);
        _setQuote(adA, mA, spread, skew, MAX_NET);
        uint256 margin = 50_000e6;
        _deposit(alice, mA, margin);
        IPoolEngine.MarketState memory s0 = engine.state(mA);

        vm.prank(alice);
        try engine.trade(mA, size, size > 0 ? type(uint256).max : 0) {}
        catch {
            return; // e.g. initial margin with an extreme skew
        }
        _trade(alice, mA, -size);
        IPoolEngine.Position memory p = engine.positionOf(mA, alice);
        assertEq(p.size, 0);
        assertLe(p.marginUsd, margin);
        IPoolEngine.MarketState memory s1 = engine.state(mA);
        assertEq(
            (s1.poolCashUsd + s1.feesAccruedUsd + s1.insuranceUsd)
                - (s0.poolCashUsd + s0.feesAccruedUsd + s0.insuranceUsd),
            margin - p.marginUsd
        );
        assertEq(s1.longSize, 0);
        assertEq(s1.shortSize, 0);
        _conserved();
    }

    struct EntryCase {
        uint256 s1;
        uint256 s2;
        uint256 s3;
        uint256 p1;
        uint256 p2;
        uint256 p3;
        uint256 f1;
        uint256 f2;
        uint256 f3;
        uint256 fees;
        uint256 entry;
    }

    /// @dev Average entry + realised PnL match an independent model (same rounding rules).
    function testFuzz_averageEntryAndRealisedPnl(
        uint256 s1,
        uint256 s2,
        uint256 s3,
        uint256 p1,
        uint256 p2,
        uint256 p3
    ) public {
        EntryCase memory c;
        c.s1 = bound(s1, 1e15, 100e18);
        c.s2 = bound(s2, 1e15, 100e18);
        c.p1 = bound(p1, 50e18, 150e18);
        c.p2 = bound(p2, 50e18, 150e18);
        c.p3 = bound(p3, 50e18, 150e18);
        c.s3 = bound(s3, 1, c.s1 + c.s2);
        _deposit(alice, mA, 100_000e6);

        uint256 fee;
        _price(PID_A, c.p1);
        (c.f1, fee) = _trade(alice, mA, int256(c.s1));
        c.fees += fee;
        _price(PID_A, c.p2);
        (c.f2, fee) = _trade(alice, mA, int256(c.s2));
        c.fees += fee;
        c.entry = (c.s1 * c.f1 + c.s2 * c.f2 + (c.s1 + c.s2) - 1) / (c.s1 + c.s2);
        assertEq(c.f1, (c.p1 * 20_010 + 19_999) / 20_000);
        assertEq(engine.positionOf(mA, alice).entryPriceWad, c.entry);

        _price(PID_A, c.p3);
        uint256 cash0 = engine.state(mA).poolCashUsd;
        (c.f3, fee) = _trade(alice, mA, -int256(c.s3));
        c.fees += fee;
        int256 pnl = _floorDiv(int256(c.s3) * (int256(c.f3) - int256(c.entry)), 1e30);
        IPoolEngine.Position memory p = engine.positionOf(mA, alice);
        assertEq(int256(p.marginUsd), int256(100_000e6) - int256(c.fees) + pnl);
        assertEq(int256(engine.state(mA).poolCashUsd), int256(cash0) - pnl);
        assertEq(p.entryPriceWad, c.s3 == c.s1 + c.s2 ? 0 : c.entry);
        _conserved();
    }

    // ------------------------------------------------------------------ risk limits

    function testFuzz_exposureCapHolds(int256 sizeA, int256 sizeB, uint128 maxNet) public {
        maxNet = uint128(bound(maxNet, 1e6, MAX_NET));
        _setQuote(adA, mA, 10, 0, maxNet);
        sizeA = bound(sizeA, -1000e18, 1000e18);
        sizeB = bound(sizeB, -1000e18, 1000e18);
        _deposit(alice, mA, 200_000e6);
        _deposit(bob, mA, 200_000e6);
        if (sizeA != 0) {
            vm.prank(alice);
            try engine.trade(mA, sizeA, sizeA > 0 ? type(uint256).max : 0) {
                assertLe(_abs(engine.netExposureUsd(mA)), maxNet);
            } catch (bytes memory err) {
                assertEq(bytes4(err), PoolEngine.ExposureCap.selector);
            }
        }
        if (sizeB != 0) {
            vm.prank(bob);
            try engine.trade(mA, sizeB, sizeB > 0 ? type(uint256).max : 0) {
                assertLe(_abs(engine.netExposureUsd(mA)), maxNet);
            } catch (bytes memory err) {
                assertEq(bytes4(err), PoolEngine.ExposureCap.selector);
            }
        }
    }

    function testFuzz_initialMarginEnforced(uint256 margin, int256 size) public {
        margin = bound(margin, 1e6, 10_000e6);
        size = bound(size, -500e18, 500e18);
        vm.assume(size != 0);
        _deposit(alice, mA, margin);
        vm.prank(alice);
        try engine.trade(mA, size, size > 0 ? type(uint256).max : 0) {
            IPoolEngine.Position memory p = engine.positionOf(mA, alice);
            uint256 req = (_abs(size) * PX * 1000 + 1e34 - 1) / 1e34;
            assertGe(engine.traderEquityUsd(mA, alice), int256(req));
            assertEq(p.size, size);
        } catch (bytes memory err) {
            assertEq(bytes4(err), PoolEngine.InsufficientMargin.selector);
        }
    }

    /// @dev Off-hours / stale / reduce-only: every new-risk trade reverts, every reduction and every due
    ///      liquidation succeeds.
    function testFuzz_regimesBlockNewRiskOnly(uint8 regime, int256 add, uint256 reduce, uint256 crash)
        public
    {
        regime = uint8(bound(regime, 0, 2));
        _deposit(alice, mA, 10_000e6);
        _deposit(bob, mA, 2000e6);
        _trade(alice, mA, 50e18);
        _trade(bob, mA, -100e18);
        crash = bound(crash, 115e18, 140e18); // bob (short) becomes liquidatable
        if (regime == 0) {
            _push(PID_A, crash, true);
        } else if (regime == 1) {
            _price(PID_A, crash);
            vm.warp(block.timestamp + 301);
        } else {
            _price(PID_A, crash);
            vm.prank(adA);
            engine.setReduceOnly(mA, true);
        }
        add = bound(add, -1000e18, 1000e18);
        int256 newSize = 50e18 + add;
        bool newRisk = newSize != 0 && (newSize < 0 || newSize > 50e18);
        if (add != 0 && newRisk) {
            vm.prank(alice);
            vm.expectRevert();
            engine.trade(mA, add, add > 0 ? type(uint256).max : 0);
        }
        reduce = bound(reduce, 1, 50e18);
        _trade(alice, mA, -int256(reduce));
        assertEq(engine.positionOf(mA, alice).size, 50e18 - int256(reduce));
        assertTrue(engine.isLiquidatable(mA, bob));
        vm.prank(keeper);
        engine.liquidate(mA, bob);
        assertEq(engine.positionOf(mA, bob).size, 0);
        _conserved();
    }

    // ------------------------------------------------------------------ liquidation

    function testFuzz_liquidationAccounting(uint256 margin, uint256 crashPx, bool long_) public {
        margin = bound(margin, 110e6, 1000e6);
        crashPx = long_ ? bound(crashPx, 1e18, 99e18) : bound(crashPx, 101e18, 400e18);
        int256 size = long_ ? int256(10e18) : -int256(10e18);
        _deposit(alice, mA, margin);
        _trade(alice, mA, size);
        _price(PID_A, crashPx);
        if (!engine.isLiquidatable(mA, alice)) {
            vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotLiquidatable.selector, alice));
            engine.liquidate(mA, alice);
            return;
        }
        IPoolEngine.Position memory p0 = engine.positionOf(mA, alice);
        IPoolEngine.MarketState memory s0 = engine.state(mA);
        int256 pnl = _floorDiv(size * (int256(crashPx) - int256(p0.entryPriceWad)), 1e30);
        int256 left = int256(p0.marginUsd) + pnl;
        uint256 badDebt = left < 0 ? uint256(-left) : 0;
        uint256 rem = left > 0 ? uint256(left) : 0;
        uint256 fullFee = (10 * crashPx / 1e12) * 50 / 1e4; // notional (floored to 6dp) * 50 bps
        uint256 fee = rem < fullFee ? rem : fullFee;

        vm.prank(keeper);
        uint256 reward = engine.liquidate(mA, alice);
        assertEq(reward, fee / 2);
        IPoolEngine.MarketState memory s1 = engine.state(mA);
        IPoolEngine.Position memory p1 = engine.positionOf(mA, alice);
        assertEq(p1.size, 0);
        assertEq(p1.marginUsd, rem - fee);
        uint256 cover = badDebt < s0.insuranceUsd ? badDebt : s0.insuranceUsd;
        assertEq(s1.insuranceUsd, s0.insuranceUsd - cover + (fee - fee / 2));
        assertEq(int256(s1.poolCashUsd), int256(s0.poolCashUsd) - pnl - int256(badDebt) + int256(cover));
        assertEq(usdc.balanceOf(keeper), reward);
        _conserved();
    }

    // ------------------------------------------------------------------ funding

    /// @dev Funding is zero-sum between traders and the pool: pool equity change from funding equals
    ///      the traders' aggregate unsettled funding (within rounding).
    function testFuzz_fundingZeroSum(int256 a, int256 b, uint32 dt) public {
        a = bound(a, -300e18, 300e18);
        b = bound(b, -300e18, 300e18);
        vm.assume(a != 0 && b != 0);
        dt = uint32(bound(dt, 1, 30 days));
        _deposit(alice, mB, 100_000e6);
        _deposit(bob, mB, 100_000e6);
        vm.prank(alice);
        try engine.trade(mB, a, a > 0 ? type(uint256).max : 0) {}
        catch {
            return;
        }
        vm.prank(bob);
        try engine.trade(mB, b, b > 0 ? type(uint256).max : 0) {}
        catch {
            return;
        }
        int256 eq0 = engine.poolEquityUsd(mB);
        int256 ta0 = engine.traderEquityUsd(mB, alice);
        int256 tb0 = engine.traderEquityUsd(mB, bob);
        vm.warp(block.timestamp + dt);
        _price(PID_B, PX);
        int256 eq1 = engine.poolEquityUsd(mB);
        int256 ta1 = engine.traderEquityUsd(mB, alice);
        int256 tb1 = engine.traderEquityUsd(mB, bob);
        // traders' equity change mirrors the pool's
        assertApproxEqAbs(eq1 - eq0, -((ta1 - ta0) + (tb1 - tb0)), 4);
        int256 net = a + b;
        if (net != 0) assertGe(eq1, eq0); // the crowded side pays; the pool is never a net funding payer
        // settle both and check conservation
        _trade(alice, mB, -a);
        _trade(bob, mB, -b);
        _conserved();
    }

    // ------------------------------------------------------------------ helpers

    function _floorDiv(int256 x, int256 y) internal pure returns (int256 q) {
        q = x / y;
        if (x % y != 0 && x < 0) q -= 1;
    }
}
