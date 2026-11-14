// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {EngineBase} from "../../engine/utils/EngineBase.sol";
import {PoolEngine} from "../../../src/PoolEngine.sol";
import {AttestedOracle} from "../../../src/AttestedOracle.sol";
import {PoolEngineUnit} from "../../../src/libraries/PoolEngineUnit.sol";
import {StockTokenRegistry} from "../../../src/StockTokenRegistry.sol";
import {IPoolEngine} from "../../../src/interfaces/IPoolEngine.sol";
import {IStockTokenRegistry} from "../../../src/interfaces/IStockTokenRegistry.sol";
import {MockStockToken} from "../../../src/mocks/MockStockToken.sol";

/// @title Audit remediation N-1 (new finding from the M-2 review): PoolEngine per-share positions across a split.
/// @notice Engine positions were sized in shares and never rebased, while a split's `effectiveAt` is public days ahead:
///         a short opened before a 10:1 split booked ~90% of its notional from the pool at the reopen (a long before a
///         reverse split the same). Fix (complete): positions are in market units fixed for the market's life and the
///         engine prices them at the oracle's per-share price x the shares per unit at the price's share basis
///         (PoolEngineUnit), from split ratios StockTokenRegistry records (stored mode: `setMultiplier` beyond the band;
///         live mode: `recordSplit` while staged; governance `recordSplitAt` as the fallback). A split moves no value,
///         so the close-only / window gates are gone. Each test compares the split run with a control run in which the
///         same underlying value is quoted without the split (same block times, same trades): trader equity, pool
///         equity and every engine decision must match.
contract N1EngineSplitTest is EngineBase {
    uint128 internal constant MAX_NET = 1_000_000e6;
    uint256 internal constant POOL = 500_000e6;
    uint256 internal constant IF = 100_000e6;
    uint256 internal constant SAT = T0 + 2 days;
    bytes32 internal constant PID_T = bytes32("TSLA");

    StockTokenRegistry internal registry;
    MockStockToken internal nvda;
    MockStockToken internal tsla;
    address internal ad = makeAddr("adapter");
    address internal adIdx = makeAddr("adapterIdx");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");
    uint256 internal mid; // NVDA market (PID_B)

    function setUp() public {
        _deployCore();
        registry = new StockTokenRegistry(address(cfg), address(0));
        cfg.setStockRegistry(address(registry));
        nvda = new MockStockToken("NVIDIA Stock Token", "NVDA", 1e18);
        nvda.updateMultiplier(1e18, 0);
        tsla = new MockStockToken("Tesla Stock Token", "TSLA", 1e18);
        tsla.updateMultiplier(1e18, 0);
        vm.startPrank(timelock);
        registry.register(address(nvda), PID_B, 1e18, 0);
        registry.register(address(tsla), PID_T, 1e18, 0);
        registry.setMultiplierSource(address(nvda), true);
        registry.setMultiplierSource(address(tsla), true);
        vm.stopPrank();
        mid = _createMarket(ad, _defaultCfg(PID_B, MAX_NET));
        _fundPool(ad, mid, POOL, IF);
        _setQuote(ad, mid, 10, 0, MAX_NET);
        vm.warp(block.timestamp + 1);
        _price(PID_B, PX);
        _deposit(alice, mid, 5_000e6);
        _deposit(bob, mid, 5_000e6);
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Issuer stages `m` for SAT on the token; anyone records it (the keeper's job).
    function _stage(MockStockToken tok, uint256 m) internal {
        tok.updateMultiplier(m, SAT);
        vm.prank(keeper);
        registry.recordSplit(address(tok));
    }

    /// @dev Per-share price for an unchanged underlying value: `px` per pre-split share, `ratio` shares per old share.
    function _post(uint256 px, uint256 ratioWad) internal pure returns (uint256) {
        return px * 1e18 / ratioWad;
    }

    // ---------------------------------------------------------------- the PoC

    /// @notice Control: without the registry (no split factor) the exploit is still there. A 100-unit short opened at
    ///         $100 before a 10:1 split books ~$9,000 (90% of its $10,000 notional) at the reopen print.
    function test_N1_exploit_withoutRegistry_shortTakes90Percent() public {
        nvda.updateMultiplier(10e18, SAT);
        cfg.setStockRegistry(address(0)); // a market created now has no registry for its life
        address ad2 = makeAddr("adapter2");
        uint256 m2 = _createMarket(ad2, _defaultCfg(PID_B, MAX_NET));
        _fundPool(ad2, m2, POOL, IF);
        _setQuote(ad2, m2, 10, 0, MAX_NET);
        _deposit(alice, m2, 5_000e6);
        _trade(alice, m2, -100e18);
        vm.warp(SAT + 2 days);
        _price(PID_B, PX / 10);
        assertGt(engine.traderEquityUsd(m2, alice), int256(5_000e6 + 8_900e6));
    }

    /// @notice Review L-3: the registry is bound to a market at creation; a config swap never changes its units.
    function test_N1_registrySwap_doesNotChangeAMarketsUnits() public {
        _stage(nvda, 10e18);
        vm.warp(SAT + 1 days);
        _price(PID_B, PX / 10);
        assertEq(engine.unitOf(mid), 10e18);
        cfg.setStockRegistry(address(new StockTokenRegistry(address(cfg), address(0))));
        assertEq(engine.unitOf(mid), 10e18);
        cfg.setStockRegistry(address(0));
        assertEq(engine.unitOf(mid), 10e18);
    }

    /// @dev Equities at the reopen after `sizeDelta` was opened before a split of `ratio` (or the control).
    function _reopen(int256 sizeDelta, uint256 ratio, bool split) internal returns (int256 trader, int256 pool) {
        if (split) _stage(nvda, ratio);
        _trade(alice, mid, sizeDelta);
        vm.warp(SAT + 2 days);
        _price(PID_B, split ? _post(PX, ratio) : PX);
        trader = engine.traderEquityUsd(mid, alice);
        pool = engine.poolEquityUsd(mid);
    }

    /// @notice Fixed: the short opened before a 10:1 split gains nothing (equal to the control to the micro-dollar),
    ///         and the pool loses nothing; the trader can close at the reopen for exactly the control's proceeds.
    function test_N1_poc_shortBeforeSplit_gainsNothing() public {
        uint256 snap = vm.snapshotState();
        (int256 tC, int256 pC) = _reopen(-100e18, 10e18, false);
        _trade(alice, mid, 100e18);
        uint256 marginC = engine.positionOf(mid, alice).marginUsd;
        vm.revertToState(snap);
        (int256 tS, int256 pS) = _reopen(-100e18, 10e18, true);
        assertEq(tS, tC);
        assertEq(pS, pC);
        assertEq(engine.unitOf(mid), 10e18);
        _trade(alice, mid, 100e18); // closes the 100 units (1,000 shares now)
        assertEq(engine.positionOf(mid, alice).marginUsd, marginC);
        assertEq(engine.positionOf(mid, alice).size, 0);
    }

    /// @notice And a long opened before a 1:10 reverse split gains nothing either.
    function test_N1_poc_longBeforeReverseSplit_gainsNothing() public {
        uint256 snap = vm.snapshotState();
        (int256 tC, int256 pC) = _reopen(100e18, 0.1e18, false);
        vm.revertToState(snap);
        (int256 tS, int256 pS) = _reopen(100e18, 0.1e18, true);
        assertEq(tS, tC);
        assertEq(pS, pC);
        assertEq(engine.unitOf(mid), 0.1e18);
    }

    /// @notice No gate is left: opening, increasing and withdrawing margin while a split is staged, and trading at
    ///         the last pre-split print right after effectiveAt (its basis predates the split: priced at unit 1), all
    ///         fill at the same value as without the split.
    function test_N1_noGate_tradesWhileStagedAndAtEffectiveAt() public {
        _stage(nvda, 10e18);
        _trade(alice, mid, -50e18); // was SplitPending
        vm.prank(alice);
        engine.withdrawMargin(mid, 1e6); // was SplitPending
        vm.warp(SAT - 3);
        _price(PID_B, PX);
        vm.warp(SAT + 5); // 8 s old, fresh for trades, pre-split basis
        assertEq(engine.unitOf(mid), 1e18);
        (uint256 fill,) = _trade(alice, mid, 50e18); // was SplitWindow
        assertGt(fill, PX);
        _price(PID_B, PX / 10); // first post-split print
        assertEq(engine.unitOf(mid), 10e18);
        (fill,) = _trade(bob, mid, -1e18); // a unit (10 shares) sells at the unit price
        assertApproxEqRel(fill, PX, 0.001e18);
    }

    /// @notice The engine's split state sits in its ERC-7201 namespace (and is written there through the library).
    function test_N1_unitStorage_erc7201() public pure {
        bytes32 expected =
            keccak256(abi.encode(uint256(keccak256("bookrunner.storage.PoolEngineUnit")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(PoolEngineUnit.STORAGE_LOCATION, expected);
    }

    /// @notice An in-band change (a dividend reinvestment) is not a split: no record, unit unchanged.
    function test_N1_inBandChange_isNotASplit() public {
        nvda.updateMultiplier(1.01e18, SAT);
        assertFalse(registry.splitSyncNeeded(address(nvda)));
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NothingToRecord.selector, address(nvda)));
        registry.recordSplit(address(nvda));
        vm.warp(SAT + 1);
        _price(PID_B, PX);
        assertEq(engine.unitOf(mid), 1e18);
        _trade(alice, mid, -10e18);
    }

    // ---------------------------------------------------------------- recording

    /// @notice Governance pre-approval records the staged split too; stored mode records at `setMultiplier`; a live
    ///         re-anchor beyond the band needs the split recorded.
    function test_N1_recording_paths() public {
        nvda.updateMultiplier(10e18, SAT);
        assertTrue(registry.splitSyncNeeded(address(nvda)));
        vm.prank(timelock);
        registry.setNextMultiplierAnchor(address(nvda), 10e18);
        assertFalse(registry.splitSyncNeeded(address(nvda)));
        assertEq(registry.shareFactor(PID_B, uint64(SAT)), 1e18); // review L-1: a staged record counts once active
        vm.warp(SAT + 10);
        assertEq(registry.shareFactor(PID_B, uint64(SAT + 5)), 10e18);
        assertEq(registry.shareFactor(PID_B, uint64(SAT - 1)), 1e18);
        // stored mode: the change beyond the band is the split, at the change block
        vm.prank(timelock);
        registry.setMultiplierSource(address(tsla), false);
        vm.prank(timelock);
        registry.setMultiplier(address(tsla), 3e18);
        uint256 x = block.timestamp;
        vm.warp(x + 10);
        assertEq(registry.shareFactor(PID_T, uint64(x + 5)), 3e18);
        assertEq(registry.shareFactor(PID_T, uint64(x - 1)), 1e18);
        // live re-anchor of an unrecorded split reverts
        MockStockToken amd = new MockStockToken("AMD", "AMD", 1e18);
        amd.updateMultiplier(1e18, 0);
        vm.startPrank(timelock);
        registry.register(address(amd), bytes32("AMD"), 1e18, 0);
        registry.setMultiplierSource(address(amd), true);
        vm.stopPrank();
        amd.updateMultiplier(2e18);
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.SplitNotRecorded.selector, address(amd)));
        registry.setMultiplier(address(amd), 2e18);
    }

    /// @notice One live token per price id, alone (review L-3: a stored token next to it would record the same split a
    ///         second time): no token is registered next to a live one, and a token with peers cannot go live.
    function test_N1_oneLiveTokenPerPriceId() public {
        MockStockToken nvda2 = new MockStockToken("NVDA bis", "NVDA2", 1e18);
        nvda2.updateMultiplier(1e18, 0);
        vm.startPrank(timelock);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.LiveTokenExists.selector, PID_B, address(nvda)));
        registry.register(address(nvda2), PID_B, 1e18, 0);
        bytes32 pidX = bytes32("AMD");
        MockStockToken a1 = new MockStockToken("A1", "A1", 1e18);
        MockStockToken a2 = new MockStockToken("A2", "A2", 1e18);
        registry.register(address(a1), pidX, 1e18, 0);
        registry.register(address(a2), pidX, 1e18, 0); // two stored tokens: allowed, only the first records splits
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.LiveTokenExists.selector, pidX, address(a2)));
        registry.setMultiplierSource(address(a1), true);
        registry.setMultiplier(address(a2), 3e18); // the second token's change records nothing
        registry.setMultiplier(address(a1), 3e18); // the first's records the split once
        vm.stopPrank();
        vm.warp(block.timestamp + 10);
        assertEq(registry.shareFactor(pidX, uint64(block.timestamp)), 3e18);
    }

    /// @notice The issuer re-stages after the last sync: the stale record is never used (fail closed from its time),
    ///         and the keeper's next `recordSplit` drops it and records the new staging.
    function test_N1_restagedAfterRecord_selfHeals() public {
        _stage(nvda, 10e18);
        nvda.updateMultiplier(5e18, SAT + 1 days); // re-staged, not synced
        vm.warp(SAT + 10);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.SplitUnrecorded.selector, address(nvda), SAT + 1));
        registry.shareFactor(PID_B, uint64(SAT + 5));
        assertEq(registry.shareFactor(PID_B, uint64(SAT - 1)), 1e18); // pre-split prices still value
        assertTrue(registry.splitSyncNeeded(address(nvda)));
        registry.recordSplit(address(nvda)); // drops the stale record (the token matches the records without it)
        assertEq(registry.shareFactor(PID_B, uint64(SAT + 5)), 1e18);
        vm.warp(SAT + 1 days + 10);
        assertEq(registry.shareFactor(PID_B, uint64(SAT + 1 days + 5)), 5e18);
    }

    // ---------------------------------------------------------------- unrecorded: fail closed, governance fallback

    /// @notice Nobody recorded the staged split: from the last consistent point on (the market's creation here),
    ///         every price-dependent action reverts SplitUnrecorded, liquidations at the held pre-split price included
    ///         (review M-1: that path was a free option for an underwater trader, who could push a post-split print to
    ///         end it). The keeper's recordSplit latches it; the guardian records it at once (bounded on chain) and the
    ///         market resumes at exactly the control's values.
    function test_N1_unrecorded_failsClosed_untilGuardianRecords() public {
        uint256 snap = vm.snapshotState();
        _trade(alice, mid, -100e18);
        vm.warp(SAT + 2 days);
        _price(PID_B, PX);
        int256 control = engine.traderEquityUsd(mid, alice);
        vm.revertToState(snap);

        nvda.updateMultiplier(10e18, SAT); // staged, never recorded
        _trade(alice, mid, -100e18);
        vm.warp(SAT - 10);
        _push(PID_B, PX, true);
        vm.warp(SAT + 1 hours);
        _push(PID_B, PX, true);
        (uint256 f, bool latched) = registry.splitUnrecorded(address(nvda));
        assertFalse(latched);
        assertGt(f, 0);
        vm.expectRevert();
        engine.isLiquidatable(mid, alice);
        vm.prank(keeper);
        registry.recordSplit(address(nvda)); // latches, records nothing
        (f, latched) = registry.splitUnrecorded(address(nvda));
        assertTrue(latched);
        vm.warp(SAT + 2 days);
        _price(PID_B, PX / 10); // the reopen
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.SplitUnrecorded.selector, address(nvda), f));
        engine.trade(mid, 100e18, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.SplitUnrecorded.selector, address(nvda), f));
        engine.liquidate(mid, alice);
        _deposit(alice, mid, 1e6); // top-ups never need a price
        // not the guardian; then a wrong ratio (the time is the latched effectiveAt, never the guardian's)
        uint256[] memory rs = new uint256[](1);
        rs[0] = 2e18;
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.Unauthorized.selector, address(this)));
        registry.guardianRecordSplits(address(nvda), rs);
        address guardian = makeAddr("guardian");
        cfg.grantRole(cfg.GUARDIAN_ROLE(), guardian);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.SplitRatioMismatch.selector, 2e18, 10e18));
        registry.guardianRecordSplits(address(nvda), rs);
        rs[0] = 10e18;
        vm.prank(guardian);
        registry.guardianRecordSplits(address(nvda), rs);
        (f, latched) = registry.splitUnrecorded(address(nvda));
        assertEq(f, 0);
        assertFalse(latched);
        assertEq(engine.traderEquityUsd(mid, alice), control + 1e6);
        _trade(alice, mid, 100e18);
        assertEq(engine.positionOf(mid, alice).size, 0);
    }

    /// @notice Governance fallback (timelock): records the change at its own time, the same values result.
    function test_N1_unrecorded_governanceRecords() public {
        _trade(alice, mid, -100e18);
        nvda.updateMultiplier(10e18, SAT);
        vm.warp(SAT + 2 days);
        _price(PID_B, PX / 10);
        vm.expectRevert();
        engine.traderEquityUsd(mid, alice);
        vm.prank(timelock);
        registry.recordSplitAt(address(nvda), uint64(SAT), 10e18);
        assertEq(engine.unitOf(mid), 10e18);
        _trade(alice, mid, 100e18);
    }

    // ---------------------------------------------------------------- liquidation around the split

    /// @notice A long near its maintenance requirement: at every price around the liquidation boundary, held before
    ///         effectiveAt (pre-split basis) and at the reopen (post-split basis), isLiquidatable and the liquidation's
    ///         reward / bad debt equal the control's.
    function test_N1_liquidation_exactlyAroundTheSplit() public {
        // near-10x long: ~1,020 of margin on 10,005 of notional (liquidatable below ~94.58)
        address carol = makeAddr("carol");
        _deposit(carol, mid, 1_030e6);
        _trade(carol, mid, 100e18);
        uint256[4] memory moves = [uint256(9_400), 9_440, 9_460, 9_500];
        for (uint256 i; i < moves.length; ++i) {
            uint256 snap = vm.snapshotState();
            uint256 px = PX * moves[i] / 10_000;
            vm.warp(SAT + 2 days);
            _price(PID_B, px);
            bool liqC = engine.isLiquidatable(mid, carol);
            int256 eqC = engine.traderEquityUsd(mid, carol);
            uint256 rewardC;
            if (liqC) rewardC = engine.liquidate(mid, carol);
            int256 poolC = engine.poolEquityUsd(mid);
            vm.revertToState(snap);

            _stage(nvda, 10e18);
            vm.warp(SAT + 2 days);
            _price(PID_B, px / 10);
            assertEq(engine.isLiquidatable(mid, carol), liqC);
            assertEq(engine.traderEquityUsd(mid, carol), eqC);
            if (liqC) assertEq(engine.liquidate(mid, carol), rewardC);
            assertEq(engine.poolEquityUsd(mid), poolC);
            vm.revertToState(snap);
        }
    }

    /// @notice Off-hours across effectiveAt: the held pre-split price still liquidates at the off-hours requirement
    ///         (basis before the split, unit 1) after effectiveAt has passed.
    function test_N1_liquidation_heldPreSplitPrice_afterEffectiveAt() public {
        address carol = makeAddr("carol");
        _deposit(carol, mid, 1_500e6);
        _trade(carol, mid, 100e18);
        _stage(nvda, 10e18);
        vm.warp(SAT - 60);
        _push(PID_B, PX * 95 / 100, true);
        vm.warp(SAT + 1 hours);
        _push(PID_B, PX * 95 / 100, true); // held: basis = the last live print, before the split
        assertEq(engine.unitOf(mid), 1e18);
        assertTrue(engine.isLiquidatable(mid, carol)); // below 2x initial margin while held
        engine.liquidate(mid, carol);
        assertEq(engine.positionOf(mid, carol).size, 0);
    }

    /// @notice A held price on an oracle that never stored a live one (lastLiveAt 0: a cutover over a split weekend)
    ///         has no known share basis: refused once a split was recorded, until the first live print.
    function test_N1_heldPriceWithoutLiveBasis_refusedAfterASplit() public {
        _trade(alice, mid, -10e18);
        _stage(nvda, 10e18);
        vm.warp(SAT + 1 days);
        _price(PID_B, PX / 10);
        assertEq(engine.unitOf(mid), 10e18);
        AttestedOracle o2 = new AttestedOracle(address(cfg), signer, bytes32("devnet-attestation"));
        cfg.setOracle(address(o2));
        oracle = o2;
        vm.warp(block.timestamp + 1);
        _push(PID_B, PX / 10, true);
        vm.expectRevert(abi.encodeWithSelector(IPoolEngine.PriceBeforeSplit.selector, uint64(0), uint64(block.timestamp)));
        engine.unitOf(mid);
        _price(PID_B, PX / 10); // the first live print on the new oracle
        assertEq(engine.unitOf(mid), 10e18);
    }

    // ---------------------------------------------------------------- funding, loss budget

    /// @notice Funding accrued across the split (accruals before, across and after effectiveAt) equals the control's
    ///         to the wei, and so does the loss budget's view of the pool.
    function test_N1_funding_andLossBudget_acrossTheSplit() public {
        uint256 snap = vm.snapshotState();
        int256[3] memory c = _fundingRun(false);
        vm.revertToState(snap);
        int256[3] memory s = _fundingRun(true);
        assertEq(s[0], c[0]); // funding index
        assertEq(s[1], c[1]); // trader equity
        assertEq(s[2], c[2]); // loss-budget loss
    }

    function _fundingRun(bool split) internal returns (int256[3] memory out) {
        if (split) _stage(nvda, 10e18);
        _trade(alice, mid, -200e18);
        _trade(bob, mid, 50e18);
        vm.warp(SAT - 1 hours);
        _price(PID_B, PX);
        _trade(bob, mid, 10e18); // accrual before
        vm.warp(SAT + 3 hours);
        _price(PID_B, split ? PX / 10 : PX);
        _trade(bob, mid, 10e18); // accrual across effectiveAt
        vm.warp(SAT + 1 days);
        _price(PID_B, split ? PX / 10 : PX);
        (,,, int256 loss,,) = engine.lossBudget(mid);
        out = [engine.state(mid).fundingIndex, engine.traderEquityUsd(mid, alice), loss];
    }

    // ---------------------------------------------------------------- several splits, untouched positions

    /// @notice 10:1, then 1:5, then 3:2, then 1:3 (a ratio WAD cannot hold exactly): at each reopen every equity
    ///         matches the control (the last within the documented dust: under one micro-dollar here).
    function test_N1_severalSplitsInARow_untouchedPositions() public {
        uint256[4] memory ratios = [uint256(10e18), 0.2e18, 1.5e18, uint256(1e18) / 3];
        uint256 snap = vm.snapshotState();
        int256[4] memory ctl;
        _trade(alice, mid, -100e18);
        _trade(bob, mid, 40e18);
        for (uint256 i; i < 4; ++i) {
            vm.warp(SAT + (i + 1) * 30 days);
            _price(PID_B, PX);
            ctl[i] = engine.traderEquityUsd(mid, alice);
        }
        int256 poolC = engine.poolEquityUsd(mid);
        vm.revertToState(snap);

        _trade(alice, mid, -100e18);
        _trade(bob, mid, 40e18);
        uint256 cum = 1e18;
        for (uint256 i; i < 4; ++i) {
            uint256 at = SAT + (i + 1) * 30 days - 1 days;
            nvda.updateMultiplier(nvda.uiMultiplier() * ratios[i] / 1e18, at);
            registry.recordSplit(address(nvda));
            cum = cum * ratios[i] / 1e18;
            vm.warp(SAT + (i + 1) * 30 days);
            _price(PID_B, PX * 1e18 / cum);
            // exact while the per-share price is exact (10:1, 1:5); 1/3-share prices round by a wei
            if (i < 2) assertEq(engine.traderEquityUsd(mid, alice), ctl[i]);
            else assertApproxEqAbs(engine.traderEquityUsd(mid, alice), ctl[i], 1);
        }
        assertApproxEqAbs(engine.poolEquityUsd(mid), poolC, 1);
        // alice was never touched since her open: she closes her 100 units in one trade
        _trade(alice, mid, 100e18);
        assertEq(engine.positionOf(mid, alice).size, 0);
    }

    // ---------------------------------------------------------------- index markets

    function _indexMarket() internal returns (uint256 idx) {
        IStockTokenRegistry.IndexComponent[] memory cs = new IStockTokenRegistry.IndexComponent[](2);
        cs[0] = IStockTokenRegistry.IndexComponent({token: address(nvda), weightBps: 6000});
        cs[1] = IStockTokenRegistry.IndexComponent({token: address(tsla), weightBps: 4000});
        vm.prank(timelock);
        registry.registerIndex(keccak256("BKRN.INDEX.RHX5"), PID_A, cs);
        idx = _createMarket(adIdx, _defaultCfg(PID_A, MAX_NET));
        _fundPool(adIdx, idx, POOL, IF);
        _setQuote(adIdx, idx, 10, 0, MAX_NET);
        _deposit(alice, idx, 5_000e6);
        _deposit(bob, idx, 5_000e6);
    }

    /// @dev One signed round: the index level (0.6 x NVDA + 0.4 x TSLA) and both components, same publishedAt.
    function _round(uint256 nv, uint256 ts, bool held) internal {
        uint64 last = oracle.latest(PID_A).publishedAt;
        if (oracle.latest(PID_B).publishedAt > last) last = oracle.latest(PID_B).publishedAt;
        if (oracle.latest(PID_T).publishedAt > last) last = oracle.latest(PID_T).publishedAt;
        if (last >= block.timestamp) vm.warp(uint256(last) + 1);
        uint64 at = uint64(block.timestamp);
        _pushAt(PID_B, nv, at, held);
        _pushAt(PID_T, ts, at, held);
        _pushAt(PID_A, (nv * 6000 + ts * 4000) / 10_000, at, held);
    }

    function _pushAt(bytes32 pid, uint256 px, uint64 at, bool held) internal {
        oracle.push(_update(pid, px, at, held, 3), _sign(SIGNER_PK, _update(pid, px, at, held, 3)));
    }

    /// @notice One component (TSLA, 40% weight) splits 3:1. At the reopen's signed round the index level drops (TSLA
    ///         prints at 1/3); the market's unit moves once by R = (L + 0.4 x q_TSLA x 2) / L and every equity equals
    ///         the control's (same underlying values, no split). A round whose component price is not the index
    ///         price's round is refused (IndexSnapshot): the first toucher cannot mix rounds.
    function test_N1_indexMarket_oneComponentSplits() public {
        uint256 idx = _indexMarket();
        uint256 snap = vm.snapshotState();
        _round(100e18, 90e18, false);
        _trade(alice, idx, -20e18);
        _trade(bob, idx, 5e18);
        vm.warp(SAT + 2 days + 2); // the split run's reopen round lands at the same time
        _round(105e18, 87e18, false);
        int256 tC = engine.traderEquityUsd(idx, alice);
        int256 bC = engine.traderEquityUsd(idx, bob);
        int256 pC = engine.poolEquityUsd(idx);
        vm.revertToState(snap);

        _round(100e18, 90e18, false);
        _trade(alice, idx, -20e18);
        _trade(bob, idx, 5e18);
        _stage(tsla, 3e18);
        vm.warp(SAT + 2 days);
        // a toucher mixing rounds: TSLA from an older round than the index price
        _pushAt(PID_T, 29e18, uint64(block.timestamp), false);
        vm.warp(block.timestamp + 1);
        _pushAt(PID_A, (105e18 * 6000 + 29e18 * 4000) / 10_000, uint64(block.timestamp), false);
        _pushAt(PID_B, 105e18, uint64(block.timestamp), false);
        vm.expectRevert(abi.encodeWithSelector(IPoolEngine.IndexSnapshot.selector, PID_A));
        engine.syncUnit(idx, "");
        // the reopen's full round
        _round(105e18, 29e18, false);
        uint256 unitView = engine.unitOf(idx);
        // parity vector (packages/shared engineMath indexUnitWad): ceil(1e18 x 97.8 / 74.6), traders net short
        assertEq(unitView, 1_310_991_957_104_557_641);
        vm.expectEmit(true, false, false, false, address(engine));
        emit IPoolEngine.UnitUpdated(idx, 0, 0);
        engine.syncUnit(idx, "");
        assertEq(engine.unitOf(idx), unitView);
        // value is conserved at the round's prices: the split run is the control at TSLA 87 = 3 x 29
        assertApproxEqAbs(engine.traderEquityUsd(idx, alice), tC, 1);
        assertApproxEqAbs(engine.traderEquityUsd(idx, bob), bC, 1);
        assertApproxEqAbs(engine.poolEquityUsd(idx), pC, 1);
        // later rounds: the unit is fixed, the index tracks the new definition
        _round(110e18, 30e18, false);
        assertEq(engine.unitOf(idx), unitView);
        _trade(alice, idx, 20e18);
        assertEq(engine.positionOf(idx, alice).size, 0);
    }

    /// @notice An index price whose basis predates a split already in the unit is refused (no move backwards).
    function test_N1_indexMarket_priceBeforeAppliedSplit_refused() public {
        uint256 idx = _indexMarket();
        _round(100e18, 90e18, false);
        _trade(alice, idx, -20e18);
        _stage(tsla, 3e18);
        vm.warp(SAT + 10);
        _round(100e18, 30e18, false);
        engine.syncUnit(idx, "");
        uint256 u = engine.unitOf(idx);
        assertGt(u, 1e18);
        vm.expectRevert(abi.encodeWithSelector(IPoolEngine.PriceBeforeSplit.selector, uint64(SAT - 1), uint64(block.timestamp)));
        engine.unitAt(idx, uint64(SAT - 1));
        assertEq(engine.unitAt(idx, uint64(block.timestamp)), u);
    }

    // ---------------------------------------------------------------- review 2026-11-14 regressions (PoCs ported)

    /// @notice Review H-1 (a), PoC `test_poc_unrecordedThenRecorded_masks`: an unrecorded 10:1 split, then the issuer
    ///         stages a 2:1 split and the keeper's recordSplit runs. Before the fix it recorded the 2:1 and the market
    ///         unfroze at factor 2 instead of 20 (a short gained ~$9,000 on $10,000); recordSplitAt(E1) then reverted.
    ///         Now recordSplit latches and records nothing, the market stays frozen across the second split, and
    ///         governance records E1 then E2 at their own times: the trader's equity equals the control's.
    function test_review_H1a_unrecordedThenStagedSplit_staysFrozen_thenRecordedInOrder() public {
        uint256 e2 = SAT + 1 days;
        uint256 snap = vm.snapshotState();
        _trade(alice, mid, -100e18);
        vm.warp(e2 + 1 hours);
        _price(PID_B, PX);
        int256 control = engine.traderEquityUsd(mid, alice);
        vm.revertToState(snap);

        _trade(alice, mid, -100e18);
        nvda.updateMultiplier(10e18, SAT);
        vm.warp(SAT + 1);
        nvda.updateMultiplier(20e18, e2);
        vm.prank(keeper);
        registry.recordSplit(address(nvda)); // latches; the staged 2:1 is NOT recorded
        (, bool latched) = registry.splitUnrecorded(address(nvda));
        assertTrue(latched);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NothingToRecord.selector, address(nvda)));
        registry.recordSplit(address(nvda));
        vm.warp(e2 + 1 hours);
        _price(PID_B, PX / 20);
        vm.expectRevert();
        engine.traderEquityUsd(mid, alice);
        vm.startPrank(timelock);
        registry.recordSplitAt(address(nvda), uint64(SAT), 10e18);
        (, latched) = registry.splitUnrecorded(address(nvda));
        assertTrue(latched); // 10 recorded, the token is at 20: still frozen
        registry.recordSplitAt(address(nvda), uint64(e2), 2e18);
        vm.stopPrank();
        (uint256 f, bool l2) = registry.splitUnrecorded(address(nvda));
        assertEq(f, 0);
        assertFalse(l2);
        assertEq(engine.unitOf(mid), 20e18);
        assertEq(engine.traderEquityUsd(mid, alice), control);
    }

    /// @notice Review H-1 (b), PoC `test_poc_unrecordedThenDividend_unfreezes`: an unrecorded 10:1 split, the reopen
    ///         print, then the issuer's immediate in-band dividend update. Before the fix the frozen range moved to the
    ///         dividend's time and the stored post-split print was valued at factor 1 (a long liquidated at 1/10). Now
    ///         the market stays frozen, liquidations included, and the guardian's bound accepts the split ratio with
    ///         the dividend on top (target 10.01 / 1).
    function test_review_H1b_unrecordedThenDividend_staysFrozen_guardianBoundToleratesIt() public {
        _trade(alice, mid, 50e18);
        nvda.updateMultiplier(10e18, SAT);
        vm.warp(SAT + 30);
        vm.prank(keeper);
        registry.recordSplit(address(nvda)); // the keeper's pass latches the change at its effectiveAt
        vm.warp(SAT + 1 hours);
        _price(PID_B, PX / 10);
        vm.warp(block.timestamp + 5);
        nvda.updateMultiplier(10.01e18); // immediate in-band dividend
        vm.expectRevert();
        engine.unitOf(mid);
        vm.expectRevert();
        engine.liquidate(mid, alice);
        address guardian = makeAddr("guardian");
        cfg.grantRole(cfg.GUARDIAN_ROLE(), guardian);
        uint256[] memory rs = new uint256[](1);
        rs[0] = 10.01e18; // the dividend-tainted target is no clean split: refused
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.SplitRatioMismatch.selector, 10.01e18, 10e18));
        registry.guardianRecordSplits(address(nvda), rs);
        rs[0] = 10e18; // the exact 10:1 within the band of 10.01
        vm.prank(guardian);
        registry.guardianRecordSplits(address(nvda), rs);
        assertEq(engine.unitOf(mid), 10e18);
        assertFalse(engine.isLiquidatable(mid, alice)); // valued at the same underlying value: no loss
    }

    /// @notice Review M-1: the guardian's bound. Two unrecorded splits (10:1, then 2:1), each latched by the keeper at
    ///         its effectiveAt, are recorded in one call at exactly those times; ratios that are not the unique clean
    ///         split of each latched change are refused.
    function test_review_M1_guardianBound() public {
        address guardian = makeAddr("guardian");
        cfg.grantRole(cfg.GUARDIAN_ROLE(), guardian);
        nvda.updateMultiplier(10e18, SAT);
        vm.warp(SAT + 1);
        registry.recordSplit(address(nvda)); // the keeper's pass latches the first (SAT)
        nvda.updateMultiplier(20e18, SAT + 1 days);
        vm.warp(SAT + 1 days + 1);
        registry.recordSplit(address(nvda)); // latches the second (SAT + 1 day)
        uint256[] memory r1 = new uint256[](1);
        r1[0] = 20e18;
        vm.prank(guardian);
        vm.expectRevert(StockTokenRegistry.BadSplit.selector); // two latched changes, one ratio
        registry.guardianRecordSplits(address(nvda), r1);
        uint256[] memory r2 = new uint256[](2);
        (r2[0], r2[1]) = (10.4e18, 2e18); // within the band, not the clean split
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.SplitRatioMismatch.selector, 10.4e18, 10e18));
        registry.guardianRecordSplits(address(nvda), r2);
        (r2[0], r2[1]) = (10e18, 2e18);
        vm.prank(guardian);
        registry.guardianRecordSplits(address(nvda), r2);
        vm.warp(SAT + 2 days);
        assertEq(registry.shareFactor(PID_B, uint64(SAT + 1 hours)), 10e18);
        assertEq(registry.shareFactor(PID_B, uint64(SAT + 2 days)), 20e18);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NothingToRecord.selector, address(nvda)));
        registry.guardianRecordSplits(address(nvda), r2);
    }

    /// @notice Verification Medium, PoC `test_poc_guardianLateTime`: the guardian used to choose the split time; the
    ///         right ratio recorded 10 s after the stored reopen print valued that print at the pre-split unit (a $5,000
    ///         long at ~$492). Now the time is the latched effectiveAt: the stored print is post-split and the long keeps
    ///         its value. The guardian cannot pass a time at all.
    function test_review_V1_guardianCannotChooseTheTime() public {
        uint256 snap = vm.snapshotState();
        _trade(alice, mid, 50e18);
        vm.warp(SAT + 2 days + 30);
        _price(PID_B, PX);
        int256 control = engine.traderEquityUsd(mid, alice);
        vm.revertToState(snap);

        _trade(alice, mid, 50e18);
        nvda.updateMultiplier(10e18, SAT); // the keeper misses the staging, latches at activation
        vm.warp(SAT + 40);
        vm.prank(keeper);
        registry.recordSplit(address(nvda));
        vm.warp(SAT + 2 days);
        _price(PID_B, PX / 10); // the reopen print
        vm.warp(block.timestamp + 30);
        _price(PID_B, PX / 10);
        address guardian = makeAddr("guardian");
        cfg.grantRole(cfg.GUARDIAN_ROLE(), guardian);
        uint256[] memory rs = new uint256[](1);
        rs[0] = 10e18;
        vm.prank(guardian);
        registry.guardianRecordSplits(address(nvda), rs);
        assertEq(engine.unitOf(mid), 10e18);
        assertEq(engine.traderEquityUsd(mid, alice), control);
        assertFalse(engine.isLiquidatable(mid, alice));
    }

    /// @notice Verification Lows: no unique clean ratio (a 1:1.05 change, or an unknown time) goes to governance; a
    ///         latch holding a split is never cleared by reanchorDrift, a drift-sized one is.
    function test_review_V2_noCleanRatio_unknownTime_driftLatch() public {
        address guardian = makeAddr("guardian");
        cfg.grantRole(cfg.GUARDIAN_ROLE(), guardian);
        nvda.updateMultiplier(10e18, SAT);
        vm.warp(SAT + 1);
        registry.recordSplit(address(nvda));
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.SplitLatched.selector, PID_B));
        registry.reanchorDrift(address(nvda), 10e18);
        // a split hidden by a later staged change: its time is unknown, the guardian refuses
        MockStockToken amd = new MockStockToken("AMD", "AMD", 1e18);
        amd.updateMultiplier(1e18, 0);
        bytes32 pidX = bytes32("AMD");
        vm.startPrank(timelock);
        registry.register(address(amd), pidX, 1e18, 0);
        registry.setMultiplierSource(address(amd), true);
        vm.stopPrank();
        amd.updateMultiplier(3e18); // active now
        vm.warp(block.timestamp + 1);
        amd.updateMultiplier(3.01e18, block.timestamp + 1 days); // a later change staged on top hides the time
        registry.recordSplit(address(amd));
        uint256[] memory rs = new uint256[](1);
        rs[0] = 3e18;
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.SplitNotSnappable.selector, 3e18));
        registry.guardianRecordSplits(address(amd), rs);
        // dividend drift past the band: latched, then reanchorDrift clears it (no split)
        MockStockToken ibm = new MockStockToken("IBM", "IBM", 1e18);
        ibm.updateMultiplier(1e18, 0);
        bytes32 pidY = bytes32("IBM");
        vm.startPrank(timelock);
        registry.register(address(ibm), pidY, 1e18, 0);
        registry.setMultiplierSource(address(ibm), true);
        vm.stopPrank();
        ibm.updateMultiplier(1.06e18);
        registry.recordSplit(address(ibm));
        rs[0] = 1.06e18;
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.SplitNotSnappable.selector, 1.06e18));
        registry.guardianRecordSplits(address(ibm), rs);
        vm.prank(timelock);
        registry.reanchorDrift(address(ibm), 1.06e18);
        (uint256 f, bool l) = registry.splitUnrecorded(address(ibm));
        assertEq(f, 0);
        assertFalse(l);
    }

    /// @notice Review L-1, PoC `test_poc_futureBasis`: a pre-split print stamped 5 s ahead (basis = effectiveAt) landing
    ///         before effectiveAt. Before the fix it got the post-split unit at once (10x). Now the staged record does
    ///         not count before its time, and after it the ambiguous basis is refused until the next print.
    function test_review_L1_futureStampedPrint_neverMeetsThePostSplitUnit() public {
        _stage(nvda, 10e18);
        vm.warp(SAT - 4);
        oracle.update(_priceData(PID_B, PX, uint64(SAT), false));
        assertEq(engine.unitOf(mid), 1e18);
        vm.warp(SAT + 1);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.SplitBasisAmbiguous.selector, PID_B, uint64(SAT)));
        engine.unitOf(mid);
        vm.warp(SAT + 6);
        _price(PID_B, PX / 10);
        assertEq(engine.unitOf(mid), 10e18);
    }

    /// @notice Review L-2: an index unit move needs a signed round at most 60 s old (no older round in hindsight).
    function test_review_L2_indexMoveNeedsARecentRound() public {
        uint256 idx = _indexMarket();
        _round(100e18, 90e18, false);
        _trade(alice, idx, -20e18);
        _stage(tsla, 3e18);
        vm.warp(SAT + 2 days);
        _round(105e18, 29e18, false);
        vm.warp(block.timestamp + 61);
        vm.expectRevert(abi.encodeWithSelector(IPoolEngine.IndexSnapshot.selector, PID_A));
        engine.syncUnit(idx, "");
        _round(106e18, 30e18, false);
        engine.syncUnit(idx, "");
    }
}
