// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {IStockTokenRegistry} from "../../src/interfaces/IStockTokenRegistry.sol";
import {StockTokenRegistry} from "../../src/StockTokenRegistry.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockStockToken} from "../../src/mocks/MockStockToken.sol";
import {MandateMockConfig, MandateMockOracle} from "./utils/MandateMocks.sol";

/// @notice VERIFY T2 / C2: mainnet multiplier source = the token's ERC-8056 `uiMultiplier()` (WAD), and the
///         "multiplier applied exactly once" convention with Robinhood's per-TOKEN Chainlink feeds:
///         oracle price (per share) = feed / uiMultiplier (oracle service), registry value =
///         qty x uiMultiplier x per-share = qty x feed. The pinned vector is shared with the TypeScript
///         mirrors (packages/shared/src/stockTokens.ts MULTIPLIER_VECTOR).
contract StockTokenRegistryLiveMultiplierTest is Test {
    MandateMockConfig internal cfg;
    MandateMockOracle internal oracle;
    StockTokenRegistry internal reg;
    MockStockToken internal tok;

    address internal timelock = makeAddr("timelock");
    address internal stranger = makeAddr("stranger");
    bytes32 internal constant NVDA = "NVDA";

    // ---- MULTIPLIER_VECTOR (keep identical to packages/shared/src/stockTokens.ts) ----
    /// Robinhood NVDA Stock Token uiMultiplier on 2026-10-10 (api.robinhood.com/rhj/assets currentMultiplier).
    uint256 internal constant V_MULT = 1_000_775_159_164_630_595;
    uint256 internal constant V_QTY = 12.5e18;
    /// Chainlink "Robinhood NVDA / USD" answer, 8 decimals: $185.12345678 per TOKEN.
    uint256 internal constant V_FEED_ANSWER = 18_512_345_678;
    /// What the oracle signs: round8(feed / uiMultiplier) per SHARE, as WAD.
    uint256 internal constant V_PER_SHARE_WAD = 184_980_067_790_000_000_000;
    /// floor(qty x feed) in USD 6dp = $2314.043209 (qty x feed = 2314.04320975).
    uint256 internal constant V_VALUE_USD6 = 2_314_043_209;
    /// What a double-applied multiplier would value it at (per-token price x multiplier).
    uint256 internal constant V_DOUBLE_USD6 = 2_315_836_961;

    event MultiplierSourceSet(address indexed token, bool fromToken);
    event NextMultiplierAnchorSet(address indexed token, uint256 multiplierWad);
    event MultiplierBandSet(uint16 bandBps);

    function setUp() public {
        vm.warp(1_790_000_000);
        cfg = new MandateMockConfig();
        cfg.setTimelock(timelock);
        oracle = new MandateMockOracle(cfg);
        cfg.setOracle(address(oracle));
        reg = new StockTokenRegistry(address(cfg), address(0));
        tok = new MockStockToken("NVIDIA Robinhood Token", "NVDA", 1e18);
        vm.prank(timelock);
        reg.register(address(tok), NVDA, 1e18, 1000e18);
    }

    function _live(uint256 anchor) internal {
        vm.startPrank(timelock);
        reg.setMultiplier(address(tok), anchor);
        reg.setMultiplierSource(address(tok), true);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ convention (pinned vector)

    function test_vector_uiMultiplierScaleIsWad_andValueIsQtyTimesFeed() public {
        tok.updateMultiplier(V_MULT);
        _live(1e18);
        assertEq(reg.multiplierOf(address(tok)), V_MULT);
        // per-share price the oracle signs = feed / uiMultiplier (WAD math, then 8 dp rounding)
        uint256 feedWad = V_FEED_ANSWER * 1e10;
        assertApproxEqAbs(feedWad * 1e18 / V_MULT, V_PER_SHARE_WAD, 1e10); // within the 8 dp rounding
        oracle.set(NVDA, V_PER_SHARE_WAD, uint64(block.timestamp), false);

        uint256 v = reg.valueUsd(address(tok), V_QTY);
        assertEq(v, V_VALUE_USD6);
        // == Robinhood's own holdings formula: balance * feed / 1e8 (USD, 18 dp) -> 6 dp
        assertEq(V_QTY * V_FEED_ANSWER / 1e8 / 1e12, V_VALUE_USD6);
        assertEq(reg.valueUsdAt(address(tok), V_QTY, V_PER_SHARE_WAD), V_VALUE_USD6);
        // publishing the per-TOKEN feed price would apply the multiplier twice
        assertEq(reg.valueUsdAt(address(tok), V_QTY, feedWad), V_DOUBLE_USD6);
        assertGt(V_DOUBLE_USD6, V_VALUE_USD6);
    }

    function test_getToken_reportsEffectiveMultiplier() public {
        tok.updateMultiplier(1.02e18);
        assertEq(reg.getToken(address(tok)).multiplierWad, 1e18); // stored mode
        _live(1e18);
        IStockTokenRegistry.StockToken memory s = reg.getToken(address(tok));
        assertEq(s.multiplierWad, 1.02e18);
        assertEq(s.decimals, 18);
        // unregistered tokens: zero struct, no external call
        assertEq(reg.getToken(stranger).token, address(0));
    }

    // ------------------------------------------------------------------ corporate actions

    function test_dividendDrift_followsTokenWithinBand() public {
        _live(1e18);
        oracle.set(NVDA, 190e18, uint64(block.timestamp), false);
        assertEq(reg.valueUsd(address(tok), 10e18), 1900e6);
        tok.updateMultiplier(1.049e18); // reinvested dividends: inside the 5% band
        assertEq(reg.valueUsd(address(tok), 10e18), 1993.1e6);
        tok.updateMultiplier(1.051e18); // outside: fail closed until re-anchored
        vm.expectRevert(
            abi.encodeWithSelector(StockTokenRegistry.MultiplierOutOfBand.selector, address(tok), 1.051e18, 1e18)
        );
        reg.valueUsd(address(tok), 10e18);
        vm.expectRevert(
            abi.encodeWithSelector(StockTokenRegistry.MultiplierOutOfBand.selector, address(tok), 1.051e18, 1e18)
        );
        reg.getToken(address(tok));
        vm.prank(timelock);
        reg.setMultiplier(address(tok), 1.05e18); // re-anchor
        assertEq(reg.valueUsd(address(tok), 10e18), 1996.9e6);
    }

    function test_scheduledSplit_preApprovedAnchor() public {
        _live(1e18);
        tok.updateMultiplier(10e18, block.timestamp + 1 days); // staged 10:1 split
        assertEq(reg.multiplierOf(address(tok)), 1e18); // not active yet
        vm.prank(timelock);
        vm.expectEmit(true, false, false, true, address(reg));
        emit NextMultiplierAnchorSet(address(tok), 10e18);
        reg.setNextMultiplierAnchor(address(tok), 10e18);
        assertEq(reg.multiplierOf(address(tok)), 1e18); // the old anchor still accepted
        vm.warp(block.timestamp + 1 days);
        oracle.set(NVDA, 19e18, uint64(block.timestamp), false); // post-split share price
        assertEq(reg.multiplierOf(address(tok)), 10e18);
        assertEq(reg.valueUsd(address(tok), 10e18), 1900e6); // continuous token value
        // without the pre-approval the split fails closed
        vm.prank(timelock);
        reg.setNextMultiplierAnchor(address(tok), 0);
        vm.expectRevert(
            abi.encodeWithSelector(StockTokenRegistry.MultiplierOutOfBand.selector, address(tok), 10e18, 1e18)
        );
        reg.valueUsd(address(tok), 10e18);
    }

    function test_disablingLiveMode_returnsStoredValue() public {
        _live(1e18);
        tok.updateMultiplier(1.01e18);
        assertEq(reg.multiplierOf(address(tok)), 1.01e18);
        vm.prank(timelock);
        vm.expectEmit(true, false, false, true, address(reg));
        emit MultiplierSourceSet(address(tok), false);
        reg.setMultiplierSource(address(tok), false);
        assertEq(reg.multiplierOf(address(tok)), 1e18);
        assertFalse(reg.multiplierFromToken(address(tok)));
    }

    // ------------------------------------------------------------------ guards

    function test_setMultiplierSource_requiresErc8056Token() public {
        MockERC20 plain = new MockERC20("Plain", "PLN", 18);
        vm.startPrank(timelock);
        reg.register(address(plain), "PLN", 1e18, 0);
        vm.expectRevert(); // no uiMultiplier()
        reg.setMultiplierSource(address(plain), true);
        // out of band at enable time
        tok.updateMultiplier(2e18);
        vm.expectRevert(
            abi.encodeWithSelector(StockTokenRegistry.MultiplierOutOfBand.selector, address(tok), 2e18, 1e18)
        );
        reg.setMultiplierSource(address(tok), true);
        tok.updateMultiplier(0);
        vm.expectRevert(StockTokenRegistry.BadMultiplier.selector);
        reg.setMultiplierSource(address(tok), true);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotRegistered.selector, stranger));
        reg.setMultiplierSource(stranger, true);
        vm.stopPrank();
    }

    function test_governanceOnly_andBandBounds() public {
        assertEq(reg.multiplierBandBps(), 500);
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.Unauthorized.selector, stranger));
        reg.setMultiplierSource(address(tok), true);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.Unauthorized.selector, stranger));
        reg.setNextMultiplierAnchor(address(tok), 1e18);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.Unauthorized.selector, stranger));
        reg.setMultiplierBand(100);
        vm.stopPrank();

        vm.startPrank(timelock);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.BadBand.selector, uint16(0)));
        reg.setMultiplierBand(0);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.BadBand.selector, uint16(5001)));
        reg.setMultiplierBand(5001);
        vm.expectEmit(false, false, false, true, address(reg));
        emit MultiplierBandSet(100);
        reg.setMultiplierBand(100);
        vm.stopPrank();
        _live(1e18);
        tok.updateMultiplier(1.01e18); // exactly on the 1% edge: accepted
        assertEq(reg.multiplierOf(address(tok)), 1.01e18);
        tok.updateMultiplier(1.0101e18);
        vm.expectRevert(
            abi.encodeWithSelector(StockTokenRegistry.MultiplierOutOfBand.selector, address(tok), 1.0101e18, 1e18)
        );
        reg.multiplierOf(address(tok));
    }

    /// @dev Fuzz: for any multiplier in band and any per-token feed price, the per-share conversion done by
    ///      the oracle service followed by the registry valuation equals qty x feed (up to the 8 dp price
    ///      rounding and the final floor) — never qty x feed x multiplier.
    function testFuzz_appliedOnce(uint256 mult, uint256 feedAnswer, uint256 qty) public {
        mult = bound(mult, 0.96e18, 1.04e18);
        feedAnswer = bound(feedAnswer, 1e8, 10_000e8); // $1 .. $10,000 per token, 8 dp
        qty = bound(qty, 1e15, 1_000_000e18);
        tok.updateMultiplier(mult);
        _live(1e18);
        uint256 perShareWad = (feedAnswer * 1e10 * 1e18 / mult) / 1e10 * 1e10; // floor to 8 dp
        uint256 v = reg.valueUsdAt(address(tok), qty, perShareWad);
        uint256 expected = qty * feedAnswer / 1e8 / 1e12;
        // error <= qty x mult x 1e-8 (one 8-dp unit of the per-share price) + 1 (floor)
        uint256 tol = qty * mult / 1e18 / 1e18 * 1e6 / 1e8 + 2;
        assertApproxEqAbs(v, expected, tol);
    }
}
