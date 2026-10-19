// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {IAttestedOracle} from "../../../src/interfaces/IAttestedOracle.sol";
import {AttestedOracle} from "../../../src/AttestedOracle.sol";
import {BookrunnerDesk} from "../../../src/BookrunnerDesk.sol";
import {StockTokenRegistry} from "../../../src/StockTokenRegistry.sol";
import {MockStockToken} from "../../../src/mocks/MockStockToken.sol";
import {MandateBase} from "../../mandate/utils/MandateBase.sol";

/// @title External audit 2026-10, M-2: stock split / multiplier change while the price is held.
/// @notice Finding: a split during a closed session is valued at the OLD per-share price times the NEW
///         multiplier. The oracle re-signs Friday's per-share price as held with a fresh timestamp while the
///         registry reads the token's live `uiMultiplier()`; once a pre-approved 10:1 split takes effect over
///         the weekend each token is valued at 10x. A desk key then buys far over value with every mandate
///         check passing and the slippage budget charged about $0 (PoC: the desk spends $10,000 and keeps
///         $1,000 of value; control: the same trade without the split reverts SlippageTooHigh). A reverse
///         split mirrors it on sells. Marks taken in that window are inflated the same way.
///         Fix: `StockTokenRegistry.valueUsd` fails closed (MultiplierChangedSincePrice) when the price's share
///         basis predates the last multiplier change. The basis is the price's `publishedAt`, or for a held
///         price `AttestedOracle.lastLiveAt` (the last price signed NOT held: a held price re-stamps that
///         observation, so its fresh `publishedAt` says nothing about its basis). The change time is the
///         token's `effectiveAt()` in live mode, the governance `setMultiplier` / source switch otherwise.
///
///         Desk: the default MandateBase book, venue exposure -20k (short: a spot buy is a hedge), NVDA turned
///         into an ERC-8056 Stock Token in live-multiplier mode, the split's anchor pre-approved.
contract M2SplitHeldPriceTest is MandateBase {
    uint256 internal constant FRI_CLOSE = T0 + 1 days;
    uint256 internal constant SAT = FRI_CLOSE + 1 days; // the split's effectiveAt
    uint256 internal constant SPEND = 10_000e6;

    MockStockToken internal st;

    function setUp() public override {
        super.setUp();
        adapter.setExposure(-20_000e6);
        _fundDesk(20_000e6);
        // turn the devnet token into an ERC-8056 Stock Token in place (same ERC-20 storage layout)
        vm.etch(address(nvda), address(new MockStockToken("x", "x", 1e18)).code);
        st = MockStockToken(address(nvda));
        st.updateMultiplier(1e18, 0); // active since forever, no change recorded
        vm.prank(timelock);
        registry.setMultiplierSource(address(nvda), true);
    }

    // ------------------------------------------------------------------ helpers

    /// @dev Stage a split / reverse split at SAT and pre-approve its anchor (the auditor's precondition).
    function _stageSplit(uint256 newMultiplier) internal {
        st.updateMultiplier(newMultiplier, SAT);
        vm.prank(timelock);
        registry.setNextMultiplierAnchor(address(nvda), newMultiplier);
    }

    /// @dev Friday: last live print at the close, then the session closes and the oracle holds it; the
    ///      weekend is re-stamped up to `until` (fresh publishedAt, still Friday's per-share price).
    function _closedSessionUntil(uint256 until) internal {
        vm.warp(FRI_CLOSE);
        oracle.set(NVDA_ID, NVDA_PX, uint64(FRI_CLOSE), false);
        vm.warp(FRI_CLOSE + 60);
        oracle.set(NVDA_ID, NVDA_PX, uint64(block.timestamp), true);
        vm.warp(until);
        oracle.set(NVDA_ID, NVDA_PX, uint64(block.timestamp), true); // re-signed held, fresh timestamp
        oracle.set(TSLA_ID, TSLA_PX, uint64(block.timestamp), true);
    }

    function _buy(uint256 usd) internal returns (bytes memory) {
        return _exec(key, _hedgeAction(address(nvda), true, usd, 0));
    }

    function _changedErr(uint64 basis, uint256 changedAt) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            StockTokenRegistry.MultiplierChangedSincePrice.selector, address(nvda), basis, changedAt
        );
    }

    // ------------------------------------------------------------------ PoC (buy side)

    /// @notice The auditor's PoC: after a pre-approved 10:1 split takes effect over the closed session, the
    ///         desk buys from a pool quoting the token at 10x its value. Audited code: every check passes and
    ///         the desk keeps $1,000 of value for $10,000. Fixed: the valuation fails closed, the trade reverts.
    function test_M2_poc_splitOverClosedSession_overpayingBuyReverts() public {
        _stageSplit(10e18);
        _closedSessionUntil(SAT + 1 hours);
        assertEq(registry.multiplierOf(address(nvda)), 10e18); // the split is live on the token
        assertEq(registry.multiplierChangedAt(address(nvda)), SAT);
        assertEq(oracle.lastLiveAt(NVDA_ID), FRI_CLOSE);
        // attacker pool: 1 token (= 10 post-split shares at ~$19, worth ~$190) offered at $1,900
        router.setPrice(address(nvda), 1900e18);

        vm.prank(key);
        vm.expectRevert(_changedErr(uint64(FRI_CLOSE), SAT));
        desk.execute(_hedgeAction(address(nvda), true, SPEND, 0));
        // the strict valuation views fail closed too (the mark service mirrors the rule)
        vm.expectRevert(_changedErr(uint64(FRI_CLOSE), SAT));
        registry.valueUsd(address(nvda), 1e18);
    }

    /// @notice The economics the guard removes: at Friday's held per-share price the registry would value the
    ///         5.26 tokens the attacker pool gives for $10,000 at $10,000 (zero slippage), their true value
    ///         at the post-split share price ($19) is $1,000.
    function test_M2_poc_economics_heldPriceTimesNewMultiplierIs10x() public {
        _stageSplit(10e18);
        vm.warp(SAT);
        uint256 qty = SPEND * 1e12 * 1e18 / 1900e18; // what the $1,900 pool returns for $10,000
        assertApproxEqAbs(registry.valueUsdAt(address(nvda), qty, NVDA_PX), SPEND, 1); // held $190 x 10
        assertApproxEqAbs(registry.valueUsdAt(address(nvda), qty, NVDA_PX / 10), 1000e6, 1); // true: $19 x 10
    }

    /// @notice Control: the same trade without the split is refused by the desk's slippage bound.
    function test_M2_control_noSplit_sameTradeRevertsSlippageTooHigh() public {
        _closedSessionUntil(SAT + 1 hours);
        router.setPrice(address(nvda), 1900e18);
        uint256 qty = SPEND * 1e12 * 1e18 / 1900e18;
        uint256 value = registry.valueUsd(address(nvda), qty); // ~$1,000 at multiplier 1
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.SlippageTooHigh.selector, SPEND, value));
        desk.execute(_hedgeAction(address(nvda), true, SPEND, 0));
    }

    // ------------------------------------------------------------------ PoC mirror (sell side)

    /// @notice Reverse split 1:10 over the closed session: each token is valued at 1/10 of its value, so the
    ///         desk could sell its whole position for 10% with zero slippage charged. Fixed: reverts.
    function test_M2_poc_reverseSplit_underpricedSellReverts() public {
        _buy(9500e6); // 50 tokens at $190 (Thursday, fair pool)
        uint256 bal = nvda.balanceOf(address(desk));
        assertEq(bal, 50e18);
        adapter.setExposure(0); // the venue went flat: the desk unwinds its spot hedge
        _stageSplit(0.1e18);
        _closedSessionUntil(SAT + 1 hours);
        // audited valuation: 50 x 0.1 x $190 = $950 for tokens worth 50 x 0.1 x $1,900 = $9,500
        assertEq(registry.valueUsdAt(address(nvda), bal, NVDA_PX), 950e6);
        router.setPrice(address(nvda), 19e18); // attacker pool bids $19 per $190 token

        vm.prank(key);
        vm.expectRevert(_changedErr(uint64(FRI_CLOSE), SAT));
        desk.execute(_hedgeAction(address(nvda), false, bal, 0));
        // the desk-key Flatten values the same way: refused too
        vm.prank(key);
        vm.expectRevert(_changedErr(uint64(FRI_CLOSE), SAT));
        desk.execute(_flattenAction(address(nvda), bal, 0));
        assertEq(nvda.balanceOf(address(desk)), bal);
    }

    // ------------------------------------------------------------------ the window and its end

    /// @notice Right at effectiveAt in an OPEN session: a live price published before the change (still
    ///         fresh) is refused; the first price published after it values the position continuously.
    function test_M2_liveSession_priceBeforeEffectiveAt_refusedUntilRepriced() public {
        _buy(9500e6); // 50 tokens
        _stageSplit(10e18);
        vm.warp(SAT - 20);
        oracle.set(NVDA_ID, NVDA_PX, uint64(block.timestamp), false); // live, 20 s before the split
        vm.warp(SAT + 10);
        vm.expectRevert(_changedErr(uint64(SAT - 20), SAT));
        desk.valueUsd();
        oracle.set(NVDA_ID, NVDA_PX / 10, uint64(block.timestamp), false); // post-split per-share print
        assertEq(registry.valueUsd(address(nvda), 50e18), 9500e6); // 50 x 10 x $19: continuous
        assertEq(desk.hedgeNotionalUsd(), 9500e6);
        // a fair trade works again (pool: $190 per token)
        _buy(1900e6);
        assertEq(nvda.balanceOf(address(desk)), 60e18);
    }

    /// @notice The guard lifts at the reopen (first live post-split print), and a later hold is valued as
    ///         usual: its basis (lastLiveAt) is after the change.
    function test_M2_reopenLifts_andNextHoldIsValued() public {
        _buy(9500e6);
        _stageSplit(10e18);
        _closedSessionUntil(SAT + 1 hours);
        vm.expectRevert(_changedErr(uint64(FRI_CLOSE), SAT));
        desk.valueUsd();
        uint256 mon = SAT + 2 days;
        vm.warp(mon);
        oracle.set(NVDA_ID, NVDA_PX / 10, uint64(mon), false); // Monday open, new basis
        assertEq(registry.valueUsd(address(nvda), 50e18), 9500e6);
        vm.warp(mon + 5 days);
        oracle.set(NVDA_ID, NVDA_PX / 10, uint64(block.timestamp), true); // next weekend, held
        assertEq(oracle.lastLiveAt(NVDA_ID), mon);
        assertEq(registry.valueUsd(address(nvda), 50e18), 9500e6);
    }

    /// @notice Review I-2: after the pre-approved split took effect, the issuer stages a further update with a
    ///         future effectiveAt, so the token no longer reports when the split took effect. The active
    ///         multiplier is still the split (only in the pre-approved anchor's band): the time of the change is
    ///         unknown, so the guard must stay on (audited fix: the guard fell back to the old registry stamp and
    ///         the PoC returned). It stays on through the governance re-anchor (stamped) until a live print.
    function test_M2_stagedFollowUpChange_doesNotHideTheSplit() public {
        _buy(9500e6);
        _stageSplit(10e18);
        _closedSessionUntil(SAT + 1 hours);
        st.updateMultiplier(10.01e18, SAT + 3 days); // a later update staged before the reopen
        assertEq(registry.multiplierOf(address(nvda)), 10e18); // the split is the active multiplier
        vm.expectRevert(_changedErr(uint64(FRI_CLOSE), block.timestamp));
        registry.valueUsd(address(nvda), 50e18);
        router.setPrice(address(nvda), 1900e18);
        vm.prank(key);
        vm.expectRevert(_changedErr(uint64(FRI_CLOSE), block.timestamp));
        desk.execute(_hedgeAction(address(nvda), true, SPEND, 0));
        // governance re-anchors the split (beyond the band of the old anchor: stamped as a change)
        vm.warp(block.timestamp + 1 hours);
        vm.prank(timelock);
        registry.setMultiplier(address(nvda), 10e18);
        assertEq(registry.multiplierSetAt(address(nvda)), block.timestamp);
        oracle.set(NVDA_ID, NVDA_PX, uint64(block.timestamp), true); // still Friday's held price
        vm.expectRevert(_changedErr(uint64(FRI_CLOSE), block.timestamp));
        registry.valueUsd(address(nvda), 50e18);
        // the reopen: a live post-split print values it again
        vm.warp(block.timestamp + 1);
        oracle.set(NVDA_ID, NVDA_PX / 10, uint64(block.timestamp), false);
        assertEq(registry.valueUsd(address(nvda), 50e18), 9500e6);
    }

    /// @notice Review M-1: a no-op `setMultiplierSource` re-call and an in-band live re-anchor are not changes
    ///         (a weekend governance no-op must not pause valuation); an out-of-band live re-anchor is.
    function test_M2_registryStamps_onlyRealChanges() public {
        uint64 before = registry.multiplierSetAt(address(nvda)); // setUp's switch to live mode
        vm.warp(block.timestamp + 1 hours);
        vm.startPrank(timelock);
        registry.setMultiplierSource(address(nvda), true); // no-op
        assertEq(registry.multiplierSetAt(address(nvda)), before);
        registry.setMultiplier(address(nvda), 1.02e18); // in-band re-anchor
        assertEq(registry.multiplierSetAt(address(nvda)), before);
        registry.setNextMultiplierAnchor(address(nvda), 10e18);
        registry.setMultiplier(address(nvda), 10e18); // out-of-band re-anchor (a split)
        assertEq(registry.multiplierSetAt(address(nvda)), block.timestamp);
        vm.stopPrank();
    }

    /// @notice A held price with no multiplier change in the hold is still a valid valuation price.
    function test_M2_heldPrice_noChange_stillValued() public {
        _buy(9500e6);
        _closedSessionUntil(SAT + 1 hours);
        assertEq(registry.valueUsd(address(nvda), 50e18), 9500e6);
        assertEq(desk.hedgeNotionalUsd(), 9500e6);
    }

    /// @notice A staged change not yet effective changes nothing (the active multiplier is still the old one).
    function test_M2_stagedButNotEffective_noEffect() public {
        _buy(9500e6);
        _stageSplit(10e18);
        _closedSessionUntil(SAT - 1 hours);
        assertEq(registry.multiplierChangedAt(address(nvda)), T0); // setUp source switch; split not active
        assertEq(registry.valueUsd(address(nvda), 50e18), 9500e6);
    }

    /// @notice Review I-4: the RISK Flatten tolerated a failed valuation with notional 0, so in a split window
    ///         (reverse split: 1/10 reference) it sold with no slippage bound at all. It now defers until the
    ///         oracle reprices (LP exits never depend on a flatten), then runs bounded at the repriced value.
    function test_M2_riskFlatten_deferredInTheWindow_boundedAfterReprice() public {
        _buy(9500e6);
        adapter.setExposure(0);
        _stageSplit(0.1e18);
        _closedSessionUntil(SAT + 1 hours);
        router.setPrice(address(nvda), 19e18); // a pool bidding 1/10 of the token's value
        vm.prank(risk);
        vm.expectRevert(_changedErr(uint64(FRI_CLOSE), SAT));
        desk.execute(_flattenAction(address(nvda), 50e18, 0));
        assertEq(nvda.balanceOf(address(desk)), 50e18);
        // repriced (reverse split: per share x10): the 1/10 bid is now refused by the RISK slippage bound
        vm.warp(SAT + 2 days);
        oracle.set(NVDA_ID, NVDA_PX * 10, uint64(block.timestamp), false);
        assertEq(registry.valueUsd(address(nvda), 50e18), 9500e6);
        vm.prank(risk);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.SlippageTooHigh.selector, 9500e6, 950e6));
        desk.execute(_flattenAction(address(nvda), 50e18, 0));
        router.setPrice(address(nvda), 190e18); // fair pool
        _exec(risk, _flattenAction(address(nvda), 50e18, 0));
        assertEq(nvda.balanceOf(address(desk)), 0);
    }

    /// @notice Fix round 2, N-I2: the reopen with no post-split Chainlink round yet. The oracle drops the
    ///         pre-split round, nothing is signed in session, the stored (pre-split) price goes stale: the RISK
    ///         flatten used to tolerate the stale valuation (notional 0) and sell at 1/10 unbounded. Deferred.
    function test_M2_riskFlatten_deferredWhenStaleInTheWindow() public {
        _buy(9500e6);
        adapter.setExposure(0);
        _stageSplit(0.1e18);
        _closedSessionUntil(SAT + 1 hours);
        vm.warp(SAT + 2 days); // Monday open: no new round, the stored held price is far past maxPriceAge
        router.setPrice(address(nvda), 19e18); // a pool bidding 1/10 of the token's value
        vm.prank(risk);
        vm.expectRevert(_changedErr(uint64(FRI_CLOSE), SAT));
        desk.execute(_flattenAction(address(nvda), 50e18, 0));
        assertEq(nvda.balanceOf(address(desk)), 50e18);
    }

    /// @notice Fix round 2, N-I1: the on-chain multiplier in force at a price basis (off-chain valuations use it
    ///         in the split window instead of 0).
    function test_M2_basisMultiplier_onChainSource() public {
        _stageSplit(10e18);
        _closedSessionUntil(SAT + 1 hours);
        uint64 fri = uint64(FRI_CLOSE);
        assertEq(registry.basisMultiplier(address(nvda), uint64(block.timestamp)), 10e18); // no change since
        assertEq(registry.basisMultiplier(address(nvda), fri), 1e18); // token-side split: the pre-split anchor
        st.updateMultiplier(10.01e18, SAT + 3 days); // I-2 state: change time hidden
        assertEq(registry.basisMultiplier(address(nvda), fri), 1e18);
        vm.prank(timelock);
        registry.setMultiplier(address(nvda), 10e18); // stamped split re-anchor: records the anchor before it
        assertEq(registry.basisMultiplier(address(nvda), fri), 1e18);
        // stored mode: the value before the first registry change after the basis, however many followed (Task 7
        // full history; the round-2 registry returned 0 here)
        vm.warp(block.timestamp + 10);
        vm.prank(timelock);
        registry.setMultiplierSource(address(nvda), false); // a second registry change after the basis
        assertEq(registry.basisMultiplier(address(nvda), fri), 1e18);
        assertEq(registry.basisMultiplier(address(nvda), uint64(block.timestamp - 5)), 10e18);
    }

    /// @notice A stale price (no split) still never blocks the RISK Flatten (unchanged emergency behaviour).
    function test_M2_riskFlatten_stalePriceStillTolerated() public {
        _buy(9500e6);
        adapter.setExposure(0);
        vm.warp(block.timestamp + 1 days); // the stored price is far past maxPriceAge
        _exec(risk, _flattenAction(address(nvda), 50e18, 0));
        assertEq(nvda.balanceOf(address(desk)), 0);
    }

    /// @notice Stored-multiplier mode (devnet / testnet): governance mirroring a split during a hold is the
    ///         same change; the re-stamped held price is refused until the first live print after it.
    function test_M2_storedMode_setMultiplierDuringHold_refused() public {
        _buy(9500e6);
        vm.prank(timelock);
        registry.setMultiplierSource(address(nvda), false); // stored 1e18
        _closedSessionUntil(SAT);
        vm.prank(timelock);
        registry.setMultiplier(address(nvda), 10e18);
        assertEq(registry.multiplierChangedAt(address(nvda)), SAT);
        vm.warp(SAT + 1 hours);
        oracle.set(NVDA_ID, NVDA_PX, uint64(block.timestamp), true); // re-stamped held
        vm.expectRevert(_changedErr(uint64(FRI_CLOSE), SAT));
        registry.valueUsd(address(nvda), 50e18);
        oracle.set(NVDA_ID, NVDA_PX / 10, uint64(block.timestamp + 1), false);
        vm.warp(block.timestamp + 1);
        assertEq(registry.valueUsd(address(nvda), 50e18), 9500e6);
    }

    /// @notice A live-mode re-anchor (governance `setMultiplier`) does not change the effective multiplier,
    ///         so it does not trip the guard; switching the source does.
    function test_M2_liveMode_reanchorIsNotAChange_sourceSwitchIs() public {
        _buy(9500e6);
        _closedSessionUntil(SAT + 1 hours);
        vm.startPrank(timelock);
        registry.setMultiplier(address(nvda), 1e18); // live mode: anchor only
        assertEq(registry.multiplierChangedAt(address(nvda)), T0); // still the setUp source switch
        assertEq(registry.valueUsd(address(nvda), 50e18), 9500e6);
        registry.setMultiplierSource(address(nvda), false);
        vm.stopPrank();
        assertEq(registry.multiplierChangedAt(address(nvda)), SAT + 1 hours);
        vm.expectRevert(_changedErr(uint64(FRI_CLOSE), SAT + 1 hours));
        registry.valueUsd(address(nvda), 50e18);
    }
}

