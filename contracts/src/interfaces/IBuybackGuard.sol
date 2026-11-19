// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IBuybackGuard — what BkrnFeeRouter reads from its BuybackGuard (tech update #9).
interface IBuybackGuard {
    /// @notice Settlement token (USDG) per ETH, WAD, from the on-chain TWAP reference (or the governance fallback while it
    ///         has not expired). Reverts `EthReferenceUnavailable` when neither is usable: buybacks that need an ETH
    ///         reference then stop (fail-safe), nothing is guessed.
    function ethUsdcPerEth() external view returns (uint256);

    /// @notice The most settlement token (USDG, 6dp) one buyback may swap now so that its price impact on the BKRN pool stays
    ///         within `maxImpactBps` (`maxBuybackNoDepth` while there is no usable BKRN depth pool: never unlimited).
    function maxBuyback() external view returns (uint256);
}
