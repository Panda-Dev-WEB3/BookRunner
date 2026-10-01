// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IHedgeExecutor — executes long-spot hedge legs in canonical Stock Tokens.
/// @notice Uniswap v3 SwapRouter02 path implemented; v4 (UniversalRouter) path behind the same call,
///         VERIFY addresses/pools on RHC. Stock Tokens are NOT borrowable: sells are capped by holdings.
interface IHedgeExecutor {
    /// @notice Pulls `amountIn` of tokenIn from msg.sender, swaps, sends tokenOut to `recipient`.
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
}
