// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {M3Stack} from "./utils/M3Stack.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {AttestedOracle} from "../../../src/AttestedOracle.sol";
import {PoolEngine} from "../../../src/PoolEngine.sol";
import {MMMandate} from "../../../src/MMMandate.sol";
import {BookrunnerDesk} from "../../../src/BookrunnerDesk.sol";
import {PoolEngineAdapter} from "../../../src/PoolEngineAdapter.sol";
import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {IAttestedOracle} from "../../../src/interfaces/IAttestedOracle.sol";
import {IBookrunnerDesk} from "../../../src/interfaces/IBookrunnerDesk.sol";
import {IPoolEngine} from "../../../src/interfaces/IPoolEngine.sol";

/// @notice Colluding desk + traders at a CONSTANT oracle price: the desk key quotes anything (through
///         desk.execute -> mandate.checkQuote -> adapter -> engine), the adapter itself sets raw engine quotes
///         (a compromised / buggy adapter: only the engine's own bounds apply), the committee re-mandates with
///         arbitrary terms, and three traders open, flip, reduce and close at will, move margin and liquidate.
///         Time only moves in small steps with the same price re-published (trades need a fresh price).
contract PoolEquityHandler is Test {
    uint256 internal constant SIGNER_PK = 0xA11CE;
    uint256 internal constant N = 3;

    PoolEngine public engine;
    AttestedOracle public oracle;
    MockERC20 public usdc;
    BookrunnerDesk public desk;
    MMMandate public mandate;
    PoolEngineAdapter public adapter;
    uint256 public mid;
    bytes32 public pid;
    uint256 public price;
    address public key;
    address public sponsor;
    address public committee;
    uint128 public maxInv;
    address[N] public actors;

    // ghosts
    uint256 public deposited;
    uint256 public withdrawn;
    uint256 public trades;
    uint256 public newRiskTrades;
    uint256 public quotesSet;
    uint256 public rawQuotesSet;
    uint256 public remandates;

    constructor(
        PoolEngine engine_,
        AttestedOracle oracle_,
        MockERC20 usdc_,
        BookrunnerDesk desk_,
        MMMandate mandate_,
        PoolEngineAdapter adapter_,
        bytes32 pid_,
        uint256 price_,
        address key_,
        address sponsor_,
        address committee_,
        uint128 maxInv_
    ) {
        engine = engine_;
        oracle = oracle_;
        usdc = usdc_;
        desk = desk_;
        mandate = mandate_;
        adapter = adapter_;
        mid = adapter_.marketId();
        pid = pid_;
        price = price_;
        key = key_;
        sponsor = sponsor_;
        committee = committee_;
        maxInv = maxInv_;
        for (uint256 i; i < N; ++i) {
            actors[i] = address(uint160(0xC0110 + i));
            vm.prank(actors[i]);
            usdc.approve(address(engine_), type(uint256).max);
        }
    }

    function _push() internal {
        IAttestedOracle.PriceUpdate memory u = IAttestedOracle.PriceUpdate({
            underlying: pid,
            priceWad: price,
            publishedAt: uint64(block.timestamp),
            held: false,
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

    // ------------------------------------------------------------------ desk (colluding)

    function quote(uint16 spread, int16 skew, uint128 maxNet) external {
        spread = uint16(bound(spread, 0, 120));
        skew = int16(bound(skew, -80, 80));
        maxNet = uint128(bound(maxNet, 0, maxInv));
        IBookrunnerDesk.Action memory a;
        a.kind = IBookrunnerDesk.ActionKind.SetQuote;
        a.data = abi.encode(spread, skew, maxNet);
        vm.prank(key);
        try desk.execute(a) {
            quotesSet++;
        } catch {}
    }

    /// @dev The adapter (not the mandate) setting the engine quote: only the engine's own bounds apply.
    function rawQuote(uint16 spread, int16 skew, uint128 maxNet) external {
        spread = uint16(bound(spread, 0, 5000));
        skew = int16(bound(skew, -2500, 2500));
        maxNet = uint128(bound(maxNet, 0, maxInv));
        vm.prank(address(adapter));
        try engine.setQuote(mid, spread, skew, maxNet) {
            rawQuotesSet++;
        } catch {}
    }

    /// @dev Committee re-mandate with arbitrary width / skew, then the sponsor re-registers the key.
    function remandate(uint16 width, int16 skew, int16 kill) external {
        BRTypes.Mandate memory m = mandate.getMandate();
        m.minQuoteWidthBps = uint16(bound(width, 1, 100));
        m.maxSkewBps = int16(bound(skew, 1, 80));
        m.killAtDrawdownBps = int16(bound(kill, -5000, -1));
        vm.prank(committee);
        try mandate.remandate(m) {
            remandates++;
        } catch {}
        if (!mandate.getKey(key).active) {
            vm.prank(sponsor);
            try mandate.registerKey(key, sponsor, uint64(block.timestamp + 365 days), maxInv) {} catch {}
        }
    }

    // ------------------------------------------------------------------ traders (colluding)

    function depositMargin(uint256 actorSeed, uint256 amount) external {
        address a = actors[actorSeed % N];
        amount = bound(amount, 1e6, 30_000e6);
        usdc.mint(a, amount);
        vm.prank(a);
        engine.depositMargin(mid, amount);
        deposited += amount;
    }

    function withdrawMargin(uint256 actorSeed, uint256 amount) external {
        address a = actors[actorSeed % N];
        uint256 m = engine.positionOf(mid, a).marginUsd;
        if (m == 0) return;
        amount = bound(amount, 1, m);
        vm.prank(a);
        try engine.withdrawMargin(mid, amount) {
            withdrawn += amount;
        } catch {}
    }

    function trade(uint256 actorSeed, int256 size) external {
        address a = actors[actorSeed % N];
        size = bound(size, -1000e18, 1000e18);
        if (size == 0) return;
        _trade(a, size);
    }

    function closeAll(uint256 actorSeed) external {
        address a = actors[actorSeed % N];
        int256 s = engine.positionOf(mid, a).size;
        if (s != 0) _trade(a, -s);
    }

    function _trade(address a, int256 size) internal {
        int256 o = engine.positionOf(mid, a).size;
        vm.prank(a);
        try engine.trade(mid, size, size > 0 ? type(uint256).max : 0) {
            trades++;
            if (_isNewRisk(o, o + size)) newRiskTrades++;
        } catch {}
    }

    function liquidate(uint256 actorSeed) external {
        address a = actors[actorSeed % N];
        if (engine.positionOf(mid, a).size == 0) return;
        try engine.liquidate(mid, a) {} catch {}
    }

    /// @dev Time moves in small steps; the same price is re-published so trades keep a fresh print.
    function tick(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 12));
        _push();
    }

    function equitySum() public view returns (int256 sum) {
        for (uint256 i; i < N; ++i) {
            sum += engine.traderEquityUsd(mid, actors[i]);
        }
    }
}

/// @title Audit "missing invariant" lead (M-3): pool equity cannot fall at a constant oracle price.
/// @notice Whatever the colluding desk quotes and the colluding traders trade, at a constant oracle price the
///         pool's equity (cash + traders' unrealised P&L and funding, marked at the oracle) never falls (beyond
///         rounding, a few micro-USD), and the coalition never takes out more than it put in. This would have
///         caught M-3: a quote entirely on one side of the oracle loses spread on every fill. Default profile:
///         256 runs x 128 calls; CI profile: 800 x 128 = 102,400 calls.
/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 128
/// forge-config: ci.invariant.runs = 800
/// forge-config: ci.invariant.depth = 128
contract M3PoolEquityInvariantTest is M3Stack {
    PoolEquityHandler internal handler;
    int256 internal eq0;
    /// @dev Rounding allowance: the engine floors the pool's mark at the final 6dp conversion; every realised
    ///      P&L, funding and entry rounding is in the pool's favour. 1 micro-USD per trade plus a constant.
    int256 internal constant ROUNDING_PER_TRADE = 1;
    int256 internal constant ROUNDING_FLOOR = 4;

    function setUp() public {
        _deployStack();
        handler = new PoolEquityHandler(
            engine, oracle, usdc, desk, mandate, adapter, PID_A, PX, key, sponsor, committee, MAX_INV
        );
        cfg.grantRole(cfg.KEEPER_ROLE(), address(handler));
        eq0 = engine.poolEquityUsd(mid);
        targetContract(address(handler));
    }

    function _tolerance() internal view returns (int256) {
        return ROUNDING_FLOOR + ROUNDING_PER_TRADE * int256(handler.trades());
    }

    /// Pool equity at the (constant) oracle price never falls below its starting value.
    function invariant_poolEquityNeverFallsAtConstantPrice() public view {
        assertGe(engine.poolEquityUsd(mid), eq0 - _tolerance(), "pool equity fell at a constant oracle price");
    }

    /// The colluding traders never take out (withdrawn + current equity) more than they deposited.
    function invariant_coalitionNeverProfits() public view {
        int256 out = int256(handler.withdrawn()) + handler.equitySum();
        assertLe(out, int256(handler.deposited()) + _tolerance(), "colluding traders extracted value");
    }

    /// Conservation still holds: the engine's USDC equals the market's ledgers.
    function invariant_conservation() public view {
        assertEq(usdc.balanceOf(address(engine)), _ledger(mid));
    }

    /// @dev Deterministic campaign of the auditor's shape (flip the skew around each leg) plus random steps:
    ///      the invariants hold after every step and the handler really trades.
    function test_campaign_flipSkewAndRandom() public {
        handler.depositMargin(0, 30_000e6);
        handler.depositMargin(1, 30_000e6);
        for (uint256 i; i < 25; ++i) {
            handler.quote(MIN_WIDTH, -MAX_SKEW, MAX_INV);
            handler.trade(0, 700e18);
            handler.quote(MIN_WIDTH, MAX_SKEW, MAX_INV);
            handler.closeAll(0);
            invariant_poolEquityNeverFallsAtConstantPrice();
            invariant_coalitionNeverProfits();
        }
        uint256 seed = 0x3333;
        for (uint256 step; step < 600; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 op = seed % 10;
            uint256 a = seed >> 8;
            uint256 b = seed >> 40;
            uint256 c = seed >> 80;
            if (op == 0) handler.quote(uint16(a), int16(int256(b % 161) - 80), uint128(c));
            else if (op == 1) handler.rawQuote(uint16(a), int16(int256(b % 5001) - 2500), uint128(c));
            else if (op == 2) handler.remandate(uint16(a), int16(int256(b % 80)), -int16(int256(c % 5000)));
            else if (op == 3) handler.depositMargin(a, b);
            else if (op == 4) handler.withdrawMargin(a, b);
            else if (op <= 6) handler.trade(a, int256(b % 1200e18) - 600e18);
            else if (op == 7) handler.closeAll(a);
            else if (op == 8) handler.liquidate(a);
            else handler.tick(a);
            invariant_poolEquityNeverFallsAtConstantPrice();
            invariant_coalitionNeverProfits();
            invariant_conservation();
        }
        assertGt(handler.trades(), 50, "trades");
        assertGt(handler.newRiskTrades(), 20, "new-risk trades");
        assertGt(handler.quotesSet() + handler.rawQuotesSet(), 10, "quotes");
    }
}
