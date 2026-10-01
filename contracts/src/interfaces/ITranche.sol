// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ITranche — Senior / Junior tranche of one book. ERC-20 shares (6 decimals) with an
///        ERC-7540-style asynchronous flow on top of ERC-4626 views:
///   * Subscriptions are commitments (window or top-up round), settled at window close / next mark,
///     pro-rata if over capacity. Claim shares + refund with claimAllocation().
///   * Redemptions are requests, settled at the first mark whose periodEnd >= eligibleAt
///     (Senior: request time; Junior: request time + juniorNoticeSeconds). Notice != gate.
///   * INVARIANT: requestRedeem and claims NEVER revert for lack of permission (no pause, no
///     allow-list, no kill, no book state blocks them). Claims may revert only with
///     InsufficientLiquidity when escrow is short (the mark service must prevent this).
///   * pause() blocks deposits only.
interface ITranche {
    error InsufficientLiquidity(uint256 needed, uint256 available);
    error DepositsClosed();
    error WalletCapExceeded(uint256 cap, uint256 attempted);

    function initialize(address config, uint256 bookId, address book, uint8 kind) external;

    // ---- views ----
    function book() external view returns (address);
    function bookId() external view returns (uint256);
    function kind() external view returns (uint8); // BRTypes.SENIOR | BRTypes.JUNIOR
    function asset() external view returns (address); // USDC
    function totalAssets() external view returns (uint256); // tranche NAV from the book
    function convertToAssets(uint256 shares) external view returns (uint256); // at last mark price
    function convertToShares(uint256 assets) external view returns (uint256);
    function depositsOpen() external view returns (bool);
    function paused() external view returns (bool);
    function totalCommitted() external view returns (uint256); // current round
    function committedOf(address wallet) external view returns (uint256); // current round

    // ---- subscriptions ----
    /// @notice ERC-4626 signature. Records a commitment for `receiver`; returns 0 (shares are minted at
    ///         settlement). Reverts DepositsClosed outside a window/top-up or while paused.
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    /// @notice Anyone may call for any wallet (push); shares and refund go to `wallet`.
    function claimAllocation(address wallet) external returns (uint256 shares, uint256 refund);
    function claimableAllocation(address wallet) external view returns (uint256 shares, uint256 refund);
    /// @notice Cancelled book: returns the wallet's full commitment.
    function claimCancelledRefund(address wallet) external returns (uint256 refund);

    // ---- redemptions (ERC-7540 style) ----
    /// @return requestId the bucket index (periodEnd / markInterval) the request settles in.
    function requestRedeem(uint256 shares, address controller, address owner) external returns (uint256 requestId);
    function pendingRedeemRequest(uint256 requestId, address controller) external view returns (uint256 shares);
    function claimableRedeemRequest(uint256 requestId, address controller) external view returns (uint256 shares);
    /// @notice USDC claimable by `controller` across all settled buckets.
    function claimableAssets(address controller) external view returns (uint256 assets);
    /// @notice Claims all settled redemptions of `controller` to `receiver`.
    ///         msg.sender must be controller or an approved operator; `claimFor` pushes to controller.
    function claimRedemption(address controller, address receiver) external returns (uint256 assets);
    function claimFor(address controller) external returns (uint256 assets);
    function setOperator(address operator, bool approved) external returns (bool);
    function isOperator(address controller, address operator) external view returns (bool);
    /// @notice Earliest timestamp a redeem requested now becomes eligible.
    function redeemEligibleAt(uint64 requestedAt) external view returns (uint64);

    // ---- book hooks (only book) ----
    /// @dev Settles commitments at window close. allocated = assets accepted (pro-rata), moved to vault.
    function settleWindow(uint256 allocatedAssets, address vault) external;
    /// @dev Settles due redemption buckets (index <= upToIndex) at `priceWad` and top-up commits.
    ///      Returns shares burned / assets owed, and top-up assets accepted / shares minted.
    function settleAtMark(uint256 upToIndex, uint256 priceWad, uint256 topUpCapacity, address vault)
        external
        returns (uint256 sharesBurned, uint256 assetsOwed, uint256 topUpAccepted, uint256 sharesMinted);
    function markCancelled() external;
    function openRound(uint64 endsAt) external;
    function pause() external; // GUARDIAN or sponsor via book; deposits only
    function unpause() external;

    event Committed(address indexed wallet, address indexed receiver, uint256 assets, uint256 round);
    event AllocationClaimed(address indexed wallet, uint256 shares, uint256 refund);
    event RedeemRequest(address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares);
    event BucketSettled(uint256 indexed requestId, uint256 shares, uint256 assets, uint256 priceWad);
    event RedemptionClaimed(address indexed controller, address indexed receiver, uint256 assets);
    event OperatorSet(address indexed controller, address indexed operator, bool approved);
}
