// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IPoolEngine — in-house pool-vs-trader perp engine (Synthetix V3 lineage, simplified).
/// @notice One market per in-house book. The book's MM inventory is the pool (counterparty to traders);
///         the book's IF absorbs bad debt; when the IF is depleted, ADL applies to that market only.
///         Isolated margin. Fill price = oracle * (1 +/- (spreadBps/2 + skewBps)/1e4) per side.
///         Off-hours (oracle held) or stale price: new risk blocked; reduce + liquidations allowed.
///         Pull oracle (LOW_GAS.md §1): the `priceData` overloads of trade / liquidate carry the signed
///         prices the transaction needs; staleness is judged on the price after that in-tx update.
///         Sizes: 1e18 = 1 unit of underlying. Prices WAD. USD 6 decimals.
interface IPoolEngine {
    struct MarketConfig {
        bytes32 underlying;
        bytes32 symbol;
        uint16 takerFeeBps;
        uint16 makerFeeBps; // reserved (pool is the maker)
        uint16 initialMarginBps; // e.g. 1000 = 10x max leverage
        uint16 maintenanceMarginBps; // e.g. 500
        uint16 liquidationFeeBps; // of position notional, to IF + liquidator
        uint32 fundingVelocityBps; // max funding rate per day at full skew, bps
        uint128 maxNetExposureUsd; // pool net exposure cap (mandate maxInventoryUsd)
    }

    struct MarketState {
        uint16 spreadBps;
        int16 skewBps;
        bool reduceOnly;
        int256 longSize; // aggregate trader long size (>= 0)
        int256 shortSize; // aggregate trader short size (<= 0, stored negative)
        uint256 poolCashUsd; // liquidity deposited + realised pool PnL
        uint256 insuranceUsd;
        uint256 feesAccruedUsd; // not yet claimed by adapter -> RevenueRouter
        int256 fundingIndex; // cumulative funding per unit size, WAD USD
    }

    struct Position {
        int256 size; // signed, 1e18 units
        uint256 entryPriceWad; // average entry
        uint256 marginUsd;
        int256 fundingIndexAtEntry;
    }

    // ---- market admin (only the market's adapter) ----
    function createMarket(MarketConfig calldata cfg) external returns (uint256 marketId); // only factory-registered adapters
    function setQuote(uint256 marketId, uint16 spreadBps, int16 skewBps, uint128 maxNetExposureUsd) external;
    function setReduceOnly(uint256 marketId, bool reduceOnly) external;
    function depositInsurance(uint256 marketId, uint256 amount) external;
    function depositLiquidity(uint256 marketId, uint256 amount) external;
    /// @notice Withdrawable liquidity keeps the pool solvent vs current trader PnL; reverts otherwise.
    function withdrawLiquidity(uint256 marketId, uint256 amount, address to) external;
    function withdrawInsurance(uint256 marketId, uint256 amount, address to) external;
    function claimFees(uint256 marketId, address to) external returns (uint256);

    // ---- traders ----
    function depositMargin(uint256 marketId, uint256 amount) external;
    function withdrawMargin(uint256 marketId, uint256 amount) external;
    function trade(uint256 marketId, int256 sizeDelta, uint256 acceptablePriceWad)
        external
        returns (uint256 fillPriceWad, uint256 feeUsd);
    function liquidate(uint256 marketId, address trader) external returns (uint256 rewardUsd);
    /// @notice Pull oracle (LOW_GAS.md §1): `AttestedOracle.update(priceData)` first when non-empty
    ///         (`priceData = abi.encode(IAttestedOracle.PriceUpdate[], bytes[])`), then `trade`. A trade
    ///         adding risk needs the price it uses to satisfy publishedAt >= now - config.maxTradePriceAge().
    function trade(uint256 marketId, int256 sizeDelta, uint256 acceptablePriceWad, bytes calldata priceData)
        external
        returns (uint256 fillPriceWad, uint256 feeUsd);
    /// @notice Pull oracle: `AttestedOracle.update(priceData)` first when non-empty, then `liquidate`.
    function liquidate(uint256 marketId, address trader, bytes calldata priceData)
        external
        returns (uint256 rewardUsd);

    // ---- views ----
    function adapterOf(uint256 marketId) external view returns (address);
    function config(uint256 marketId) external view returns (MarketConfig memory);
    function state(uint256 marketId) external view returns (MarketState memory);
    function positionOf(uint256 marketId, address trader) external view returns (Position memory);
    function quotePrice(uint256 marketId, int256 sizeDelta) external view returns (uint256 fillPriceWad);
    /// @notice Pool equity = poolCash - aggregate trader unrealised PnL - net funding owed (USD 6dp, signed).
    function poolEquityUsd(uint256 marketId) external view returns (int256);
    /// @notice Pool's signed exposure = -(long + short) * price (USD 6dp). Positive = pool long.
    function netExposureUsd(uint256 marketId) external view returns (int256);
    function marginRatioBps(uint256 marketId, address trader) external view returns (uint256);
    function isLiquidatable(uint256 marketId, address trader) external view returns (bool);

    event MarketCreated(uint256 indexed marketId, address indexed adapter, bytes32 underlying, bytes32 symbol);
    event QuoteSet(uint256 indexed marketId, uint16 spreadBps, int16 skewBps, uint128 maxNetExposureUsd);
    event Trade(
        uint256 indexed marketId,
        address indexed trader,
        int256 sizeDelta,
        uint256 fillPriceWad,
        uint256 feeUsd,
        int256 realizedPnlUsd,
        int256 newSize
    );
    event Liquidation(uint256 indexed marketId, address indexed trader, address indexed liquidator, int256 size, uint256 priceWad, uint256 feeUsd, uint256 badDebtUsd);
    event ADL(uint256 indexed marketId, uint256 shortfallUsd);
    event MarginChanged(uint256 indexed marketId, address indexed trader, int256 delta);
    event LiquidityChanged(uint256 indexed marketId, int256 liquidityDelta, int256 insuranceDelta);
    event FeesClaimed(uint256 indexed marketId, address to, uint256 amount);
}
