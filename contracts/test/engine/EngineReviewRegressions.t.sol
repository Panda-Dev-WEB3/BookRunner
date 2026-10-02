// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Test.sol";
import {EngineBase} from "./utils/EngineBase.sol";
import {PoolEngine} from "../../src/PoolEngine.sol";
import {AttestedOracle} from "../../src/AttestedOracle.sol";
import {IAttestedOracle} from "../../src/interfaces/IAttestedOracle.sol";
import {IPoolEngine} from "../../src/interfaces/IPoolEngine.sol";

/// @notice Regressions for the adversarial-review findings on PoolEngine / AttestedOracle. Every test here
///         only uses the pre-fix ABI (new functions / errors are reached by signature) so it compiles
///         against the old code and FAILS there.
contract EngineReviewRegressionsTest is EngineBase {
    event ADL(uint256 indexed marketId, uint256 shortfallUsd);

    address internal adA = makeAddr("adapterA");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal eve = makeAddr("eve");

    uint128 internal constant CAP = 75_000e6;
    uint256 internal constant POOL = 100_000e6;
    uint256 internal constant IF = 25_000e6;

    uint256 internal mA; // velocity 0 (exact PnL math)
    uint256 internal mF; // velocity 100 (funding)
    address internal adF = makeAddr("adapterF");

    function setUp() public {
        _deployCore();
        IPoolEngine.MarketConfig memory c = _defaultCfg(PID_A, CAP);
        c.fundingVelocityBps = 0;
        mA = _createMarket(adA, c);
        mF = _createMarket(adF, _defaultCfg(PID_B, CAP));
        _fundPool(adA, mA, POOL, IF);
        _fundPool(adF, mF, POOL, IF);
        _setQuote(adA, mA, 10, 0, CAP);
        _setQuote(adF, mF, 10, 0, CAP);
        _price(PID_A, PX);
        _price(PID_B, PX);
    }

    // =================================================================== engine-netflat-drain-adl-winners

    /// @dev Alice long 70k, Bob short 70k (net 0), price +5%. Pool liquidity must stay >= IM x the larger
    ///      side, and the IF cannot leave while positions are open: the winner is then paid in full.
    function test_regression_netFlatPoolCannotBeDrainedWhileGrossOpen() public {
        _deposit(alice, mA, 15_000e6);
        _deposit(bob, mA, 15_000e6);
        _trade(alice, mA, 700e18);
        _trade(bob, mA, -700e18);
        assertEq(engine.netExposureUsd(mA), 0);
        _price(PID_A, 105e18);

        uint256 cash = engine.state(mA).poolCashUsd;
        vm.prank(adA);
        vm.expectPartialRevert(PoolEngine.PoolUndercollateralized.selector);
        engine.withdrawLiquidity(mA, cash, adA);
        vm.prank(adA);
        vm.expectRevert(abi.encodeWithSignature("OpenInterest(uint256)", mA));
        engine.withdrawInsurance(mA, IF, adA);

        // the most that can leave keeps 10% of the 73.5k side (7,350) in the pool
        uint256 required = 7350e6;
        int256 eq = engine.poolEquityUsd(mA);
        vm.prank(adA);
        engine.withdrawLiquidity(mA, uint256(eq) - required, adA);
        vm.prank(adA);
        vm.expectPartialRevert(PoolEngine.PoolUndercollateralized.selector);
        engine.withdrawLiquidity(mA, 1, adA);

        // the winner closes first and is paid in full by the pool (no IF draw, no ADL)
        uint256 m0 = engine.positionOf(mA, alice).marginUsd;
        uint256 if0 = engine.state(mA).insuranceUsd;
        vm.recordLogs();
        (uint256 fill, uint256 fee) = _trade(alice, mA, -700e18);
        uint256 pnl = 700e18 * (fill - 100.05e18) / 1e30;
        assertEq(engine.positionOf(mA, alice).marginUsd, m0 + pnl - fee);
        assertEq(engine.state(mA).insuranceUsd, if0);
        _assertNoHaircut();
        assertEq(usdc.balanceOf(address(engine)), _ledger(mA) + _ledger(mF));
    }

    function _assertNoHaircut() internal view {
        bytes32 adl = keccak256("ADL(uint256,uint256)");
        bytes32 drawn = keccak256("InsuranceDrawn(uint256,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != adl && logs[i].topics[0] != drawn, "winner haircut / IF draw");
        }
    }

    // =================================================================== engine-cap-bypass-by-reduction

    /// @dev PoC: a1 +74k, a2 -74k, a1 +74k (net 74k), a2 closes -> pool net -148k (198% of the cap). Each
    ///      side's OI is now capped at the inventory cap, so the second a1 add is rejected.
    function test_regression_counterpartyCloseCannotPushNetBeyondCap() public {
        _deposit(alice, mA, 20_000e6);
        _deposit(bob, mA, 20_000e6);
        _trade(alice, mA, 740e18);
        _trade(bob, mA, -740e18);
        vm.prank(alice);
        vm.expectPartialRevert(PoolEngine.ExposureCap.selector);
        engine.trade(mA, 740e18, type(uint256).max);
        // up to the cap on the long side is fine (74k + 0.9k)
        _trade(alice, mA, 9e18);
        // the counterparty leaving can never take |pool net| above the cap
        _trade(bob, mA, 740e18);
        assertLe(_abs(engine.netExposureUsd(mA)), CAP);
    }

    /// @dev Any interleaving of opens / adds / closes by three traders at a constant price keeps
    ///      |pool net exposure| <= the inventory cap after every step (the A10 bound "always").
    function testFuzz_regression_netWithinCapUnderAnyReductions(uint256 seed) public {
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) _deposit(who[i], mA, 40_000e6);
        for (uint256 step; step < 24; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            address t = who[seed % 3];
            int256 cur = engine.positionOf(mA, t).size;
            int256 delta;
            if ((seed >> 8) % 4 == 0 && cur != 0) delta = -cur; // full close
            else delta = (int256((seed >> 16) % 600) - 300) * 1e18;
            if (delta == 0) continue;
            vm.prank(t);
            try engine.trade(mA, delta, delta > 0 ? type(uint256).max : 0) {} catch {}
            assertLe(_abs(engine.netExposureUsd(mA)), CAP, "pool net above inventory cap");
        }
    }

    // =================================================================== funding-keyed-to-quote-cap

    /// @dev 5k of trader skew on a 75k book: 100 bps/day * 5/75 = 6.67 bps/day, whatever the agent's quote
    ///      cap (it freezes the cap at |exposure| when quoting one-sided).
    function test_regression_fundingNormalisedByInventoryCapNotQuoteCap() public {
        _deposit(alice, mF, 2000e6);
        _trade(alice, mF, 50e18); // ~5k long skew
        int256 r0 = engine.fundingRatePerDayWad(mF);
        uint256 expected = uint256(1e18) * 100 / 1e4 * 5000e6 / uint256(CAP);
        assertApproxEqRel(uint256(r0), expected, 0.001e18);
        _setQuote(adF, mF, 10, 0, 5000e6); // agent freezes the cap at |exposure|
        assertEq(engine.fundingRatePerDayWad(mF), r0);
        _setQuote(adF, mF, 10, 0, 1);
        assertEq(engine.fundingRatePerDayWad(mF), r0);
    }

    // =================================================================== oracle-signed-price-sandwich

    /// @dev PoC: the stored price is 100 and a fresh signed 100.40 leaked (public /prices). Eve buys at the
    ///      stored ask, relays the signed update herself, and sells at the new bid in one flow. Relaying is now
    ///      restricted to signers / KEEPER / timelock, so the push reverts and the sandwich is impossible.
    function test_regression_oracleSandwich_traderCannotRelaySignedPrice() public {
        _deposit(eve, mA, 20_000e6);
        vm.warp(block.timestamp + 1);
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 100.4e18, uint64(block.timestamp), false, 3);
        bytes memory sig = _sign(SIGNER_PK, u); // leaked signature
        _trade(eve, mA, 700e18);
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSignature("NotRelayer(address)", eve));
        oracle.push(u, sig);
        IAttestedOracle.PriceUpdate[] memory us = new IAttestedOracle.PriceUpdate[](1);
        bytes[] memory sigs = new bytes[](1);
        us[0] = u;
        sigs[0] = sig;
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSignature("NotRelayer(address)", eve));
        oracle.pushMany(us, sigs);
        assertEq(oracle.latest(PID_A).priceWad, PX);
        // the registered signer (the oracle service's tx sender) still relays
        vm.prank(signer);
        oracle.push(u, sig);
        assertEq(oracle.latest(PID_A).priceWad, 100.4e18);
    }

    /// @dev New risk needs a price at most NEW_RISK_MAX_PRICE_AGE (60s) old even though maxPriceAge is 300s:
    ///      a stalled push cannot be farmed against the market. Reductions keep working.
    function test_regression_newRiskNeedsRecentPrice() public {
        _deposit(alice, mA, 5000e6);
        _trade(alice, mA, 10e18);
        uint64 at = oracle.latest(PID_A).publishedAt;
        vm.warp(uint256(at) + 60);
        _trade(alice, mA, 1e18); // exactly 60s old: fine
        vm.warp(uint256(at) + 61);
        assertFalse(oracle.isStale(PID_A));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, at));
        engine.trade(mA, 1e18, type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, at));
        engine.withdrawMargin(mA, 1e6);
        _trade(alice, mA, -5e18); // reduce ok
        _price(PID_A, PX);
        _trade(alice, mA, 1e18);
    }
}
