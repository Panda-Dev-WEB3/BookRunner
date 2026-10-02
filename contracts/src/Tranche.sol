// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

import {BRTypes} from "./interfaces/BRTypes.sol";
import {IBook} from "./interfaces/IBook.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {ITranche} from "./interfaces/ITranche.sol";
import {Waterfall} from "./libraries/Waterfall.sol";

/// @title IBookTrancheHooks — Book functions (beyond IBook) that its tranches call. Implemented by Book.
interface IBookTrancheHooks {
    /// @notice Mark interval snapshotted by the book at initialization (bucket index unit).
    function markInterval() external view returns (uint32);
    /// @notice Retired state: the price redemption requests settle at immediately, and its epoch
    ///         (bumped whenever a late credit changes the price).
    function retiredPrice(uint8 kind) external view returns (uint256 priceWad, uint64 epoch);
    /// @notice Only the Junior tranche: the sponsor moved Junior shares out (redeem request or transfer).
    function onJuniorRedeemRequested(address owner) external;
    /// @notice Only a tranche, Retired state: a redemption of `sharesBurned` (already burned) settled
    ///         immediately for `assetsOwed`.
    function onRetiredRedeem(uint256 assetsOwed, uint256 sharesBurned) external;
}

/// @title ITrancheBookHooks — Tranche functions (beyond ITranche) that its book calls / exposes.
interface ITrancheBookHooks {
    /// @notice Only book: settles the open top-up round with nothing accepted (all refundable).
    function cancelRound() external;
    /// @notice USDC held for redemption claims (escrow balance minus subscription escrow).
    function redemptionLiquidity() external view returns (uint256);
}

