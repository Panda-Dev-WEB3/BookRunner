// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BRTypes} from "./BRTypes.sol";

/// @title IBook — one book per approved charter (bookId == charterId). ERC1967 proxy, UUPS logic,
///        upgrades only via the 48h timelock. Owns the waterfall accounting (S, J) and lifecycle.
/// @notice Accounting identity (ARCHITECTURE.md §Waterfall): seniorNav + juniorNav == accounted NAV.
///         applyMark reconciles accounted NAV to marked NAV = vault.idle() - unfundedClaims + deployedValueUsd.
interface IBook {
    function initialize(
        address config,
        uint256 bookId,
        BRTypes.Charter calldata charter,
        BRTypes.BookComponents calldata components
    ) external;

    // ---- views ----
    function bookId() external view returns (uint256);
    function state() external view returns (BRTypes.BookState);
    function getCharter() external view returns (BRTypes.Charter memory);
    function components() external view returns (BRTypes.BookComponents memory);
    function config() external view returns (address);
    function sponsor() external view returns (address);
    function subscriptionEnds() external view returns (uint64);
    function trancheNav() external view returns (uint256 seniorNav, uint256 juniorNav);
    /// @notice WAD assets-per-share at the last applied mark (or 1e18 before first mark).
    function sharePrice(uint8 kind) external view returns (uint256);
    function seniorImpairment() external view returns (uint256);
    /// @notice Performance index (WAD, starts 1e18) and its high-water mark; drawdown measured on it.
    function perfIndex() external view returns (uint256 index, uint256 highWater);
    function drawdownBps() external view returns (int256);
    function flowNonce() external view returns (uint64);
    function lastMarkId() external view returns (uint256);
    function lastMarkPeriodEnd() external view returns (uint64);
    function unfundedClaims() external view returns (uint256);
    function markedNavPreview(uint256 deployedValueUsd) external view returns (uint256);

    // ---- lifecycle ----
    /// @notice Anyone, after subscriptionEnds. Allocates pro-rata, runs sponsor >=10% Junior check,
    ///         moves capital to the vault and deploys IF + MM inventory via the vault -> adapter.
    function closeWindow() external;
    /// @notice Anyone. Applies a committed mark from MarkRegistry (reverts if flowNonce mismatch,
    ///         out of order, not the book's latest committed mark, or already applied). Runs losses/gains, backstop, drawdown kill check,
    ///         settles due redemption + top-up buckets at the post-P&L share prices.
    function applyMark(uint256 markId) external;
    /// @notice Only the book's RevenueRouter, after transferring senior+junior USDC to the vault.
    function creditDistribution(uint256 seniorAmount, uint256 juniorAmount) external;
    /// @notice Only the book's vault: increments flowNonce on every vault<->venue/desk movement.
    function onCapitalFlow() external;
    /// @notice Anyone: moves vault idle USDC to tranche escrows for redemption claims still unfunded.
    function fundClaims() external returns (uint256 funded);
    /// @notice Only MarketCharter (sponsor or committee route). Live -> Retiring.
    function retire() external;
    /// @notice Anyone once Retiring and a mark with deployedValueUsd == 0 has been applied. -> Retired.
    function finalizeRetirement() external;
    /// @notice Sponsor: opens a top-up round; deposits settle at the next mark's prices, pro-rata.
    function openTopUp(uint32 window, uint128 seniorCapacityUsd, uint128 juniorCapacityUsd) external;
    /// @notice Only the book's MMMandate: records kill (keys revoked, reduce-only).
    function onKill(bytes32 reason) external;

    event WindowClosed(uint256 indexed bookId, uint256 seniorAllocated, uint256 juniorAllocated, uint256 seniorCommitted, uint256 juniorCommitted);
    event BookCancelled(uint256 indexed bookId, bytes32 reason);
    event CapitalDeployed(uint256 indexed bookId, uint256 ifAmount, uint256 mmAmount);
    event MarkApplied(
        uint256 indexed bookId,
        uint256 indexed markId,
        uint256 navUsd,
        int256 pnlUsd,
        uint256 seniorNav,
        uint256 juniorNav,
        uint256 seniorPrice,
        uint256 juniorPrice
    );
    event LossAbsorbed(uint256 indexed bookId, uint256 juniorLoss, uint256 seniorLoss, uint256 backstopCovered);
    event GainAllocated(uint256 indexed bookId, uint256 seniorRestored, uint256 juniorGain);
    event DistributionCredited(uint256 indexed bookId, uint256 seniorAmount, uint256 juniorAmount);
    event ClaimsFunded(uint256 indexed bookId, uint256 amount, uint256 stillUnfunded);
    event TopUpOpened(uint256 indexed bookId, uint64 endsAt, uint128 seniorCapacity, uint128 juniorCapacity);
    event Retiring(uint256 indexed bookId);
    event Retired(uint256 indexed bookId, uint256 finalNav);
    event Killed(uint256 indexed bookId, bytes32 reason);
    event SponsorBelowSkin(uint256 indexed bookId, uint256 sponsorShares, uint256 juniorSupply);
}
