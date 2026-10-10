// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IUniswapV3PoolView — the read-only Uniswap v3 pool surface the protocol uses (TWAP + checks).
/// @notice Signatures match `IUniswapV3PoolImmutables` / `IUniswapV3PoolState` / `IUniswapV3PoolDerivedState`.
interface IUniswapV3PoolView {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    /// @dev Reverts "OLD" when a requested timestamp is older than the oldest stored observation.
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/// @title IUniswapV3Factory — pool lookup. RHC mainnet `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` (VERIFY U1).
interface IUniswapV3Factory {
    /// @dev Token order does not matter; returns address(0) when no pool exists for the fee tier.
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}