/// @title Tranche — Senior or Junior tranche of one book (EIP-1167 clone; kind set at initialize).
/// @notice ERC-20 shares (6 decimals) with an ERC-7540-style asynchronous flow over ERC-4626 views.
///   * Subscriptions are commitments per round (round 0 = subscription window, later rounds = top-ups
///     opened by the book), settled pro-rata at window close / at the first mark after the round ends.
///   * Redemptions are requests into buckets (bucketIndex(eligibleAt, markInterval)); a mark with
///     periodEnd T settles every bucket <= T / markInterval at that mark's post-P&L share price.
///   * INVARIANT: requestRedeem and every claim path never revert for lack of permission — pause,
///     newBooksPaused, kill and book state (Live, Retiring, Retired) do not gate them. A claim may revert
///     only with InsufficientLiquidity (escrow short after trying book.fundClaims()).
///   * pause() blocks deposits only.
contract Tranche is ITranche, ITrancheBookHooks, Initializable, ERC20Upgradeable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    /// @notice Bucket ids >= this are Retired-state immediate settlements (RETIRED_BUCKET_BASE + epoch).
    uint256 public constant RETIRED_BUCKET_BASE = 1 << 128;
    /// @notice Max redemption buckets settled per settleAtMark call (leftover due buckets settle next call).
    uint256 public constant MAX_SETTLE_BUCKETS = 256;
    /// @notice Max controller buckets processed per claim call (call again to continue).
    uint256 public constant MAX_CLAIM_BUCKETS = 64;

    uint8 private constant MODE_ALL = 0;
    uint8 private constant MODE_SHARES = 1;
    uint8 private constant MODE_ASSETS = 2;

    struct Round {
        uint64 endsAt;
        bool settled;
        bool cancelled;
        uint256 totalCommitted;
        uint256 accepted; // assets moved to the vault
        uint256 sharesMinted; // shares minted into escrow for the round
    }

    struct Bucket {
        uint256 shares; // total shares requested into the bucket
        uint248 priceWad; // settlement price (valid when settled)
        bool settled;
    }

    error NotBook();
    error NotPauser();
    error NotAuthorized();
    error ZeroAddress();
    error ZeroAmount();
    error BadKind();
    error BookMismatch();
    error BadConfig();
    error RoundNotSettled();
    error RoundAlreadySettled();
    error BadRoundEnd();
    error AllocationExceedsCommitted(uint256 allocated, uint256 committed);
    error ExceedsClaimable(uint256 requested, uint256 claimable);
    error AsyncFlow();
    error GuardianPaused();

    event WindowSettled(uint256 committed, uint256 allocated);
    event RoundOpened(uint256 indexed round, uint64 endsAt);
    event RoundCancelled(uint256 indexed round);
    event TopUpSettled(
        uint256 indexed round, uint256 committed, uint256 accepted, uint256 sharesMinted, uint256 priceWad
    );
    event CancelledRefundClaimed(address indexed wallet, uint256 refund);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    /// @dev ERC-4626 Withdraw, emitted by the ERC-7540 claim functions redeem() / withdraw().
    event Withdraw(
        address indexed sender,
        address indexed receiver,
        address indexed owner,
        uint256 assets,
        uint256 shares
    );

    // ---- identity ----
    address public config;
    uint256 public bookId;
    address public book;
    uint8 public kind;
    bool public paused;
    /// @notice Set when the GUARDIAN paused deposits: only the GUARDIAN may then unpause.
    bool public guardianPaused;
    uint32 public markInterval;
    uint64 public juniorNoticeSeconds;
    address public sponsor;
    uint128 public perWalletCapUsd;
    IERC20 internal _usdc;

    // ---- subscriptions ----
    uint256 public currentRound;
    /// @notice USDC held for commitments and unclaimed refunds (not available for redemption claims).
    uint256 public commitEscrow;
    mapping(uint256 round => Round) internal _rounds;
    mapping(address wallet => uint256) public walletRound;
    mapping(address wallet => uint256) public walletCommit;
    /// @notice Junior: the sponsor's window (round 0) commitment, snapshotted at settleWindow. The sponsor
    ///         is allocated first: min(sponsorWindowCommit, allocated) shares (Waterfall sponsor priority).
    uint256 public sponsorWindowCommit;

    // ---- redemptions ----
    mapping(uint256 bucket => Bucket) internal _buckets;
    uint256[] internal _bucketQueue; // non-empty normal buckets, strictly increasing
    uint256 public bucketHead;
    uint256 public lastSettledIndex;
    mapping(address controller => uint256[]) internal _ctrlBuckets; // increasing (FIFO)
    mapping(address controller => uint256) internal _ctrlHead;
    mapping(uint256 bucket => mapping(address controller => uint256)) internal _remaining;
    mapping(address controller => mapping(address operator => bool)) public isOperator;

    modifier onlyBook() {
        if (msg.sender != book) revert NotBook();
        _;
    }

    constructor() {
        _disableInitializers();
    }

    /// @notice Clone initializer. The book must already be initialized (factory order: book first).
    /// @param config_ BookrunnerConfig.
    /// @param bookId_ book id (== charter id); must match `book_.bookId()`.
    /// @param book_ the book proxy.
    /// @param kind_ BRTypes.SENIOR or BRTypes.JUNIOR.
    function initialize(address config_, uint256 bookId_, address book_, uint8 kind_) external initializer {
        if (config_ == address(0) || book_ == address(0)) revert ZeroAddress();
        if (kind_ > BRTypes.JUNIOR) revert BadKind();
        if (IBook(book_).bookId() != bookId_) revert BookMismatch();
        BRTypes.Charter memory c = IBook(book_).getCharter();
        uint32 interval = IBookTrancheHooks(book_).markInterval();
        address usdc = IBookrunnerConfig(config_).usdc();
        if (interval == 0 || usdc == address(0)) revert BadConfig();

        string memory sym = _symbolString(c.symbol);
        bool senior = kind_ == BRTypes.SENIOR;
        __ERC20_init(
            string.concat("BKRN ", sym, senior ? " Senior" : " Junior"),
            string.concat("BKRN-", sym, senior ? "-S" : "-J")
        );

        config = config_;
        bookId = bookId_;
        book = book_;
        kind = kind_;
        markInterval = interval;
        juniorNoticeSeconds = c.juniorNoticeSeconds;
        sponsor = c.sponsor;
        perWalletCapUsd = c.perWalletCapUsd;
        _usdc = IERC20(usdc);
        _rounds[0].endsAt = IBook(book_).subscriptionEnds();
        emit RoundOpened(0, _rounds[0].endsAt);
    }

    // =========================================================================================
    // Views
    // =========================================================================================

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function asset() external view returns (address) {
        return address(_usdc);
    }

    /// @notice Tranche NAV as accounted by the book.
    function totalAssets() external view returns (uint256) {
        (uint256 s, uint256 j) = IBook(book).trancheNav();
        return kind == BRTypes.SENIOR ? s : j;
    }

    /// @notice At the last applied mark price (final price once Retired).
    function convertToAssets(uint256 shares) external view returns (uint256) {
        return Waterfall.sharesToAssets(shares, IBook(book).sharePrice(kind));
    }

    function convertToShares(uint256 assets) external view returns (uint256) {
        uint256 price = IBook(book).sharePrice(kind);
        return price == 0 ? 0 : Math.mulDiv(assets, WAD, price);
    }

    function depositsOpen() public view returns (bool) {
        Round storage rd = _rounds[currentRound];
        return
            !paused && !rd.settled && block.timestamp < rd.endsAt
                && !IBookrunnerConfig(config).newBooksPaused();
    }

    function totalCommitted() external view returns (uint256) {
        return _rounds[currentRound].totalCommitted;
    }

    function committedOf(address wallet) external view returns (uint256) {
        return walletRound[wallet] == currentRound ? walletCommit[wallet] : 0;
    }

    function roundInfo(uint256 round) external view returns (Round memory) {
        return _rounds[round];
    }

    /// @notice ERC-4626: 0 outside an open round; remaining per-wallet cap otherwise (sponsor uncapped).
    function maxDeposit(address receiver) external view returns (uint256) {
        if (!depositsOpen()) return 0;
        uint256 cap = perWalletCapUsd;
        if (cap == 0 || receiver == sponsor) return type(uint256).max;
        uint256 used = walletRound[receiver] == currentRound ? walletCommit[receiver] : 0;
        return used >= cap ? 0 : cap - used;
    }

    /// @notice Shares are only minted at settlement; mint() is not supported.
    function maxMint(address) external pure returns (uint256) {
        return 0;
    }

    /// @notice ERC-7540: asynchronous flows MUST revert previews.
    function previewDeposit(uint256) external pure returns (uint256) {
        revert AsyncFlow();
    }

    function previewMint(uint256) external pure returns (uint256) {
        revert AsyncFlow();
    }

    function previewRedeem(uint256) external pure returns (uint256) {
        revert AsyncFlow();
    }

    function previewWithdraw(uint256) external pure returns (uint256) {
        revert AsyncFlow();
    }

    /// @notice Settled, unclaimed allocation of `wallet`. Junior window: sponsor priority
    ///         (Waterfall.juniorWindowAllocation); every other round / tranche: pro-rata.
    function claimableAllocation(address wallet) public view returns (uint256 shares, uint256 refund) {
        uint256 commit = walletCommit[wallet];
        if (commit == 0) return (0, 0);
        uint256 r = walletRound[wallet];
        Round storage rd = _rounds[r];
        if (!rd.settled) return (0, 0);
        if (rd.cancelled) return (0, commit);
        if (r == 0 && kind == BRTypes.JUNIOR) {
            return Waterfall.juniorWindowAllocation(
                commit, wallet == sponsor, rd.totalCommitted, sponsorWindowCommit, rd.accepted
            );
        }
        return Waterfall.roundAllocation(commit, rd.totalCommitted, rd.accepted, rd.sharesMinted);
    }

    function pendingRedeemRequest(uint256 requestId, address controller)
        external
        view
        returns (uint256 shares)
    {
        return _buckets[requestId].settled ? 0 : _remaining[requestId][controller];
    }

    function claimableRedeemRequest(uint256 requestId, address controller)
        external
        view
        returns (uint256 shares)
    {
        return _buckets[requestId].settled ? _remaining[requestId][controller] : 0;
    }

    /// @notice USDC claimable by `controller` across all settled buckets (claim calls process at most
    ///         MAX_CLAIM_BUCKETS buckets each).
    function claimableAssets(address controller) public view returns (uint256 assets) {
        (, assets) = _claimableTotals(controller);
    }

    /// @notice ERC-7540: settled (claimable) redemption shares of `controller`.
    function maxRedeem(address controller) external view returns (uint256 shares) {
        (shares,) = _claimableTotals(controller);
    }

    /// @notice ERC-7540: settled (claimable) redemption assets of `controller`.
    function maxWithdraw(address controller) external view returns (uint256 assets) {
        (, assets) = _claimableTotals(controller);
    }

    function redeemEligibleAt(uint64 requestedAt) external view returns (uint64) {
        return uint64(Waterfall.redeemEligibleAt(kind, requestedAt, juniorNoticeSeconds));
    }

    function redemptionLiquidity() public view returns (uint256) {
        uint256 bal = _usdc.balanceOf(address(this));
        return bal > commitEscrow ? bal - commitEscrow : 0;
    }

    function bucketInfo(uint256 bucket) external view returns (Bucket memory) {
        return _buckets[bucket];
    }

    /// @notice Number of normal (non-retired) buckets still awaiting settlement.
    function pendingBucketCount() external view returns (uint256) {
        return _bucketQueue.length - bucketHead;
    }

    /// @notice A controller's redemption buckets not yet fully claimed, FIFO.
    function controllerBuckets(address controller) external view returns (uint256[] memory out) {
        uint256[] storage list = _ctrlBuckets[controller];
        uint256 head = _ctrlHead[controller];
        out = new uint256[](list.length - head);
        for (uint256 i = head; i < list.length; i++) {
            out[i - head] = list[i];
        }
    }

    // =========================================================================================
    // Subscriptions
    // =========================================================================================

    /// @notice ERC-4626 signature. Records a commitment of `assets` USDC for `receiver` in the current
    ///         round; shares are minted at settlement, so this returns 0. Pulls USDC from msg.sender.
    /// @dev Reverts DepositsClosed outside an open round, while paused or while config.newBooksPaused().
    ///      Per-wallet cap = charter.perWalletCapUsd per round (0 = none; sponsor exempt).
    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256) {
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0) || receiver == address(this)) revert ZeroAddress();
        if (!depositsOpen()) revert DepositsClosed();
        uint256 r = currentRound;
        if (walletRound[receiver] != r) {
            // an older round's commitment is settled before a new round opens: push it out first
            _settleAllocation(receiver);
            if (walletCommit[receiver] != 0) revert RoundNotSettled();
            walletRound[receiver] = r;
        }
        uint256 newCommit = walletCommit[receiver] + assets;
        uint256 cap = perWalletCapUsd;
        if (cap != 0 && receiver != sponsor && newCommit > cap) revert WalletCapExceeded(cap, newCommit);

        walletCommit[receiver] = newCommit;
        _rounds[r].totalCommitted += assets;
        commitEscrow += assets;
        emit Committed(msg.sender, receiver, assets, r);
        _usdc.safeTransferFrom(msg.sender, address(this), assets);
        return 0;
    }

    /// @notice Anyone may push a wallet's settled allocation: shares + refund go to `wallet`.
    ///         Returns (0, 0) when nothing is claimable (never reverts for permission or state).
    ///         For a cancelled round the full commitment is refunded.
    function claimAllocation(address wallet) external nonReentrant returns (uint256 shares, uint256 refund) {
        return _settleAllocation(wallet);
    }

    /// @notice Cancelled book (or cancelled top-up round): returns the wallet's full commitment to it.
    function claimCancelledRefund(address wallet) external nonReentrant returns (uint256 refund) {
        if (walletCommit[wallet] == 0 || !_rounds[walletRound[wallet]].cancelled) return 0;
        (, refund) = _settleAllocation(wallet);
        emit CancelledRefundClaimed(wallet, refund);
    }

    // =========================================================================================
    // Redemptions (ERC-7540 style)
    // =========================================================================================

    /// @notice Moves `shares` from `owner` into escrow as a redemption request for `controller`.
    ///         msg.sender must be `owner`, an operator of `owner`, or hold an allowance (ERC-7540).
    ///         Never gated by pause, guardian pause, kill or book state. In Retired state the request
    ///         settles immediately at the book's final price.
    /// @return requestId the bucket the request settles in (bucketIndex(eligibleAt, markInterval)).
    function requestRedeem(uint256 shares, address controller, address owner)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        if (shares == 0) revert ZeroAmount();
        if (controller == address(0) || controller == address(this)) revert ZeroAddress();
        if (owner != msg.sender && !isOperator[owner][msg.sender]) {
            _spendAllowance(owner, msg.sender, shares);
        }
        _transfer(owner, address(this), shares);

        if (IBook(book).state() == BRTypes.BookState.Retired) {
            return _requestRetired(shares, controller, owner);
        }

        uint256 b = Waterfall.bucketIndex(
            Waterfall.redeemEligibleAt(kind, block.timestamp, juniorNoticeSeconds), markInterval
        );
        uint256 last = lastSettledIndex;
        if (b <= last) b = last + 1; // never into an already-settled bucket
        _buckets[b].shares += shares;
        uint256 qlen = _bucketQueue.length;
        if (qlen == 0 || _bucketQueue[qlen - 1] != b) _bucketQueue.push(b);
        _remaining[b][controller] += shares;
        _pushControllerBucket(controller, b);
        emit RedeemRequest(controller, owner, b, msg.sender, shares);
        return b;
    }

    /// @notice Claims all settled redemptions of `controller` (up to MAX_CLAIM_BUCKETS buckets) to
    ///         `receiver`. msg.sender must be `controller` or its operator. Reverts only with
    ///         InsufficientLiquidity when escrow is short.
    function claimRedemption(address controller, address receiver)
        external
        nonReentrant
        returns (uint256 assets)
    {
        _checkController(controller);
        if (receiver == address(0)) revert ZeroAddress();
        (, assets) = _claim(controller, receiver, MODE_ALL, 0);
    }

    /// @notice Anyone: pushes all settled redemptions of `controller` to `controller`.
    function claimFor(address controller) external nonReentrant returns (uint256 assets) {
        (, assets) = _claim(controller, controller, MODE_ALL, 0);
    }

    /// @notice ERC-7540 claim: redeems `shares` of claimable redemption shares (FIFO over settled
    ///         buckets) and sends the assets to `receiver`.
    function redeem(uint256 shares, address receiver, address controller)
        external
        nonReentrant
        returns (uint256 assets)
    {
        _checkController(controller);
        if (receiver == address(0)) revert ZeroAddress();
        (, assets) = _claim(controller, receiver, MODE_SHARES, shares);
        emit Withdraw(msg.sender, receiver, controller, assets, shares);
    }

    /// @notice ERC-7540 claim: withdraws exactly `assets` of claimable redemption assets (FIFO over
    ///         settled buckets) to `receiver`; returns the claimable shares consumed.
    function withdraw(uint256 assets, address receiver, address controller)
        external
        nonReentrant
        returns (uint256 shares)
    {
        _checkController(controller);
        if (receiver == address(0)) revert ZeroAddress();
        (shares,) = _claim(controller, receiver, MODE_ASSETS, assets);
        emit Withdraw(msg.sender, receiver, controller, assets, shares);
    }

    function setOperator(address operator, bool approved) external returns (bool) {
        isOperator[msg.sender][operator] = approved;
        emit OperatorSet(msg.sender, operator, approved);
        return true;
    }

    // =========================================================================================
    // Pause (deposits only)
    // =========================================================================================

    /// @notice GUARDIAN, the book's sponsor, or the book. Blocks deposits only.
    function pause() external {
        if (_checkPauser()) guardianPaused = true;
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice GUARDIAN, the book's sponsor, or the book; a GUARDIAN pause can only be lifted by the GUARDIAN.
    function unpause() external {
        bool isGuardian = _checkPauser();
        if (guardianPaused && !isGuardian) revert GuardianPaused();
        paused = false;
        guardianPaused = false;
        emit Unpaused(msg.sender);
    }

    // =========================================================================================
    // Book hooks
    // =========================================================================================

    /// @notice Only book, at window close: accepts `allocatedAssets` of round 0 (Senior pro-rata; Junior
    ///         sponsor first, then pro-rata), mints the same number of shares into escrow and moves the
    ///         allocated USDC to `vault`.
    function settleWindow(uint256 allocatedAssets, address vault) external onlyBook nonReentrant {
        if (currentRound != 0) revert RoundAlreadySettled();
        Round storage rd = _rounds[0];
        if (rd.settled) revert RoundAlreadySettled();
        if (allocatedAssets > rd.totalCommitted) {
            revert AllocationExceedsCommitted(allocatedAssets, rd.totalCommitted);
        }
        // every wallet is still in round 0, so this is the sponsor's window commitment (== committedOf)
        if (kind == BRTypes.JUNIOR) sponsorWindowCommit = walletCommit[sponsor];
        rd.settled = true;
        rd.accepted = allocatedAssets;
        rd.sharesMinted = allocatedAssets;
        commitEscrow -= allocatedAssets;
        emit WindowSettled(rd.totalCommitted, allocatedAssets);
        if (allocatedAssets > 0) {
            _mint(address(this), allocatedAssets);
            _usdc.safeTransfer(vault, allocatedAssets);
        }
    }

    /// @notice Only book, at each applied mark: settles redemption buckets lastSettled+1 .. upToIndex
    ///         at `priceWad` (per-bucket floor), burns their shares, and settles an ended top-up round
    ///         (accepted = min(committed, topUpCapacity), minted at `priceWad`, cash -> `vault`).
    function settleAtMark(uint256 upToIndex, uint256 priceWad, uint256 topUpCapacity, address vault)
        external
        onlyBook
        nonReentrant
        returns (uint256 sharesBurned, uint256 assetsOwed, uint256 topUpAccepted, uint256 sharesMinted)
    {
        (sharesBurned, assetsOwed) = _settleBuckets(upToIndex, priceWad);
        if (upToIndex > lastSettledIndex) lastSettledIndex = upToIndex;
        if (sharesBurned > 0) _burn(address(this), sharesBurned);

        uint256 r = currentRound;
        Round storage rd = _rounds[r];
        if (r > 0 && !rd.settled && upToIndex * markInterval >= rd.endsAt) {
            (topUpAccepted, sharesMinted) = _settleTopUp(r, rd, priceWad, topUpCapacity, vault);
        }
    }

    /// @notice Only book: the window failed its checks; every round-0 commitment is refundable 1:1.
    function markCancelled() external onlyBook {
        Round storage rd = _rounds[0];
        if (currentRound != 0 || rd.settled) revert RoundAlreadySettled();
        rd.settled = true;
        rd.cancelled = true;
        emit RoundCancelled(0);
    }

    /// @notice Only book: opens a top-up round ending at `endsAt` (previous round must be settled).
    function openRound(uint64 endsAt) external onlyBook {
        if (!_rounds[currentRound].settled) revert RoundNotSettled();
        if (endsAt <= block.timestamp) revert BadRoundEnd();
        uint256 r = ++currentRound;
        _rounds[r].endsAt = endsAt;
        emit RoundOpened(r, endsAt);
    }

    /// @notice Only book (retirement): cancels the open top-up round; commitments refundable in full.
    function cancelRound() external onlyBook {
        uint256 r = currentRound;
        Round storage rd = _rounds[r];
        if (r == 0 || rd.settled) return;
        rd.settled = true;
        rd.cancelled = true;
        emit RoundCancelled(r);
    }

    // =========================================================================================
    // Internals
    // =========================================================================================

    /// @dev Settles queued buckets <= upToIndex (at most MAX_SETTLE_BUCKETS) at `priceWad`, each at its
    ///      own floor(bucketShares * price / 1e18).
    function _settleBuckets(uint256 upToIndex, uint256 priceWad)
        internal
        returns (uint256 burned, uint256 owed)
    {
        uint248 p = SafeCast.toUint248(priceWad);
        uint256 head = bucketHead;
        uint256 end = Math.min(_bucketQueue.length, head + MAX_SETTLE_BUCKETS);
        while (head < end) {
            uint256 b = _bucketQueue[head];
            if (b > upToIndex) break;
            Bucket storage bk = _buckets[b];
            uint256 bShares = bk.shares;
            uint256 bAssets = Waterfall.sharesToAssets(bShares, priceWad);
            bk.priceWad = p;
            bk.settled = true;
            burned += bShares;
            owed += bAssets;
            emit BucketSettled(b, bShares, bAssets, priceWad);
            unchecked {
                ++head;
            }
        }
        bucketHead = head;
    }

    function _settleAllocation(address wallet) internal returns (uint256 shares, uint256 refund) {
        (shares, refund) = claimableAllocation(wallet);
        if (shares == 0 && refund == 0) {
            // settled with nothing owed (e.g. dust commitment): clear it so the wallet can recommit
            if (walletCommit[wallet] != 0 && _rounds[walletRound[wallet]].settled) {
                walletCommit[wallet] = 0;
                emit AllocationClaimed(wallet, 0, 0);
            }
            return (0, 0);
        }
        walletCommit[wallet] = 0;
        if (refund > 0) commitEscrow -= refund;
        emit AllocationClaimed(wallet, shares, refund);
        if (shares > 0) _transfer(address(this), wallet, shares);
        if (refund > 0) _usdc.safeTransfer(wallet, refund);
    }

    function _settleTopUp(uint256 r, Round storage rd, uint256 priceWad, uint256 capacity, address vault)
        internal
        returns (uint256 accepted, uint256 minted)
    {
        accepted = Math.min(rd.totalCommitted, capacity);
        if (accepted > 0 && priceWad > 0) {
            minted = Math.mulDiv(accepted, WAD, priceWad);
            if (minted == 0) accepted = 0;
        } else {
            accepted = 0;
        }
        rd.settled = true;
        rd.accepted = accepted;
        rd.sharesMinted = minted;
        emit TopUpSettled(r, rd.totalCommitted, accepted, minted, priceWad);
        if (accepted > 0) {
            commitEscrow -= accepted;
            _mint(address(this), minted);
            _usdc.safeTransfer(vault, accepted);
        }
    }

    function _requestRetired(uint256 shares, address controller, address owner) internal returns (uint256 b) {
        (uint256 price, uint64 epoch) = IBookTrancheHooks(book).retiredPrice(kind);
        b = RETIRED_BUCKET_BASE + epoch;
        Bucket storage bk = _buckets[b];
        if (!bk.settled) {
            bk.settled = true;
            bk.priceWad = SafeCast.toUint248(price);
        }
        uint256 p = bk.priceWad;
        // bucket-level floor: total owed for the bucket is always floor(totalShares * p / 1e18)
        uint256 before = Waterfall.sharesToAssets(bk.shares, p);
        bk.shares += shares;
        uint256 owed = Waterfall.sharesToAssets(bk.shares, p) - before;
        _burn(address(this), shares);
        _remaining[b][controller] += shares;
        _pushControllerBucket(controller, b);
        emit RedeemRequest(controller, owner, b, msg.sender, shares);
        emit BucketSettled(b, shares, owed, p);
        IBookTrancheHooks(book).onRetiredRedeem(owed, shares);
    }

    function _pushControllerBucket(address controller, uint256 b) internal {
        uint256[] storage list = _ctrlBuckets[controller];
        uint256 len = list.length;
        if (len == 0 || list[len - 1] != b || _ctrlHead[controller] >= len) list.push(b);
    }

    /// @dev FIFO consumption of a controller's settled buckets. MODE_ALL takes everything, MODE_SHARES
    ///      exactly `amount` shares, MODE_ASSETS exactly `amount` assets. Each consumption pays
    ///      floor(sharesTaken * price / 1e18) (or less), so a controller never receives more than its
    ///      share of a bucket's settled assets.
    function _claim(address controller, address receiver, uint8 mode, uint256 amount)
        internal
        returns (uint256 sharesUsed, uint256 assets)
    {
        uint256 left;
        (sharesUsed, assets, left) = _consume(controller, mode, amount);
        if (mode != MODE_ALL && left != 0) revert ExceedsClaimable(amount, amount - left);
        if (assets > 0) {
            _ensureLiquidity(assets);
            emit RedemptionClaimed(controller, receiver, assets);
            _usdc.safeTransfer(receiver, assets);
        }
    }

    function _consume(address controller, uint8 mode, uint256 amount)
        internal
        returns (uint256 sharesUsed, uint256 assets, uint256 left)
    {
        uint256[] storage list = _ctrlBuckets[controller];
        uint256 head = _ctrlHead[controller];
        uint256 end = Math.min(list.length, head + MAX_CLAIM_BUCKETS);
        left = amount;
        while (head < end && (mode == MODE_ALL || left != 0)) {
            (bool settled, bool full, uint256 take, uint256 pay) =
                _consumeBucket(list[head], controller, mode, left);
            if (!settled) break;
            if (mode != MODE_ALL) left -= mode == MODE_SHARES ? take : pay;
            sharesUsed += take;
            assets += pay;
            if (!full) break; // partially consumed: the request is satisfied
            ++head;
        }
        _ctrlHead[controller] = head;
    }

    function _consumeBucket(uint256 b, address controller, uint8 mode, uint256 left)
        internal
        returns (bool settled, bool full, uint256 take, uint256 pay)
    {
        Bucket storage bk = _buckets[b];
        if (!bk.settled) return (false, false, 0, 0);
        uint256 rem = _remaining[b][controller];
        (take, pay) = _takeFrom(mode, rem, bk.priceWad, left);
        _remaining[b][controller] = rem - take;
        return (true, rem == take, take, pay);
    }

    /// @dev Shares taken from one settled bucket and the assets paid for them (never more than
    ///      floor(take * price / 1e18)).
    function _takeFrom(uint8 mode, uint256 rem, uint256 price, uint256 left)
        internal
        pure
        returns (uint256 take, uint256 pay)
    {
        if (mode == MODE_ALL) return (rem, Waterfall.sharesToAssets(rem, price));
        if (mode == MODE_SHARES) {
            take = Math.min(rem, left);
            return (take, Waterfall.sharesToAssets(take, price));
        }
        uint256 value = Waterfall.sharesToAssets(rem, price);
        if (value <= left) return (rem, value);
        // value > left >= 0 implies price > 0 and ceil(left * 1e18 / price) <= rem
        return (Math.mulDiv(left, WAD, price, Math.Rounding.Ceil), left);
    }

    function _claimableTotals(address controller) internal view returns (uint256 shares, uint256 assets) {
        uint256[] storage list = _ctrlBuckets[controller];
        uint256 len = list.length;
        for (uint256 i = _ctrlHead[controller]; i < len; i++) {
            uint256 b = list[i];
            Bucket storage bk = _buckets[b];
            if (!bk.settled) break;
            uint256 rem = _remaining[b][controller];
            shares += rem;
            assets += Waterfall.sharesToAssets(rem, bk.priceWad);
        }
    }

    /// @dev Pulls unfunded claims from the book's vault if escrow is short; only then reverts.
    function _ensureLiquidity(uint256 needed) internal {
        uint256 avail = redemptionLiquidity();
        if (avail >= needed) return;
        try IBook(book).fundClaims() {} catch {}
        avail = redemptionLiquidity();
        if (avail < needed) revert InsufficientLiquidity(needed, avail);
    }

    function _checkController(address controller) internal view {
        if (msg.sender != controller && !isOperator[controller][msg.sender]) revert NotAuthorized();
    }

    /// @return isGuardian whether msg.sender holds GUARDIAN (reverts NotPauser if no pauser at all).
    function _checkPauser() internal view returns (bool isGuardian) {
        IBookrunnerConfig cfg = IBookrunnerConfig(config);
        isGuardian = cfg.hasRole(cfg.GUARDIAN_ROLE(), msg.sender);
        if (!isGuardian && msg.sender != book && msg.sender != sponsor) revert NotPauser();
    }

    /// @dev Junior: any outflow of the sponsor's shares (redeem request or transfer) is reported to the
    ///      book for the sponsor-skin check. The hook can never block the transfer.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (kind == BRTypes.JUNIOR && from != address(0) && from == sponsor && value > 0) {
            try IBookTrancheHooks(book).onJuniorRedeemRequested(from) {} catch {}
        }
    }

    function _symbolString(bytes32 sym) internal pure returns (string memory) {
        uint256 n;
        while (n < 32 && sym[n] != 0) n++;
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = sym[i];
        }
        return string(out);
    }
}
