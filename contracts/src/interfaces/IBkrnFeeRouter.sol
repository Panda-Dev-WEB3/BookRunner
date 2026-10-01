// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IBkrnFeeRouter — splits protocol carry: 50% buyback-to-stakers, 50% syndicate backstop.
interface IBkrnFeeRouter {
    /// @notice Called by a book's RevenueRouter after transferring `amount` USDC of carry.
    function notifyCarry(uint256 bookId, uint256 amount) external;
    /// @notice USDC waiting to be swapped to BKRN for stakers.
    function buybackPending() external view returns (uint256);
    /// @notice KEEPER: swaps pending USDC -> BKRN via the configured router and notifies staking.
    function executeBuyback(uint256 amountIn, uint256 minBkrnOut, uint24 poolFee) external returns (uint256 bkrnOut);

    event CarryReceived(uint256 indexed bookId, uint256 amount, uint256 toBuyback, uint256 toBackstop);
    event BuybackExecuted(uint256 usdcIn, uint256 bkrnOut);
}

/// @title IBackstop — syndicate backstop. Covers Senior shortfalls after Junior is exhausted, up to balance.
interface IBackstop {
    function balance() external view returns (uint256);
    /// @notice Only a registered Book. Transfers min(shortfall, balance) USDC to the book's vault.
    function cover(uint256 bookId, uint256 shortfall) external returns (uint256 covered);
    /// @notice Accounting hook when USDC arrives (fee router or donations).
    function notifyDeposit(uint256 amount) external;

    event Deposited(address indexed from, uint256 amount);
    event Covered(uint256 indexed bookId, uint256 requested, uint256 covered);
}
