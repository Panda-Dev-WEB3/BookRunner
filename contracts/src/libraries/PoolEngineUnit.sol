// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAttestedOracle} from "../interfaces/IAttestedOracle.sol";
import {IPoolEngine} from "../interfaces/IPoolEngine.sol";
import {IStockTokenRegistry} from "../interfaces/IStockTokenRegistry.sol";

/// @title PoolEngineUnit — PoolEngine's split factor (audit N-1), an external library (PoolEngine's size).
/// @notice A market's positions, open interest, entry prices and funding index are kept in MARKET UNITS, fixed for the
///         life of the market: one unit is one share of the underlying (one index level for an index market) when the
///         market was created. A stock split changes the shares per unit, never a position: the engine converts the
///         oracle's per-share price into a price per unit,
///             unitPrice = price x unitWad / 1e18,
///         where `unitWad` (shares per unit, WAD) is taken at the price's share basis (its publishedAt, or
///         AttestedOracle.lastLiveAt when held; audit M-2). The value of a position is continuous across a split: a
///         10:1 split prints the per-share price at 1/10 and the unit at 10x. Seen in shares, this is a rebase of
///         every position (size x ratio, entry / ratio, notional unchanged) with no rounding drift: nothing stored
///         moves.
///         - Share price id: unitWad = StockTokenRegistry.shareFactor(priceId, basis) / its value when the market was
///           created (path-independent: any basis, no state).
///         - Index level: the level is sum(weight x per-share price) of its components, so a component's split moves
///           the level by an amount that depends on the prices. At the first touch with a basis past a component's
///           split, the unit moves once by R = (L + sum_k w_k q_k (r_k - 1) / 1e4) / L: L the index price, q_k the
///           split component's price, r_k its split ratio not applied yet. R conserves the value of a unit at those
///           prices exactly (the old unit is the basket of w_i / 1e4 old shares of each component). The prices must be
///           ONE signed oracle round: the stored price of every split component has the index price's publishedAt,
///           held flag and share basis, else IndexSnapshot (fail closed for that transaction). So the first toucher
///           only picks which signed round, never mixes rounds, and no choice of round moves value: R is computed
///           from the same snapshot the index price is in.
///         Rounding: the unit price and R round in the pool's favour (down while traders are net long, up while net
///         short); dust is below one wei of price per unit.
library PoolEngineUnit {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 1e4;

    /// @dev Per-market split state.
    struct UnitState {
        // share price id: its shareFactor at creation (0 = no registry then: 1e18)
        uint256 baseWad;
        // index level: the applied unit (0 = 1e18)
        uint256 unitWad;
        // index level: the basis the unit last moved at
        uint64 basisAt;
        // index level: each component's share factor already in the unit (0 = not seen yet: taken as is)
        mapping(bytes32 componentPriceId => uint256 factorWad) applied;
    }

    /// @custom:storage-location erc7201:bookrunner.storage.PoolEngineUnit
    struct UnitStorage {
        mapping(uint256 marketId => UnitState) units;
    }

    // keccak256(abi.encode(uint256(keccak256("bookrunner.storage.PoolEngineUnit")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_LOCATION = 0xa315fa28946cdaeded6ff96908ce0c93f0e3592d46023b640db55df40962c100;

    /// @dev The calling engine's split state (delegatecall: the engine's storage, in its own ERC-7201 namespace).
    function _unit(uint256 marketId) private view returns (UnitState storage) {
        UnitStorage storage $;
        assembly {
            $.slot := STORAGE_LOCATION
        }
        return $.units[marketId];
    }

    error BadIndexLevel();

    /// @notice At market creation: the split factors the market starts from.
    function init(uint256 marketId, address reg, bytes32 priceId) external {
        if (reg == address(0)) return;
        UnitState storage u = _unit(marketId);
        (uint256 f, IStockTokenRegistry.SplitComponent[] memory cs) =
            IStockTokenRegistry(reg).splitFactors(priceId, uint64(block.timestamp));
        if (cs.length == 0) {
            u.baseWad = f;
            return;
        }
        for (uint256 i; i < cs.length; ++i) {
            u.applied[cs[i].priceId] = cs[i].factorWad;
        }
        u.basisAt = uint64(block.timestamp);
    }

    /// @notice Shares per unit (WAD) for a price with share basis `basisAt`, without writing (views).
    function viewUnit(uint256 marketId, address reg, address oracle, bytes32 priceId, uint64 basisAt, int256 net)
        external
        view
        returns (uint256 unit)
    {
        (unit,,) = _compute(_unit(marketId), reg, oracle, priceId, basisAt, net);
    }

    /// @notice {viewUnit}, storing an index market's move (emits IPoolEngine.UnitUpdated) and first-seen components.
    function syncUnit(uint256 marketId, address reg, address oracle, bytes32 priceId, uint64 basisAt, int256 net)
        external
        returns (uint256 unit)
    {
        UnitState storage u = _unit(marketId);
        IStockTokenRegistry.SplitComponent[] memory cs;
        bool moved;
        (unit, cs, moved) = _compute(u, reg, oracle, priceId, basisAt, net);
        for (uint256 i; i < cs.length; ++i) {
            if (u.applied[cs[i].priceId] != cs[i].factorWad) u.applied[cs[i].priceId] = cs[i].factorWad;
        }
        if (moved) {
            u.unitWad = unit;
            u.basisAt = basisAt;
            emit IPoolEngine.UnitUpdated(marketId, unit, basisAt);
        }
    }

    /// @dev Unit at `basisAt`; for an index market also its components and whether the unit moves.
    function _compute(UnitState storage u, address reg, address oracle, bytes32 priceId, uint64 basisAt, int256 net)
        private
        view
        returns (uint256 unit, IStockTokenRegistry.SplitComponent[] memory cs, bool moved)
    {
        if (reg == address(0)) return (WAD, cs, false);
        uint256 f;
        (f, cs) = IStockTokenRegistry(reg).splitFactors(priceId, basisAt);
        if (cs.length == 0) {
            // a held price on an oracle that never stored a live one (lastLiveAt 0, e.g. after a cutover) has no known
            // share basis: refused when a split was recorded since (its unit would be the pre-split one)
            if (basisAt == 0) {
                (uint256 fNow,) = IStockTokenRegistry(reg).splitFactors(priceId, uint64(block.timestamp));
                if (fNow != f) revert IPoolEngine.PriceBeforeSplit(0, uint64(block.timestamp));
            }
            uint256 b = u.baseWad;
            return (b == 0 || b == WAD ? f : Math.mulDiv(f, WAD, b, _rounding(net)), cs, false);
        }
        unit = u.unitWad == 0 ? WAD : u.unitWad;
        int256 delta = 0;
        uint256 level = 0;
        for (uint256 i; i < cs.length; ++i) {
            uint256 a = u.applied[cs[i].priceId];
            uint256 fk = cs[i].factorWad;
            if (a == 0 || a == fk) continue;
            if (level == 0) level = _snapshotLevel(u, oracle, priceId, basisAt);
            IAttestedOracle.PriceData memory c = _snapshotPrice(oracle, cs[i].priceId, priceId, basisAt);
            uint256 term = Math.mulDiv(c.priceWad * cs[i].weightBps, fk > a ? fk - a : a - fk, a * BPS);
            delta += fk > a ? int256(term) : -int256(term);
        }
        if (level == 0) return (unit, cs, false);
        int256 num = int256(level) + delta;
        if (num <= 0) revert BadIndexLevel();
        return (Math.mulDiv(unit, uint256(num), level, _rounding(net)), cs, true);
    }

    /// @dev The index price of the snapshot: the stored one, whose share basis must be `basisAt` (no older than the
    ///      basis the unit last moved at).
    function _snapshotLevel(UnitState storage u, address oracle, bytes32 priceId, uint64 basisAt)
        private
        view
        returns (uint256)
    {
        if (basisAt < u.basisAt) revert IPoolEngine.PriceBeforeSplit(basisAt, u.basisAt);
        IAttestedOracle.PriceData memory d = IAttestedOracle(oracle).latest(priceId);
        if (d.priceWad == 0 || _basis(oracle, priceId, d) != basisAt) revert IPoolEngine.IndexSnapshot(priceId);
        return d.priceWad;
    }

    /// @dev A split component's stored price, which must be from the index price's signed round: same publishedAt,
    ///      held flag and share basis.
    function _snapshotPrice(address oracle, bytes32 componentId, bytes32 indexId, uint64 basisAt)
        private
        view
        returns (IAttestedOracle.PriceData memory c)
    {
        IAttestedOracle o = IAttestedOracle(oracle);
        IAttestedOracle.PriceData memory d = o.latest(indexId);
        c = o.latest(componentId);
        if (c.publishedAt != d.publishedAt || c.held != d.held || _basis(oracle, componentId, c) != basisAt) {
            revert IPoolEngine.IndexSnapshot(indexId);
        }
    }

    function _basis(address oracle, bytes32 id, IAttestedOracle.PriceData memory d) private view returns (uint64) {
        return d.held ? IAttestedOracle(oracle).lastLiveAt(id) : d.publishedAt;
    }

    /// @dev In the pool's favour: down while traders are net long (a lower unit price), up while net short.
    function _rounding(int256 net) private pure returns (Math.Rounding) {
        return net > 0 ? Math.Rounding.Floor : Math.Rounding.Ceil;
    }
}
