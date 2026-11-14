// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {EngineBase} from "../../engine/utils/EngineBase.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {MockStockToken} from "../../../src/mocks/MockStockToken.sol";
import {AttestedOracle} from "../../../src/AttestedOracle.sol";
import {PoolEngine} from "../../../src/PoolEngine.sol";
import {StockTokenRegistry} from "../../../src/StockTokenRegistry.sol";
import {IAttestedOracle} from "../../../src/interfaces/IAttestedOracle.sol";
import {IPoolEngine} from "../../../src/interfaces/IPoolEngine.sol";
import {IStockTokenRegistry} from "../../../src/interfaces/IStockTokenRegistry.sol";

/// @notice Audit N-1 (ENG-9, strengthened after the 2026-11-14 review): a share market (NVDA) and an index market
///         (0.6 NVDA + 0.4 TSLA) under a moving underlying (real P&L, liquidations), held and live rounds, splits and
///         reverse splits staged on the tokens and recorded by the keeper or never recorded, issuer re-staging,
///         in-band dividends, an unrecorded split followed by another split or a dividend, guardian and governance
///         recording, future-stamped pre-split prints and late index syncs. The model knows the TRUE share unit of every
///         print it signs; the engine must price the stored print at exactly that unit or refuse (fail closed). It
///         catches review H-1 (a later recorded split or a dividend unfreezing at the wrong unit), L-1 (a future-stamped
///         pre-split print meeting the post-split unit) and L-2 (an index unit moved from a round older than 60 s).
contract SplitTruthHandler is Test {
    uint256 internal constant SIGNER_PK = 0xA11CE;
    uint256 internal constant N = 3;
    bytes32 internal constant PB = bytes32("NVDA");
    bytes32 internal constant PT = bytes32("TSLA");
    bytes32 internal constant PA = bytes32("RHX5");

    PoolEngine public engine;
    AttestedOracle public oracle;
    MockERC20 public usdc;
    StockTokenRegistry public registry;
    MockStockToken public tokB;
    MockStockToken public tokT;
    address public timelock;
    uint256 public mid;
    uint256 public idx;
    address[N] internal actors;

    // ---- the model: true values per ORIGINAL share and true shares per original share
    uint256 public vB = 100e18;
    uint256 public vT = 90e18;
    uint256 public cumB = 1e18;
    uint256 public cumT = 1e18;
    /// @dev true unit of the stored NVDA print (the cum it was observed at)
    uint256 public storedCumB = 1e18;
    /// @dev last live round's per-share prices (a held round re-signs them)
    uint256 internal liveB;
    uint256 internal liveT;
    uint256 internal liveCumB = 1e18;
    uint256 internal liveCumT = 1e18;
    uint256 internal liveVB = 100e18;
    uint256 internal liveVT = 90e18;
    /// @dev the true values per ORIGINAL share behind the stored index round, and the index market's model basket:
    ///      original shares of each component per market unit (WAD), and the unit it was derived from
    uint256 internal roundVB = 100e18;
    uint256 internal roundVT = 90e18;
    uint256 internal roundCumT = 1e18;
    uint256 public basketB = 0.6e18;
    uint256 public basketT = 0.4e18;
    uint256 public idxUnit = 1e18;
    uint256 public guardianWrongAccepted;
    uint256 public governanceUnresolved;

    struct Pending {
        uint64 at;
        uint256 ratio; // as the registry reads it from the token (floored)
        uint256 nominal; // the clean split ratio (what the guardian / governance record)
        bool recorded; // the registry's staged record matches it
    }

    mapping(address => Pending) internal pending;
    mapping(address => uint64[]) internal unrecAt;
    mapping(address => uint256[]) internal unrecRatio;
    mapping(address => uint64) internal staleAt; // a staged record the token no longer follows (re-staged later)

    uint256 public violations;
    string public why;
    uint256 public splitsActivated;
    uint256 public unrecordedSplits;
    uint256 public guardianRecords;
    uint256 public governanceRecords;
    uint256 public liquidations;
    uint256 public indexMoves;
    uint256 public refusals;

    constructor(PoolEngine e, AttestedOracle o, MockERC20 u, StockTokenRegistry r) {
        (engine, oracle, usdc, registry) = (e, o, u, r);
        liveB = vB;
        liveT = vT;
    }

    /// @dev Second step of the construction (stack depth): tokens, governance and markets; funds the actors.
    function init(MockStockToken b, MockStockToken t, address tl, uint256 m, uint256 i) external {
        (tokB, tokT, timelock, mid, idx) = (b, t, tl, m, i);
        for (uint256 k; k < N; ++k) {
            actors[k] = address(uint160(0x5711800 + k));
            usdc.mint(actors[k], 40_000e6);
            vm.startPrank(actors[k]);
            usdc.approve(address(engine), type(uint256).max);
            engine.depositMargin(mid, 20_000e6);
            engine.depositMargin(idx, 20_000e6);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------ oracle

    function _sign(bytes32 pid, uint256 px, uint64 at, bool held) internal {
        IAttestedOracle.PriceUpdate memory u = IAttestedOracle.PriceUpdate({
            underlying: pid, priceWad: px, publishedAt: at, held: held, sourceCount: 3, sourcesHash: bytes32(0)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, oracle.hashPrice(u));
        oracle.push(u, abi.encodePacked(r, s, v));
    }

    function _nextTs() internal returns (uint64) {
        uint64 last = oracle.latest(PA).publishedAt;
        if (oracle.latest(PB).publishedAt > last) last = oracle.latest(PB).publishedAt;
        if (oracle.latest(PT).publishedAt > last) last = oracle.latest(PT).publishedAt;
        if (last >= block.timestamp) vm.warp(uint256(last) + 1);
        _activate();
        return uint64(block.timestamp);
    }

    /// @dev One signed round of the three price ids at `at`; live: the true per-share prices now.
    function _round(bool held) internal {
        uint64 at = _nextTs();
        uint256 pb = held ? liveB : vB * 1e18 / cumB;
        uint256 pt = held ? liveT : vT * 1e18 / cumT;
        if (!held) (liveB, liveT, liveCumB, liveVB, liveVT, liveCumT) = (pb, pt, cumB, vB, vT, cumT);
        _sign(PB, pb, at, held);
        _sign(PT, pt, at, held);
        _sign(PA, (pb * 6000 + pt * 4000) / 10_000, at, held);
        storedCumB = liveCumB;
        (roundVB, roundVT, roundCumT) = (liveVB, liveVT, liveCumT);
    }

    // ------------------------------------------------------------------ the issuer's tokens (truth)

    /// @dev Applies the token-side changes whose time has passed (the true unit moves; unrecorded ones are noted).
    function _activate() internal {
        _activateOne(tokB, true);
        _activateOne(tokT, false);
        _dropStale(tokB);
        _dropStale(tokT);
    }

    /// @dev Time passes to `t` with the keeper's 60 s passes in between: a pass runs right after every staged record's
    ///      time and every token activation on the way (it confirms, drops or latches as the registry decides).
    function _warpTo(uint256 t) internal {
        for (uint256 guard; guard < 8; ++guard) {
            uint256 next = t;
            (uint64 sb,,) = registry.stagedSplit(PB);
            (uint64 st,,) = registry.stagedSplit(PT);
            uint64 pb = pending[address(tokB)].at;
            uint64 pt = pending[address(tokT)].at;
            if (sb > block.timestamp && sb < next) next = sb;
            if (st > block.timestamp && st < next) next = st;
            if (pb > block.timestamp && pb < next) next = pb;
            if (pt > block.timestamp && pt < next) next = pt;
            if (next == t) break;
            vm.warp(next + 1 > t ? t : next + 1);
            _activate();
            try registry.recordSplit(address(tokB)) {} catch {}
            try registry.recordSplit(address(tokT)) {} catch {}
        }
        if (block.timestamp < t) vm.warp(t);
    }

    /// @dev The keeper's pass once a stale staged record's time has passed: it drops it (the token did not follow).
    function _dropStale(MockStockToken tok) internal {
        uint64 st = staleAt[address(tok)];
        if (st == 0 || st > block.timestamp) return;
        try registry.recordSplit(address(tok)) {} catch {}
        (, bool latched) = registry.splitUnrecorded(address(tok));
        if (!latched) delete staleAt[address(tok)];
    }

    function _activateOne(MockStockToken tok, bool isB) internal {
        Pending memory p = pending[address(tok)];
        if (p.at == 0 || p.at > block.timestamp) return;
        if (isB) cumB = cumB * p.ratio / 1e18;
        else cumT = cumT * p.ratio / 1e18;
        ++splitsActivated;
        delete pending[address(tok)];
        if (!p.recorded) {
            unrecAt[address(tok)].push(p.at);
            unrecRatio[address(tok)].push(p.nominal);
            ++unrecordedSplits;
        }
        // the keeper's pass (every 60 s) runs before the issuer's next action: it confirms (finalizes) a recorded split
        // or latches an unrecorded one. With no write at all between a change and the issuer's next one, nothing on
        // chain remembers the first (documented residual)
        try registry.recordSplit(address(tok)) {} catch {}
    }

    function _ratio(uint256 c, uint256 cum) internal pure returns (uint256 r) {
        uint256[6] memory rs = [uint256(10e18), 2e18, 3e18, 0.5e18, 0.1e18, uint256(1e18) / 3];
        r = rs[c % 6];
        uint256 next = cum * r / 1e18;
        if (next > 1e22 || next < 1e14) r = rs[(c + 3) % 6]; // keep the cumulative factor within [1e-4, 1e4]
    }

    /// @dev Stages `r` on the token; returns the ratio exactly as the registry reads it (newUIMultiplier / uiMultiplier,
    ///      floored): the model's truth uses it too.
    function _stageOnToken(MockStockToken tok, uint256 r, uint64 at) internal returns (uint256) {
        uint256 cur = tok.uiMultiplier();
        uint256 nu = cur * r / 1e18;
        tok.updateMultiplier(nu, at);
        return nu * 1e18 / cur;
    }

    /// @dev The issuer stages a split one hour ahead; the keeper records it or not.
    function stage(uint256 which, uint256 c, bool keeperRecords) external {
        MockStockToken tok = which % 2 == 0 ? tokB : tokT;
        if (pending[address(tok)].at != 0) return;
        _activate();
        uint64 at = uint64(block.timestamp + 1 hours);
        uint256 nominal = _ratio(c, which % 2 == 0 ? cumB : cumT);
        uint256 r = _stageOnToken(tok, nominal, at);
        pending[address(tok)] = Pending({at: at, ratio: r, nominal: nominal, recorded: false});
        if (keeperRecords) _keeper(tok);
        _check();
    }

    /// @dev The issuer re-stages its pending split later (a different ratio); the keeper may not see it.
    function restage(uint256 which, uint256 c) external {
        MockStockToken tok = which % 2 == 0 ? tokB : tokT;
        Pending storage p = pending[address(tok)];
        if (p.at == 0 || p.at <= block.timestamp) return;
        uint256 r0 = _ratio(c + 1, which % 2 == 0 ? cumB : cumT);
        if (r0 == p.nominal) return;
        if (p.recorded) staleAt[address(tok)] = p.at;
        uint64 at = p.at + 30 minutes;
        uint256 r = _stageOnToken(tok, r0, at); // the active multiplier is unchanged until `at`
        (p.at, p.ratio, p.nominal, p.recorded) = (at, r, r0, false);
        _check();
    }

    /// @dev An immediate in-band dividend reinvestment (not a split: the share unit does not change).
    function dividend(uint256 which) external {
        MockStockToken tok = which % 2 == 0 ? tokB : tokT;
        if (pending[address(tok)].at != 0) return; // MockStockToken: an immediate update replaces the staged one
        _activate();
        tok.updateMultiplier(tok.uiMultiplier() * 1.002e18 / 1e18);
        _check();
    }

    /// @dev The keeper's recordSplit (records a staged split, drops a stale one, or latches an unrecorded change).
    function keeperSync(uint256 which) external {
        _activate();
        _keeper(which % 2 == 0 ? tokB : tokT);
        _check();
    }

    function _keeper(MockStockToken tok) internal {
        bool clean = unrecAt[address(tok)].length == 0;
        try registry.recordSplit(address(tok)) {} catch {}
        _dropStale(tok);
        Pending storage p = pending[address(tok)];
        // the staged split is on chain only when nothing unrecorded holds the latch
        if (p.at != 0 && p.at > block.timestamp && clean) p.recorded = true;
    }

    /// @dev Time passes past any pending activation; a fresh live round (post-split prints for an activated split).
    ///      With the underlying value unchanged, every equity the engine still values must be unchanged.
    function passTime(uint256 dt) external {
        int256[2] memory before = [_eq(mid), _eq(idx)];
        bool[2] memory had = [_ok(mid), _ok(idx)];
        _warpTo(block.timestamp + bound(dt, 1 minutes, 3 hours));
        _round(false);
        if (had[0] && _ok(mid)) _near(_eq(mid), before[0]);
        if (had[1] && _ok(idx)) {
            try engine.syncUnit(idx, "") {} catch {}
            if (_ok(idx)) _near(_eq(idx), before[1]);
        }
        _check();
    }

    /// @dev Review L-1: a pre-split print stamped 5 s ahead, landing 4 s before a pending split activates.
    function futurePrint(uint256 which) external {
        MockStockToken tok = which % 2 == 0 ? tokB : tokT;
        Pending storage p = pending[address(tok)];
        if (p.at == 0 || p.at <= block.timestamp + 4) return;
        uint64 at = p.at;
        _warpTo(at - 4);
        _activate();
        if (oracle.latest(PB).publishedAt >= at || oracle.latest(PT).publishedAt >= at || oracle.latest(PA).publishedAt >= at) return;
        uint256 pb = vB * 1e18 / cumB;
        uint256 pt = vT * 1e18 / cumT;
        (liveB, liveT, liveCumB, liveVB, liveVT, liveCumT) = (pb, pt, cumB, vB, vT, cumT);
        (roundVB, roundVT, roundCumT) = (vB, vT, cumT);
        _sign(PB, pb, at, false);
        _sign(PT, pt, at, false);
        _sign(PA, (pb * 6000 + pt * 4000) / 10_000, at, false);
        storedCumB = cumB; // observed before the split: the pre-split unit, whatever its stamp
        _check();
        vm.warp(at + 1);
        _activate();
        _check();
    }

    /// @dev A held round (the session closed): the last live prices re-signed.
    function hold() external {
        _round(true);
        _check();
    }

    /// @dev The underlying moves (real P&L: liquidations happen).
    function move(int256 db, int256 dt) external {
        db = bound(db, -400, 400);
        dt = bound(dt, -400, 400);
        vB = uint256(int256(vB) * (10_000 + db) / 10_000);
        vT = uint256(int256(vT) * (10_000 + dt) / 10_000);
        if (vB < 1e18) vB = 1e18;
        if (vT < 1e18) vT = 1e18;
        _round(false);
        _check();
    }

    function trade(uint256 who, int256 units, bool onIndex) external {
        units = bound(units, -40e18, 40e18);
        if (units == 0) return;
        _round(false);
        uint256 m = onIndex ? idx : mid;
        vm.prank(actors[who % N]);
        try engine.trade(m, units, units > 0 ? type(uint256).max : 0) {} catch {}
        _check();
    }

    function liquidate(uint256 who, bool onIndex) external {
        uint256 m = onIndex ? idx : mid;
        try engine.liquidate(m, actors[who % N]) {
            ++liquidations;
        } catch {}
        _check();
    }

    /// @dev The guardian: first adversarial ratios (3% off, inside the band) that must be refused, then the clean
    ///      ratios of the latched changes (the times are the latch's, the guardian passes none).
    function guardian(uint256 which, uint256 skew) external {
        MockStockToken tok = which % 2 == 0 ? tokB : tokT;
        _activate();
        uint256[] storage rs = unrecRatio[address(tok)];
        if (rs.length == 0 || staleAt[address(tok)] != 0) return;
        try registry.recordSplit(address(tok)) {} catch {}
        uint256[] memory bad = new uint256[](rs.length);
        for (uint256 k; k < rs.length; ++k) {
            bad[k] = rs[k] * (skew % 2 == 0 ? 103 : 97) / 100;
        }
        try registry.guardianRecordSplits(address(tok), bad) {
            ++guardianWrongAccepted;
            _bad("the guardian recorded a wrong ratio");
        } catch {}
        try registry.guardianRecordSplits(address(tok), rs) {
            ++guardianRecords;
            delete unrecAt[address(tok)];
            delete unrecRatio[address(tok)];
        } catch {}
        _check();
    }

    /// @dev Governance (timelock) fallback: removes a stale staged record, then records the unrecorded changes in order.
    function governance(uint256 which) external {
        MockStockToken tok = which % 2 == 0 ? tokB : tokT;
        _activate();
        uint64[] storage ats = unrecAt[address(tok)];
        if (ats.length == 0) return;
        vm.startPrank(timelock);
        uint64 st = staleAt[address(tok)];
        if (st != 0 && st <= block.timestamp) {
            try registry.recordSplitAt(address(tok), st, 1e18) {} catch {}
            delete staleAt[address(tok)];
        }
        for (uint256 k; k < ats.length; ++k) {
            registry.recordSplitAt(address(tok), ats[k], unrecRatio[address(tok)][k]);
        }
        vm.stopPrank();
        ++governanceRecords;
        delete unrecAt[address(tok)];
        delete unrecRatio[address(tok)];
        // governance recorded the truth: the token is consistent again and the latch is gone
        (uint256 from, bool latched) = registry.splitUnrecorded(address(tok));
        if (from != 0 || latched) ++governanceUnresolved;
        _check();
    }

    /// @dev Review L-2: an index sync some time after the last round; a move may only use a round <= 60 s old.
    function lateIndexSync(uint256 dt) external {
        _warpTo(block.timestamp + bound(dt, 0, 300));
        _activate();
        uint256 age = block.timestamp - oracle.latest(PA).publishedAt;
        vm.recordLogs();
        try engine.syncUnit(idx, "") {} catch {}
        bytes32 topic = IPoolEngine.UnitUpdated.selector;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 k; k < logs.length; ++k) {
            if (logs[k].topics.length != 0 && logs[k].topics[0] == topic) {
                ++indexMoves;
                if (age > 60) _bad("index move from an old round");
                // the round used is one round: the split component's stored price is the index price's
                if (oracle.latest(PT).publishedAt != oracle.latest(PA).publishedAt
                    && oracle.latest(PB).publishedAt != oracle.latest(PA).publishedAt) _bad("index move from mixed rounds");
            }
        }
        _check();
    }

    // ------------------------------------------------------------------ checks

    function _ok(uint256 m) internal view returns (bool) {
        try engine.unitOf(m) returns (uint256) {
            return true;
        } catch {
            return false;
        }
    }

    function _eq(uint256 m) internal view returns (int256 sum) {
        try engine.poolEquityUsd(m) returns (int256 p) {
            sum = p;
        } catch {
            return 0;
        }
        for (uint256 k; k < N; ++k) {
            try engine.traderEquityUsd(m, actors[k]) returns (int256 e) {
                sum += e;
            } catch {}
        }
    }

    function _near(int256 a, int256 b) internal {
        int256 d = a > b ? a - b : b - a;
        if (d > 3) _bad("a split moved an equity");
    }

    function _bad(string memory reason) internal {
        ++violations;
        why = reason;
    }

    /// @dev The engine prices the stored NVDA print at its TRUE unit, or refuses.
    function _check() internal {
        try engine.unitOf(mid) returns (uint256 u) {
            uint256 d = u > storedCumB ? u - storedCumB : storedCumB - u;
            if (d * 1e12 > storedCumB) _bad("unit is not the stored print's true unit");
        } catch {
            ++refusals;
        }
        _checkIndex();
    }

    /// @dev The index market's value per unit (stored index price x unit) equals the model basket valued at the true
    ///      values behind that round; when the engine's unit moves (a component split applied), the new basket must
    ///      be worth what the old one was at that round: a move never shifts value between traders and the pool.
    function _checkIndex() internal {
        uint256 u;
        try engine.unitOf(idx) returns (uint256 v) {
            u = v;
        } catch {
            return;
        }
        uint256 old = (basketB * roundVB + basketT * roundVT) / 1e18;
        bool synced;
        if (u != idxUnit) {
            // the first touch stores the move at this round (until then the view prices the old basket)
            try engine.syncUnit(idx, "") {
                synced = true;
            } catch {}
            try engine.unitOf(idx) returns (uint256 v) {
                u = v;
            } catch {
                return;
            }
        }
        if (u != idxUnit && synced) {
            uint256 nb = u * 6000 * 1e18 / (10_000 * storedCumB);
            uint256 nt = u * 4000 * 1e18 / (10_000 * roundCumT);
            uint256 neu = (nb * roundVB + nt * roundVT) / 1e18;
            if (_rel(neu, old) > 1e9) _bad("an index unit move shifted value");
            (basketB, basketT, idxUnit) = (nb, nt, u);
            old = neu;
        }
        uint256 engineValue = oracle.latest(PA).priceWad * u / 1e18;
        if (_rel(engineValue, old) > 1e9) _bad("the index unit prices the basket wrongly");
    }

    /// @dev |a - b| / b in 1e-18 units
    function _rel(uint256 a, uint256 b) internal pure returns (uint256) {
        if (b == 0) return a == 0 ? 0 : type(uint256).max;
        return (a > b ? a - b : b - a) * 1e18 / b;
    }

    function actor(uint256 k) external view returns (address) {
        return actors[k];
    }
}

contract N1SplitConservationInvariantTest is EngineBase {
    SplitTruthHandler internal h;
    StockTokenRegistry internal registry;
    MockStockToken internal tokB;
    MockStockToken internal tokT;
    uint256 internal mid;
    uint256 internal idx;
    uint256 internal constant POOL = 2_000_000e6;
    uint256 internal constant IF = 200_000e6;
    bytes32 internal constant PID_T = bytes32("TSLA");

    function setUp() public {
        _deployCore();
        registry = new StockTokenRegistry(address(cfg), address(0));
        cfg.setStockRegistry(address(registry));
        tokB = new MockStockToken("NVIDIA Stock Token", "NVDA", 1e18);
        tokB.updateMultiplier(1e18, 0);
        tokT = new MockStockToken("Tesla Stock Token", "TSLA", 1e18);
        tokT.updateMultiplier(1e18, 0);
        vm.startPrank(timelock);
        registry.register(address(tokB), PID_B, 1e18, 0);
        registry.register(address(tokT), PID_T, 1e18, 0);
        registry.setMultiplierSource(address(tokB), true);
        registry.setMultiplierSource(address(tokT), true);
        IStockTokenRegistry.IndexComponent[] memory cs = new IStockTokenRegistry.IndexComponent[](2);
        cs[0] = IStockTokenRegistry.IndexComponent({token: address(tokB), weightBps: 6000});
        cs[1] = IStockTokenRegistry.IndexComponent({token: address(tokT), weightBps: 4000});
        registry.registerIndex(keccak256("BKRN.INDEX.RHX5"), PID_A, cs);
        vm.stopPrank();
        address ad = makeAddr("adapter");
        address adI = makeAddr("adapterIdx");
        IPoolEngine.MarketConfig memory c = _defaultCfg(PID_B, 10_000_000e6);
        c.fundingVelocityBps = 0;
        mid = _createMarket(ad, c);
        c.underlying = PID_A;
        idx = _createMarket(adI, c);
        _fundPool(ad, mid, POOL, IF);
        _fundPool(adI, idx, POOL, IF);
        _setQuote(ad, mid, 20, 5, 10_000_000e6);
        _setQuote(adI, idx, 20, 5, 10_000_000e6);
        vm.warp(block.timestamp + 1);
        uint64 at = uint64(block.timestamp);
        _pushRound(at);
        h = new SplitTruthHandler(engine, oracle, usdc, registry);
        h.init(tokB, tokT, timelock, mid, idx);
        cfg.grantRole(cfg.KEEPER_ROLE(), address(h));
        cfg.grantRole(cfg.GUARDIAN_ROLE(), address(h));
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](14);
        sel[0] = h.stage.selector;
        sel[1] = h.restage.selector;
        sel[2] = h.dividend.selector;
        sel[3] = h.keeperSync.selector;
        sel[4] = h.passTime.selector;
        sel[5] = h.futurePrint.selector;
        sel[6] = h.hold.selector;
        sel[7] = h.move.selector;
        sel[8] = h.trade.selector;
        sel[9] = h.liquidate.selector;
        sel[10] = h.guardian.selector;
        sel[11] = h.governance.selector;
        sel[12] = h.lateIndexSync.selector;
        sel[13] = h.trade.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function _pushRound(uint64 at) internal {
        oracle.push(_update(PID_B, 100e18, at, false, 3), _sign(SIGNER_PK, _update(PID_B, 100e18, at, false, 3)));
        oracle.push(_update(PID_T, 90e18, at, false, 3), _sign(SIGNER_PK, _update(PID_T, 90e18, at, false, 3)));
        uint256 l = (100e18 * 6000 + 90e18 * 4000) / 10_000;
        oracle.push(_update(PID_A, l, at, false, 3), _sign(SIGNER_PK, _update(PID_A, l, at, false, 3)));
    }

    /// @notice The engine prices every print at its true share unit or refuses; no split moves an equity; no index unit
    ///         move uses a round older than 60 s or mixed rounds.
    /// @notice Verification: the guardian never records a ratio other than the clean split of a latched change.
    function invariant_guardianNeverAcceptsAWrongRecord() public view {
        assertEq(h.guardianWrongAccepted(), 0);
    }

    /// @notice Governance recording the true changes at their own times always resolves the freeze.
    function invariant_governanceTruthResolves() public view {
        assertEq(h.governanceUnresolved(), 0);
    }

    function invariant_unitIsTheTruthOrRefused() public view {
        assertEq(h.violations(), 0, h.why());
    }

    /// @notice USDC conservation across both markets (ENG-1) whatever splits, recordings and liquidations happened.
    function invariant_ledgerConserved() public view {
        // state() values the funding index at the price: a frozen market (fail closed) is checked once it reopens
        try engine.state(mid) {} catch {
            return;
        }
        try engine.state(idx) {} catch {
            return;
        }
        assertEq(usdc.balanceOf(address(engine)), _ledger(mid) + _ledger(idx));
    }

    /// @notice The handler run deterministically: an unrecorded split followed by a staged one (H-1 a), a dividend after
    ///         an unrecorded one (H-1 b), a future-stamped print (L-1), a late index sync (L-2), then the guardian and
    ///         governance paths; no violation.
    function test_handler_reviewScenarios() public {
        h.trade(0, -20e18, false);
        h.trade(1, 15e18, true);
        h.stage(0, 0, false); // NVDA 10:1, never recorded
        h.passTime(2 hours); // activates: frozen
        h.stage(0, 1, true); // a staged 2:1: the keeper latches, records nothing
        h.passTime(2 hours); // activates
        h.move(100, -50);
        h.governance(0); // records 10 then 2 at their own times
        h.stage(0, 3, false); // 1:2 reverse split, unrecorded
        h.passTime(2 hours);
        h.dividend(0);
        h.keeperSync(0);
        h.guardian(0, 1); // a 3% skew refused, then the clean 1:2 (the dividend after it inside the band)
        h.stage(1, 2, true); // TSLA 3:1 recorded
        h.futurePrint(1);
        h.passTime(1 minutes);
        h.lateIndexSync(120);
        h.passTime(1 minutes);
        h.lateIndexSync(0);
        h.liquidate(0, false);
        assertEq(h.violations(), 0);
        assertGt(h.splitsActivated(), 3);
        assertGt(h.unrecordedSplits(), 1);
        assertGt(h.governanceRecords() + h.guardianRecords(), 1);
    }
}