/// @notice M-2 end to end on the real AttestedOracle: signed held prices re-stamped after the split never
///         move `lastLiveAt`, so the registry refuses them; the first signed live post-split price restores it.
contract M2SplitRealOracleTest is MandateBase {
    uint256 internal constant SIGNER_PK = 0xA11CE;
    AttestedOracle internal real;
    MockStockToken internal st;

    function setUp() public override {
        super.setUp();
        real = new AttestedOracle(address(cfg), vm.addr(SIGNER_PK), bytes32(0));
        cfg.setOracle(address(real));
        vm.etch(address(nvda), address(new MockStockToken("x", "x", 1e18)).code);
        st = MockStockToken(address(nvda));
        st.updateMultiplier(1e18, 0);
        vm.startPrank(timelock);
        registry.setMultiplierSource(address(nvda), true);
        registry.setNextMultiplierAnchor(address(nvda), 10e18);
        vm.stopPrank();
    }

    function _signed(uint256 price, uint64 at, bool held) internal view returns (bytes memory) {
        IAttestedOracle.PriceUpdate[] memory us = new IAttestedOracle.PriceUpdate[](1);
        bytes[] memory sigs = new bytes[](1);
        us[0] = IAttestedOracle.PriceUpdate({
            underlying: NVDA_ID,
            priceWad: price,
            publishedAt: at,
            held: held,
            sourceCount: 3,
            sourcesHash: keccak256(abi.encode(price, at))
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, real.hashPrice(us[0]));
        sigs[0] = abi.encodePacked(r, s, v);
        return abi.encode(us, sigs);
    }

    function test_M2_realOracle_reStampedHeldPriceRefused_liveRepriceRestores() public {
        uint256 fri = T0 + 1 days;
        uint256 sat = fri + 1 days;
        st.updateMultiplier(10e18, sat);
        vm.warp(fri);
        real.update(_signed(NVDA_PX, uint64(fri), false));
        vm.warp(fri + 60);
        real.update(_signed(NVDA_PX, uint64(fri + 60), true));
        assertEq(real.lastLiveAt(NVDA_ID), fri);
        vm.warp(sat + 1 hours);
        real.update(_signed(NVDA_PX, uint64(block.timestamp), true)); // the oracle's weekend re-stamp
        assertEq(real.latest(NVDA_ID).publishedAt, sat + 1 hours);
        assertEq(real.lastLiveAt(NVDA_ID), fri);
        vm.expectRevert(
            abi.encodeWithSelector(
                StockTokenRegistry.MultiplierChangedSincePrice.selector, address(nvda), uint64(fri), sat
            )
        );
        registry.valueUsd(address(nvda), 10e18);
        vm.warp(sat + 2 days);
        real.update(_signed(NVDA_PX / 10, uint64(block.timestamp), false)); // Monday open
        assertEq(real.lastLiveAt(NVDA_ID), sat + 2 days);
        assertEq(registry.valueUsd(address(nvda), 10e18), 1900e6);
    }
}
