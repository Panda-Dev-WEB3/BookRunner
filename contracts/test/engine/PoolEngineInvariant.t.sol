// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {EngineBase} from "./utils/EngineBase.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {AttestedOracle} from "../../src/AttestedOracle.sol";
import {PoolEngine} from "../../src/PoolEngine.sol";
import {IAttestedOracle} from "../../src/interfaces/IAttestedOracle.sol";
import {IPoolEngine} from "../../src/interfaces/IPoolEngine.sol";

/// @notice Drives random trading, price moves (incl. held / stale regimes and crashes), funding time,
///         liquidations (incl. bad debt + ADL) and pool admin across two markets.
contract EngineHandler is Test {
    uint256 internal constant SIGNER_PK = 0xA11CE;
    uint256 internal constant N_ACTORS = 4;

    PoolEngine public engine;
    AttestedOracle public oracle;
    MockERC20 public usdc;

    uint256[2] public markets;
    address[2] public adapters;
    bytes32[2] public pids;
    address[N_ACTORS] public actors;

    // ghost
    uint256 public capViolations;
    uint256 public isolationViolations;
    uint256 public newRiskTrades;
    uint256 public reduceTrades;
    uint256 public liquidations;
    uint256 public badDebtLiquidations;
    uint256 public adlEvents;
    uint256 public regimeBlocked;

    struct Snap {
        uint16 spreadBps;
        int16 skewBps;
        bool reduceOnly;
        int256 longSize;
        int256 shortSize;
        uint256 poolCashUsd;
        uint256 insuranceUsd;
        uint256 feesAccruedUsd;
        uint256 totalMarginUsd;
        uint64 lastFundingTime;
        bytes32 positionsHash;
    }

    constructor(
        PoolEngine engine_,
        AttestedOracle oracle_,
        MockERC20 usdc_,
        uint256[2] memory markets_,
        address[2] memory adapters_,
        bytes32[2] memory pids_
    ) {
        engine = engine_;
        oracle = oracle_;
        usdc = usdc_;
        markets = markets_;
        adapters = adapters_;
        pids = pids_;
        for (uint256 i; i < N_ACTORS; ++i) {
            actors[i] = address(uint160(0xA000 + i));
            vm.prank(actors[i]);
            usdc.approve(address(engine), type(uint256).max);
        }
    }

    // ------------------------------------------------------------------ helpers

    function _snap(uint256 k) internal view returns (Snap memory s) {
        uint256 id = markets[k];
        IPoolEngine.MarketState memory st = engine.state(id);
        s.spreadBps = st.spreadBps;
        s.skewBps = st.skewBps;
        s.reduceOnly = st.reduceOnly;
        s.longSize = st.longSize;
        s.shortSize = st.shortSize;
        s.poolCashUsd = st.poolCashUsd;
        s.insuranceUsd = st.insuranceUsd;
        s.feesAccruedUsd = st.feesAccruedUsd;
        s.totalMarginUsd = engine.totalMarginUsd(id);
        s.lastFundingTime = engine.lastFundingTime(id);
        bytes memory acc;
        for (uint256 i; i < N_ACTORS; ++i) {
            IPoolEngine.Position memory p = engine.positionOf(id, actors[i]);
            acc = abi.encode(acc, p.size, p.entryPriceWad, p.marginUsd, p.fundingIndexAtEntry);
        }
        s.positionsHash = keccak256(acc);
    }

    function _same(Snap memory a, Snap memory b) internal pure returns (bool) {
        return keccak256(abi.encode(a)) == keccak256(abi.encode(b));
    }

    /// @dev Wraps an action on market k and records any change to the other market.
    modifier isolated(uint256 k) {
        Snap memory before = _snap(1 - k);
        _;
        if (!_same(before, _snap(1 - k))) isolationViolations++;
    }

    function _push(uint256 k, uint256 price, bool held) internal {
        bytes32 pid = pids[k];
        uint64 stored = oracle.latest(pid).publishedAt;
        if (stored >= block.timestamp) vm.warp(uint256(stored) + 1);
        IAttestedOracle.PriceUpdate memory u = IAttestedOracle.PriceUpdate({
            underlying: pid,
            priceWad: price,
            publishedAt: uint64(block.timestamp),
            held: held,
            sourceCount: 3,
            sourcesHash: bytes32(0)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, oracle.hashPrice(u));
        oracle.push(u, abi.encodePacked(r, s, v));
    }

    function _isNewRisk(int256 o, int256 n) internal pure returns (bool) {
        if (n == 0) return false;
        if (o == 0) return true;
        if ((o > 0) != (n > 0)) return true;
        return (n > 0 ? n : -n) > (o > 0 ? o : -o);
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }

    // ------------------------------------------------------------------ actions

    function depositMargin(uint256 actorSeed, uint256 mSeed, uint256 amount) external {
        uint256 k = mSeed % 2;
        address a = actors[actorSeed % N_ACTORS];
        amount = bound(amount, 1e6, 10_000e6);
        usdc.mint(a, amount);
        _depositMargin(k, a, amount);
    }

    function _depositMargin(uint256 k, address a, uint256 amount) internal isolated(k) {
        vm.prank(a);
        engine.depositMargin(markets[k], amount);
    }

    function withdrawMargin(uint256 actorSeed, uint256 mSeed, uint256 amount) external {
        uint256 k = mSeed % 2;
        _withdrawMargin(k, actors[actorSeed % N_ACTORS], amount);
    }

    function _withdrawMargin(uint256 k, address a, uint256 amount) internal isolated(k) {
        uint256 m = engine.positionOf(markets[k], a).marginUsd;
        if (m == 0) return;
        amount = bound(amount, 1, m);
        vm.prank(a);
        try engine.withdrawMargin(markets[k], amount) {} catch {}
    }

    function trade(uint256 actorSeed, uint256 mSeed, int256 size) external {
        uint256 k = mSeed % 2;
        address a = actors[actorSeed % N_ACTORS];
        size = bound(size, -400e18, 400e18);
        if (size == 0) return;
        _tradeOn(k, a, size);
    }

    function _tradeOn(uint256 k, address a, int256 size) internal isolated(k) {
        uint256 id = markets[k];
        int256 oldSize = engine.positionOf(id, a).size;
        bool newRisk = _isNewRisk(oldSize, oldSize + size);
        vm.prank(a);
        try engine.trade(id, size, size > 0 ? type(uint256).max : 0) {
            if (newRisk) {
                newRiskTrades++;
                if (_abs(engine.netExposureUsd(id)) > engine.config(id).maxNetExposureUsd) capViolations++;
            } else {
                reduceTrades++;
            }
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            if (
                sel == PoolEngine.OffHours.selector || sel == PoolEngine.StalePrice.selector
                    || sel == PoolEngine.MarketReduceOnly.selector
            ) regimeBlocked++;
        }
    }

    function closeAll(uint256 actorSeed, uint256 mSeed) external {
        uint256 k = mSeed % 2;
        address a = actors[actorSeed % N_ACTORS];
        int256 s = engine.positionOf(markets[k], a).size;
        if (s == 0) return;
        _tradeOn(k, a, -s);
    }

    function movePrice(uint256 mSeed, int256 moveBps, bool held) external {
        uint256 k = mSeed % 2;
        moveBps = bound(moveBps, -1500, 1500);
        uint256 p = oracle.latest(pids[k]).priceWad;
        uint256 np = uint256(int256(p) * (1e4 + moveBps) / 1e4);
        if (np < 1e18) np = 1e18;
        if (np > 10_000e18) np = 10_000e18;
        _movePrice(k, np, held && (moveBps % 5 == 0));
    }

    function _movePrice(uint256 k, uint256 np, bool held) internal isolated(k) {
        _push(k, np, held);
    }

    /// @dev Large move then liquidate every liquidatable actor: exercises bad debt, IF and ADL.
    function crash(uint256 mSeed, bool up, uint256 sizeBps) external {
        uint256 k = mSeed % 2;
        sizeBps = bound(sizeBps, 2000, 6000);
        uint256 p = oracle.latest(pids[k]).priceWad;
        uint256 np = up ? p * (1e4 + sizeBps) / 1e4 : p * (1e4 - sizeBps) / 1e4;
        if (np < 1e18) np = 1e18;
        if (np > 10_000e18) np = 10_000e18;
        _crash(k, np);
    }

    function _crash(uint256 k, uint256 np) internal isolated(k) {
        _push(k, np, false);
        uint256 id = markets[k];
        for (uint256 i; i < N_ACTORS; ++i) {
            if (engine.isLiquidatable(id, actors[i])) _liquidate(id, actors[i]);
        }
    }

    function liquidate(uint256 actorSeed, uint256 mSeed) external {
        uint256 k = mSeed % 2;
        _liquidateOn(k, actors[actorSeed % N_ACTORS]);
    }

    function _liquidateOn(uint256 k, address a) internal isolated(k) {
        uint256 id = markets[k];
        if (engine.isLiquidatable(id, a)) _liquidate(id, a);
    }

    function _liquidate(uint256 id, address a) internal {
        vm.recordLogs();
        try engine.liquidate(id, a) {
            liquidations++;
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 i; i < logs.length; ++i) {
                if (logs[i].topics[0] == IPoolEngine.Liquidation.selector) {
                    (,,, uint256 badDebt) = abi.decode(logs[i].data, (int256, uint256, uint256, uint256));
                    if (badDebt != 0) badDebtLiquidations++;
                } else if (logs[i].topics[0] == IPoolEngine.ADL.selector) {
                    adlEvents++;
                }
            }
        } catch {}
    }

    function warp(uint256 dt, bool refresh) external {
        dt = bound(dt, 1, 2 days);
        vm.warp(block.timestamp + dt);
        if (refresh) {
            _push(0, oracle.latest(pids[0]).priceWad, false);
            _push(1, oracle.latest(pids[1]).priceWad, false);
        }
    }

    function setQuote(uint256 mSeed, uint16 spread, int16 skew, uint128 maxNet) external {
        uint256 k = mSeed % 2;
        spread = uint16(bound(spread, 0, 100));
        skew = int16(bound(skew, -50, 50));
        maxNet = uint128(bound(maxNet, 10_000e6, 100_000e6));
        _setQuote(k, spread, skew, maxNet);
    }

    function _setQuote(uint256 k, uint16 spread, int16 skew, uint128 maxNet) internal isolated(k) {
        vm.prank(adapters[k]);
        try engine.setQuote(markets[k], spread, skew, maxNet) {} catch {}
    }

    function setReduceOnly(uint256 mSeed, bool ro) external {
        uint256 k = mSeed % 2;
        _setReduceOnly(k, ro);
    }

    function _setReduceOnly(uint256 k, bool ro) internal isolated(k) {
        vm.prank(adapters[k]);
        engine.setReduceOnly(markets[k], ro);
    }

    function poolFlow(uint256 mSeed, uint256 amount, uint8 kind) external {
        uint256 k = mSeed % 2;
        amount = bound(amount, 1e6, 50_000e6);
        _poolFlow(k, amount, kind % 5);
    }

    function _poolFlow(uint256 k, uint256 amount, uint8 kind) internal isolated(k) {
        uint256 id = markets[k];
        address ad = adapters[k];
        if (kind == 0 || kind == 1) {
            usdc.mint(ad, amount);
            vm.startPrank(ad);
            usdc.approve(address(engine), amount);
            if (kind == 0) engine.depositLiquidity(id, amount);
            else engine.depositInsurance(id, amount);
            vm.stopPrank();
        } else if (kind == 2) {
            vm.prank(ad);
            try engine.withdrawLiquidity(id, amount, ad) {} catch {}
        } else if (kind == 3) {
            vm.prank(ad);
            try engine.withdrawInsurance(id, amount, ad) {} catch {}
        } else {
            vm.prank(ad);
            engine.claimFees(id, ad);
        }
    }
}

