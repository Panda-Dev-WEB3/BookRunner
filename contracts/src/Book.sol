// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {BRTypes} from "./interfaces/BRTypes.sol";
import {IBook} from "./interfaces/IBook.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {ITranche} from "./interfaces/ITranche.sol";
import {IUnderwritingVault} from "./interfaces/IUnderwritingVault.sol";
import {Waterfall} from "./libraries/Waterfall.sol";
import {BookLogic} from "./libraries/BookLogic.sol";
import {IBookTrancheHooks, ITrancheBookHooks} from "./Tranche.sol";

/// @dev MMMandate's reduce-only wind-down entry point (book only), not part of the frozen IMMMandate.
interface IMMMandateRetiring {
    function setRetiring() external;
}

/// @dev UnderwritingVault's backstop repayment (book only), not part of the frozen IUnderwritingVault.
interface IVaultBackstopRepay {
    function repayBackstop(uint256 amount) external;
}

/// @title Book — one book per approved charter (bookId == charterId). ERC1967 proxy, UUPS logic,
///        upgrades only via config.timelock(). Owns the waterfall accounting (S = Senior NAV,
///        J = Junior NAV) and the lifecycle Subscription -> Live -> Retiring -> Retired (or Cancelled).
/// @notice Accounting identity: S + J == vault idle + deployed - unfundedClaims at every applied mark,
///         where unfundedClaims are settled redemption assets not yet moved from the vault to tranche
///         escrow plus a backstop repayment not yet paid. Between marks S/J move only by credited fee
///         flow and (Retired) redemptions, each matched one-for-one by vault cash. Per-tranche values are indexed by kind
///         (BRTypes.SENIOR = 0, BRTypes.JUNIOR = 1).
/// @dev The heavy state transitions (closeWindow, applyMark, fundClaims, finalizeRetirement,
///      settleRetiredBacklog, onRetiredRedeem, the Retired price bump) live in the linked EXTERNAL library
///      `BookLogic` (EIP-170 headroom) and run by DELEGATECALL in this proxy's context, behind this
///      contract's `nonReentrant` entry points. Deploying a Book implementation therefore needs BookLogic
///      deployed and linked (forge links automatically in tests / scripts; see script/UpgradeBook.s.sol).
contract Book is IBook, IBookTrancheHooks, Initializable, UUPSUpgradeable, ReentrancyGuardTransient {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint8 internal constant S = BRTypes.SENIOR;
    uint8 internal constant J = BRTypes.JUNIOR;
    /// @notice Longest top-up round the sponsor may open.
    uint256 public constant MAX_TOPUP_WINDOW = 30 days;

    bytes32 public constant KILL_DRAWDOWN = "DRAWDOWN"; // == BookLogic.KILL_DRAWDOWN
    bytes32 public constant KILL_RETIRE = "RETIRE";

    /// @notice Stored facts about the last applied mark.
    struct LastMark {
        uint256 markId;
        uint64 periodEnd;
        uint64 flowNonce;
        uint256 navUsd;
        uint256 deployedValueUsd;
        uint256 backstopCovered;
    }

    /// @custom:storage-location erc7201:bookrunner.storage.Book
    struct BookStorage {
        address config;
        uint256 bookId;
        BRTypes.Charter charter;
        BRTypes.BookComponents components;
        BRTypes.BookState state;
        uint64 subscriptionEnds;
        uint32 markInterval;
        uint64 flowNonce;
        uint256[2] nav;
        uint256 seniorImpairment;
        uint256 perfIndex;
        uint256 highWater;
        int256 drawdownBps;
        uint256[2] unfunded;
        uint256[2] price; // at last applied mark; Retired: immediate-settlement price
        uint64[2] retiredEpoch;
        LastMark lastMark;
        bool markAppliedWhileRetiring;
        bool topUpOpen;
        uint64 topUpEndsAt;
        uint128[2] topUpCapacity;
        bool sponsorAbandoned;
        bytes32 lastKillReason;
        uint64 lastKillAt;
        // ---- appended (upgrade-safe) ----
        /// @dev backstop cover received and not yet repaid from later gains (A5-01)
        uint256 backstopDebt;
        /// @dev repayment owed to the backstop, netted from NAV, paid from vault idle once claims are funded
        uint256 backstopPayable;
    }

    // keccak256(abi.encode(uint256(keccak256("bookrunner.storage.Book")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant BOOK_STORAGE_LOCATION =
        0xafd306892a6154f35c973e251e6b4f2659d2ae19802986651fcc8ec3ae5c4c00;

    error ZeroAddress();
    error ComponentMismatch();
    error BadCharter();
    error BadConfig();
    error BadKind(uint8 kind);
    error BadState(BRTypes.BookState state);
    error NotTimelock();
    error NotRouter();
    error NotVault();
    error NotCharter();
    error NotMandate();
    error NotSponsor();
    error NotTranche();
    error WindowStillOpen(uint64 endsAt);
    error UnknownMark(uint256 markId);
    error MarkForOtherBook(uint256 markId, uint256 markBookId);
    error MarkAlreadyApplied(uint256 markId);
    error MarkOutOfOrder(uint64 periodEnd, uint64 lastPeriodEnd);
    error FlowNonceMismatch(uint64 expected, uint64 provided);
    error RetirementNotReady();
    error TopUpActive();
    error BadTopUp();
    error NewBooksPaused();
    /// @dev OZ SafeCast's error (same signature/selector), raised by Waterfall.applyMarkPnl inside the
    ///      linked BookLogic library and bubbled through Book. Declared here so Book's ABI still lists it
    ///      (an external library's errors are not part of the linking contract's ABI).
    error SafeCastOverflowedUintToInt(uint256 value);

    event BookInitialized(
        uint256 indexed bookId, address indexed sponsor, uint64 subscriptionEnds, uint32 markInterval
    );
    event CapitalFlow(uint256 indexed bookId, uint64 flowNonce);
    /// @notice Per-tranche detail of an applied mark ([senior, junior]): NAV after P&L + backstop (before
    ///         settlement), redemption assets settled and top-up assets accepted.
    event MarkSettled(
        uint256 indexed bookId,
        uint256 indexed markId,
        uint256 backstopCovered,
        uint256[2] navPostPnl,
        uint256[2] owed,
        uint256[2] topUp
    );
    event TopUpSettled(uint256 indexed bookId, uint256 seniorAccepted, uint256 juniorAccepted);
    event TopUpCancelled(uint256 indexed bookId);
    event BackstopCoverFailed(uint256 indexed bookId, uint256 shortfall);
    event MandateKillFailed(uint256 indexed bookId, bytes32 reason);
    event RetiredPriceSet(uint256 indexed bookId, uint8 indexed kind, uint256 priceWad, uint64 epoch);
    event RetiredRedemption(uint256 indexed bookId, uint8 indexed kind, uint256 assetsOwed);
    event RetiredBacklogSettled(uint256 indexed bookId, uint256 seniorOwed, uint256 juniorOwed);

    constructor() {
        _disableInitializers();
    }

    // =========================================================================================
    // Initialization / upgrades
    // =========================================================================================

    /// @notice Called once by the BookFactory, normally as the ERC1967Proxy constructor's init call
    ///         (OZ 5.7 proxies refuse empty init data), before any component is initialized.
    /// @param config_ BookrunnerConfig.
    /// @param bookId_ book id (== charter id).
    /// @param charter_ the approved charter (stored verbatim).
    /// @param c every component of this book; `c.book` must be this proxy or address(0) (the proxy
    ///          address is not known yet when initializing from the proxy constructor) and is stored as
    ///          address(this).
    function initialize(
        address config_,
        uint256 bookId_,
        BRTypes.Charter calldata charter_,
        BRTypes.BookComponents calldata c
    ) external initializer {
        if (config_ == address(0) || charter_.sponsor == address(0)) {
            revert ZeroAddress();
        }
        if (c.book != address(0) && c.book != address(this)) revert ComponentMismatch();
        if (
            c.senior == address(0) || c.junior == address(0) || c.vault == address(0)
                || c.mandate == address(0) || c.router == address(0) || c.desk == address(0)
                || c.adapter == address(0)
        ) revert ZeroAddress();
        if (charter_.seniorCapBps > BPS || charter_.seniorHurdleBps > BPS) revert BadCharter();
        uint32 interval = IBookrunnerConfig(config_).markInterval();
        if (interval == 0) revert BadConfig();

        BookStorage storage $ = _s();
        $.config = config_;
        $.bookId = bookId_;
        $.charter = charter_;
        $.components = c;
        $.components.book = address(this);
        $.state = BRTypes.BookState.Subscription;
        $.subscriptionEnds = uint64(block.timestamp) + charter_.subscriptionWindow;
        $.markInterval = interval;
        $.perfIndex = WAD;
        $.highWater = WAD;
        $.price = [WAD, WAD];
        emit BookInitialized(bookId_, charter_.sponsor, $.subscriptionEnds, interval);
    }

    /// @dev Upgrades only through the protocol timelock.
    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != IBookrunnerConfig(_s().config).timelock()) revert NotTimelock();
    }

    // =========================================================================================
    // Views
    // =========================================================================================

    function bookId() external view returns (uint256) {
        return _s().bookId;
    }

    function state() external view returns (BRTypes.BookState) {
        return _s().state;
    }

    function getCharter() external view returns (BRTypes.Charter memory) {
        return _s().charter;
    }

    function components() external view returns (BRTypes.BookComponents memory) {
        return _s().components;
    }

    function config() external view returns (address) {
        return _s().config;
    }

    function sponsor() external view returns (address) {
        return _s().charter.sponsor;
    }

    function subscriptionEnds() external view returns (uint64) {
        return _s().subscriptionEnds;
    }

    function markInterval() external view returns (uint32) {
        return _s().markInterval;
    }

    function trancheNav() external view returns (uint256 seniorNav, uint256 juniorNav) {
        BookStorage storage $ = _s();
        return ($.nav[S], $.nav[J]);
    }

    /// @notice WAD assets per share at the last applied mark (1e18 before the first mark); once Retired,
    ///         the price redemption requests settle at immediately.
    function sharePrice(uint8 kind) external view returns (uint256) {
        return _s().price[_kind(kind)];
    }

    function seniorImpairment() external view returns (uint256) {
        return _s().seniorImpairment;
    }

    function perfIndex() external view returns (uint256 index, uint256 highWater) {
        BookStorage storage $ = _s();
        return ($.perfIndex, $.highWater);
    }

    function drawdownBps() external view returns (int256) {
        return _s().drawdownBps;
    }

    function flowNonce() external view returns (uint64) {
        return _s().flowNonce;
    }

    function lastMarkId() external view returns (uint256) {
        return _s().lastMark.markId;
    }

    function lastMarkPeriodEnd() external view returns (uint64) {
        return _s().lastMark.periodEnd;
    }

    function lastMarkSummary() external view returns (LastMark memory) {
        return _s().lastMark;
    }

    /// @notice Vault cash owed out of the book and netted from its NAV: settled redemption assets owed to
    ///         tranche escrows but not yet funded, plus the backstop repayment not yet paid (the vault
    ///         reserves all of it from deployment).
    function unfundedClaims() external view returns (uint256) {
        return BookLogic.liabilities(_s());
    }

    /// @notice Backstop cover not yet repaid from gains (`debt`), and the part of it already earned back
    ///         by a gain, netted from NAV and waiting for vault idle (`payable_`).
    function backstopDebt() external view returns (uint256 debt, uint256 payable_) {
        BookStorage storage $ = _s();
        return ($.backstopDebt, $.backstopPayable);
    }

    function unfundedOf(uint8 kind) external view returns (uint256) {
        return _s().unfunded[_kind(kind)];
    }

    /// @notice NAV applyMark would compute for `deployedValueUsd` right now.
    function markedNavPreview(uint256 deployedValueUsd) external view returns (uint256) {
        BookStorage storage $ = _s();
        return Waterfall.markedNavNet(
            IUnderwritingVault($.components.vault).idle(), BookLogic.liabilities($), deployedValueUsd
        );
    }

    function retiredPrice(uint8 kind) external view returns (uint256 priceWad, uint64 epoch) {
        BookStorage storage $ = _s();
        uint8 k = _kind(kind);
        return ($.price[k], $.retiredEpoch[k]);
    }

    function topUp()
        external
        view
        returns (bool open, uint64 endsAt, uint128 seniorCapacityUsd, uint128 juniorCapacityUsd)
    {
        BookStorage storage $ = _s();
        return ($.topUpOpen, $.topUpEndsAt, $.topUpCapacity[S], $.topUpCapacity[J]);
    }

    /// @notice True once the sponsor moved Junior below 10% of supply while Live (committee may slash).
    function sponsorAbandoned() external view returns (bool) {
        return _s().sponsorAbandoned;
    }

    function lastKill() external view returns (bytes32 reason, uint64 at) {
        BookStorage storage $ = _s();
        return ($.lastKillReason, $.lastKillAt);
    }

    // =========================================================================================
    // Lifecycle
    // =========================================================================================

    /// @notice Anyone, once `subscriptionEnds` has passed. Allocates pro-rata (senior cap), checks the
    ///         sponsor holds >= 10% of Junior and the IF is fundable; on failure the book is Cancelled and
    ///         every commitment is refundable 1:1. On success capital moves to the vault and the IF + MM
    ///         inventory are deployed through the vault -> adapter.
    function closeWindow() external nonReentrant {
        BookLogic.closeWindow(_s());
    }

    /// @notice Anyone. Applies a committed mark: must be for this book, not applied, the book's latest
    ///         committed mark in the registry (a superseded older one reverts MarkOutOfOrder), newer than
    ///         the last applied mark and computed against the current flowNonce. Runs P&L through the
    ///         waterfall (Junior -> Senior -> backstop, backstop debt repaid from gains), the drawdown kill
    ///         check, settles due redemption buckets and an ended top-up round at the post-P&L share prices
    ///         and funds claims (then a backstop repayment owed) from vault idle.
    function applyMark(uint256 markId) external nonReentrant {
        BookLogic.applyMark(_s(), markId);
    }

    /// @notice Only the book's RevenueRouter, after transferring senior + junior USDC to the vault.
    function creditDistribution(uint256 seniorAmount, uint256 juniorAmount) external {
        BookStorage storage $ = _s();
        if (msg.sender != $.components.router) revert NotRouter();
        BRTypes.BookState st = $.state;
        if (st == BRTypes.BookState.Subscription || st == BRTypes.BookState.Cancelled) revert BadState(st);
        $.nav[S] += seniorAmount;
        $.nav[J] += juniorAmount;
        emit DistributionCredited($.bookId, seniorAmount, juniorAmount);
        if (st == BRTypes.BookState.Retired) {
            // late fee flow raises the immediate-settlement price for the remaining holders
            if (seniorAmount > 0) BookLogic.setRetiredPrice($, S, true);
            if (juniorAmount > 0) BookLogic.setRetiredPrice($, J, true);
        }
    }

    /// @notice Only the book's vault: every vault <-> venue / desk capital movement bumps the nonce, so a
    ///         mark valued against an older nonce can never be applied.
    function onCapitalFlow() external {
        BookStorage storage $ = _s();
        if (msg.sender != $.components.vault) revert NotVault();
        uint64 n = ++$.flowNonce;
        emit CapitalFlow($.bookId, n);
    }

    /// @notice Anyone: moves vault idle USDC to tranche escrows for settled-but-unfunded claims
    ///         (Senior claims first), then to the backstop for a repayment owed to it.
    function fundClaims() external nonReentrant returns (uint256 funded) {
        return BookLogic.fundClaims(_s());
    }

    /// @notice Only MarketCharter (sponsor or committee route). Live -> Retiring: cancels an open top-up
    ///         round and puts the mandate into reduce-only wind-down (`setRetiring`: no new risk, keys stay
    ///         active so the desk can flatten, return USDC and recall the venue toward finalizeRetirement).
    ///         Never blocked by the mandate: a failing call emits MandateKillFailed(bookId, "RETIRE").
    function retire() external nonReentrant {
        BookStorage storage $ = _s();
        if (msg.sender != IBookrunnerConfig($.config).charter()) revert NotCharter();
        if ($.state != BRTypes.BookState.Live) revert BadState($.state);
        $.state = BRTypes.BookState.Retiring;
        emit Retiring($.bookId);
        if ($.topUpOpen) {
            $.topUpOpen = false;
            emit TopUpCancelled($.bookId);
            ITrancheBookHooks($.components.senior).cancelRound();
            ITrancheBookHooks($.components.junior).cancelRound();
        }
        try IMMMandateRetiring($.components.mandate).setRetiring() {}
        catch {
            emit MandateKillFailed($.bookId, KILL_RETIRE);
        }
    }

    /// @notice Anyone once Retiring, after a mark applied while Retiring reported deployedValueUsd == 0
    ///         and no capital flowed since. -> Retired: fixes the final share prices, settles every pending
    ///         redemption bucket at them and releases the sponsor bond via the charter.
    function finalizeRetirement() external nonReentrant {
        BookLogic.finalizeRetirement(_s());
    }

    /// @notice Anyone, Retired: settles pending redemption buckets left over (beyond the per-call bucket
    ///         cap) at the final prices.
    function settleRetiredBacklog() external nonReentrant {
        BookLogic.settleRetiredBacklog(_s());
    }

    /// @notice Sponsor: opens a top-up round of `window` seconds. Commitments settle at the first mark
    ///         whose period ends at or after the round end, pro-rata up to the capacities (Senior also
    ///         capped by charter.seniorCapBps of book capital), at that mark's share prices.
    function openTopUp(uint32 window, uint128 seniorCapacityUsd, uint128 juniorCapacityUsd)
        external
        nonReentrant
    {
        BookStorage storage $ = _s();
        if (msg.sender != $.charter.sponsor) revert NotSponsor();
        if ($.state != BRTypes.BookState.Live) revert BadState($.state);
        if (IBookrunnerConfig($.config).newBooksPaused()) revert NewBooksPaused();
        if ($.topUpOpen) revert TopUpActive();
        if (window == 0 || window > MAX_TOPUP_WINDOW || (seniorCapacityUsd == 0 && juniorCapacityUsd == 0)) {
            revert BadTopUp();
        }
        uint64 endsAt = uint64(block.timestamp) + window;
        $.topUpOpen = true;
        $.topUpEndsAt = endsAt;
        $.topUpCapacity = [seniorCapacityUsd, juniorCapacityUsd];
        emit TopUpOpened($.bookId, endsAt, seniorCapacityUsd, juniorCapacityUsd);
        ITranche($.components.senior).openRound(endsAt);
        ITranche($.components.junior).openRound(endsAt);
    }

    /// @notice Only the book's MMMandate: records a kill (keys revoked, reduce-only).
    function onKill(bytes32 reason) external {
        BookStorage storage $ = _s();
        if (msg.sender != $.components.mandate) revert NotMandate();
        $.lastKillReason = reason;
        $.lastKillAt = uint64(block.timestamp);
        emit Killed($.bookId, reason);
    }

    // =========================================================================================
    // Tranche hooks
    // =========================================================================================

    /// @notice Only the Junior tranche, on any outflow of the sponsor's Junior shares. Never gates the
    ///         request: if the sponsor ends below 10% of Junior supply while Live, the book records
    ///         `sponsorAbandoned` and emits SponsorBelowSkin.
    function onJuniorRedeemRequested(address owner) external {
        BookStorage storage $ = _s();
        address junior = $.components.junior;
        if (msg.sender != junior) revert NotTranche();
        if ($.state != BRTypes.BookState.Live || owner != $.charter.sponsor) return;
        (uint256 unclaimed,) = ITranche(junior).claimableAllocation(owner);
        uint256 sponsorShares = IERC20(junior).balanceOf(owner) + unclaimed;
        uint256 supply = IERC20(junior).totalSupply();
        if (sponsorShares * BPS < supply * Waterfall.SPONSOR_MIN_JUNIOR_BPS) {
            $.sponsorAbandoned = true;
            emit SponsorBelowSkin($.bookId, sponsorShares, supply);
        }
    }

    /// @notice Only a tranche, Retired state: a redemption of `sharesBurned` (already burned) settled
    ///         immediately at the final price.
    function onRetiredRedeem(uint256 assetsOwed, uint256 sharesBurned) external nonReentrant {
        BookLogic.onRetiredRedeem(_s(), assetsOwed, sharesBurned);
    }

    // =========================================================================================
    // Internals
    // =========================================================================================

    function _s() private pure returns (BookStorage storage $) {
        assembly {
            $.slot := BOOK_STORAGE_LOCATION
        }
    }

    function _kind(uint8 kind) internal pure returns (uint8) {
        if (kind > J) revert BadKind(kind);
        return kind;
    }
}
