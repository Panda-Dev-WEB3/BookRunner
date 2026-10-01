// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {BRTypes} from "./interfaces/BRTypes.sol";
import {IMarkRegistry} from "./interfaces/IMarkRegistry.sol";
import {IBookFactory} from "./interfaces/IBookFactory.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";

/// @title MarkRegistry — signed, receipt-rooted period marks.
/// @notice The mark service signs an EIP-712 `Mark` (domain "Bookrunner MarkRegistry" / "1"); anyone may
///         relay it. A commit is accepted only if the signature recovers to a MARK_SIGNER and the period
///         is aligned to `config.markInterval()`, strictly after the book's previous committed period,
///         not in the future and no older than `config.maxMarkAge()`, for a book registered by the
///         factory. Mark ids are global and start at 1. Only the mark's book may flag it applied.
/// @dev Typed data mirrored by `packages/shared/src/eip712.ts` (`markTypes`).
contract MarkRegistry is IMarkRegistry, EIP712 {
    /// @inheritdoc IMarkRegistry
    bytes32 public constant MARK_TYPEHASH = keccak256(
        "Mark(uint256 bookId,uint64 periodEnd,uint256 navUsd,uint256 deployedValueUsd,uint64 flowNonce,bytes32 inventoryRoot,bytes32 pnlJsonHash,bytes32 receiptsRoot)"
    );

    bytes32 private constant MARK_SIGNER_ROLE = keccak256("MARK_SIGNER");

    /// @notice Protocol registry.
    IBookrunnerConfig public immutable config;

    /// @inheritdoc IMarkRegistry
    uint256 public markCount;
    /// @inheritdoc IMarkRegistry
    mapping(uint256 bookId => uint256 markId) public latestMarkId;
    /// @notice periodEnd of the book's latest committed mark (0 = none).
    mapping(uint256 bookId => uint64 periodEnd) public lastPeriodEnd;

    mapping(uint256 markId => BRTypes.Mark) private _marks;

    error ZeroAddress();
    error NotConfigured(bytes32 what);
    error InvalidSignature();
    error NotMarkSigner(address signer);
    error PeriodNotAligned(uint64 periodEnd, uint32 markInterval);
    error PeriodNotAfterLast(uint64 periodEnd, uint64 lastPeriodEnd);
    error PeriodInFuture(uint64 periodEnd, uint256 nowTs);
    error MarkTooOld(uint64 periodEnd, uint256 nowTs, uint32 maxMarkAge);
    error UnknownBook(uint256 bookId);
    error UnknownMark(uint256 markId);
    error NotBook(uint256 markId, address caller);
    error AlreadyApplied(uint256 markId);

    /// @param config_ BookrunnerConfig.
    constructor(address config_) EIP712("Bookrunner MarkRegistry", "1") {
        if (config_ == address(0)) revert ZeroAddress();
        config = IBookrunnerConfig(config_);
    }

    /// @inheritdoc IMarkRegistry
    function hashMark(BRTypes.MarkInput calldata m) public view returns (bytes32 digest) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    MARK_TYPEHASH,
                    m.bookId,
                    m.periodEnd,
                    m.navUsd,
                    m.deployedValueUsd,
                    m.flowNonce,
                    m.inventoryRoot,
                    m.pnlJsonHash,
                    m.receiptsRoot
                )
            )
        );
    }

    /// @notice EIP-712 domain separator of this registry.
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @inheritdoc IMarkRegistry
    function commit(BRTypes.MarkInput calldata m, bytes calldata sig) external returns (uint256 markId) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hashMark(m), sig);
        if (err != ECDSA.RecoverError.NoError) revert InvalidSignature();
        if (!config.hasRole(MARK_SIGNER_ROLE, signer)) revert NotMarkSigner(signer);

        uint64 periodEnd = m.periodEnd;
        uint32 interval = config.markInterval();
        if (periodEnd % interval != 0) revert PeriodNotAligned(periodEnd, interval);
        uint64 last = lastPeriodEnd[m.bookId];
        if (periodEnd <= last) revert PeriodNotAfterLast(periodEnd, last);
        if (periodEnd > block.timestamp) revert PeriodInFuture(periodEnd, block.timestamp);
        uint32 maxAge = config.maxMarkAge();
        if (block.timestamp - periodEnd > maxAge) revert MarkTooOld(periodEnd, block.timestamp, maxAge);
        if (_factory().bookOf(m.bookId) == address(0)) revert UnknownBook(m.bookId);

        markId = ++markCount;
        BRTypes.Mark storage mk = _marks[markId];
        mk.input = m;
        mk.signer = signer;
        mk.committedAt = uint64(block.timestamp);
        latestMarkId[m.bookId] = markId;
        lastPeriodEnd[m.bookId] = periodEnd;

        _emitCommitted(markId, m, signer);
    }

    /// @inheritdoc IMarkRegistry
    function getMark(uint256 markId) external view returns (BRTypes.Mark memory) {
        if (markId == 0 || markId > markCount) revert UnknownMark(markId);
        return _marks[markId];
    }

    /// @inheritdoc IMarkRegistry
    /// @dev Only `config.factory().bookOf(mark.bookId)`; each mark can be applied once.
    function markApplied(uint256 markId) external {
        if (markId == 0 || markId > markCount) revert UnknownMark(markId);
        BRTypes.Mark storage mk = _marks[markId];
        uint256 bookId = mk.input.bookId;
        if (_factory().bookOf(bookId) != msg.sender) revert NotBook(markId, msg.sender);
        if (mk.applied) revert AlreadyApplied(markId);
        mk.applied = true;
        emit MarkApplied(markId, bookId);
    }

    function _factory() private view returns (IBookFactory) {
        address factory = config.factory();
        if (factory == address(0)) revert NotConfigured("factory");
        return IBookFactory(factory);
    }

    function _emitCommitted(uint256 markId, BRTypes.MarkInput calldata m, address signer) private {
        emit MarkCommitted(
            markId,
            m.bookId,
            m.periodEnd,
            m.navUsd,
            m.deployedValueUsd,
            m.inventoryRoot,
            m.pnlJsonHash,
            m.receiptsRoot,
            signer
        );
    }
}
