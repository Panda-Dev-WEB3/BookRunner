// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IV4PoolManager} from "./external/IUniswapV4.sol";

/// @title IBkrnV4Swapper — executes one BKRN buyback route against the Uniswap v4 PoolManager for BkrnFeeRouter.
interface IBkrnV4Swapper {
    /// @notice A governance-set v4 buyback route (BkrnFeeRouter.setV4Route). Native ETH is v4 currency address(0).
    ///         kind 0 ROUTE_DIRECT: USDG -> BKRN in `bkrnPool` = {USDG, BKRN};
    ///         kind 1 ROUTE_V4_ETH: USDG -> ETH in `ethPool` = {ETH, USDG}, then ETH -> BKRN in `bkrnPool` = {ETH, BKRN},
    ///         one unlock (the ETH never leaves the PoolManager);
    ///         kind 2 ROUTE_V3_WETH: USDG -> WETH through the v3 SwapRouter02 (`v3Fee` tier), unwrap `weth`, then
    ///         ETH -> BKRN in `bkrnPool` = {ETH, BKRN}, all inside the unlock.
    struct V4Route {
        uint8 kind;
        IV4PoolManager.PoolKey bkrnPool;
        IV4PoolManager.PoolKey ethPool;
        uint24 v3Fee;
        address weth;
    }

    /// @notice One buyback: route, exact input and per-hop sqrtPriceX96 limits.
    struct V4Job {
        V4Route route;
        uint256 amountIn;
        uint160 limit0; // first hop (USDG ->)
        uint160 limit1; // ETH -> BKRN hop (via ETH only)
        address v3Router; // ROUTE_V3_WETH: SwapRouter02
    }

    /// @notice Fee router only: runs `job` in one `manager.unlock`, paying the settlement token from the fee router
    ///         (exact allowance of `job.amountIn`) and sending the BKRN to it. Returns (settlement token paid, BKRN out).
    function swap(address manager, V4Job calldata job) external returns (uint256 paid, uint256 bkrnOut);
}
