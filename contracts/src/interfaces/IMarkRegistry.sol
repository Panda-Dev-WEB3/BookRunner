// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BRTypes} from "./BRTypes.sol";

/// @title IMarkRegistry — daily signed, receipt-rooted marks.
/// @notice EIP-712 domain: name "Bookrunner MarkRegistry", version "1".
///         MARK_TYPEHASH = keccak256("Mark(uint256 bookId,uint64 periodEnd,uint256 navUsd,uint256 deployedValueUsd,uint64 flowNonce,bytes32 inventoryRoot,bytes32 pnlJsonHash,bytes32 receiptsRoot)")
///         Anyone may submit; the signature must recover to a MARK_SIGNER.
///         periodEnd must be a multiple of config.markInterval(), strictly greater than the book's
///         previous committed periodEnd, <= block.timestamp, and >= block.timestamp - maxMarkAge.
interface IMarkRegistry {
    function MARK_TYPEHASH() external view returns (bytes32);
    function hashMark(BRTypes.MarkInput calldata m) external view returns (bytes32 digest);
    function commit(BRTypes.MarkInput calldata m, bytes calldata sig) external returns (uint256 markId);
    function getMark(uint256 markId) external view returns (BRTypes.Mark memory);
    function latestMarkId(uint256 bookId) external view returns (uint256); // 0 = none
    function markCount() external view returns (uint256);
    /// @notice Only the book itself flags its mark as applied.
    function markApplied(uint256 markId) external;

    event MarkCommitted(
        uint256 indexed markId,
        uint256 indexed bookId,
        uint64 periodEnd,
        uint256 navUsd,
        uint256 deployedValueUsd,
        bytes32 inventoryRoot,
        bytes32 pnlJsonHash,
        bytes32 receiptsRoot,
        address signer
    );
    event MarkApplied(uint256 indexed markId, uint256 indexed bookId);
}

/// @title IMarkRegistryAtomic — LOW_GAS §3: one mark transaction per book per period (implemented by
///        MarkRegistry; a separate interface so IMarkRegistry implementers stay unchanged).
interface IMarkRegistryAtomic is IMarkRegistry {
    /// @notice Atomic, callable by anyone (keeper):
    ///           1. oracle.update(priceData)                    when priceData is non-empty
    ///           2. IOrderlyAdapter(adapter).reportSigned(...)  when venueReport is non-empty (Orderly books)
    ///           3. commit(m, sig)                              same checks as commit (incl. stale-mark replacement)
    ///           4. IBook(factory.bookOf(m.bookId)).applyMark(markId)
    ///         Reverts atomically if any step reverts.
    /// @param priceData abi.encode(IAttestedOracle.PriceUpdate[], bytes[]) or empty.
    /// @param venueReport abi.encode(uint256 insuranceUsd, int256 marginUsd, int256 netExposureUsd,
    ///        uint64 asOf, bytes sig) or empty; adapter = factory.componentsOf(m.bookId).adapter.
    function commitAndApply(
        BRTypes.MarkInput calldata m,
        bytes calldata sig,
        bytes calldata priceData,
        bytes calldata venueReport
    ) external returns (uint256 markId);
}
