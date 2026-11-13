// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {EngineBase} from "../../engine/utils/EngineBase.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {MockStockToken} from "../../../src/mocks/MockStockToken.sol";
import {AttestedOracle} from "../../../src/AttestedOracle.sol";
import {PoolEngine} from "../../../src/PoolEngine.sol";
import {StockTokenRegistry} from "../../../src/StockTokenRegistry.sol";
import {IAttestedOracle} from "../../../src/interfaces/IAttestedOracle.sol";
import {IPoolEngine} from "../../../src/interfaces/IPoolEngine.sol";

/// @notice Audit N-1 value conservation: random trades, margin moves, liquidations, splits and reverse splits (live
///         token, staged and recorded, of any ratio among 10:1, 3:1, 2:1, 3:2 and their inverses) at a CONSTANT
///         underlying value: the per-share price is always value / cumulative split factor. Funding is off (velocity
///         0) so nothing else moves equity with time. Every split checks that no trader's equity and not the pool's
///         equity moved by more than the documented dust (one micro-dollar each); the invariant then checks the
///         count of violations, the dust, and that trader + pool equity + fees + insurance equals what was deposited.
contract SplitConservationHandler is Test {
    uint256 internal constant SIGNER_PK = 0xA11CE;
    uint256 internal constant N = 3;
    uint256 internal constant VALUE = 100e18; // per original share

    PoolEngine public engine;
    AttestedOracle public oracle;
    MockERC20 public usdc;
    StockTokenRegistry public registry;
    MockStockToken public token;
    uint256 public mid;
    bytes32 public pid;
    address[N] public actors;

    uint256 public cum = 1e18; // shares per original share
    uint256 public deposited;
    uint256 public splits;
    uint256 public reverseSplits;
    uint256 public trades;
    uint256 public violations;
    uint256 public maxDust;

    constructor(PoolEngine e, AttestedOracle o, MockERC20 u, StockTokenRegistry r, MockStockToken t, uint256 m, bytes32 p) {
        (engine, oracle, usdc, registry, token, mid, pid) = (e, o, u, r, t, m, p);
        for (uint256 i; i < N; ++i) {
            actors[i] = address(uint160(0x5711700 + i));
            vm.prank(actors[i]);
            usdc.approve(address(engine), type(uint256).max);
        }
    }

    function price() public view returns (uint256) {
        return VALUE * 1e18 / cum;
    }

    function _push() internal {
        uint64 last = oracle.latest(pid).publishedAt;
        if (last >= block.timestamp) vm.warp(uint256(last) + 1);
        IAttestedOracle.PriceUpdate memory u = IAttestedOracle.PriceUpdate({
            underlying: pid,
            priceWad: price(),
            publishedAt: uint64(block.timestamp),
            held: false,
            sourceCount: 3,
            sourcesHash: bytes32(0)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, oracle.hashPrice(u));
        oracle.push(u, abi.encodePacked(r, s, v));
    }

    function deposit(uint256 who, uint256 amount) external {
        address a = actors[who % N];
        amount = bound(amount, 1e6, 20_000e6);
        usdc.mint(a, amount);
        vm.prank(a);
        engine.depositMargin(mid, amount);
        deposited += amount;
    }

    function trade(uint256 who, int256 units) external {
        address a = actors[who % N];
        units = bound(units, -50e18, 50e18);
        if (units == 0) return;
        _push();
        vm.prank(a);
        try engine.trade(mid, units, units > 0 ? type(uint256).max : 0) {
            ++trades;
        } catch {}
    }

    function closeAll(uint256 who) external {
        address a = actors[who % N];
        int256 size = engine.positionOf(mid, a).size;
        if (size == 0) return;
        _push();
        vm.prank(a);
        try engine.trade(mid, -size, size < 0 ? type(uint256).max : 0) {} catch {}
    }

    function withdraw(uint256 who, uint256 amount) external {
        address a = actors[who % N];
        _push();
        uint256 m = engine.positionOf(mid, a).marginUsd;
        if (m == 0) return;
        amount = bound(amount, 1, m);
        vm.prank(a);
        try engine.withdrawMargin(mid, amount) {
            deposited -= amount;
        } catch {}
    }

    function liquidate(uint256 who) external {
        _push();
        try engine.liquidate(mid, actors[who % N]) returns (uint256 reward) {
            deposited -= reward; // paid out to the liquidator (this handler)
        } catch {}
    }

    /// @dev A split of `choice`, staged on the token, recorded by a keeper, effective one hour later; the reopen print
    ///      quotes the same value in post-split shares. Equities before and after must match.
    function split(uint256 choice) external {
        uint256[8] memory r = [uint256(10e18), 3e18, 2e18, 1.5e18, 0.1e18, uint256(1e18) / 3, 0.5e18, uint256(2e18) / 3];
        uint256 ratio = r[choice % 8];
        // keep the cumulative factor within [1e-6, 1e6]
        if (cum * ratio / 1e18 > 1e24 || cum * ratio / 1e18 < 1e12) ratio = r[(choice + 4) % 8];
        _push();
        int256[N] memory before;
        for (uint256 i; i < N; ++i) {
            before[i] = engine.traderEquityUsd(mid, actors[i]);
        }
        int256 poolBefore = engine.poolEquityUsd(mid);

        uint256 cur = token.uiMultiplier();
        uint256 at = block.timestamp + 1 hours;
        token.updateMultiplier(cur * ratio / 1e18, at);
        registry.recordSplit(address(token));
        vm.warp(at);
        cum = registry.shareFactor(pid, uint64(at));
        _push();
        if (engine.unitOf(mid) != cum) ++violations;
        for (uint256 i; i < N; ++i) {
            _dust(engine.traderEquityUsd(mid, actors[i]) - before[i]);
        }
        _dust(engine.poolEquityUsd(mid) - poolBefore);
        if (ratio > 1e18) ++splits;
        else ++reverseSplits;
    }

    function _dust(int256 d) internal {
        uint256 a = d >= 0 ? uint256(d) : uint256(-d);
        if (a > maxDust) maxDust = a;
        if (a > 1) ++violations;
    }

    function actor(uint256 i) external view returns (address) {
        return actors[i];
    }
}

contract N1SplitConservationInvariantTest is EngineBase {
    SplitConservationHandler internal h;
    StockTokenRegistry internal registry;
    MockStockToken internal token;
    uint256 internal mid;
    uint256 internal constant POOL = 2_000_000e6;
    uint256 internal constant IF = 200_000e6;

    function setUp() public {
        _deployCore();
        registry = new StockTokenRegistry(address(cfg), address(0));
        cfg.setStockRegistry(address(registry));
        token = new MockStockToken("NVIDIA Stock Token", "NVDA", 1e18);
        token.updateMultiplier(1e18, 0);
        vm.startPrank(timelock);
        registry.register(address(token), PID_B, 1e18, 0);
        registry.setMultiplierSource(address(token), true);
        vm.stopPrank();
        address ad = makeAddr("adapter");
        IPoolEngine.MarketConfig memory c = _defaultCfg(PID_B, 10_000_000e6);
        c.fundingVelocityBps = 0;
        mid = _createMarket(ad, c);
        _fundPool(ad, mid, POOL, IF);
        _setQuote(ad, mid, 20, 5, 10_000_000e6);
        vm.warp(block.timestamp + 1);
        _price(PID_B, PX);
        h = new SplitConservationHandler(engine, oracle, usdc, registry, token, mid, PID_B);
        cfg.grantRole(cfg.KEEPER_ROLE(), address(h));
        targetContract(address(h));
    }

    /// @notice The handler itself, once in each direction with positions open (the fuzzer's runs are random).
    function test_handler_splitsBothWays_noViolation() public {
        h.deposit(0, 10_000e6);
        h.deposit(1, 10_000e6);
        h.trade(0, -30e18);
        h.trade(1, 12e18);
        h.split(0); // 10:1
        h.split(5); // 1:3
        h.split(3); // 3:2
        h.trade(0, 30e18);
        assertEq(h.splits(), 2);
        assertEq(h.reverseSplits(), 1);
        assertEq(h.trades(), 3);
        assertEq(h.violations(), 0);
        invariant_valueConserved();
    }

    /// @notice No split moved any equity beyond the dust bound, the engine's unit is the registry's factor.
    function invariant_splitMovesNoValue() public view {
        assertEq(h.violations(), 0);
        assertLe(h.maxDust(), 1);
    }

    /// @notice Trader equity + pool equity + fees + insurance is what traders and the pool put in (net of what left),
    ///         within one micro-dollar of floor rounding per open position and the pool.
    function invariant_valueConserved() public view {
        int256 sum = engine.poolEquityUsd(mid);
        for (uint256 i; i < 3; ++i) {
            sum += engine.traderEquityUsd(mid, h.actor(i));
        }
        IPoolEngine.MarketState memory s = engine.state(mid);
        int256 expected = int256(POOL + IF + h.deposited());
        sum += int256(s.feesAccruedUsd + s.insuranceUsd);
        assertApproxEqAbs(sum, expected, 4);
    }
}
