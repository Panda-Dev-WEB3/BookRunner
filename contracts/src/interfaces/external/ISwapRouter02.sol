// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ISwapRouter02 — Uniswap v3 SwapRouter02 (IV3SwapRouter) subset.
/// @notice RHC mainnet SwapRouter02 `0xcaf681a66d020601342297493863e78c959e5cb2` (docs/VERIFY.md U1; re-check
///         on-chain). SwapRouter02's v3 structs carry NO `deadline` (unlike the original SwapRouter).
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @dev `path` = abi.encodePacked(tokenA, feeAB, tokenB, feeBC, tokenC, ...) (20-byte address, 3-byte fee).
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @title AggregatorV3Interface — Chainlink feed subset (equity feeds 24/5 hold off-hours). VERIFY feeds.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
