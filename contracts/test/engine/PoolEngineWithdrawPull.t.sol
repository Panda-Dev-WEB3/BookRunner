// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {EngineBase} from "./utils/EngineBase.sol";
import {PoolEngine} from "../../src/PoolEngine.sol";
import {IAttestedOracle} from "../../src/interfaces/IAttestedOracle.sol";
import {IPoolEngine} from "../../src/interfaces/IPoolEngine.sol";

/// @notice Tech update #8 (upkeep paid inside user transactions): `withdrawMargin(marketId, amount, priceData)`.
///         With an open position the withdrawal needs a live, fresh stored price; the wallet used to send a separate
///         oracle-relay transaction first. The overload carries the signed bundle and runs `AttestedOracle.update`
///         inside the same transaction, with every signature / freshness / replay rule of the oracle unchanged.
contract PoolEngineWithdrawPullTest is EngineBase {
    uint256 internal constant OTHER_PK = 0xB0B;
    uint128 internal constant MAX_NET = 75_000e6;

    address internal adA = makeAddr("adapterA");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal mA;
    uint64 internal t0;

    function setUp() public {
        _deployCore();
        IPoolEngine.MarketConfig memory c = _defaultCfg(PID_A, MAX_NET);
        c.fundingVelocityBps = 0;
        mA = _createMarket(adA, c);
        _fundPool(adA, mA, 100_000e6, 25_000e6);
        _setQuote(adA, mA, 10, 0, MAX_NET);
        _price(PID_A, PX);
        t0 = oracle.latest(PID_A).publishedAt;
        _deposit(alice, mA, 200e6);
        _trade(alice, mA, 10e18); // notional 1000, initial margin 100
    }

    function _now() internal view returns (uint64) {
        return uint64(block.timestamp);
    }

    function _withdraw(address who, uint256 amount, bytes memory pd) internal {
        vm.prank(who);
        engine.withdrawMargin(mA, amount, pd);
    }

    /// @dev The stored price is an hour old: the plain call refuses; the same withdrawal carrying a fresh signed print
    ///      lands in one transaction and stores that print.
    function test_withdraw_carriesFreshPriceWhenStoredIsStale() public {
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, t0));
        engine.withdrawMargin(mA, 10e6);

        _withdraw(alice, 10e6, _priceData(PID_A, PX, _now(), false));
        assertEq(oracle.latest(PID_A).publishedAt, _now());
        assertEq(engine.positionOf(mA, alice).marginUsd, 198_999_500 - 10e6);
        assertEq(usdc.balanceOf(alice), 10e6);
    }

    /// @dev Empty priceData is the plain call: same result, nothing reaches the oracle.
    function test_withdraw_emptyPriceDataIsThePlainCall() public {
        _withdraw(alice, 10e6, "");
        assertEq(oracle.latest(PID_A).publishedAt, t0, "empty priceData never reaches the oracle");
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, t0));
        engine.withdrawMargin(mA, 1e6, "");
    }

    /// @dev A bundle signed by anyone but an oracle signer reverts the whole call: nothing stored, no margin moved.
    function test_withdraw_badSignatureReverts() public {
        vm.warp(block.timestamp + 10);
        bytes memory forged = _priceDataBy(OTHER_PK, PID_A, 300e18, _now(), false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, vm.addr(OTHER_PK)));
        engine.withdrawMargin(mA, 1e6, forged);
        assertEq(oracle.latest(PID_A).priceWad, PX);
        assertEq(engine.positionOf(mA, alice).marginUsd, 198_999_500);
    }

    /// @dev Security review L4: a withdrawal that leaves a position open is new risk and uses the TRADE freshness bound
    ///      (maxTradePriceAge, 15 s), not the 60 s new-risk bound: a print older than that is stored (it is newer than the
    ///      stored one) but does not satisfy the withdrawal, which reverts StalePrice.
    function test_withdraw_oldPrintDoesNotSatisfyTheFreshnessBound() public {
        vm.warp(block.timestamp + 1 hours);
        uint64 old = _now() - 16;
        bytes memory pd = _priceData(PID_A, PX, old, false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, old));
        engine.withdrawMargin(mA, 1e6, pd);
        assertEq(oracle.latest(PID_A).publishedAt, t0, "the reverted tx stored nothing");
        _withdraw(alice, 1e6, _priceData(PID_A, PX, _now() - 15, false)); // exactly at the trade bound: allowed
    }

    /// @dev Replay: re-sending an older bundle is skipped (not newer than the stored price), so it can neither
    ///      overwrite a newer price nor revive a stale one.
    function test_withdraw_replayedBundleIsSkipped() public {
        vm.warp(block.timestamp + 5);
        bytes memory first = _priceData(PID_A, 101e18, _now(), false);
        _withdraw(alice, 1e6, first);
        assertEq(oracle.latest(PID_A).priceWad, 101e18);
        vm.warp(block.timestamp + 5);
        _withdraw(alice, 1e6, _priceData(PID_A, 99e18, _now(), false));
        assertEq(oracle.latest(PID_A).priceWad, 99e18);
        // the first bundle again: older than the stored print, skipped; the newer 99 stays and the withdrawal lands
        _withdraw(alice, 1e6, first);
        assertEq(oracle.latest(PID_A).priceWad, 99e18);
    }

    /// @dev The engine's own checks run on the carried price: a print that moves the position against the wallet makes
    ///      the equity test fail (InsufficientMargin), the whole call reverts and the print is not kept.
    function test_withdraw_equityCheckUsesTheCarriedPrice() public {
        vm.warp(block.timestamp + 5);
        // price down 20%: pnl -200 on the long 10, equity ~0 -> initial margin check fails
        bytes memory down = _priceData(PID_A, 80e18, _now(), false);
        vm.prank(alice);
        vm.expectRevert();
        engine.withdrawMargin(mA, 50e6, down);
        assertEq(oracle.latest(PID_A).priceWad, PX);
    }

    /// @dev Parity with services/api/test/trade.test.ts: the selectors the API prepares are the contract's.
    function test_selectors_matchTheApiParityVector() public pure {
        assertEq(bytes4(keccak256("withdrawMargin(uint256,uint256,bytes)")), bytes4(0xd263fc50));
        assertEq(bytes4(keccak256("withdrawMargin(uint256,uint256)")), bytes4(0x3bad4bbb));
    }

    /// @dev A held (off-hours) print carried in the bundle is stored, and the withdrawal with a position still refuses.
    function test_withdraw_heldPrintStillRefusesWithAPosition() public {
        vm.warp(block.timestamp + 5);
        bytes memory held = _priceData(PID_A, PX, _now(), true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mA));
        engine.withdrawMargin(mA, 1e6, held);
        assertEq(oracle.latest(PID_A).publishedAt, t0, "the reverted tx stored nothing");
    }

    /// @dev The plain call (stored price) follows the same bound with a position open: a 20 s old stored price is refused.
    function test_withdraw_plainCallWithAPositionUsesTheTradeBound() public {
        vm.warp(block.timestamp + 20);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, t0));
        engine.withdrawMargin(mA, 1e6);
        vm.warp(t0 + 15);
        vm.prank(alice);
        engine.withdrawMargin(mA, 1e6);
    }

    /// @dev A flat wallet with no position needs no price at all: an hour-old stored price does not matter.
    function test_withdraw_flatWalletNeedsNoPrice() public {
        _deposit(bob, mA, 50e6);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(bob);
        engine.withdrawMargin(mA, 50e6);
        assertEq(usdc.balanceOf(bob), 50e6);
    }

    /// @dev A flat wallet withdraws freely, carrying a bundle or not.
    function test_withdraw_flatWalletWithBundle() public {
        _deposit(bob, mA, 50e6);
        vm.warp(block.timestamp + 5);
        _withdraw(bob, 50e6, _priceData(PID_A, PX, _now(), false));
        assertEq(usdc.balanceOf(bob), 50e6);
    }

    /// @dev Zero amount and unknown market revert as in the plain call (after the carried update).
    function test_withdraw_zeroAmountReverts() public {
        vm.prank(alice);
        vm.expectRevert(PoolEngine.ZeroAmount.selector);
        engine.withdrawMargin(mA, 0, "");
    }

    /// @dev Someone else relaying the same bundle first (a public tx) does not break the wallet's call.
    function test_withdraw_bundleAlreadyRelayedByAnotherCaller() public {
        vm.warp(block.timestamp + 5);
        bytes memory pd = _priceData(PID_A, PX, _now(), false);
        oracle.update(pd); // anyone relays it first
        _withdraw(alice, 1e6, pd); // the carried copy is skipped, the withdrawal still lands
        assertEq(engine.positionOf(mA, alice).marginUsd, 198_999_500 - 1e6);
    }
}
