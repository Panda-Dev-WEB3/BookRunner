// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IUnderwritingVault — holds a book's undeployed USDC. Capital leaves only to the book's
///        venue adapter (IF / MM accounts), the book's desk (hedge budget) or tranche escrows (claims).
///        recall() always lands back in this vault. Every deploy/recall calls book.onCapitalFlow().
interface IUnderwritingVault {
    function initialize(address config, uint256 bookId, address book) external;
    function book() external view returns (address);
    function asset() external view returns (address);
    function idle() external view returns (uint256);

    /// @notice Book (at closeWindow) or the desk (mandate-checked inventory move).
    function deployToVenue(uint8 account, uint256 amount) external;
    /// @notice Book, desk, KEEPER or RISK. Venue withdrawals are async on Orderly (ops executes) and
    ///         sync on the in-house engine. Funds can only return to this vault.
    function recall(uint8 account, uint256 amount) external;
    /// @notice Desk only (mandate-checked): moves USDC hedge budget vault -> desk.
    function fundDesk(uint256 amount) external;
    /// @notice Only book: tranche escrow funding for claims / window settlement transfers.
    function payTo(address to, uint256 amount) external;

    event Deployed(uint8 indexed account, uint256 amount);
    event RecallRequested(uint8 indexed account, uint256 amount, address indexed by);
    event DeskFunded(uint256 amount);
    event Paid(address indexed to, uint256 amount);
}
