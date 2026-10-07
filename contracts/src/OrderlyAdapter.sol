// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {IOrderlyAdapter, IVenueAdapter} from "./interfaces/IVenueAdapter.sol";
import {IOrderlyVault} from "./interfaces/external/IOrderlyVault.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {IBook} from "./interfaces/IBook.sol";
import {IRevenueRouter} from "./interfaces/IRevenueRouter.sol";
import {BRTypes} from "./interfaces/BRTypes.sol";

/// @dev UnderwritingVault hook: adapter pushes returned USDC, vault bumps book.flowNonce.
interface IVaultFlowNotify {
    function notifyCapitalFlow() external;
}

/// @title OrderlyAdapter — a book's venue adapter for the Orderly "Perp Anything" builder path.
/// @notice One ERC1967/UUPS proxy per Orderly book (upgrades only via `config.timelock()`).
///
///         Money paths (the ONLY ways USDC leaves this contract):
///           1. `depositToVenue`  vault -> adapter -> Orderly Vault (the venue pulls the exact amount).
///           2. `sweepToVault`    adapter -> the book's UnderwritingVault.
///           3. `sweepFees` / `forwardPendingFees`  adapter -> the book's RevenueRouter.
///         `rescueToken` (timelock) can never move USDC. There is no other transfer of USDC.
///
///         Valuation (consumed by the mark service and MMMandate):
///           venue-side balances = last `report` adjusted by flows since (deposits add, confirmed
///           withdrawals subtract), so mandate checks cannot be bypassed between reports.
///           deployedValueUsd = insurance + max(margin, 0) + inTransit, where inTransit is the amount of
///           confirmed (executed on Orderly) withdrawals not yet swept into the vault. Requested but
///           unconfirmed withdrawals are still venue-side and are counted there (never twice).
///
///         Withdrawal / report protocol (each USDC unit is counted exactly once, in any order of venue
///         payout vs `confirmWithdraw`):
///           Requested  counted venue-side. `report` reverts (`WithdrawalPending`) while any request is
///                      Requested, so no venue snapshot taken after the venue debit can overwrite the
///                      venue-side figure before the confirmation books that debit on-chain. A payout that
///                      lands before confirmation is HELD on the adapter (neither swept nor forwarded).
///           Confirmed  moved venue-side -> inTransit (ops-venue confirms as soon as the venue has debited
///                      the account). Reports are raw venue equity, i.e. net of executed withdrawals.
///           Swept      inTransit -> vault idle (mark-window gated, bumps `book.flowNonce`).
///         Reports must also already reflect every on-chain deposit (`asOf > lastFlowAt` is enforced
///         here; ops-venue must additionally wait until the venue has credited `totalDepositedUsd`).
///
///         Signed reports (LOW_GAS §2): ops-venue signs the same snapshot off-chain as EIP-712
///         `VenueReport(uint256 insuranceUsd,int256 marginUsd,int256 netExposureUsd,uint64 asOf)` under the
///         domain ("Bookrunner OrderlyAdapter", "1", chainId, this proxy) and anyone relays it through
///         `reportSigned` (typically MarkRegistry.commitAndApply inside the daily mark transaction). The
///         signer must hold OPS_VENUE; acceptance rules are exactly those of `report`, so the strictly
///         increasing `asOf` is the replay guard and the domain binds a report to one adapter on one chain.
///
///         Attribution of USDC sitting on the adapter is principal-first: up to `inTransitUsd` is returned
///         principal (vault-bound), then up to `pendingWithdrawUsd` is held for requested-but-unconfirmed
///         withdrawals (stays here), then up to `pendingFeesUsd` is fee flow (router-bound), anything else
///         is unattributed (vault-bound). Fee forwarding therefore never consumes principal.
///
///         Mark-window gate [ext]: while the book is Live/Retiring, `sweepToVault` may not move returned
///         principal once a mark period has ended until that period's mark is applied. A mark carries a
///         snapshot of `deployedValueUsd` (which includes in-transit principal) while `Book.applyMark`
///         reads `vault.idle()` live; without the gate a sweep between the mark snapshot and its
///         application would count the same USDC twice. Only principal sweeps notify the vault (flowNonce
///         bump); unattributed USDC was never part of `deployedValueUsd`, so sweeping it is a plain gain that
///         a mark counts once through `vault.idle()` and must not invalidate a committed mark.
///
/// @dev VERIFY (see docs/VERIFY.md): Orderly validates `accountId == keccak256(abi.encode(receiver,
///      brokerHash))` on deposit, i.e. ONE account per (address, broker). The devnet derivation used here
///      (two accounts per adapter) is accepted only by MockOrderlyVault; mainnet requires an upgrade that
///      maps IF/MM to real Orderly accounts. Orderly on Robinhood Chain lists USDG (not USDC) as its token.
/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract OrderlyAdapter is IOrderlyAdapter, Initializable, UUPSUpgradeable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    enum WithdrawStatus {
        None, // unknown nonce
        Requested, // vault asked; still venue-side
        Confirmed, // executed on Orderly; in transit to the adapter
        Cancelled, // ops-venue could not execute it; nothing moved
        Failed // confirmed, then failed on the venue; funds back venue-side
    }

    struct WithdrawRequest {
        uint128 amount; // requested amount (USDC 6dp)
        uint128 venueFee; // withdrawal fee charged by the venue (recorded at confirmation)
        uint64 requestedAt;
        uint64 confirmedAt;
        uint8 account; // BRTypes.ACCOUNT_IF | ACCOUNT_MM
        WithdrawStatus status;
    }

    /// @dev ERC-7201 namespaced storage. Append-only across upgrades: never reorder, retype or remove fields.
    /// @custom:storage-location erc7201:bookrunner.storage.OrderlyAdapter
    struct AdapterStorage {
        IBookrunnerConfig config;
        uint256 bookId;
        address book;
        address vault;
        address router;
        IERC20 usdc;
        IOrderlyVault orderlyVault;
        bytes32 brokerHash;
        bytes32 tokenHash;
        address delegateSigner;
        // venue-side balances: last report, adjusted by flows since
        uint256 insuranceUsd;
        int256 marginUsd;
        int256 netExposureUsd;
        uint64 lastReportAsOf;
        uint64 lastFlowAt;
        uint64 feePeriodFloor;
        // withdrawals
        uint256 withdrawNonce;
        uint256 inTransitUsd;
        uint256[2] pendingWithdrawUsd;
        mapping(uint256 nonce => WithdrawRequest) requests;
        // fee flow
        uint256 maxFeeSweepPerPeriodUsd;
        uint256 pendingFeesUsd;
        mapping(uint64 period => uint256 amount) feeSweptForPeriod;
        // statistics
        uint256[2] totalDepositedUsd;
        uint256 totalReturnedUsd;
        uint256 totalFeesForwardedUsd;
        // appended (v2): latest fee period label accepted by `sweepFees` (monotonic)
        uint64 lastSweptPeriod;
    }

    // ---------------------------------------------------------------------------------------------
    // Constants / immutables
    // ---------------------------------------------------------------------------------------------

    /// @notice Default per-period fee sweep cap: 2% of (ifTargetUsd + mmInventoryUsd).
    uint256 public constant DEFAULT_FEE_SWEEP_CAP_BPS = 200;
    /// @notice `sweepFees` accepts a period label at most this many mark intervals before the current
    ///         period start (ops-venue plans only the latest completed periods; older settlements carry
    ///         forward cumulatively), so at most (1 + lookback) caps can be earmarked in a burst.
    uint64 public constant FEE_SWEEP_LOOKBACK_PERIODS = 2;
    uint256 private constant BPS = 10_000;

    /// @inheritdoc IOrderlyAdapter
    bytes32 public constant REPORT_TYPEHASH =
        keccak256("VenueReport(uint256 insuranceUsd,int256 marginUsd,int256 netExposureUsd,uint64 asOf)");
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant EIP712_NAME_HASH = keccak256("Bookrunner OrderlyAdapter");
    bytes32 private constant EIP712_VERSION_HASH = keccak256("1");

    /// @dev keccak256(abi.encode(uint256(keccak256("bookrunner.storage.OrderlyAdapter")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0xbfdc54f9325019c58409789152d0f65a8a6ec89934e70c876f5b37182d3b8500;

    /// @notice Orderly broker hash copied into each proxy at initialize: keccak256(bytes(brokerId)). VERIFY.
    bytes32 public immutable DEFAULT_BROKER_HASH;
    /// @notice Orderly token hash copied into each proxy at initialize: keccak256(bytes("USDC")) on devnet;
    ///         Orderly on Robinhood Chain lists USDG (VERIFY).
    bytes32 public immutable DEFAULT_TOKEN_HASH;

    // ---------------------------------------------------------------------------------------------
    // Events (beyond IVenueAdapter)
    // ---------------------------------------------------------------------------------------------

    event AdapterInitialized(
        uint256 indexed bookId,
        address indexed book,
        address vault,
        address router,
        address orderlyVault,
        bytes32 brokerHash,
        bytes32 tokenHash,
        uint256 maxFeeSweepPerPeriodUsd
    );
    event OrderlyDeposit(uint8 indexed account, bytes32 indexed accountId, uint256 amount, uint256 nativeFee);
    event WithdrawConfirmed(
        uint256 indexed requestNonce, uint8 indexed account, uint256 amount, uint256 venueFee
    );
    event WithdrawCancelled(uint256 indexed requestNonce, uint8 indexed account, uint256 amount);
    event WithdrawFailed(uint256 indexed requestNonce, uint8 indexed account, uint256 amount);
    event VenueReported(uint256 insuranceUsd, int256 marginUsd, int256 netExposureUsd, uint64 asOf);
    /// @notice A `reportSigned` report signed by OPS_VENUE holder `signer` was accepted (relayed by `relayer`).
    event VenueReportRelayed(address indexed signer, address indexed relayer, uint64 asOf);
    event InTransitCleared(uint256 principalReturned, uint256 inTransitRemaining);
    event FeesForwarded(uint256 amount, uint256 stillPending);
    event PendingFeesCancelled(uint256 amount, address indexed by);
    event DelegateSignerSet(address indexed signer);
    event MaxFeeSweepSet(uint256 previousCap, uint256 newCap);
    event NativeRescued(address indexed to, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event CapitalFlowNotifyFailed(address indexed vault);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error ZeroHash();
    error ZeroMarkInterval();
    error NotFactory();
    error NotVault();
    error NotOpsVenue();
    error InvalidReportSignature();
    error NotOpsVenueSigner(address signer);
    error NotTimelock();
    error NotOpsVenueOrTimelock();
    error BookMismatch();
    error WrongVenue(uint8 venue);
    error NotBookAdapter();
    error InvalidAccount(uint8 account);
    error TokenNotAllowedByVenue(bytes32 tokenHash, address allowedToken);
    error InsufficientNativeForFee(uint256 fee, uint256 balance);
    error VenueDidNotPull(uint256 expected, uint256 pulled);
    error RequestNotPending(uint256 requestNonce, WithdrawStatus status);
    error RequestNotConfirmed(uint256 requestNonce, WithdrawStatus status);
    error VenueFeeExceedsAmount(uint256 venueFee, uint256 amount);
    error ReportInFuture(uint64 asOf, uint64 nowTs);
    error StaleReport(uint64 asOf, uint64 lastAsOf);
    error ReportPredatesFlow(uint64 asOf, uint64 lastFlowAt);
    error ReportOutOfRange();
    error PeriodMisaligned(uint64 period, uint32 markInterval);
    error PeriodInFuture(uint64 period);
    error PeriodBeforeBook(uint64 period, uint64 feePeriodFloor);
    error PeriodAlreadySwept(uint64 period);
    error PeriodNotAfterLastSwept(uint64 period, uint64 lastSweptPeriod);
    error PeriodTooOld(uint64 period, uint64 oldestAccepted);
    error WithdrawalPending(uint256 pendingUsd);
    error FeeSweepAboveCap(uint256 amount, uint256 cap);
    error ExceedsPendingFees(uint256 amount, uint256 pending);
    error SweepBlockedUntilMark(uint64 periodEnd, uint64 lastAppliedPeriodEnd);
    error CannotRescueUsdc();
    error NativeTransferFailed();

    // ---------------------------------------------------------------------------------------------
    // Construction / initialization
    // ---------------------------------------------------------------------------------------------

    /// @param defaultBrokerHash keccak256(bytes(brokerId)) of the builder's Orderly broker id (VERIFY).
    /// @param defaultTokenHash  keccak256(bytes(tokenSymbol)) of the deposit token on Orderly (VERIFY).
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(bytes32 defaultBrokerHash, bytes32 defaultTokenHash) {
        if (defaultBrokerHash == bytes32(0) || defaultTokenHash == bytes32(0)) revert ZeroHash();
        DEFAULT_BROKER_HASH = defaultBrokerHash;
        DEFAULT_TOKEN_HASH = defaultTokenHash;
        _disableInitializers();
    }

    /// @notice Binds the proxy to its book. Callable once, only by `config.factory()` (BookFactory.create),
    ///         after `book.initialize` (the book's components must list this proxy as the adapter).
    /// @param config_ BookrunnerConfig.
    /// @param bookId_ The book id (== charter id).
    /// @param book_ The book proxy.
    function initialize(address config_, uint256 bookId_, address book_) external initializer {
        if (config_ == address(0) || book_ == address(0)) revert ZeroAddress();
        IBookrunnerConfig cfg = IBookrunnerConfig(config_);
        if (msg.sender != cfg.factory()) revert NotFactory();
        if (IBook(book_).bookId() != bookId_) revert BookMismatch();

        AdapterStorage storage $ = _s();
        $.config = cfg;
        $.bookId = bookId_;
        $.book = book_;
        _bindBook($, book_);
        _bindVenue($, cfg);

        emit AdapterInitialized(
            bookId_,
            book_,
            $.vault,
            $.router,
            address($.orderlyVault),
            $.brokerHash,
            $.tokenHash,
            $.maxFeeSweepPerPeriodUsd
        );
    }

    /// @notice Accepts ETH used to pay Orderly/LayerZero deposit fees (and their refunds).
    receive() external payable {}

    // ---------------------------------------------------------------------------------------------
    // Vault-facing flows
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IVenueAdapter
    /// @dev Only the book's vault. Pulls `amount` USDC from the vault, approves the Orderly Vault for exactly
    ///      `amount` and deposits it into `accountId(account)`. Pays the venue's native deposit fee from this
    ///      contract's ETH balance when `getDepositFee > 0`. Credits the venue-side balance immediately.
    function depositToVenue(uint8 account, uint256 amount) external nonReentrant {
        AdapterStorage storage $ = _s();
        if (msg.sender != $.vault) revert NotVault();
        _checkAccount(account);
        if (amount == 0) revert ZeroAmount();
        _checkVenueToken($);

        IOrderlyVault ov = $.orderlyVault;
        IERC20 token = $.usdc;
        IOrderlyVault.VaultDepositFE memory data = IOrderlyVault.VaultDepositFE({
            accountId: _accountId(account),
            brokerHash: $.brokerHash,
            tokenHash: $.tokenHash,
            tokenAmount: SafeCast.toUint128(amount)
        });

        // effects
        _creditVenueSide($, account, amount);
        $.totalDepositedUsd[account] += amount;
        $.lastFlowAt = uint64(block.timestamp);

        // interactions
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 fee = ov.getDepositFee(address(this), data);
        if (fee > address(this).balance) revert InsufficientNativeForFee(fee, address(this).balance);
        uint256 balanceBefore = token.balanceOf(address(this));
        token.forceApprove(address(ov), amount);
        ov.deposit{value: fee}(data);
        uint256 balanceAfter = token.balanceOf(address(this));
        if (balanceAfter + amount != balanceBefore) {
            revert VenueDidNotPull(amount, balanceBefore > balanceAfter ? balanceBefore - balanceAfter : 0);
        }

        emit VenueDeposit(account, amount);
        emit OrderlyDeposit(account, data.accountId, amount, fee);
    }

    /// @inheritdoc IVenueAdapter
    /// @dev Only the book's vault. Asynchronous: records request `nonce` for ops-venue, which executes it
    ///      on Orderly (receiver = this adapter) and calls `confirmWithdraw(nonce)` as soon as the venue has
    ///      debited the account (before or after the payout lands — USDC landing first is held here).
    ///      Venue reports are rejected until the request is confirmed or cancelled.
    function requestWithdraw(uint8 account, uint256 amount) external {
        AdapterStorage storage $ = _s();
        if (msg.sender != $.vault) revert NotVault();
        _checkAccount(account);
        if (amount == 0) revert ZeroAmount();

        uint256 nonce = ++$.withdrawNonce;
        $.requests[nonce] = WithdrawRequest({
            amount: SafeCast.toUint128(amount),
            venueFee: 0,
            requestedAt: uint64(block.timestamp),
            confirmedAt: 0,
            account: account,
            status: WithdrawStatus.Requested
        });
        $.pendingWithdrawUsd[account] += amount;

        emit WithdrawRequested(account, amount, nonce);
    }

    /// @inheritdoc IVenueAdapter
    /// @dev Anyone. Sends returned principal plus unattributed USDC to the vault, keeping USDC held for
    ///      requested-but-unconfirmed withdrawals on the adapter and USDC attributed to pending fee sweeps
    ///      for the router. Returns 0 (no-op) when there is nothing to sweep. Reverts with
    ///      `SweepBlockedUntilMark` if principal would move while the current period's mark is unapplied.
    ///      Only a principal sweep notifies the vault (book.flowNonce++).
    function sweepToVault() external nonReentrant returns (uint256 amount) {
        AdapterStorage storage $ = _s();
        uint256 principal;
        (amount, principal) = _sweepable($);
        if (amount == 0) return 0;
        if (principal != 0) _checkSweepOpen($);

        uint256 remaining = $.inTransitUsd - principal;
        $.inTransitUsd = remaining;
        $.totalReturnedUsd += amount;

        $.usdc.safeTransfer($.vault, amount);

        emit SweptToVault(amount);
        if (principal != 0) {
            emit InTransitCleared(principal, remaining);
            // flowNonce++ so a mark valued with these funds still in transit can no longer be applied
            // (defence in depth on top of the sweep window gate). Best-effort: never blocks a sweep.
            // Unattributed USDC (donations, cancelled earmarks) never bumps the nonce: it was never in
            // deployedValueUsd, so a mark counts it once via vault.idle() and stays applicable.
            try IVaultFlowNotify($.vault).notifyCapitalFlow() {}
            catch {
                emit CapitalFlowNotifyFailed($.vault);
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Ops-venue flows (OPS_VENUE role)
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IOrderlyAdapter
    /// @dev OPS_VENUE. Requested -> Confirmed: moves the amount from venue-side to in-transit. Call it as
    ///      soon as the venue has debited the account; USDC that already landed (held) becomes principal.
    function confirmWithdraw(uint256 requestNonce) external {
        _checkOpsVenue();
        _confirm(requestNonce, 0);
    }

    /// @notice OPS_VENUE. As `confirmWithdraw`, recording a withdrawal fee charged by the venue: the full
    ///         amount leaves venue-side, `amount - venueFee` is expected back on the adapter.
    /// @param requestNonce The request to confirm.
    /// @param venueFee The venue's withdrawal fee (USDC 6dp), <= the requested amount.
    function confirmWithdrawWithFee(uint256 requestNonce, uint256 venueFee) external {
        _checkOpsVenue();
        _confirm(requestNonce, venueFee);
    }

    /// @notice OPS_VENUE. Requested -> Cancelled for a request the venue cannot execute (e.g. IF locked
    ///         while the symbol is listed). Nothing moves; the requester may recall again later. Never
    ///         cancel a request the venue executed (debited or paid): confirm it (and `failWithdraw` if the
    ///         venue later returns the funds). Sets `lastFlowAt`, so a venue snapshot taken while the
    ///         request was outstanding can no longer be reported.
    /// @param requestNonce The request to cancel.
    function cancelWithdraw(uint256 requestNonce) external {
        _checkOpsVenue();
        AdapterStorage storage $ = _s();
        WithdrawRequest storage r = $.requests[requestNonce];
        if (r.status != WithdrawStatus.Requested) revert RequestNotPending(requestNonce, r.status);
        r.status = WithdrawStatus.Cancelled;
        uint256 amount = r.amount;
        $.pendingWithdrawUsd[r.account] -= amount;
        $.lastFlowAt = uint64(block.timestamp);
        emit WithdrawCancelled(requestNonce, r.account, amount);
    }

    /// @notice OPS_VENUE. Confirmed -> Failed for a withdrawal that failed on the venue after confirmation
    ///         (funds credited back to the Orderly account): moves it from in-transit back to venue-side.
    /// @param requestNonce The confirmed request that failed.
    function failWithdraw(uint256 requestNonce) external {
        _checkOpsVenue();
        AdapterStorage storage $ = _s();
        WithdrawRequest storage r = $.requests[requestNonce];
        if (r.status != WithdrawStatus.Confirmed) revert RequestNotConfirmed(requestNonce, r.status);
        r.status = WithdrawStatus.Failed;
        uint256 amount = r.amount;
        uint256 expected = amount - r.venueFee;
        uint256 transit = $.inTransitUsd;
        $.inTransitUsd = transit - Math.min(transit, expected);
        _creditVenueSide($, r.account, amount);
        $.lastFlowAt = uint64(block.timestamp);
        emit WithdrawFailed(requestNonce, r.account, amount);
    }

    /// @inheritdoc IOrderlyAdapter
    /// @dev OPS_VENUE. Overwrites the venue-side balances with raw venue equity (net of every withdrawal the
    ///      venue executed, gross of nothing). Reverts `WithdrawalPending` while any withdrawal is Requested
    ///      (the venue debits on request, the adapter on confirmation: a snapshot in between would debit
    ///      the same amount twice). `asOf` must be strictly increasing, not in the future, and strictly
    ///      after the last on-chain flow (a snapshot taken before — or in the same second as — a
    ///      deposit/confirmation/cancellation/failure may not reflect it and would silently undo it).
    ///      Values are bounded to 128-bit ranges.
    function report(uint256 insuranceUsd, int256 marginUsd, int256 exposureUsd, uint64 asOf) external {
        _checkOpsVenue();
        _storeReport(insuranceUsd, marginUsd, exposureUsd, asOf);
    }

    /// @inheritdoc IOrderlyAdapter
    /// @dev Anyone relays; `sig` (65-byte, low-s ECDSA over `hashReport(...)`) must recover to an OPS_VENUE
    ///      holder at relay time (a revoked key's reports stop verifying). Then exactly `report`'s rules:
    ///      reverts `WithdrawalPending` while any withdrawal is Requested, `ReportInFuture`, `StaleReport`
    ///      (asOf not strictly after the last report: the replay guard), `ReportPredatesFlow`,
    ///      `ReportOutOfRange`. Emits `VenueReported` and `VenueReportRelayed(signer, msg.sender, asOf)`.
    function reportSigned(
        uint256 insuranceUsd,
        int256 marginUsd,
        int256 exposureUsd,
        uint64 asOf,
        bytes calldata sig
    ) external {
        (address signer, ECDSA.RecoverError err,) =
            ECDSA.tryRecoverCalldata(hashReport(insuranceUsd, marginUsd, exposureUsd, asOf), sig);
        if (err != ECDSA.RecoverError.NoError) revert InvalidReportSignature();
        IBookrunnerConfig cfg = _s().config;
        if (!cfg.hasRole(cfg.OPS_VENUE_ROLE(), signer)) revert NotOpsVenueSigner(signer);
        _storeReport(insuranceUsd, marginUsd, exposureUsd, asOf);
        emit VenueReportRelayed(signer, msg.sender, asOf);
    }

    /// @inheritdoc IOrderlyAdapter
    function hashReport(uint256 insuranceUsd, int256 marginUsd, int256 exposureUsd, uint64 asOf)
        public
        view
        returns (bytes32)
    {
        return MessageHashUtils.toTypedDataHash(
            DOMAIN_SEPARATOR(),
            keccak256(abi.encode(REPORT_TYPEHASH, insuranceUsd, marginUsd, exposureUsd, asOf))
        );
    }

    /// @notice EIP-712 domain separator of this adapter proxy: ("Bookrunner OrderlyAdapter", "1",
    ///         block.chainid, address(this)). Computed per call (proxy address, fork-safe chain id).
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, EIP712_NAME_HASH, EIP712_VERSION_HASH, block.chainid, address(this)
            )
        );
    }

    /// @notice ERC-5267 domain description (name, version, chainId, verifyingContract).
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        )
    {
        return (
            hex"0f",
            "Bookrunner OrderlyAdapter",
            "1",
            block.chainid,
            address(this),
            bytes32(0),
            new uint256[](0)
        );
    }

    /// @inheritdoc IVenueAdapter
    /// @dev OPS_VENUE, once per period. `period` is a mark-period label: a multiple of
    ///      `config.markInterval()`, `<= block.timestamp`, after the period in which the adapter was
    ///      initialized, strictly after the last swept label (monotonic) and at most
    ///      `FEE_SWEEP_LOOKBACK_PERIODS` intervals before the current period start (no backfill of old
    ///      labels: the per-period cap bounds the sweep rate). `amount <= maxFeeSweepPerPeriodUsd`. The
    ///      amount is earmarked as pending fee flow and as much as is available (USDC on the adapter beyond
    ///      in-transit principal and held withdrawals) is forwarded to the RevenueRouter now
    ///      (`notifySettlement(SRC_VENUE_TAKER_SHARE, swept)`); the rest is forwarded by
    ///      `forwardPendingFees` once the venue's fee withdrawal lands. Emits FeesSwept(period, amount).
    ///      Required ops order: sweepFees (earmark) -> fee payment to the adapter -> forwardPendingFees
    ///      (unearmarked USDC on the adapter is vault-bound and anyone may sweep it).
    /// @return swept USDC forwarded to the router in this call.
    function sweepFees(uint64 period, uint256 amount) external nonReentrant returns (uint256 swept) {
        _checkOpsVenue();
        AdapterStorage storage $ = _s();
        if (amount == 0) revert ZeroAmount();
        uint32 interval = $.config.markInterval();
        if (interval == 0) revert ZeroMarkInterval();
        if (period % interval != 0) revert PeriodMisaligned(period, interval);
        if (period > block.timestamp) revert PeriodInFuture(period);
        if (period <= $.feePeriodFloor) revert PeriodBeforeBook(period, $.feePeriodFloor);
        if ($.feeSweptForPeriod[period] != 0) revert PeriodAlreadySwept(period);
        uint64 last = $.lastSweptPeriod;
        if (period <= last) revert PeriodNotAfterLastSwept(period, last);
        uint64 oldest = _oldestFeePeriod(interval);
        if (period < oldest) revert PeriodTooOld(period, oldest);
        uint256 cap = $.maxFeeSweepPerPeriodUsd;
        if (amount > cap) revert FeeSweepAboveCap(amount, cap);

        $.feeSweptForPeriod[period] = amount;
        $.lastSweptPeriod = period;
        $.pendingFeesUsd += amount;
        emit FeesSwept(period, amount);

        swept = _forwardFees($);
    }

    /// @notice Anyone. Forwards pending fee flow that has landed on the adapter (USDC beyond in-transit
    ///         principal and USDC held for requested-but-unconfirmed withdrawals) to the book's RevenueRouter.
    /// @return amount USDC forwarded.
    function forwardPendingFees() external nonReentrant returns (uint256 amount) {
        amount = _forwardFees(_s());
    }

    /// @notice OPS_VENUE or timelock. Drops an earmark for fee flow that will not arrive; the USDC (if any)
    ///         then becomes vault-bound. Never moves funds.
    /// @param amount Amount of pending fees to cancel (<= pendingFeesUsd).
    function cancelPendingFees(uint256 amount) external {
        AdapterStorage storage $ = _s();
        IBookrunnerConfig cfg = $.config;
        if (!cfg.hasRole(cfg.OPS_VENUE_ROLE(), msg.sender) && msg.sender != cfg.timelock()) {
            revert NotOpsVenueOrTimelock();
        }
        if (amount == 0) revert ZeroAmount();
        uint256 pending = $.pendingFeesUsd;
        if (amount > pending) revert ExceedsPendingFees(amount, pending);
        $.pendingFeesUsd = pending - amount;
        emit PendingFeesCancelled(amount, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Timelock administration
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IOrderlyAdapter
    /// @dev Timelock. Calls `IOrderlyVault.delegateSigner({brokerHash, signer})`. Orderly requires the caller
    ///      to be a contract and the delegate to be an EOA; one delegate per contract account (a new one
    ///      replaces the old). The delegate signs Orderly API actions incl. withdrawals (receiver = adapter).
    function setDelegateSigner(address signer) external {
        _checkTimelock();
        if (signer == address(0)) revert ZeroAddress();
        AdapterStorage storage $ = _s();
        $.delegateSigner = signer;
        $.orderlyVault
            .delegateSigner(IOrderlyVault.VaultDelegate({brokerHash: $.brokerHash, delegateSigner: signer}));
        emit DelegateSignerSet(signer);
    }

    /// @notice Timelock. Sets the per-period fee sweep cap (0 disables fee sweeps).
    /// @param cap New cap in USDC 6dp.
    function setMaxFeeSweepPerPeriodUsd(uint256 cap) external {
        _checkTimelock();
        AdapterStorage storage $ = _s();
        emit MaxFeeSweepSet($.maxFeeSweepPerPeriodUsd, cap);
        $.maxFeeSweepPerPeriodUsd = cap;
    }

    /// @notice Timelock. Returns ETH held for venue deposit fees.
    /// @param to Recipient.
    /// @param amount Wei to send.
    function rescueNative(address payable to, uint256 amount) external nonReentrant {
        _checkTimelock();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit NativeRescued(to, amount);
    }

    /// @notice Timelock. Recovers a token sent here by mistake. Never USDC (USDC leaves only to vault/router).
    /// @param token The ERC20 to recover (must not be the book's USDC).
    /// @param to Recipient.
    /// @param amount Amount to send.
    function rescueToken(address token, address to, uint256 amount) external nonReentrant {
        _checkTimelock();
        AdapterStorage storage $ = _s();
        if (token == address($.usdc)) revert CannotRescueUsdc();
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IVenueAdapter
    function book() external view returns (address) {
        return _s().book;
    }

    /// @inheritdoc IVenueAdapter
    function venueKind() external pure returns (uint8) {
        return BRTypes.VENUE_ORDERLY;
    }

    /// @inheritdoc IOrderlyAdapter
    /// @dev Devnet derivation keccak256(abi.encode(address(this), brokerHash, account)) — VERIFY.
    function accountId(uint8 account) external view returns (bytes32) {
        _checkAccount(account);
        return _accountId(account);
    }

    /// @notice Native (ETH) fee the venue charges for depositing `amount` into `account` now
    ///         (`IOrderlyVault.getDepositFee`). `depositToVenue` pays it from this contract's balance and
    ///         reverts `InsufficientNativeForFee` without it (e.g. at `Book.closeWindow`): ops must keep
    ///         `address(adapter).balance >= depositNativeFee(...)` funded before deploys.
    function depositNativeFee(uint8 account, uint256 amount) external view returns (uint256) {
        _checkAccount(account);
        AdapterStorage storage $ = _s();
        return $.orderlyVault
            .getDepositFee(
                address(this),
                IOrderlyVault.VaultDepositFE({
                    accountId: _accountId(account),
                    brokerHash: $.brokerHash,
                    tokenHash: $.tokenHash,
                    tokenAmount: SafeCast.toUint128(amount)
                })
            );
    }

    /// @inheritdoc IOrderlyAdapter
    function maxFeeSweepPerPeriodUsd() external view returns (uint256) {
        return _s().maxFeeSweepPerPeriodUsd;
    }

    /// @inheritdoc IVenueAdapter
    function insuranceEquityUsd() external view returns (uint256) {
        return _s().insuranceUsd;
    }

    /// @inheritdoc IVenueAdapter
    function marginEquityUsd() external view returns (int256) {
        return _s().marginUsd;
    }

    /// @inheritdoc IVenueAdapter
    function netExposureUsd() external view returns (int256) {
        return _s().netExposureUsd;
    }

    /// @inheritdoc IVenueAdapter
    /// @dev Confirmed (executed on Orderly) withdrawals not yet swept into the vault, net of venue fees.
    ///      Requested-but-unconfirmed amounts are still counted venue-side (see `pendingWithdrawUsd`).
    function inTransitUsd() external view returns (uint256) {
        return _s().inTransitUsd;
    }

    /// @inheritdoc IVenueAdapter
    function deployedValueUsd() external view returns (uint256) {
        AdapterStorage storage $ = _s();
        int256 margin = $.marginUsd;
        return $.insuranceUsd + (margin > 0 ? uint256(margin) : 0) + $.inTransitUsd;
    }

    /// @inheritdoc IVenueAdapter
    function valuationAt() external view returns (uint64) {
        return _s().lastReportAsOf;
    }

    /// @notice BookrunnerConfig.
    function config() external view returns (address) {
        return address(_s().config);
    }

    /// @notice Book id (== charter id).
    function bookId() external view returns (uint256) {
        return _s().bookId;
    }

    /// @notice The book's UnderwritingVault (only destination of returned principal).
    function vault() external view returns (address) {
        return _s().vault;
    }

    /// @notice The book's RevenueRouter (only destination of fee flow).
    function router() external view returns (address) {
        return _s().router;
    }

    /// @notice The book's settlement token (config.usdc() at initialize).
    function usdc() external view returns (address) {
        return address(_s().usdc);
    }

    /// @notice Orderly Vault (config.orderlyVault() at initialize).
    function orderlyVault() external view returns (address) {
        return address(_s().orderlyVault);
    }

    /// @notice Orderly broker hash used for deposits and delegation.
    function brokerHash() external view returns (bytes32) {
        return _s().brokerHash;
    }

    /// @notice Orderly token hash used for deposits.
    function tokenHash() external view returns (bytes32) {
        return _s().tokenHash;
    }

    /// @notice Last delegate signer announced to Orderly (address(0) if none).
    function delegateSigner() external view returns (address) {
        return _s().delegateSigner;
    }

    /// @notice Timestamp of the last on-chain venue-side flow (deposit, confirmation, failure).
    function lastFlowAt() external view returns (uint64) {
        return _s().lastFlowAt;
    }

    /// @notice Last assigned withdrawal request nonce (nonces start at 1).
    function withdrawNonce() external view returns (uint256) {
        return _s().withdrawNonce;
    }

    /// @notice A withdrawal request by nonce.
    function withdrawRequest(uint256 requestNonce) external view returns (WithdrawRequest memory) {
        return _s().requests[requestNonce];
    }

    /// @notice Requested but not yet confirmed withdrawals for `account` (still venue-side). While the sum
    ///         over both accounts is non-zero, `report` reverts and landed USDC up to it is held.
    function pendingWithdrawUsd(uint8 account) external view returns (uint256) {
        _checkAccount(account);
        return _s().pendingWithdrawUsd[account];
    }

    /// @notice Fee flow authorised by `sweepFees` and not yet forwarded to the router.
    function pendingFeesUsd() external view returns (uint256) {
        return _s().pendingFeesUsd;
    }

    /// @notice Amount authorised by `sweepFees` for `period` (0 = not swept).
    function feeSweptForPeriod(uint64 period) external view returns (uint256) {
        return _s().feeSweptForPeriod[period];
    }

    /// @notice Fee periods must be strictly greater than this (aligned start of the initialization period).
    function feePeriodFloor() external view returns (uint64) {
        return _s().feePeriodFloor;
    }

    /// @notice Latest period label accepted by `sweepFees` (0 = none); the next must be strictly greater.
    function lastSweptPeriod() external view returns (uint64) {
        return _s().lastSweptPeriod;
    }

    /// @notice Cumulative deposits into `account`.
    function totalDepositedUsd(uint8 account) external view returns (uint256) {
        _checkAccount(account);
        return _s().totalDepositedUsd[account];
    }

    /// @notice Cumulative USDC swept to the vault.
    function totalReturnedUsd() external view returns (uint256) {
        return _s().totalReturnedUsd;
    }

    /// @notice Cumulative fee flow forwarded to the router.
    function totalFeesForwardedUsd() external view returns (uint256) {
        return _s().totalFeesForwardedUsd;
    }

    /// @notice Whether `sweepToVault` may currently move returned principal (mark-window gate).
    function sweepOpen() external view returns (bool) {
        return _sweepOpen(_s());
    }

    /// @notice Preview of the next `sweepToVault` amount (ignores the mark-window gate).
    function sweepableToVault() external view returns (uint256 amount) {
        (amount,) = _sweepable(_s());
    }

    /// @notice USDC on the adapter held for requested-but-unconfirmed withdrawals (a venue payout that
    ///         landed before `confirmWithdraw`): neither swept nor forwarded until confirmed.
    function heldForPendingWithdrawalsUsd() external view returns (uint256) {
        AdapterStorage storage $ = _s();
        uint256 balance = $.usdc.balanceOf(address(this));
        return balance - Math.min(balance, $.inTransitUsd) - _freeBalance($, balance);
    }

    /// @notice Preview of the next `forwardPendingFees` amount.
    function forwardableFees() external view returns (uint256) {
        AdapterStorage storage $ = _s();
        return Math.min($.pendingFeesUsd, _freeBalance($, $.usdc.balanceOf(address(this))));
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _s() private pure returns (AdapterStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    function _bindBook(AdapterStorage storage $, address book_) private {
        BRTypes.Charter memory charter = IBook(book_).getCharter();
        if (charter.venue != BRTypes.VENUE_ORDERLY) revert WrongVenue(charter.venue);
        BRTypes.BookComponents memory c = IBook(book_).components();
        if (c.adapter != address(this)) revert NotBookAdapter();
        if (c.vault == address(0) || c.router == address(0)) revert ZeroAddress();
        $.vault = c.vault;
        $.router = c.router;
        $.maxFeeSweepPerPeriodUsd = (uint256(charter.ifTargetUsd) + uint256(charter.mmInventoryUsd))
            * DEFAULT_FEE_SWEEP_CAP_BPS / BPS;
    }

    function _bindVenue(AdapterStorage storage $, IBookrunnerConfig cfg) private {
        address usdc_ = cfg.usdc();
        address ov = cfg.orderlyVault();
        if (usdc_ == address(0) || ov == address(0)) revert ZeroAddress();
        uint32 interval = cfg.markInterval();
        if (interval == 0) revert ZeroMarkInterval();
        $.usdc = IERC20(usdc_);
        $.orderlyVault = IOrderlyVault(ov);
        $.brokerHash = DEFAULT_BROKER_HASH;
        $.tokenHash = DEFAULT_TOKEN_HASH;
        $.feePeriodFloor = uint64(block.timestamp - (block.timestamp % interval));
        _checkVenueToken($);
    }

    /// @dev Shared acceptance rules + effects of `report` and `reportSigned` (see `report`).
    function _storeReport(uint256 insuranceUsd, int256 marginUsd, int256 exposureUsd, uint64 asOf) private {
        AdapterStorage storage $ = _s();
        uint256 pending = $.pendingWithdrawUsd[BRTypes.ACCOUNT_IF] + $.pendingWithdrawUsd[BRTypes.ACCOUNT_MM];
        if (pending != 0) revert WithdrawalPending(pending);
        if (asOf > block.timestamp) revert ReportInFuture(asOf, uint64(block.timestamp));
        if (asOf <= $.lastReportAsOf) revert StaleReport(asOf, $.lastReportAsOf);
        if (asOf <= $.lastFlowAt) revert ReportPredatesFlow(asOf, $.lastFlowAt);
        if (
            insuranceUsd > type(uint128).max || marginUsd > type(int128).max || marginUsd < type(int128).min
                || exposureUsd > type(int128).max || exposureUsd < type(int128).min
        ) revert ReportOutOfRange();

        $.insuranceUsd = insuranceUsd;
        $.marginUsd = marginUsd;
        $.netExposureUsd = exposureUsd;
        $.lastReportAsOf = asOf;

        emit VenueReported(insuranceUsd, marginUsd, exposureUsd, asOf);
    }

    function _accountId(uint8 account) private view returns (bytes32) {
        return keccak256(abi.encode(address(this), _s().brokerHash, account));
    }

    function _confirm(uint256 requestNonce, uint256 venueFee) private {
        AdapterStorage storage $ = _s();
        WithdrawRequest storage r = $.requests[requestNonce];
        if (r.status != WithdrawStatus.Requested) revert RequestNotPending(requestNonce, r.status);
        uint256 amount = r.amount;
        if (venueFee > amount) revert VenueFeeExceedsAmount(venueFee, amount);
        uint8 account = r.account;

        r.status = WithdrawStatus.Confirmed;
        r.confirmedAt = uint64(block.timestamp);
        r.venueFee = uint128(venueFee);
        $.pendingWithdrawUsd[account] -= amount;
        _debitVenueSide($, account, amount);
        $.inTransitUsd += amount - venueFee;
        $.lastFlowAt = uint64(block.timestamp);

        emit WithdrawConfirmed(requestNonce, account, amount, venueFee);
    }

    /// @dev Principal-first attribution of the adapter's USDC balance:
    ///        principal = min(balance, inTransit)                  -> vault (mark-window gated)
    ///        held      = min(balance - principal, pendingWithdraw) -> stays (payout landed before confirm)
    ///        fees      = min(pendingFees, free)                    -> router
    ///        free - fees                                           -> vault (unattributed)
    ///      where free = balance - principal - held.
    function _sweepable(AdapterStorage storage $) private view returns (uint256 amount, uint256 principal) {
        uint256 balance = $.usdc.balanceOf(address(this));
        principal = Math.min(balance, $.inTransitUsd);
        uint256 free = _freeBalance($, balance);
        amount = principal + free - Math.min($.pendingFeesUsd, free);
    }

    /// @dev USDC on the adapter beyond in-transit principal and USDC held for Requested withdrawals.
    function _freeBalance(AdapterStorage storage $, uint256 balance) private view returns (uint256) {
        uint256 reserved = $.inTransitUsd + $.pendingWithdrawUsd[BRTypes.ACCOUNT_IF]
            + $.pendingWithdrawUsd[BRTypes.ACCOUNT_MM];
        return balance - Math.min(balance, reserved);
    }

    /// @dev Oldest fee period label `sweepFees` accepts now (saturating at 0).
    function _oldestFeePeriod(uint32 interval) private view returns (uint64) {
        uint256 start = block.timestamp - (block.timestamp % interval);
        uint256 back = uint256(FEE_SWEEP_LOOKBACK_PERIODS) * interval;
        return start > back ? uint64(start - back) : 0;
    }

    function _forwardFees(AdapterStorage storage $) private returns (uint256 amount) {
        uint256 pending = $.pendingFeesUsd;
        if (pending == 0) return 0;
        amount = Math.min(pending, _freeBalance($, $.usdc.balanceOf(address(this))));
        if (amount == 0) return 0;

        $.pendingFeesUsd = pending - amount;
        $.totalFeesForwardedUsd += amount;

        address router_ = $.router;
        $.usdc.safeTransfer(router_, amount);
        IRevenueRouter(router_).notifySettlement(BRTypes.SRC_VENUE_TAKER_SHARE, amount);

        emit FeesForwarded(amount, pending - amount);
    }

    function _creditVenueSide(AdapterStorage storage $, uint8 account, uint256 amount) private {
        if (account == BRTypes.ACCOUNT_IF) $.insuranceUsd += amount;
        else $.marginUsd += SafeCast.toInt256(amount);
    }

    function _debitVenueSide(AdapterStorage storage $, uint8 account, uint256 amount) private {
        if (account == BRTypes.ACCOUNT_IF) {
            uint256 ins = $.insuranceUsd;
            $.insuranceUsd = ins - Math.min(ins, amount);
        } else {
            $.marginUsd -= SafeCast.toInt256(amount);
        }
    }

    function _sweepOpen(AdapterStorage storage $) private view returns (bool) {
        IBook b = IBook($.book);
        BRTypes.BookState st = b.state();
        if (st != BRTypes.BookState.Live && st != BRTypes.BookState.Retiring) return true;
        uint32 interval = $.config.markInterval();
        if (interval == 0) return true;
        // same reference as BookrunnerDesk._flowGate: before the first mark the subscription end stands in, so a
        // recall the desk lets a key start in the first (partial) period can also be swept back (no deadlock with
        // the mark, which refuses a venue report while that withdrawal is pending)
        uint64 lastEnd = b.lastMarkPeriodEnd();
        uint64 ref = lastEnd == 0 ? b.subscriptionEnds() : lastEnd;
        return ref >= block.timestamp - (block.timestamp % interval);
    }

    function _checkSweepOpen(AdapterStorage storage $) private view {
        if (!_sweepOpen($)) {
            uint32 interval = $.config.markInterval();
            revert SweepBlockedUntilMark(
                uint64(block.timestamp - (block.timestamp % interval)), IBook($.book).lastMarkPeriodEnd()
            );
        }
    }

    function _checkVenueToken(AdapterStorage storage $) private view {
        address allowed = $.orderlyVault.getAllowedToken($.tokenHash);
        if (allowed != address($.usdc)) revert TokenNotAllowedByVenue($.tokenHash, allowed);
    }

    function _checkAccount(uint8 account) private pure {
        if (account != BRTypes.ACCOUNT_IF && account != BRTypes.ACCOUNT_MM) revert InvalidAccount(account);
    }

    function _checkOpsVenue() private view {
        IBookrunnerConfig cfg = _s().config;
        if (!cfg.hasRole(cfg.OPS_VENUE_ROLE(), msg.sender)) revert NotOpsVenue();
    }

    function _checkTimelock() private view {
        if (msg.sender != _s().config.timelock()) revert NotTimelock();
    }

    /// @dev UUPS: only the protocol timelock may upgrade.
    function _authorizeUpgrade(address) internal view override {
        _checkTimelock();
    }
}
