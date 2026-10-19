// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {console2} from "forge-std/console2.sol";
import {M3Stack} from "./utils/M3Stack.sol";
import {MMMandate} from "../../../src/MMMandate.sol";
import {PoolEngine} from "../../../src/PoolEngine.sol";
import {BRTypes} from "../../../src/interfaces/BRTypes.sol";

/// @title Audit remediation M-3: a desk key drains the PoolEngine pool with in-mandate quotes.
/// @notice checkQuote bounded width and skew separately. With max skew above half the minimum width (all three
///         devnet charters: 8/25, 12/30, 10/25) a quote can sit entirely on one side of the oracle: at width 10
///         and skew -25 the pool SELLS 20 bps below the oracle, at skew +25 it BUYS 20 bps above it. Flipping the
///         skew around a colluding trader's buy and sell moves value from the pool to the trader with no price
///         move. PoC (RHX5 terms): 25 round trips of $70k in one block, the pool loses ~$7,000 and the trader
///         nets ~$4,900 (the rest is taker fee); it repeats every block until the drawdown kill at the next mark.
///         Fix: (1) MMMandate.checkQuote requires 2 x |skew| <= spread (QuoteOneSided), and PoolEngine.setQuote
///         enforces the same bound whatever the mandate (InvalidQuote); (2) validateMandate / MarketCharter.validate
///         require maxSkew <= minQuoteWidth / 2 (BAD_MANDATE); (3) a per-period pool loss budget on PoolEngine
///         (|killAtDrawdownBps| of the pool equity at the period's first trade, period = config.markInterval()):
///         past it, new risk reverts LossBudgetExceeded until the next period, whatever the number of trades.
contract M3PoolDrainSkewTest is M3Stack {
    address internal mallory = makeAddr("mallory");
    address internal bob = makeAddr("bob");
    uint256 internal constant MARGIN = 20_000e6;
    int256 internal constant SIZE = 700e18; // 700 units x $100 = $70k

    function setUp() public {
        _deployStack();
        _deposit(mallory, mid, MARGIN);
    }

    /// @notice The auditor's PoC, verbatim: the desk key flips the skew around each leg of the colluding
    ///         trader's round trip, 25 times in one block. Fixed: the one-sided quotes are refused (mandate
    ///         checkQuote and the engine bound), so every leg fills at a quote straddling the oracle: the pool
    ///         keeps (at least) its equity and the trader cannot extract anything.
    function test_M3_poc_flipSkewRoundTrips_poolNotDrained() public {
        int256 eq0 = engine.poolEquityUsd(mid);
        uint256 quotesAccepted;
        uint256 legs;
        for (uint256 i; i < 25; ++i) {
            if (_tryQuote(MIN_WIDTH, -MAX_SKEW, MAX_INV)) quotesAccepted++; // ask 20 bps BELOW the oracle
            if (_tryTrade(mallory, SIZE)) legs++;
            if (_tryQuote(MIN_WIDTH, MAX_SKEW, MAX_INV)) quotesAccepted++; // bid 20 bps ABOVE the oracle
            if (_tryTrade(mallory, -SIZE)) legs++;
        }
        int256 eq1 = engine.poolEquityUsd(mid);
        uint256 margin1 = engine.positionOf(mid, mallory).marginUsd;
        console2.log("one-sided quotes accepted", quotesAccepted);
        console2.log("trade legs filled", legs);
        console2.log("pool equity change (USD 6dp)", eq1 - eq0);
        console2.log("trader margin change (USD 6dp)", int256(margin1) - int256(MARGIN));
        // not vacuous: every leg filled (at the straddling quote left in place), no one-sided quote landed
        assertEq(legs, 50, "trade legs filled");
        assertEq(quotesAccepted, 0, "one-sided quotes accepted");
        assertEq(engine.positionOf(mid, mallory).size, 0, "round trips closed");
        assertGe(eq1, eq0, "pool drained by in-mandate quotes at a constant oracle price");
        assertLe(margin1, MARGIN, "colluding trader extracted value from the pool");
    }

    /// @notice The quote that makes the PoC possible: width 10 with skew -25 puts the whole quote below the
    ///         oracle (buy fill = oracle x (1 + 5 bps - 25 bps)). Refused.
    function test_M3_poc_oneSidedQuote_refused() public {
        assertFalse(_tryQuote(MIN_WIDTH, -MAX_SKEW, MAX_INV), "ask below the oracle accepted");
        assertFalse(_tryQuote(MIN_WIDTH, MAX_SKEW, MAX_INV), "bid above the oracle accepted");
        assertFalse(_tryQuote(MIN_WIDTH, 6, MAX_INV), "skew above half the width accepted");
        assertGe(engine.quotePrice(mid, 1e18), PX, "buy fill below the oracle");
        assertLe(engine.quotePrice(mid, -1e18), PX, "sell fill above the oracle");
    }

    // ------------------------------------------------------------------ (1) the quote straddles the oracle

    /// @notice Exact errors: the mandate (cached 10/25 terms) refuses the one-sided quote, and the engine refuses
    ///         it too when the adapter sets it directly (any mandate, any adapter bug).
    function test_M3_oneSidedQuote_exactErrors() public {
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(MMMandate.QuoteOneSided.selector, uint16(10), int16(-25)));
        desk.execute(_quoteAction(10, -25, MAX_INV));
        vm.expectRevert(abi.encodeWithSelector(MMMandate.QuoteOneSided.selector, uint16(10), int16(6)));
        mandate.checkQuote(key, 10, 6, MAX_INV);
        mandate.checkQuote(key, 10, 5, MAX_INV); // |skew| == spread / 2: the bid sits at the oracle
        mandate.checkQuote(key, 50, -25, MAX_INV); // a wider quote may use the full max skew
        vm.prank(address(adapter));
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.InvalidQuote.selector, uint16(10), int16(25)));
        engine.setQuote(mid, 10, 25, MAX_INV);
    }

    /// @notice Engine bound, fuzzed: setQuote succeeds iff 2 x |skew| <= spread (within the sanity bounds), and
    ///         then the buy fill is at or above the oracle and the sell fill at or below it.
    function testFuzz_M3_engineQuoteStraddlesOracle(uint16 spread, int16 skew) public {
        spread = uint16(bound(spread, 0, 5000));
        skew = int16(bound(skew, -2500, 2500));
        uint256 a = skew < 0 ? uint256(-int256(skew)) : uint256(int256(skew));
        vm.prank(address(adapter));
        try engine.setQuote(mid, spread, skew, MAX_INV) {
            assertLe(a * 2, spread, "one-sided quote accepted");
            assertGe(engine.quotePrice(mid, 1e18), PX);
            assertLe(engine.quotePrice(mid, -1e18), PX);
        } catch (bytes memory err) {
            assertGt(a * 2, spread, "straddling quote refused");
            assertEq(bytes4(err), PoolEngine.InvalidQuote.selector);
        }
    }

    /// @notice The attack at the largest skew still allowed (|skew| == width / 2): one side fills exactly at the
    ///         oracle, the other half a width away, so each round trip costs the trader spread + fees and the
    ///         pool gains (never loses) equity.
    function test_M3_maxAllowedSkew_roundTrips_poolNeverLoses() public {
        int256 eq0 = engine.poolEquityUsd(mid);
        for (uint256 i; i < 25; ++i) {
            _quote(MIN_WIDTH, -5, MAX_INV); // buy fills at the oracle
            assertTrue(_tryTrade(mallory, SIZE));
            _quote(MIN_WIDTH, 5, MAX_INV); // sell fills at the oracle
            assertTrue(_tryTrade(mallory, -SIZE));
        }
        assertGe(engine.poolEquityUsd(mid), eq0);
        assertLt(engine.positionOf(mid, mallory).marginUsd, MARGIN, "the trader pays the taker fees");
    }

    // ------------------------------------------------------------------ (2) terms

    /// @notice validateMandate (and so remandate) refuses every devnet charter's terms (8/25, 12/30, 10/25) and
    ///         accepts the corrected ones (8/4, 12/6, 10/5).
    function test_M3_validateMandate_requiresSkewAtMostHalfWidth() public {
        uint16[3] memory widths = [uint16(8), 12, 10];
        int16[3] memory oldSkews = [int16(25), 30, 25];
        int16[3] memory newSkews = [int16(4), 6, 5];
        for (uint256 i; i < 3; ++i) {
            assertEq(mandate.validateMandate(_terms(MAX_INV, widths[i], oldSkews[i])), bytes32("BAD_MANDATE"));
            assertEq(mandate.validateMandate(_terms(MAX_INV, widths[i], newSkews[i] + 1)), bytes32("BAD_MANDATE"));
            assertEq(mandate.validateMandate(_terms(MAX_INV, widths[i], newSkews[i])), bytes32(0));
        }
        vm.prank(committee);
        vm.expectRevert(abi.encodeWithSelector(MMMandate.InvalidMandate.selector, bytes32("BAD_MANDATE")));
        mandate.remandate(_terms(MAX_INV, 10, 25));
    }

    // ------------------------------------------------------------------ (3) per-period loss budget

    /// @notice Adapter wiring: the engine budget is |killAtDrawdownBps| from the charter, re-applied on a
    ///         re-mandate; only the adapter can set it, within 1..5000 bps.
    function test_M3_lossBudget_setFromMandateKill() public {
        (uint16 bps,,,,,) = engine.lossBudget(mid);
        assertEq(bps, 800);
        BRTypes.Mandate memory m = _terms(MAX_INV, 10, 5);
        m.killAtDrawdownBps = -300;
        vm.prank(committee);
        mandate.remandate(m);
        (bps,,,,,) = engine.lossBudget(mid);
        assertEq(bps, 300);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotAdapter.selector, address(this)));
        engine.setLossBudget(mid, 100);
        vm.startPrank(address(adapter));
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.InvalidLossBudget.selector, uint16(0)));
        engine.setLossBudget(mid, 0);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.InvalidLossBudget.selector, uint16(5001)));
        engine.setLossBudget(mid, 5001);
        vm.stopPrank();
        assertEq(adapter.lossBudgetBps(_terms(MAX_INV, 10, 5)), 800);
    }

    /// @notice A loss beyond the budget within one period (here a +17% move against the pool's short) blocks new
    ///         risk; reductions and closes stay open; the next period re-anchors and new risk resumes.
    function test_M3_lossBudget_blocksNewRiskUntilNextPeriod() public {
        _deposit(bob, mid, 5_000e6);
        assertTrue(_tryTrade(mallory, 500e18)); // anchors the period at 100,000 (pool equity before the trade)
        _price(PID_A, 117e18); // pool short 500 units: -$8,500 + spread > the $8,000 budget
        (,, int256 anchor, int256 loss, uint256 budget, bool blocked) = engine.lossBudget(mid);
        assertEq(anchor, int256(POOL));
        assertEq(budget, 8_000e6);
        assertGt(loss, int256(budget));
        assertTrue(blocked);
        vm.prank(bob);
        vm.expectPartialRevert(PoolEngine.LossBudgetExceeded.selector);
        engine.trade(mid, 10e18, type(uint256).max);
        vm.prank(bob);
        vm.expectPartialRevert(PoolEngine.LossBudgetExceeded.selector);
        engine.trade(mid, -10e18, 0); // even new risk that offsets the pool's exposure
        assertTrue(_tryTrade(mallory, -100e18), "reduction blocked");
        // next period: re-anchored at the equity then, new risk resumes
        vm.warp(block.timestamp + cfg.markInterval());
        _price(PID_A, 117e18);
        (,,, loss,, blocked) = engine.lossBudget(mid);
        assertEq(loss, 0);
        assertFalse(blocked);
        assertTrue(_tryTrade(bob, 10e18), "new risk after the period");
        assertTrue(_tryTrade(mallory, -400e18), "close");
    }

    /// @notice Rate: many trades in ONE block cannot spend more than one budget. A trader relays alternating
    ///         signed prints (pull oracle, each newer than the last) and round-trips $50k on a 2% swing, 25 times
    ///         in the same block: once the period's pool loss passes $8,000 every further open reverts; the pool
    ///         loses at most the budget plus the one position already open (exits are never blocked).
    function test_M3_lossBudget_capsManyTradesInOneBlock() public {
        cfg.setMaxTradePriceAge(60);
        vm.warp(block.timestamp + 100);
        uint64 t0 = uint64(block.timestamp) - 59;
        int256 eq0 = engine.poolEquityUsd(mid);
        uint256 opens;
        uint256 refused;
        int256 size = 500e18;
        for (uint256 i; i < 25; ++i) {
            bytes memory lo = _priceData(PID_A, 100e18, t0 + uint64(2 * i), false);
            bytes memory hi = _priceData(PID_A, 102e18, t0 + uint64(2 * i + 1), false);
            vm.prank(mallory);
            try engine.trade(mid, size, type(uint256).max, lo) {
                opens++;
            } catch (bytes memory err) {
                assertEq(bytes4(err), PoolEngine.LossBudgetExceeded.selector);
                refused++;
                continue;
            }
            vm.prank(mallory);
            engine.trade(mid, -size, 0, hi); // the close is a reduction: never blocked
        }
        int256 lost = eq0 - engine.poolEquityUsd(mid);
        console2.log("opens", opens);
        console2.log("refused", refused);
        console2.log("pool loss (USD 6dp)", lost);
        assertGt(refused, 0, "budget never bit");
        assertLt(opens, 25);
        // budget + one round trip's loss (500 units x $2)
        assertLe(lost, int256(8_000e6 + 1_000e6), "pool lost more than one budget in a block");
    }

    /// @notice Liquidity moved by the adapter is not a trading result: a recall does not consume the budget and a
    ///         deposit does not refill it.
    function test_M3_lossBudget_followsLiquidityFlows() public {
        assertTrue(_tryTrade(mallory, 10e18)); // anchor
        vault.recall(BRTypes.ACCOUNT_MM, 50_000e6);
        (,, int256 anchor, int256 loss,,) = engine.lossBudget(mid);
        assertEq(anchor, int256(POOL - 50_000e6));
        assertLe(loss, 0);
        assertTrue(_tryTrade(mallory, 10e18), "a recall is not a loss");
        usdc.mint(address(vault), 20_000e6);
        vault.deployToVenue(BRTypes.ACCOUNT_MM, 20_000e6);
        (,, int256 anchor2,,,) = engine.lossBudget(mid);
        assertEq(anchor2, anchor + 20_000e6);
    }
}