contract PoolEngineInvariantTest is EngineBase {
    EngineHandler internal handler;
    uint256 internal mA;
    uint256 internal mB;
    address internal adA = makeAddr("adapterA");
    address internal adB = makeAddr("adapterB");

    function setUp() public {
        _deployCore();
        mA = _createMarket(adA, _defaultCfg(PID_A, 75_000e6));
        IPoolEngine.MarketConfig memory c = _defaultCfg(PID_B, 50_000e6);
        c.fundingVelocityBps = 500;
        mB = _createMarket(adB, c);
        _fundPool(adA, mA, 100_000e6, 2000e6);
        _fundPool(adB, mB, 60_000e6, 10e6); // thin IF in B so bad debt reaches ADL
        _setQuote(adA, mA, 10, 0, 75_000e6);
        _setQuote(adB, mB, 20, 0, 50_000e6);
        _price(PID_A, 100e18);
        _price(PID_B, 250e18);

        handler = new EngineHandler(engine, oracle, usdc, [mA, mB], [adA, adB], [PID_A, PID_B]);
        cfg.grantRole(cfg.KEEPER_ROLE(), address(handler)); // price relayer
        targetContract(address(handler));
    }

    /// (b) conservation: the engine's USDC equals the sum of all per-market ledgers.
    function invariant_conservation() public view {
        assertEq(usdc.balanceOf(address(engine)), _ledger(mA) + _ledger(mB));
    }

    /// (a) |pool net exposure| <= maxNetExposureUsd right after every successful new-risk trade.
    function invariant_exposureCapAfterNewRisk() public view {
        assertEq(handler.capViolations(), 0);
    }

    /// (c) actions on one market (incl. ADL) never change the other market's state.
    function invariant_marketIsolation() public view {
        assertEq(handler.isolationViolations(), 0);
    }

    /// O(1) aggregates equal the per-position sums.
    function invariant_aggregatesMatchPositions() public view {
        uint256[2] memory ids = [mA, mB];
        for (uint256 j; j < 2; ++j) {
            int256 longs;
            int256 shorts;
            uint256 margins;
            int256 traderPnlMinusFunding;
            for (uint256 i; i < 4; ++i) {
                address a = handler.actors(i);
                IPoolEngine.Position memory p = engine.positionOf(ids[j], a);
                if (p.size > 0) longs += p.size;
                else shorts += p.size;
                margins += p.marginUsd;
                if (p.size != 0) {
                    traderPnlMinusFunding += engine.traderEquityUsd(ids[j], a) - int256(p.marginUsd);
                }
            }
            IPoolEngine.MarketState memory s = engine.state(ids[j]);
            assertEq(s.longSize, longs);
            assertEq(s.shortSize, shorts);
            assertEq(engine.totalMarginUsd(ids[j]), margins);
            // pool equity == pool cash - sum(trader unrealised PnL - unsettled funding), up to rounding
            assertApproxEqAbs(engine.poolEquityUsd(ids[j]), int256(s.poolCashUsd) - traderPnlMinusFunding, 8);
        }
    }

    /// @dev Deterministic campaign through the same handler: checks every invariant after each step and
    ///      proves the interesting paths (new risk, reductions, liquidations, bad debt -> IF/ADL, regime
    ///      blocks) are actually reached by the handler.
    function test_handlerCampaign() public {
        uint256 seed = 0xB00C;
        for (uint256 step; step < 1000; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 op = seed % 13;
            uint256 a = seed >> 8;
            uint256 b = seed >> 16;
            uint256 c = seed >> 32;
            if (op <= 1) handler.depositMargin(a, b, 500e6 + c % 3000e6);
            else if (op <= 4) handler.trade(a, b, int256(c % 200e18) - 100e18);
            else if (op == 5) handler.closeAll(a, b);
            else if (op == 6) handler.movePrice(b, int256(c % 2000) - 1000, (c >> 20) % 7 == 0);
            else if (op == 7) handler.crash(b, (c >> 3) % 2 == 0, c);
            else if (op == 8) handler.liquidate(a, b);
            else if (op == 9) handler.warp(c % 4 hours, (c >> 7) % 4 != 0);
            else if (op == 10) handler.withdrawMargin(a, b, c);
            else if (op == 11) handler.setReduceOnly(b, (c >> 5) % 5 == 0);
            else handler.poolFlow(b, c, uint8(c >> 9));
            invariant_conservation();
            invariant_exposureCapAfterNewRisk();
            invariant_marketIsolation();
            invariant_aggregatesMatchPositions();
        }
        assertGt(handler.newRiskTrades(), 20, "new-risk trades");
        assertGt(handler.reduceTrades(), 5, "reductions");
        assertGt(handler.liquidations(), 3, "liquidations");
        assertGt(handler.badDebtLiquidations(), 0, "bad debt");
        assertGt(handler.adlEvents(), 0, "ADL");
        assertGt(handler.regimeBlocked(), 0, "regime blocks");
    }
}
