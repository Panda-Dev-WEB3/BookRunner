// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IVenueAdapter — common surface of OrderlyAdapter and PoolEngineAdapter (both UUPS, 48h timelock).
/// @notice Withdrawals only to the book's UnderwritingVault. Fee flow only to the book's RevenueRouter.
interface IVenueAdapter {
    function initialize(address config, uint256 bookId, address book) external;
    function book() external view returns (address);
    function venueKind() external view returns (uint8); // BRTypes.VENUE_*

    /// @notice Only vault. Pulls `amount` USDC from the vault (approved) into the venue account.
    function depositToVenue(uint8 account, uint256 amount) external;
    /// @notice Only vault. Sync venues return funds to the vault in the same call; async venues emit
    ///         WithdrawRequested for ops-venue to execute, then sweepToVault() lands them.
    function requestWithdraw(uint8 account, uint256 amount) external;
    /// @notice Anyone: sends USDC sitting on the adapter (returned withdrawals) to the vault.
    function sweepToVault() external returns (uint256 amount);
    /// @notice Fee settlement -> RevenueRouter. Orderly: OPS_VENUE with the venue's daily settlement
    ///         (capped per period). PoolEngine: anyone (claims engine-accrued fees).
    function sweepFees(uint64 period, uint256 amount) external returns (uint256 swept);

    // ---- valuation inputs for the mark service + mandate ----
    function insuranceEquityUsd() external view returns (uint256);
    function marginEquityUsd() external view returns (int256);
    /// @notice Signed MM net position notional (positive = book long).
    function netExposureUsd() external view returns (int256);
    /// @notice Withdrawals requested but not yet returned (still the book's asset).
    function inTransitUsd() external view returns (uint256);
    /// @notice insurance + max(margin, 0) + inTransit.
    function deployedValueUsd() external view returns (uint256);
    /// @notice Timestamp of the valuation (block.timestamp for on-chain venues; last report for Orderly).
    function valuationAt() external view returns (uint64);

    event VenueDeposit(uint8 indexed account, uint256 amount);
    event WithdrawRequested(uint8 indexed account, uint256 amount, uint256 indexed requestNonce);
    event SweptToVault(uint256 amount);
    event FeesSwept(uint64 indexed period, uint256 amount);
}

/// @title IOrderlyAdapter — Orderly Perp Anything builder path. VERIFY all Orderly specifics at build.
interface IOrderlyAdapter is IVenueAdapter {
    /// @notice OPS_VENUE: reported balances from the Orderly API (signed off-chain, stored on-chain).
    function report(uint256 insuranceUsd, int256 marginUsd, int256 netExposureUsd, uint64 asOf) external;
    /// @notice OPS_VENUE: marks an async withdrawal as executed on Orderly (funds now in flight to adapter).
    function confirmWithdraw(uint256 requestNonce) external;
    /// @notice Timelock: delegate signer EOA used by ops-venue for Orderly API (withdrawal) signatures.
    function setDelegateSigner(address signer) external;
    function accountId(uint8 account) external view returns (bytes32);
    function maxFeeSweepPerPeriodUsd() external view returns (uint256);
}

/// @title IPoolEngineAdapter — in-house pool-vs-trader engine path.
interface IPoolEngineAdapter is IVenueAdapter {
    function marketId() external view returns (uint256);
    /// @notice Only desk (mandate-checked): sets the pool's quote (spread, skew, max net exposure).
    function setQuote(uint16 spreadBps, int16 skewBps, uint128 maxNetExposureUsd) external;
    /// @notice Only desk / RISK on kill: stop new risk on the market (reduce-only) .
    function setReduceOnly(bool reduceOnly) external;
}
