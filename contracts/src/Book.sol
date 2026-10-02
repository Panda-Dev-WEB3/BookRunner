// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {BRTypes} from "./interfaces/BRTypes.sol";
import {IBook} from "./interfaces/IBook.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {ITranche} from "./interfaces/ITranche.sol";
import {IUnderwritingVault} from "./interfaces/IUnderwritingVault.sol";
import {IMarkRegistry} from "./interfaces/IMarkRegistry.sol";
import {IMMMandate} from "./interfaces/IMMMandate.sol";
import {IMarketCharter} from "./interfaces/IMarketCharter.sol";
import {IBackstop} from "./interfaces/IBkrnFeeRouter.sol";
import {Waterfall} from "./libraries/Waterfall.sol";
import {IBookTrancheHooks, ITrancheBookHooks} from "./Tranche.sol";

/// @dev MMMandate's reduce-only wind-down entry point (book only), not part of the frozen IMMMandate.
interface IMMMandateRetiring {
    function setRetiring() external;
}

/// @title Book — one book per approved charter (bookId == charterId). ERC1967 proxy, UUPS logic,
///        upgrades only via config.timelock(). Owns the waterfall accounting (S = Senior NAV,
///        J = Junior NAV) and the lifecycle Subscription -> Live -> Retiring -> Retired (or Cancelled).
/// @notice Accounting identity: S + J == vault idle + deployed - unfundedClaims at every applied mark,
///         where unfundedClaims are settled redemption assets not yet moved from the vault to tranche
///         escrow. Between marks S/J move only by credited fee flow and (Retired) redemptions, each
///         matched one-for-one by vault cash. Per-tranche values are indexed by kind
///         (BRTypes.SENIOR = 0, BRTypes.JUNIOR = 1).
contract Book is IBook, IBookTrancheHooks, Initializable, UUPSUpgradeable, ReentrancyGuardTransient {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint8 internal constant S = BRTypes.SENIOR;
    uint8 internal constant J = BRTypes.JUNIOR;
    /// @notice Longest top-up round the sponsor may open.
    uint256 public constant MAX_TOPUP_WINDOW = 30 days;
    /// @dev settleAtMark index used once Retired: settles every remaining normal bucket.
    uint256 internal constant RETIRED_SETTLE_INDEX = (1 << 128) - 1;

    bytes32 public constant KILL_DRAWDOWN = "DRAWDOWN";
    bytes32 public constant KILL_RETIRE = "RETIRE";

    /// @notice Working summary of a mark application (memory only; emitted as MarkSettled).
    ///         Arrays are indexed by tranche kind.
    struct MarkSummary {
        uint256 markId;
        uint64 periodEnd;
        uint64 flowNonce; // book flowNonce the mark was applied at
        uint256 navUsd; // marked NAV = max(vault idle + deployed - unfunded claims, 0)
        uint256 deployedValueUsd;
        uint256 backstopCovered; // USDC actually received from the backstop
        uint256[2] navPostPnl; // tranche NAV after P&L + backstop, before redemptions / top-ups
        uint256[2] priceWad; // settlement prices
        uint256[2] owed; // redemption assets settled at this mark
        uint256[2] topUp; // top-up assets accepted at this mark
    }

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

    /// @notice Settled redemption assets owed to tranche escrows but not yet funded from the vault.
    function unfundedClaims() external view returns (uint256) {
        BookStorage storage $ = _s();
        return $.unfunded[S] + $.unfunded[J];
    }

    function unfundedOf(uint8 kind) external view returns (uint256) {
        return _s().unfunded[_kind(kind)];
    }

    /// @notice NAV applyMark would compute for `deployedValueUsd` right now.
    function markedNavPreview(uint256 deployedValueUsd) external view returns (uint256) {
        BookStorage storage $ = _s();
        return Waterfall.markedNavNet(
            IUnderwritingVault($.components.vault).idle(), $.unfunded[S] + $.unfunded[J], deployedValueUsd
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
        BookStorage storage $ = _s();
        if ($.state != BRTypes.BookState.Subscription) revert BadState($.state);
        if (block.timestamp < $.subscriptionEnds) revert WindowStillOpen($.subscriptionEnds);

        ITranche senior = ITranche($.components.senior);
        ITranche junior = ITranche($.components.junior);
        uint256 sCommitted = senior.totalCommitted();
        uint256 jCommitted = junior.totalCommitted();
        Waterfall.WindowResult memory r = Waterfall.allocateWindow(
            Waterfall.WindowInput({
                ifTargetUsd: $.charter.ifTargetUsd,
                mmInventoryUsd: $.charter.mmInventoryUsd,
                seniorCapBps: $.charter.seniorCapBps,
                seniorCommitted: sCommitted,
                juniorCommitted: jCommitted,
                sponsorJuniorCommitted: junior.committedOf($.charter.sponsor)
            })
        );

        if (!r.ok) {
            $.state = BRTypes.BookState.Cancelled;
            emit BookCancelled($.bookId, _reasonCode(r.reason));
            senior.markCancelled();
            junior.markCancelled();
            return;
        }

        $.nav = [r.seniorAllocated, r.juniorAllocated];
        $.state = BRTypes.BookState.Live;
        emit WindowClosed($.bookId, r.seniorAllocated, r.juniorAllocated, sCommitted, jCommitted);

        address vault = $.components.vault;
        senior.settleWindow(r.seniorAllocated, vault);
        junior.settleWindow(r.juniorAllocated, vault);

        (uint256 ifAmount, uint256 mmAmount,) = Waterfall.initialDeployment(
            r.seniorAllocated + r.juniorAllocated, $.charter.ifTargetUsd, $.charter.mmInventoryUsd
        );
        emit CapitalDeployed($.bookId, ifAmount, mmAmount);
        if (ifAmount > 0) IUnderwritingVault(vault).deployToVenue(BRTypes.ACCOUNT_IF, ifAmount);
        if (mmAmount > 0) IUnderwritingVault(vault).deployToVenue(BRTypes.ACCOUNT_MM, mmAmount);
    }

    /// @notice Anyone. Applies a committed mark: must be for this book, not applied, newer than the last
    ///         applied mark and computed against the current flowNonce. Runs P&L through the waterfall
    ///         (Junior -> Senior -> backstop), the drawdown kill check, settles due redemption buckets and
    ///         an ended top-up round at the post-P&L share prices and funds claims from vault idle.
    function applyMark(uint256 markId) external nonReentrant {
        BookStorage storage $ = _s();
        BRTypes.BookState st = $.state;
        if (st != BRTypes.BookState.Live && st != BRTypes.BookState.Retiring) revert BadState(st);
        IBookrunnerConfig cfg = IBookrunnerConfig($.config);
        IMarkRegistry registry = IMarkRegistry(cfg.markRegistry());
        BRTypes.Mark memory m = registry.getMark(markId);
        if (m.committedAt == 0 || m.signer == address(0)) revert UnknownMark(markId);
        if (m.input.bookId != $.bookId) revert MarkForOtherBook(markId, m.input.bookId);
        if (m.applied) revert MarkAlreadyApplied(markId);
        if (m.input.periodEnd <= $.lastMark.periodEnd) {
            revert MarkOutOfOrder(m.input.periodEnd, $.lastMark.periodEnd);
        }
        if (m.input.flowNonce != $.flowNonce) revert FlowNonceMismatch($.flowNonce, m.input.flowNonce);

        MarkSummary memory sum;
        sum.markId = markId;
        sum.periodEnd = m.input.periodEnd;
        sum.flowNonce = $.flowNonce;
        sum.deployedValueUsd = m.input.deployedValueUsd;

        int256 pnl = _applyPnl($, cfg, sum);
        _maybeDrawdownKill($);
        _settleAtMark($, sum);

        $.lastMark = LastMark({
            markId: markId,
            periodEnd: sum.periodEnd,
            flowNonce: sum.flowNonce,
            navUsd: sum.navUsd,
            deployedValueUsd: sum.deployedValueUsd,
            backstopCovered: sum.backstopCovered
        });
        if (st == BRTypes.BookState.Retiring) $.markAppliedWhileRetiring = true;
        _fundClaims($);
        registry.markApplied(markId);
        emit MarkSettled($.bookId, markId, sum.backstopCovered, sum.navPostPnl, sum.owed, sum.topUp);
        emit MarkApplied(
            $.bookId, markId, sum.navUsd, pnl, $.nav[S], $.nav[J], sum.priceWad[S], sum.priceWad[J]
        );
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
            if (seniorAmount > 0) _setRetiredPrice($, S, true);
            if (juniorAmount > 0) _setRetiredPrice($, J, true);
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
    ///         (Senior claims first).
    function fundClaims() external nonReentrant returns (uint256 funded) {
        return _fundClaims(_s());
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
        BookStorage storage $ = _s();
        if ($.state != BRTypes.BookState.Retiring) revert BadState($.state);
        LastMark storage lm = $.lastMark;
        if (!$.markAppliedWhileRetiring || lm.deployedValueUsd != 0 || lm.flowNonce != $.flowNonce) {
            revert RetirementNotReady();
        }
        $.state = BRTypes.BookState.Retired;
        _setRetiredPrice($, S, false);
        _setRetiredPrice($, J, false);
        emit Retired($.bookId, $.nav[S] + $.nav[J]);
        _settleRetiredBacklog($);
        IMarketCharter(IBookrunnerConfig($.config).charter()).onRetired($.bookId);
    }

    /// @notice Anyone, Retired: settles pending redemption buckets left over (beyond the per-call bucket
    ///         cap) at the final prices.
    function settleRetiredBacklog() external nonReentrant {
        BookStorage storage $ = _s();
        if ($.state != BRTypes.BookState.Retired) revert BadState($.state);
        _settleRetiredBacklog($);
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
        BookStorage storage $ = _s();
        uint8 k;
        if (msg.sender == $.components.senior) k = S;
        else if (msg.sender == $.components.junior) k = J;
        else revert NotTranche();
        if ($.state != BRTypes.BookState.Retired) revert BadState($.state);
        if (k == S) _scaleImpairment($, sharesBurned, IERC20(msg.sender).totalSupply() + sharesBurned);
        $.nav[k] -= assetsOwed;
        $.unfunded[k] += assetsOwed;
        emit RetiredRedemption($.bookId, k, assetsOwed);
        _fundClaims($);
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

    function _tranche(BookStorage storage $, uint8 k) internal view returns (address) {
        return k == S ? $.components.senior : $.components.junior;
    }

    function _applyPnl(BookStorage storage $, IBookrunnerConfig cfg, MarkSummary memory sum)
        internal
        returns (int256 pnl)
    {
        address vault = $.components.vault;
        uint256 nav = Waterfall.markedNavNet(
            IUnderwritingVault(vault).idle(), $.unfunded[S] + $.unfunded[J], sum.deployedValueUsd
        );
        address backstop = cfg.backstop();
        Waterfall.MarkResult memory r = Waterfall.applyMarkPnl(
            Waterfall.MarkState({
                seniorNav: $.nav[S],
                juniorNav: $.nav[J],
                seniorImpairment: $.seniorImpairment,
                perfIndex: $.perfIndex,
                highWater: $.highWater
            }),
            Waterfall.MarkInputs({
                nav: nav,
                juniorSupply: IERC20($.components.junior).totalSupply(),
                backstopAvailable: _backstopBalance(backstop)
            })
        );

        uint256 covered;
        if (r.backstopCovered > 0) {
            uint256 shortfall = r.seniorImpairment + r.backstopCovered; // impairment before cover
            covered = _pullBackstop($.bookId, cfg, backstop, vault, shortfall);
            // replace the modelled cover with the USDC actually received
            r.seniorNav = r.seniorNav - r.backstopCovered + covered;
            r.seniorImpairment = shortfall - covered;
        }

        $.nav = [r.seniorNav, r.juniorNav];
        $.seniorImpairment = r.seniorImpairment;
        $.perfIndex = r.perfIndex;
        $.highWater = r.highWater;
        $.drawdownBps = r.drawdownBps;

        sum.navUsd = nav;
        sum.backstopCovered = covered;
        sum.navPostPnl = [r.seniorNav, r.juniorNav];
        pnl = r.pnl;

        if (r.juniorLoss > 0 || r.seniorLoss > 0 || covered > 0) {
            emit LossAbsorbed($.bookId, r.juniorLoss, r.seniorLoss, covered);
        }
        if (pnl > 0) {
            // senior side = impairment restored (+ the residual when Junior has no supply)
            emit GainAllocated($.bookId, uint256(pnl) - r.juniorGain, r.juniorGain);
        }
    }

    function _settleAtMark(BookStorage storage $, MarkSummary memory sum) internal {
        uint256 interval = $.markInterval;
        uint256 upTo = Waterfall.settlesUpTo(sum.periodEnd, interval);
        bool topUpDue = $.topUpOpen && upTo * interval >= $.topUpEndsAt;
        // prices from the post-P&L NAVs, before any settlement
        uint256 seniorSupply;
        for (uint8 k = 0; k < 2; k++) {
            uint256 supply = IERC20(_tranche($, k)).totalSupply();
            if (k == S) seniorSupply = supply;
            uint256 p = Waterfall.sharePriceWad($.nav[k], supply);
            $.price[k] = p;
            sum.priceWad[k] = p;
        }
        // Junior first so the Senior top-up cap sees the final Junior NAV
        _settleTranche($, sum, J, upTo, topUpDue ? $.topUpCapacity[J] : 0);
        uint256 seniorCap =
            topUpDue ? _seniorTopUpRoom($.nav[S], $.nav[J], $.charter.seniorCapBps, $.topUpCapacity[S]) : 0;
        _scaleImpairment($, _settleTranche($, sum, S, upTo, seniorCap), seniorSupply);

        if (topUpDue) {
            $.topUpOpen = false;
            emit TopUpSettled($.bookId, sum.topUp[S], sum.topUp[J]);
        }
    }

    /// @return burned redemption shares burned (settled) at this mark.
    function _settleTranche(BookStorage storage $, MarkSummary memory sum, uint8 k, uint256 upTo, uint256 cap)
        internal
        returns (uint256 burned)
    {
        uint256 owed;
        uint256 acc;
        (burned, owed, acc,) =
            ITranche(_tranche($, k)).settleAtMark(upTo, sum.priceWad[k], cap, $.components.vault);
        $.nav[k] = $.nav[k] - owed + acc;
        $.unfunded[k] += owed;
        sum.owed[k] = owed;
        sum.topUp[k] = acc;
    }

    /// @dev Senior top-up room: Senior may not exceed seniorCapBps of book capital after the round,
    ///      i.e. S' <= J' * c / (1 - c). Uses S before this mark's Senior redemptions (conservative).
    function _seniorTopUpRoom(uint256 sNav, uint256 jNav, uint256 capBps, uint256 capacity)
        internal
        pure
        returns (uint256)
    {
        if (capBps >= BPS) return capacity;
        uint256 limit = (jNav * capBps) / (BPS - capBps);
        uint256 room = limit > sNav ? limit - sNav : 0;
        return Math.min(room, capacity);
    }

    /// @dev Pays unfunded claims from vault idle, Senior first.
    function _fundClaims(BookStorage storage $) internal returns (uint256 funded) {
        uint256 us = $.unfunded[S];
        uint256 uj = $.unfunded[J];
        if (us == 0 && uj == 0) return 0;
        IUnderwritingVault vault = IUnderwritingVault($.components.vault);
        uint256 idle = vault.idle();
        uint256 ps = Math.min(idle, us);
        uint256 pj = Math.min(idle - ps, uj);
        funded = ps + pj;
        if (funded == 0) return 0;
        $.unfunded = [us - ps, uj - pj];
        emit ClaimsFunded($.bookId, funded, (us - ps) + (uj - pj));
        if (ps > 0) vault.payTo($.components.senior, ps);
        if (pj > 0) vault.payTo($.components.junior, pj);
    }

    function _settleRetiredBacklog(BookStorage storage $) internal {
        uint256[2] memory owed;
        for (uint8 k = 0; k < 2; k++) {
            address t = _tranche($, k);
            uint256 supply = IERC20(t).totalSupply();
            uint256 burned;
            (burned, owed[k],,) = ITranche(t).settleAtMark(RETIRED_SETTLE_INDEX, $.price[k], 0, $.components.vault);
            if (k == S) _scaleImpairment($, burned, supply);
            $.nav[k] -= owed[k];
            $.unfunded[k] += owed[k];
        }
        if (owed[S] > 0 || owed[J] > 0) emit RetiredBacklogSettled($.bookId, owed[S], owed[J]);
        _fundClaims($);
    }

    /// @dev Senior shares burned at a settlement (marks, Retired backlog / immediate redemptions) take their
    ///      pro-rata part of the impairment with them: imp' = floor(imp * (supply - burned) / supply), i.e.
    ///      0 once no Senior share is left. Restoration and backstop cover (the backstop is shared across
    ///      books) then only ever restore the remaining shares' loss.
    function _scaleImpairment(BookStorage storage $, uint256 burned, uint256 supplyBefore) internal {
        uint256 imp = $.seniorImpairment;
        if (burned == 0 || imp == 0) return;
        $.seniorImpairment = Math.mulDiv(imp, supplyBefore - burned, supplyBefore);
    }

    function _setRetiredPrice(BookStorage storage $, uint8 k, bool bumpEpoch) internal {
        uint256 p = Waterfall.sharePriceWad($.nav[k], IERC20(_tranche($, k)).totalSupply());
        if (bumpEpoch) $.retiredEpoch[k]++;
        $.price[k] = p;
        emit RetiredPriceSet($.bookId, k, p, $.retiredEpoch[k]);
    }

    function _maybeDrawdownKill(BookStorage storage $) internal {
        int256 killAt = $.charter.mandate.killAtDrawdownBps;
        // the committee may re-mandate: prefer the live terms
        try IMMMandate($.components.mandate).getMandate() returns (BRTypes.Mandate memory md) {
            killAt = md.killAtDrawdownBps;
        } catch {}
        if (Waterfall.drawdownKill($.drawdownBps, killAt)) _killMandate($, KILL_DRAWDOWN);
    }

    /// @dev Never blocks the caller (marks / retirement must stay live): failures surface as events.
    function _killMandate(BookStorage storage $, bytes32 reason) internal {
        IMMMandate mandate = IMMMandate($.components.mandate);
        try mandate.killed() returns (bool k) {
            if (k) return;
        } catch {}
        try mandate.kill(reason) {}
        catch {
            emit MandateKillFailed($.bookId, reason);
        }
    }

    function _backstopBalance(address backstop) internal view returns (uint256 bal) {
        if (backstop == address(0)) return 0;
        try IBackstop(backstop).balance() returns (uint256 b) {
            bal = b;
        } catch {}
    }

    /// @dev Returns the USDC actually received by the vault (<= shortfall). Never reverts.
    function _pullBackstop(
        uint256 id,
        IBookrunnerConfig cfg,
        address backstop,
        address vault,
        uint256 shortfall
    ) internal returns (uint256 covered) {
        IERC20 usdc = IERC20(cfg.usdc());
        uint256 before = usdc.balanceOf(vault);
        try IBackstop(backstop).cover(id, shortfall) returns (uint256 reported) {
            uint256 afterBal = usdc.balanceOf(vault);
            uint256 received = afterBal > before ? afterBal - before : 0;
            covered = Math.min(Math.min(received, reported), shortfall);
        } catch {
            emit BackstopCoverFailed(id, shortfall);
        }
    }

    function _reasonCode(uint8 reason) internal pure returns (bytes32) {
        if (reason == Waterfall.REASON_NO_JUNIOR) return "NO_JUNIOR";
        if (reason == Waterfall.REASON_SPONSOR_SKIN) return "SPONSOR_SKIN";
        return "IF_UNFUNDED";
    }
}
