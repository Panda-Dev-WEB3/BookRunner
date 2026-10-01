// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BRTypes} from "./BRTypes.sol";

/// @title IBookFactory — deploys one book's components per approved charter.
/// @notice Book: ERC1967Proxy -> Book impl (UUPS, timelock). Adapter: ERC1967Proxy -> Orderly/PoolEngine
///         adapter impl (UUPS, timelock). Tranches (x2), vault, mandate, router, desk: EIP-1167 clones.
///         Order: deploy all -> book.initialize(config, id, charter, components) -> each component
///         initialize(config, id, book) (tranches with kind) -> adapter.initialize.
interface IBookFactory {
    function create(uint256 charterId, BRTypes.Charter calldata charter)
        external
        returns (BRTypes.BookComponents memory);
    function componentsOf(uint256 bookId) external view returns (BRTypes.BookComponents memory);
    function bookOf(uint256 bookId) external view returns (address);
    function isBook(address book) external view returns (bool);
    function bookIdOf(address book) external view returns (uint256);
    /// @notice True for any component address of any book (used by Backstop/Engine/FeeRouter auth).
    function isComponent(address a) external view returns (bool);
    function bookIds() external view returns (uint256[] memory);

    event BookCreated(uint256 indexed bookId, address indexed book, BRTypes.BookComponents components);
    event ImplementationSet(bytes32 indexed kind, address impl);
}
