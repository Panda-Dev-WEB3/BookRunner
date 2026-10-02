// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {BRTypes} from "./interfaces/BRTypes.sol";
import {IMarkRegistry, IMarkRegistryAtomic} from "./interfaces/IMarkRegistry.sol";
import {IBookFactory} from "./interfaces/IBookFactory.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {IBook} from "./interfaces/IBook.sol";
import {IOrderlyAdapter, IVenueAdapter} from "./interfaces/IVenueAdapter.sol";

/// @dev AttestedOracle pull-update entry point (LOW_GAS §1): verifies and stores every signed update in
///      `priceData` that is newer than the stored one (skips the rest), reverts on a bad signature.
///      Local minimal interface so this contract does not depend on the frozen IAttestedOracle surface.
interface IAttestedOracleUpdate {
    function update(bytes calldata priceData) external;
}

/// @title MarkRegistry — signed, receipt-rooted period marks.
/// @notice The mark service signs an EIP-712 `Mark` (domain "Bookrunner MarkRegistry" / "1"); anyone may
///         relay it. A commit is accepted only if the signature recovers to a MARK_SIGNER and the period
///         is aligned to `config.markInterval()`, strictly after the book's previous committed period,
///         not in the future and no older than `config.maxMarkAge()`, for a book registered by the
///         factory. Mark ids are global and start at 1. Only the mark's book may flag it applied.
///
///         Stale-mark replacement: a commit for the SAME period as the book's latest mark is accepted
///         (superseding it as `latestMarkId`) only while that latest mark is unapplied and its `flowNonce`
///         no longer equals `book.flowNonce()`, i.e. it can never be applied (Book.applyMark requires the
///         current nonce). A capital flow between commit and apply therefore cannot burn the period, while
///         an applicable mark can never be equivocated.
///
///         One mark transaction per book per period (LOW_GAS §3): `commitAndApply` lets the keeper land the
///         period's signed oracle prices, the book's signed venue report (Orderly books), the mark commit and
///         `Book.applyMark` atomically. Book is at its size limit, so the orchestration lives here; `commit`
///         and `Book.applyMark` stay callable separately.
/// @dev Typed data mirrored by `packages/shared/src/eip712.ts` (`markTypes`).
contract MarkRegistry is IMarkRegistryAtomic, EIP712 {
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

    /// @notice `newMarkId` replaced the stale, unapplied `oldMarkId` for the same `periodEnd` of `bookId`.
    event MarkSuperseded(
        uint256 indexed bookId, uint256 indexed oldMarkId, uint256 indexed newMarkId, uint64 periodEnd
    );
    /// @notice `commitAndApply` did not relay a venue report for `bookId` because the adapter already holds
    ///         one at least as new (`asOf <= valuationAt`), e.g. the same signed report was relayed first.
    event VenueReportSkipped(
        uint256 indexed bookId, address indexed adapter, uint64 asOf, uint64 valuationAt
    );

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
        (markId,) = _commit(m, sig);
    }

    /// @inheritdoc IMarkRegistryAtomic
    /// @dev Anyone. Steps run in order and the whole call reverts if any of them reverts:
    ///        1. `IAttestedOracleUpdate(config.oracle()).update(priceData)` when `priceData` is non-empty
    ///           (reverts `NotConfigured("oracle")` if no oracle is set);
    ///        2. when `venueReport` is non-empty: decodes `(insuranceUsd, marginUsd, netExposureUsd, asOf, sig)`
    ///           and calls `reportSigned` on `factory.componentsOf(m.bookId).adapter`, unless that adapter's
    ///           `valuationAt() >= asOf` (the same or a newer report already landed, e.g. the published report
    ///           relayed by someone else first): then the relay is skipped with `VenueReportSkipped`, so
    ///           front-running the keeper with its own report cannot grief the mark. Every other rejection
    ///           (signature, signer, withdrawal pending, report predating a flow, range) reverts the mark;
    ///        3. `commit(m, sig)` with identical checks (incl. stale-mark replacement);
    ///        4. `IBook(factory.bookOf(m.bookId)).applyMark(markId)` (state / order / flowNonce checks are the
    ///           book's; a mark that cannot be applied therefore is not committed either).
    function commitAndApply(
        BRTypes.MarkInput calldata m,
        bytes calldata sig,
        bytes calldata priceData,
        bytes calldata venueReport
    ) external returns (uint256 markId) {
        if (priceData.length != 0) {
            address oracle = config.oracle();
            if (oracle == address(0)) revert NotConfigured("oracle");
            IAttestedOracleUpdate(oracle).update(priceData);
        }
        if (venueReport.length != 0) _relayVenueReport(m.bookId, venueReport);
        address book;
        (markId, book) = _commit(m, sig);
        IBook(book).applyMark(markId);
    }

    /// @notice Whether a commit for `bookId`'s latest committed period would currently be accepted as a
    ///         replacement (latest mark unapplied and its flowNonce != book.flowNonce()).
    function latestMarkReplaceable(uint256 bookId) external view returns (bool) {
        return _staleLatest(bookId) != 0;
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

    /// @dev `commit` body: verifies and stores `m`; returns its id and the book address.
    function _commit(BRTypes.MarkInput calldata m, bytes calldata sig)
        private
        returns (uint256 markId, address book)
    {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hashMark(m), sig);
        if (err != ECDSA.RecoverError.NoError) revert InvalidSignature();
        if (!config.hasRole(MARK_SIGNER_ROLE, signer)) revert NotMarkSigner(signer);

        uint64 periodEnd = m.periodEnd;
        uint32 interval = config.markInterval();
        if (periodEnd % interval != 0) revert PeriodNotAligned(periodEnd, interval);
        uint64 last = lastPeriodEnd[m.bookId];
        uint256 superseded;
        if (periodEnd < last || (periodEnd == last && (superseded = _staleLatest(m.bookId)) == 0)) {
            revert PeriodNotAfterLast(periodEnd, last);
        }
        if (periodEnd > block.timestamp) revert PeriodInFuture(periodEnd, block.timestamp);
        uint32 maxAge = config.maxMarkAge();
        if (block.timestamp - periodEnd > maxAge) revert MarkTooOld(periodEnd, block.timestamp, maxAge);
        book = _factory().bookOf(m.bookId);
        if (book == address(0)) revert UnknownBook(m.bookId);

        markId = ++markCount;
        BRTypes.Mark storage mk = _marks[markId];
        mk.input = m;
        mk.signer = signer;
        mk.committedAt = uint64(block.timestamp);
        latestMarkId[m.bookId] = markId;
        lastPeriodEnd[m.bookId] = periodEnd;

        if (superseded != 0) emit MarkSuperseded(m.bookId, superseded, markId, periodEnd);
        _emitCommitted(markId, m, signer);
    }

    /// @dev Step 2 of `commitAndApply`: relays the signed venue report to the book's adapter (see there).
    function _relayVenueReport(uint256 bookId, bytes calldata venueReport) private {
        address adapter = _factory().componentsOf(bookId).adapter;
        if (adapter == address(0)) revert UnknownBook(bookId);
        (uint256 insuranceUsd, int256 marginUsd, int256 exposureUsd, uint64 asOf, bytes memory reportSig) =
            abi.decode(venueReport, (uint256, int256, int256, uint64, bytes));
        uint64 valuationAt = IVenueAdapter(adapter).valuationAt();
        if (asOf <= valuationAt) {
            emit VenueReportSkipped(bookId, adapter, asOf, valuationAt);
            return;
        }
        IOrderlyAdapter(adapter).reportSigned(insuranceUsd, marginUsd, exposureUsd, asOf, reportSig);
    }

    /// @dev The book's latest mark id if it exists, is unapplied and was computed against a flowNonce the
    ///      book has moved past (so it can never be applied); 0 otherwise.
    function _staleLatest(uint256 bookId) private view returns (uint256 id) {
        id = latestMarkId[bookId];
        if (id == 0) return 0;
        BRTypes.Mark storage prev = _marks[id];
        if (prev.applied) return 0;
        address book = _factory().bookOf(bookId);
        if (book == address(0) || prev.input.flowNonce == IBook(book).flowNonce()) return 0;
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
