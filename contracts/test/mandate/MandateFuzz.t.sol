// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IBookrunnerDesk} from "../../src/interfaces/IBookrunnerDesk.sol";
import {IMMMandate} from "../../src/interfaces/IMMMandate.sol";
import {BookrunnerDesk} from "../../src/BookrunnerDesk.sol";
import {MandateBase} from "./utils/MandateBase.sol";

/// @notice Parity fuzzing against a literal port of packages/shared/src/mandate.ts.
contract MandateFuzzTest is MandateBase {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant HEDGE_RATIO_MIN_EXPOSURE_BPS = 500;

    uint8 internal constant OK = 0;
    uint8 internal constant OFF_HOURS_NEW_RISK = 1;
    uint8 internal constant RATIO_OUT_OF_BAND = 2;
    uint8 internal constant LEVERAGE = 3;

    // ------------------------------------------------------------------ mandate.ts port

    function _abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }

    /// @dev hedgeRatioBps(m, netExposureUsd, deskHedgeUsd): (isNull, value).
    function _tsHedgeRatioBps(BRTypes.Mandate memory m, int256 exposure, int256 hedge)
        internal
        pure
        returns (bool isNull, uint256 ratio)
    {
        uint256 absExp = _abs(exposure);
        if (absExp * BPS < uint256(m.maxInventoryUsd) * HEDGE_RATIO_MIN_EXPOSURE_BPS) return (true, 0);
        int256 offset = exposure > 0 ? -hedge : hedge;
        uint256 effective = offset > 0 ? uint256(offset) : 0;
        return (false, effective * BPS / absExp);
    }

    function _tsHedgeInBand(BRTypes.Mandate memory m, bool isNull, uint256 r) internal pure returns (bool) {
        if (isNull) return true;
        return r >= m.hedgeRatioMinBps && r <= m.hedgeRatioMaxBps;
    }

    function _tsDist(BRTypes.Mandate memory m, bool isNull, uint256 r) internal pure returns (uint256) {
        if (isNull) return 0;
        if (r < m.hedgeRatioMinBps) return m.hedgeRatioMinBps - r;
        if (r > m.hedgeRatioMaxBps) return r - m.hedgeRatioMaxBps;
        return 0;
    }

    /// @dev checkHedgeLeg(m, netExposureUsd, before, after, offHours, leverage).
    function _tsCheckHedgeLeg(
        BRTypes.Mandate memory m,
        int256 exposure,
        int256 before,
        int256 after_,
        bool offHours,
        uint16 leverage
    ) internal pure returns (uint8) {
        if (leverage > m.maxHedgeLeverage) return LEVERAGE;
        if (offHours && m.noNewRiskOffHours) {
            if (_abs(exposure + after_) > _abs(exposure + before)) return OFF_HOURS_NEW_RISK;
        }
        (bool nA, uint256 rA) = _tsHedgeRatioBps(m, exposure, after_);
        if (_tsHedgeInBand(m, nA, rA)) return OK;
        (bool nB, uint256 rB) = _tsHedgeRatioBps(m, exposure, before);
        return _tsDist(m, nA, rA) < _tsDist(m, nB, rB) ? OK : RATIO_OUT_OF_BAND;
    }

    function _code(bytes memory err) internal pure returns (uint8) {
        bytes4 sel = bytes4(err);
        if (sel == IMMMandate.OffHoursNewRisk.selector) return OFF_HOURS_NEW_RISK;
        if (sel == IMMMandate.HedgeRatioOutOfBand.selector) return RATIO_OUT_OF_BAND;
        if (sel == IMMMandate.HedgeLeverageTooHigh.selector) return LEVERAGE;
        return 99;
    }

    function _remandateBand(uint16 lo, uint16 hi, bool noNewRisk, uint16 maxLev)
        internal
        returns (BRTypes.Mandate memory m)
    {
        m = _defaultMandate();
        m.hedgeRatioMinBps = lo;
        m.hedgeRatioMaxBps = hi;
        m.noNewRiskOffHours = noNewRisk;
        m.maxHedgeLeverage = maxLev;
        vm.prank(committee);
        mandate.remandate(m);
        _registerDefaultKey();
    }

    // ------------------------------------------------------------------ parity fuzz

    struct LegCase {
        int256 exposure;
        int256 before;
        int256 after_;
        bool held;
        uint16 leverage;
    }

    /// @notice MMMandate's executed-leg check == mandate.ts checkHedgeLeg (perp venue: no spot rules).
    function testFuzz_checkHedgeLeg_parity(
        int64 expSeed,
        int64 beforeSeed,
        int64 afterSeed,
        bool held,
        bool noNewRisk,
        uint16 lev,
        uint16 loSeed,
        uint16 hiSeed
    ) public {
        uint16 lo = uint16(bound(loSeed, 0, 20_000));
        BRTypes.Mandate memory m = _remandateBand(lo, uint16(bound(hiSeed, lo, 30_000)), noNewRisk, 300);
        LegCase memory c = LegCase({
            exposure: bound(int256(expSeed), -200_000e6, 200_000e6),
            before: bound(int256(beforeSeed), -200_000e6, 200_000e6),
            after_: bound(int256(afterSeed), -200_000e6, 200_000e6),
            held: held,
            leverage: uint16(bound(lev, 0, 600))
        });
        _runLegCase(m, c);
    }

    function _runLegCase(BRTypes.Mandate memory m, LegCase memory c) internal {
        adapter.setExposure(c.exposure);
        oracle.setHeld(NVDA_ID, c.held);
        uint8 expected = _tsCheckHedgeLeg(m, c.exposure, c.before, c.after_, c.held, c.leverage);
        IMMMandate.HedgeParams memory p = IMMMandate.HedgeParams({
            asset: _asset(address(nvda)),
            venue: V_ENGINE,
            buy: c.after_ > c.before,
            qtyRaw: 1,
            notionalUsd: _abs(c.after_ - c.before),
            leverage: c.leverage
        });
        bytes32[] memory proof = _proof(address(nvda), V_ENGINE);
        try mandate.checkHedgeExecuted(key, p, proof, c.before, c.after_, 0) {
            assertEq(expected, OK, "contract accepted, TS rejects");
        } catch (bytes memory err) {
            assertEq(_code(err), expected, "rejection reason differs");
        }
    }

    /// @notice Deterministic edge rows of the band rule (boundaries, threshold, sign handling).
    function test_checkHedgeLeg_parityEdges() public {
        BRTypes.Mandate memory m = _defaultMandate();
        int256[5][14] memory rows = [
            // exposure, before, after, held(0/1), leverage
            [int256(-20_000e6), int256(0), int256(10_000e6), int256(0), int256(100)], // exactly band min
            [int256(-20_000e6), int256(0), int256(24_000e6), int256(0), int256(100)], // exactly band max
            [int256(-20_000e6), int256(0), int256(24_000e6 + 2e6), int256(0), int256(100)], // just above max, closer
            [int256(-20_000e6), int256(15_000e6), int256(24_002e6), int256(0), int256(100)], // in band -> above
            [int256(-2500e6), int256(0), int256(100_000e6), int256(0), int256(100)], // exactly at 5% threshold
            [int256(-2499e6), int256(0), int256(100_000e6), int256(0), int256(100)], // just below threshold
            [int256(20_000e6), int256(0), int256(1e6), int256(0), int256(100)], // long venue: spot never offsets
            [int256(20_000e6), int256(0), int256(-10_000e6), int256(0), int256(100)], // long venue: short hedge offsets
            [int256(-20_000e6), int256(30_000e6), int256(25_000e6), int256(1), int256(100)], // off-hours reducing
            [int256(-20_000e6), int256(10_000e6), int256(30_000e6 + 1), int256(1), int256(100)], // off-hours adding
            [int256(-20_000e6), int256(10_000e6), int256(30_000e6), int256(1), int256(100)], // off-hours equal |net|
            [int256(0), int256(0), int256(50_000e6), int256(1), int256(100)], // flat venue, off-hours, adding
            [int256(-20_000e6), int256(0), int256(15_000e6), int256(0), int256(301)], // leverage
            [int256(-20_000e6), int256(0), int256(15_000e6), int256(0), int256(300)] // leverage boundary
        ];
        for (uint256 i; i < rows.length; ++i) {
            LegCase memory c = LegCase({
                exposure: rows[i][0],
                before: rows[i][1],
                after_: rows[i][2],
                held: rows[i][3] == 1,
                leverage: uint16(uint256(rows[i][4]))
            });
            _runLegCase(m, c);
        }
    }

    /// @notice checkHedge (pre-trade view) == checkHedgeLeg with before = desk hedge, after = before +/- notional.
    function testFuzz_checkHedgeView_parity(
        int64 expSeed,
        int64 hedgeSeed,
        uint64 notionalSeed,
        bool buy,
        bool held
    ) public {
        BRTypes.Mandate memory m = _defaultMandate();
        int256 exposure = bound(int256(expSeed), -200_000e6, 200_000e6);
        int256 hedge = bound(int256(hedgeSeed), 0, 200_000e6);
        uint256 notional = bound(uint256(notionalSeed), 0, 200_000e6);
        vm.mockCall(address(desk), abi.encodeCall(IBookrunnerDesk.hedgeNotionalUsd, ()), abi.encode(hedge));
        adapter.setExposure(exposure);
        oracle.setHeld(NVDA_ID, held);
        int256 after_ = buy ? hedge + int256(notional) : hedge - int256(notional);
        uint8 expected = _tsCheckHedgeLeg(m, exposure, hedge, after_, held, 100);
        IMMMandate.HedgeParams memory p =
            IMMMandate.HedgeParams(_asset(address(nvda)), V_ENGINE, buy, 1, notional, 100);
        bytes32[] memory proof = _proof(address(nvda), V_ENGINE);
        try mandate.checkHedge(key, p, proof) {
            assertEq(expected, OK);
        } catch (bytes memory err) {
            assertEq(_code(err), expected);
        }
    }

    /// @notice IMMMandate.hedgeRatioBps == mandate.ts hedgeRatioBps (null -> type(uint256).max).
    function testFuzz_hedgeRatioBps_parity(int64 expSeed, int64 hedgeSeed) public {
        int256 exposure = bound(int256(expSeed), -500_000e6, 500_000e6);
        int256 hedge = bound(int256(hedgeSeed), -500_000e6, 500_000e6);
        vm.mockCall(address(desk), abi.encodeCall(IBookrunnerDesk.hedgeNotionalUsd, ()), abi.encode(hedge));
        adapter.setExposure(exposure);
        (bool isNull, uint256 r) = _tsHedgeRatioBps(_defaultMandate(), exposure, hedge);
        assertEq(mandate.hedgeRatioBps(), isNull ? type(uint256).max : r);
    }

    // ------------------------------------------------------------------ rule fuzz

    function testFuzz_checkInventoryMove_rule(
        uint64 insurance,
        int64 margin,
        uint64 amount,
        bool isIF,
        bool held
    ) public {
        adapter.setEquity(insurance, margin);
        oracle.setHeld(NVDA_ID, held);
        uint8 account = isIF ? BRTypes.ACCOUNT_IF : BRTypes.ACCOUNT_MM;
        uint256 base = isIF ? uint256(insurance) : (margin > 0 ? uint256(int256(margin)) : 0);
        uint256 cap = isIF ? IF_TARGET : MM_INV;
        bool shouldPass = !held && base + amount <= cap;
        try mandate.checkInventoryMove(key, true, account, amount) {
            assertTrue(shouldPass);
        } catch (bytes memory err) {
            assertFalse(shouldPass);
            if (held) {
                assertEq(bytes4(err), IMMMandate.OffHoursNewRisk.selector);
            } else {
                assertEq(err, abi.encodeWithSelector(IMMMandate.InventoryLimit.selector, base + amount, cap));
            }
        }
        // recalls are never limited for an active key
        mandate.checkInventoryMove(key, false, account, amount);
    }

    function testFuzz_checkQuote_rule(uint16 spread, int16 skew, uint128 maxNet) public view {
        int256 s = int256(skew);
        bool shouldPass = spread >= 8 && (s < 0 ? -s : s) <= 25 && maxNet <= MAX_INV;
        try mandate.checkQuote(key, spread, skew, maxNet) {
            assertTrue(shouldPass);
        } catch {
            assertFalse(shouldPass);
        }
    }

    /// @notice Executed buys never leave the desk above the float cap.
    function testFuzz_deskBuy_floatCap(uint64 usdSeed, uint64 capSeed) public {
        uint256 cap = bound(uint256(capSeed), 0, 300e18);
        vm.prank(timelock);
        registry.setFloatCap(address(nvda), cap);
        uint256 usd = bound(uint256(usdSeed), 1e6, 55_000e6);
        adapter.setExposure(-50_000e6);
        _fundDesk(usd);
        uint256 q = router.quote(address(usdc), address(nvda), usd);
        vm.prank(key);
        try desk.execute(_hedgeAction(address(nvda), true, usd, 0)) {
            assertLe(nvda.balanceOf(address(desk)), cap);
        } catch (bytes memory err) {
            if (q <= cap) {
                // the only other reason a buy can fail here is the band rule
                assertEq(bytes4(err), IMMMandate.HedgeRatioOutOfBand.selector);
            } else {
                assertEq(err, abi.encodeWithSelector(IMMMandate.FloatCapExceeded.selector, q, cap));
            }
        }
    }

    /// @notice Key swaps execute within maxSlippageBps of the oracle value, exactly at the boundary.
    function testFuzz_deskBuy_slippageBound(uint16 haircutSeed, uint64 usdSeed) public {
        uint256 haircut = bound(uint256(haircutSeed), 0, 1000);
        uint256 usd = bound(uint256(usdSeed), 1000e6, 20_000e6);
        router.setHaircutBps(haircut);
        adapter.setExposure(-20_000e6);
        _fundDesk(usd);
        uint256 q = router.quote(address(usdc), address(nvda), usd);
        uint256 value = registry.valueUsd(address(nvda), q);
        bool withinSlippage = value * BPS >= usd * (BPS - desk.maxSlippageBps());
        vm.prank(key);
        try desk.execute(_hedgeAction(address(nvda), true, usd, 0)) {
            assertTrue(withinSlippage);
        } catch (bytes memory err) {
            assertFalse(withinSlippage);
            assertEq(err, abi.encodeWithSelector(BookrunnerDesk.SlippageTooHigh.selector, usd, value));
        }
    }
}
