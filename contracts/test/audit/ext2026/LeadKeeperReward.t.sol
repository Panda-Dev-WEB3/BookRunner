// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {EngineBase} from "../../engine/utils/EngineBase.sol";
import {PoolEngine} from "../../../src/PoolEngine.sol";
import {IPoolEngine} from "../../../src/interfaces/IPoolEngine.sol";

/// @title External audit 2026-10, lead "liquidation reward": zero once margin is gone.
/// @notice Finding: `PoolEngine.liquidate` paid the liquidator half of the liquidation fee taken from the trader's
///         remaining margin. A position whose margin is already gone (a gap, a held session, a slow keeper) paid no
///         reward at all, so the positions that most need closing (their bad debt grows with the price) depended on a
///         keeper acting for free. Fix: the liquidator's share is always half of the nominal fee
///         (`liquidationFeeBps` of the notional at the oracle), paid from the forfeited margin first and the rest from
///         the market's insurance fund (after the bad debt it covers), capped by the fund's balance.
///
///         Market: fee 10 bps taker, IM 10%, MM 5%, liquidation fee 50 bps, pool $100k, IF $25k.
contract LeadKeeperRewardTest is EngineBase {
    event Liquidation(
        uint256 indexed marketId,
        address indexed trader,
        address indexed liquidator,
        int256 size,
        uint256 priceWad,
        uint256 feeUsd,
        uint256 badDebtUsd
    );
    event LiquidationRewardFromInsurance(uint256 indexed marketId, address indexed liquidator, uint256 amountUsd);

    address internal ad = makeAddr("adapter");
    address internal alice = makeAddr("alice");
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
        _deposit(alice, mid, 110e6);
        _trade(alice, mid, 10e18); // long 10 @ 100.05, margin 108.9995 after the taker fee
    }

    /// @notice PoC: margin gone (price 80: loss 200.5 vs margin 108.9995). On the audited code the keeper earns 0;
    ///         now half the nominal fee (10 x $80 x 50 bps / 2 = $2) from the IF, after the IF covered the bad debt.
    function test_lead_keeperReward_poc_paidWhenMarginIsGone() public {
        _price(PID_A, 80e18);
        uint256 badDebt = 91_500_500;
        vm.expectEmit(true, true, false, true, address(engine));
        emit LiquidationRewardFromInsurance(mid, keeper, 2e6);
        vm.expectEmit(true, true, true, true, address(engine));
        emit Liquidation(mid, alice, keeper, 10e18, 80e18, 0, badDebt);
        vm.prank(keeper);
        uint256 reward = engine.liquidate(mid, alice);
        assertEq(reward, 2e6, "keeper paid although the margin is gone");
        assertEq(usdc.balanceOf(keeper), 2e6);
        IPoolEngine.MarketState memory s = engine.state(mid);
        assertEq(s.insuranceUsd, IF - badDebt - 2e6, "bad debt first, then the reward");
        assertEq(s.poolCashUsd, POOL + 200_500_000, "pool made whole");
        assertEq(usdc.balanceOf(address(engine)), _ledger(mid), "conservation");
    }

    /// @notice Margin between half the fee and the fee: the keeper's half comes from the margin, the rest of the
    ///         margin goes to the IF (the audited code paid the keeper half of what was left: $1.74975).
    function test_lead_keeperReward_partialMargin_keeperHalfFirst() public {
        // price 89.5: loss 105.5 at the oracle, margin left 3.4995; fee 10 x 89.5 x 50 bps = 4.475, half 2.2375
        _price(PID_A, 89.5e18);
        assertEq(engine.positionOf(mid, alice).marginUsd, 108_999_500);
        vm.prank(keeper);
        uint256 reward = engine.liquidate(mid, alice);
        assertEq(reward, 2_237_500);
        assertEq(engine.state(mid).insuranceUsd, IF + 3_499_500 - 2_237_500);
        assertEq(engine.positionOf(mid, alice).marginUsd, 0);
        assertEq(usdc.balanceOf(address(engine)), _ledger(mid));
    }

    /// @notice Margin below half the fee: margin pays what it can, the IF pays the rest of the keeper's half.
    function test_lead_keeperReward_marginBelowHalfFee() public {
        // price 89.2: loss 108.5, margin left 0.4995; fee 10 x 89.2 x 50 bps = 4.46, keeper half 2.23
        _price(PID_A, 89.2e18);
        vm.expectEmit(true, true, false, true, address(engine));
        emit LiquidationRewardFromInsurance(mid, keeper, 2_230_000 - 499_500);
        vm.prank(keeper);
        uint256 reward = engine.liquidate(mid, alice);
        assertEq(reward, 2_230_000);
        assertEq(engine.state(mid).insuranceUsd, IF - (2_230_000 - 499_500));
        assertEq(engine.positionOf(mid, alice).marginUsd, 0);
        assertEq(usdc.balanceOf(address(engine)), _ledger(mid));
    }

    /// @notice A healthy liquidation is unchanged: the fee comes from the margin, half to the keeper, half to the IF.
    function test_lead_keeperReward_solventUnchanged() public {
        _price(PID_A, 93e18);
        vm.prank(keeper);
        assertEq(engine.liquidate(mid, alice), 2_325_000);
        assertEq(engine.state(mid).insuranceUsd, IF + 2_325_000);
    }

    /// @notice The top-up is capped by what the IF still holds after the bad debt (never touches the pool).
    function test_lead_keeperReward_cappedByInsurance() public {
        address ad2 = makeAddr("adapter2");
        IPoolEngine.MarketConfig memory c = _defaultCfg(PID_A, MAX_NET);
        c.fundingVelocityBps = 0;
        uint256 m2 = _createMarket(ad2, c);
        _fundPool(ad2, m2, POOL, 92e6); // IF 92: covers the 91.5005 bad debt, 0.4995 left
        _setQuote(ad2, m2, 10, 0, MAX_NET);
        address bob = makeAddr("bob");
        _deposit(bob, m2, 110e6);
        _trade(bob, m2, 10e18);
        _price(PID_A, 80e18);
        uint256 poolBefore = engine.state(m2).poolCashUsd;
        vm.prank(keeper);
        uint256 reward = engine.liquidate(m2, bob);
        assertEq(reward, 499_500, "what the IF has left");
        assertEq(engine.state(m2).insuranceUsd, 0);
        assertEq(engine.state(m2).poolCashUsd, poolBefore + 200_500_000, "the pool pays no reward");
        assertEq(usdc.balanceOf(address(engine)), _ledger(mid) + _ledger(m2));
    }

    /// @notice Fuzz: whatever the price, conservation holds and the keeper gets min(half fee, margin + IF).
    function testFuzz_lead_keeperReward_conservation(uint256 px) public {
        px = bound(px, 1e18, 94e18);
        _price(PID_A, px);
        if (!engine.isLiquidatable(mid, alice)) return;
        uint256 notional = 10 * px / 1e12;
        uint256 fullFee = notional * 50 / 1e4;
        vm.prank(keeper);
        uint256 reward = engine.liquidate(mid, alice);
        assertEq(reward, fullFee / 2);
        assertEq(usdc.balanceOf(address(engine)), _ledger(mid));
    }
}
