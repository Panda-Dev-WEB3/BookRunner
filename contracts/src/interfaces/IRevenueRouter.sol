// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IRevenueRouter — per-book fee-flow waterfall.
/// @notice distribute(): expenses (capped) -> protocol carry (config.carryBps of net) -> Senior share
///         (charter.seniorHurdleBps of the remainder) -> Junior residual. Senior+Junior USDC goes to the
///         book's UnderwritingVault and is credited via IBook.creditDistribution.
interface IRevenueRouter {
    struct Amounts {
        uint256 gross;
        uint256 expenses;
        uint256 carry;
        uint256 senior;
        uint256 junior;
    }

    function initialize(address config, uint256 bookId, address book) external;
    function book() external view returns (address);
    function bookId() external view returns (uint256);

    /// @notice Push-style: caller has ALREADY transferred `amount` USDC to this router.
    ///         Callable by the book's adapter, the pool engine, or anyone donating fee flow.
    function notifySettlement(uint8 source, uint256 amount) external;
    /// @notice USDC received and not yet distributed.
    function pendingGross() external view returns (uint256);
    /// @notice KEEPER. `period` = periodEnd label of the mark period being settled.
    function distribute(uint64 period, uint256 expensesRequested) external returns (Amounts memory);
    /// @notice Pure preview of the split for `gross` and `expenses` given current book state.
    function previewSplit(uint256 gross, uint256 expensesRequested) external view returns (Amounts memory);

    event SettlementReceived(uint256 indexed bookId, uint8 indexed source, uint256 amount);
    /// @dev amounts = [gross, expenses, carry, senior, junior]
    event Distributed(uint256 indexed bookId, uint64 indexed period, uint256[5] amounts);
}
