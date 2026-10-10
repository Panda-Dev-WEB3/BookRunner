// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IScaledUIAmount — ERC-8056 "Scaled UI Amount" (subset read by the protocol).
/// @notice Robinhood Stock Tokens implement ERC-8056: raw balances never change, a corporate-action
///         multiplier scales them into underlying shares: `shares = raw * uiMultiplier() / 1e18`.
///         Scale: 18 decimals, 1e18 = 1.0 — the same WAD scale as `StockTokenRegistry.multiplierWad`.
///         Sources (VERIFY T2): https://docs.robinhood.com/chain/building-with-stock-tokens ,
///         https://ercs.ethereum.org/ERCS/erc-8056 .
interface IScaledUIAmount {
    /// @notice Active multiplier (WAD). A staged update becomes active at `effectiveAt()`.
    function uiMultiplier() external view returns (uint256);
}

/// @notice Robinhood's pending-update extension (`IScaledUIAmountNewUIMultiplier` in Robinhood's docs).
interface IScaledUIAmountPending {
    /// @notice Multiplier scheduled to become active at `effectiveAt()` (tracks the current one when none).
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
}

/// @notice Robinhood Stock Token oracle-pause flag (advisory; the Chainlink feed holds while it is set).
///         https://docs.robinhood.com/chain/oracles-and-price-feeds/
interface IStockTokenOraclePause {
    function oraclePaused() external view returns (bool);
}
