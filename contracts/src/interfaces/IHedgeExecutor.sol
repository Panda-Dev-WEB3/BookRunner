// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IHedgeExecutor — executes long-spot hedge legs in canonical Stock Tokens.
/// @notice Uniswap v3 SwapRouter02 path implemented (direct pool or a two-pool hop route, set per Stock
///         Token by the timelock); v4 (UniversalRouter) path behind the same call, VERIFY U3 on RHC.
///         Stock Tokens are NOT borrowable: sells are capped by holdings.
interface IHedgeExecutor {
    /// @notice Pulls `amountIn` of tokenIn from msg.sender, swaps, sends tokenOut to `recipient`.
    ///         One side must be the settlement token (`config.usdc()`); the route is the governance route
    ///         of the other (Stock Token) side; `poolFee` must be 0 (use the route) or the route's fee.
    function swapExactIn(
        bytes32 venue, // "UNIV3" | "UNIV4"
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external returns (uint256 amountOut);

    function routerOf(bytes32 venue) external view returns (address);

    /// @notice Governance route of `asset` on `venue` (`fee == 0` = no route; `hop == 0` = direct pool).
    function routeOf(bytes32 venue, address asset) external view returns (uint24 fee, address hop, uint24 hopFee);
}
