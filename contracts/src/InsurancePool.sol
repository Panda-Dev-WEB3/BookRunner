// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";

import {BRTypes} from "./interfaces/BRTypes.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {IBookFactory} from "./interfaces/IBookFactory.sol";
import {IInsurancePool} from "./interfaces/IInsurancePool.sol";

/// @title InsurancePool — protocol-wide pool funding the insurance fund (IF) of every `ifFromPool` book (NEW 2026-10,
///        needs the focused re-audit before mainnet; docs/ARCHITECTURE.md §2.10).
/// @notice ERC-4626 surface over the settlement token (`config.usdc()` at initialize; shares "ib<symbol>", 12 decimals),
///         with queued (ERC-7540-style) entry and exit: `deposit` / `mint` / `withdraw` / `redeem` revert.
///
///         Value. Pool assets T = free liquidity + book claims, where free liquidity = accounted cash - cash reserved
///         for filled withdrawals (queued deposits are held apart until their epoch is processed). A book owes its
///         allocation as a senior debt; the pool's claim on it is what the book can repay at its last applied mark
///         (`markBook`: min(debt, vault idle + marked deployed value)), so the pool only loses once a book is exhausted
///         (Junior, Senior and the backstop have absorbed the IF draw first). T splits into the treasury's first-loss
///         slice FL (own accounting, no shares) and the depositors' assets D = T - FL = `totalAssets()`.
///           - premium (`notifyPremium`): T += p, FL += p * FL / T (same rate as D);
///           - loss (a book's claim falls): FL absorbs first, then D; recovery reverses that book's loss, D first;
///           - allocate / repay move cash <-> claims and never change T; deposits mint and withdrawals fill at the
///             share price of the epoch's processing (rounding in the pool's favour).
///         Cash is tracked, never read from `balanceOf`: a donation changes nothing (inflation attack), on top of the
///         ERC-4626 virtual offset of 6 decimals. Pool value changes only through book marks, retirements and
///         premiums, never through a venue read anyone can trigger.
///
///         Epochs (weekly, on the Unix grid). `requestDeposit` queues assets for the open epoch, `requestWithdraw`
///         escrows shares for the first epoch ending after now and after the owner's cooldown (7 days from the end of
///         their last deposit epoch); a withdrawal request is never refused. `processEpoch` (anyone) processes the
///         oldest ended epoch once every active pool-funded book has marked after its end (or `processGrace`, 24 h,
///         after it, emitting EpochProcessedStale): it mints the epoch's deposits and fills withdrawals oldest epoch
///         first from free liquidity, partially if cash is short (the rest stays escrowed and exposed until the next
///         processing). Deposits are paused by the guardian, exits never.
///
///         Books. `allocate` only from the BookFactory's book for the id (its closeWindow), once per book, within the
///         per-market cap (30% of T summed over the books on one underlying), the free liquidity above the buffer
///         (20% of T) and with the first-loss slice at its target (10% of T); the book, its vault and router are
///         recorded then and authenticate every later hook.
/// @dev UUPS behind an ERC1967 proxy, upgrades and parameters only by `config.timelock()`. ERC-7201 storage.
contract InsurancePool is
    IInsurancePool,
    Initializable,
    UUPSUpgradeable,
    ERC4626Upgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    /// @notice Share decimals above the settlement token's (ERC-4626 virtual offset, inflation-attack mitigation).
    uint8 public constant DECIMALS_OFFSET = 6;
    /// @notice Bound of the premium floor and of a charter's premium (MarketCharter BAD_PREMIUM).
    uint16 public constant MAX_PREMIUM_BPS = 5000;
    /// @notice Books whose freshness gates an epoch (each processing reads every one of them).
    uint256 public constant MAX_ACTIVE_BOOKS = 64;
    /// @notice Ended epochs `allocate` / `withdrawFirstLoss` look through for due withdrawals.
    uint256 public constant DUE_SCAN_EPOCHS = 64;

    bytes32 public constant PARAM_PREMIUM_FLOOR_BPS = "premiumFloorBps";
    bytes32 public constant PARAM_MARKET_CAP_BPS = "marketCapBps";
    bytes32 public constant PARAM_BUFFER_BPS = "bufferBps";
    bytes32 public constant PARAM_COOLDOWN = "cooldown";
    bytes32 public constant PARAM_EPOCH_LENGTH = "epochLength";
    bytes32 public constant PARAM_FIRST_LOSS_TARGET_BPS = "firstLossTargetBps";
    bytes32 public constant PARAM_PROCESS_GRACE = "processGrace";

    struct Epoch {
        uint256 shares; // withdrawal shares escrowed for this epoch
        uint256 filledShares; // burned at fills
        uint256 assets; // reserved for them at fills (claimed pro-rata)
        uint256 depositAssets; // queued deposits
        uint256 depositShares; // minted for them at processing (claimed pro-rata)
        uint64 endsAt; // set at processing
        bool processed;
    }

    struct Request {
        address owner;
        uint64 epoch;
        uint256 shares;
        uint256 claimed; // assets paid so far
    }

    struct DepositRequest {
        address owner;
        uint64 epoch;
        bool done; // claimed or cancelled
        uint256 assets;
    }

    /// @custom:storage-location erc7201:bookrunner.storage.InsurancePool
    struct PoolStorage {
        IBookrunnerConfig config;
        uint256 cash; // settlement token accounted by the pool (queued deposits excluded)
        uint256 reserved; // cash owed to filled withdrawals, not yet claimed (dust of pro-rata claims stays here)
        uint256 claims; // sum of the books' claims
        uint256 firstLoss; // the first-loss slice (treasury), part of T
        uint256 premiumsTotal;
        uint256 lossesTotal; // reported losses net of recoveries
        mapping(uint256 bookId => BookPosition) books;
        mapping(bytes32 market => uint256) marketAllocated; // allocation outstanding of the active books on a market
        uint256[] activeBooks;
        mapping(uint256 bookId => uint256) activeIndex; // 1-based
        mapping(address owner => uint64) lastDepositAt; // end of the owner's last claimed deposit epoch
        // ---- queue ----
        uint64 procEpoch; // oldest epoch not processed
        uint64 procEndsAt; // its end (on the Unix grid of epochLength)
        uint64 fillEpoch; // oldest processed epoch with unfilled withdrawals (== procEpoch when none)
        uint256 pendingShares; // withdrawal shares escrowed, not yet filled (all epochs)
        uint256 depositsPending; // assets of queued, unprocessed deposits
        uint256 depositSharesUnclaimed; // minted for processed deposits, still escrowed here
        mapping(uint64 epoch => Epoch) epochs;
        uint256 requestCount;
        mapping(uint256 id => Request) requests;
        uint256 depositCount;
        mapping(uint256 id => DepositRequest) deposits;
        // ---- parameters (timelock, bounded) ----
        uint16 premiumFloorBps;
        uint16 marketCapBps;
        uint16 bufferBps;
        uint16 firstLossTargetBps;
        uint32 cooldown;
        uint32 epochLength;
        uint32 pendingEpochLength; // applied once the queue is idle (never moves a queued request)
        uint32 processGrace;
        bool depositsPaused;
        bool allocationsPaused;
    }

    // keccak256(abi.encode(uint256(keccak256("bookrunner.storage.InsurancePool")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0x277c5611b7a53983c001ef30086eba22a2edb9303b5afe97ca557c58dcdc2800;

    error ZeroAddress();
    error ZeroAmount();
    error NotTimelock();
    error NotGuardianOrTimelock();
    error NotBook(uint256 bookId, address caller);
    error NotBookVault(uint256 bookId, address caller);
    error NotBookRouter(uint256 bookId, address caller);
    error NotOwner(address caller);
    error AlreadyAllocated(uint256 bookId);
    error AllocationsPaused();
    error DepositsPaused();
    error WithdrawalsDue();
    error TooManyBooks();
    error OverMarketCap(uint256 amount, uint256 cap);
    error InsufficientFreeLiquidity(uint256 amount, uint256 available);
    error FirstLossBelowTarget(uint256 firstLoss, uint256 target);
    error ExceedsAllocation(uint256 amount, uint256 allocation);
    error SharesInCooldown(address owner, uint256 until);
    error DirectEscrow();
    error QueuedOnly();
    error UnknownRequest(uint256 requestId);
    error NothingToClaim(uint256 requestId);
    error DepositDone(uint256 depositId);
    error EpochNotProcessed(uint64 epoch);
    error EpochAlreadyProcessed(uint64 epoch);
    error EpochEnded(uint64 epoch, uint256 endedAt);
    error EpochNotEnded(uint64 epoch, uint256 endsAt);
    error BooksNotMarked(uint64 epoch, uint256 staleBooks, uint256 graceEndsAt);
    error UnknownParam(bytes32 key);
    error ParamOutOfRange(bytes32 key, uint256 value);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Proxy initializer. Caches `config.usdc()` as the asset; name "BookRunner Insurance Pool <sym>",
    ///         symbol "ib<sym>". Defaults: premium floor 12%, per-market cap 30%, buffer 20%, first-loss target 10%,
    ///         cooldown 7 days, weekly epochs on the Unix grid, processing grace 24 h.
    function initialize(address config_) external initializer {
        if (config_ == address(0)) revert ZeroAddress();
        address usdc = IBookrunnerConfig(config_).usdc();
        if (usdc == address(0)) revert ZeroAddress();
        string memory sym = IERC20Metadata(usdc).symbol();
        __ERC20_init(string.concat("BookRunner Insurance Pool ", sym), string.concat("ib", sym));
        __ERC4626_init(IERC20(usdc));
        PoolStorage storage $ = _s();
        $.config = IBookrunnerConfig(config_);
        _setParam($, PARAM_PREMIUM_FLOOR_BPS, 1200);
        _setParam($, PARAM_MARKET_CAP_BPS, 3000);
        _setParam($, PARAM_BUFFER_BPS, 2000);
        _setParam($, PARAM_FIRST_LOSS_TARGET_BPS, 1000);
        _setParam($, PARAM_COOLDOWN, 7 days);
        _setParam($, PARAM_PROCESS_GRACE, 1 days);
        $.epochLength = 7 days;
        emit PoolParamSet(PARAM_EPOCH_LENGTH, 7 days);
        $.procEndsAt = _nextGridEnd(7 days);
    }

    // =========================================================================================================
    // Depositors
    // =========================================================================================================

    /// @inheritdoc IInsurancePool
    function requestDeposit(uint256 assets) external nonReentrant returns (uint256 depositId) {
        PoolStorage storage $ = _s();
        if ($.depositsPaused) revert DepositsPaused();
        if (assets == 0) revert ZeroAmount();
        _skipIdleEpochs($);
        uint64 epoch = _openEpoch($, block.timestamp + 1);
        $.epochs[epoch].depositAssets += assets;
        $.depositsPending += assets;
        depositId = ++$.depositCount;
        $.deposits[depositId] = DepositRequest({owner: msg.sender, epoch: epoch, done: false, assets: assets});
        emit DepositRequested(depositId, msg.sender, assets, epoch);
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), assets);
    }

    /// @inheritdoc IInsurancePool
    function cancelDeposit(uint256 depositId) external nonReentrant {
        PoolStorage storage $ = _s();
        DepositRequest storage d = $.deposits[depositId];
        if (d.owner != msg.sender) revert NotOwner(msg.sender);
        if (d.done) revert DepositDone(depositId);
        if ($.epochs[d.epoch].processed) revert EpochAlreadyProcessed(d.epoch);
        // only while its epoch is open: once the epoch has ended its price may be known (review round 2)
        uint256 ends = _projectedEnd($, d.epoch);
        if (block.timestamp >= ends) revert EpochEnded(d.epoch, ends);
        d.done = true;
        uint256 a = d.assets;
        $.epochs[d.epoch].depositAssets -= a;
        $.depositsPending -= a;
        emit DepositCancelled(depositId, msg.sender, a);
        IERC20(asset()).safeTransfer(msg.sender, a);
    }

    /// @inheritdoc IInsurancePool
    function claimDeposit(uint256 depositId) external nonReentrant returns (uint256 shares) {
        PoolStorage storage $ = _s();
        DepositRequest storage d = $.deposits[depositId];
        if (d.owner == address(0)) revert UnknownRequest(depositId);
        if (d.done) revert DepositDone(depositId);
        Epoch storage ep = $.epochs[d.epoch];
        if (!ep.processed) revert EpochNotProcessed(d.epoch);
        d.done = true;
        shares = Math.mulDiv(d.assets, ep.depositShares, ep.depositAssets);
        $.depositSharesUnclaimed -= shares;
        address owner = d.owner;
        if (ep.endsAt > $.lastDepositAt[owner]) $.lastDepositAt[owner] = ep.endsAt;
        emit DepositClaimed(depositId, owner, shares);
        ERC20Upgradeable._update(address(this), owner, shares);
    }

    /// @inheritdoc IInsurancePool
    function requestWithdraw(uint256 shares) external nonReentrant returns (uint256 requestId) {
        if (shares == 0) revert ZeroAmount();
        PoolStorage storage $ = _s();
        _skipIdleEpochs($);
        address owner = msg.sender;
        uint256 needed = Math.max(block.timestamp + 1, uint256($.lastDepositAt[owner]) + $.cooldown);
        uint64 epoch = _openEpoch($, needed);
        // escrow without the transfer rules of _update (exits are never blocked by the cooldown)
        ERC20Upgradeable._update(owner, address(this), shares);
        $.epochs[epoch].shares += shares;
        $.pendingShares += shares;
        requestId = ++$.requestCount;
        $.requests[requestId] = Request({owner: owner, epoch: epoch, shares: shares, claimed: 0});
        emit WithdrawRequested(requestId, owner, shares, epoch, uint64(_projectedEnd($, epoch)));
    }

    /// @inheritdoc IInsurancePool
    function claim(uint256 requestId) external nonReentrant returns (uint256 assets) {
        PoolStorage storage $ = _s();
        Request storage r = $.requests[requestId];
        if (r.owner == address(0)) revert UnknownRequest(requestId);
        uint256 entitled = _entitled($, r);
        assets = entitled - r.claimed;
        if (assets == 0) revert NothingToClaim(requestId);
        r.claimed = entitled;
        $.reserved -= assets;
        $.cash -= assets;
        address owner = r.owner;
        emit Claimed(requestId, owner, assets);
        IERC20(asset()).safeTransfer(owner, assets);
    }

    /// @inheritdoc IInsurancePool
    function processEpoch() external nonReentrant returns (uint64 e) {
        PoolStorage storage $ = _s();
        _skipIdleEpochs($);
        e = $.procEpoch;
        uint256 ends = $.procEndsAt;
        if (ends > block.timestamp) revert EpochNotEnded(e, ends);
        Epoch storage ep = $.epochs[e];
        // the epoch prices something (deposits, its withdrawals or older leftovers): every active book must have
        // marked after its end, or the grace period passed (exits are never blocked)
        bool stale = false;
        if (ep.depositAssets != 0 || ep.shares != 0 || $.fillEpoch < e) {
            uint256 stale_ = _staleBooks($, ends);
            if (stale_ != 0) {
                uint256 graceEnds = ends + $.processGrace;
                if (block.timestamp < graceEnds) revert BooksNotMarked(e, stale_, graceEnds);
                stale = true;
                emit EpochProcessedStale(e, stale_);
            }
        }
        uint256 da = ep.depositAssets;
        uint256 ds = 0;
        if (da != 0) {
            ds = _convertToShares(da, Math.Rounding.Floor);
            $.cash += da;
            $.depositsPending -= da;
            $.depositSharesUnclaimed += ds;
            ep.depositShares = ds;
            _mint(address(this), ds);
        }
        ep.endsAt = uint64(ends);
        ep.processed = true;
        $.procEpoch = e + 1;
        $.procEndsAt = uint64(ends + $.epochLength);
        emit EpochProcessed(e, da, ds, stale);
        _fillProcessed($);
    }

    /// @notice Anyone: adds `amount` to the first-loss slice (pulled from the caller). Never paused; never moves the
    ///         depositors' share price.
    function depositFirstLoss(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        PoolStorage storage $ = _s();
        $.cash += amount;
        $.firstLoss += amount;
        emit FirstLossDeposited(msg.sender, amount);
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Timelock: withdraws `amount` of the first-loss slice to `to`, from free liquidity, never while
    ///         withdrawals are due, keeping the slice at or above `firstLossTargetBps` of the pool after it.
    function withdrawFirstLoss(uint256 amount, address to) external nonReentrant {
        PoolStorage storage $ = _s();
        if (msg.sender != $.config.timelock()) revert NotTimelock();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (_withdrawalsDue($)) revert WithdrawalsDue();
        uint256 free = $.cash - $.reserved;
        if (amount > free) revert InsufficientFreeLiquidity(amount, free);
        if (amount > $.firstLoss) revert InsufficientFreeLiquidity(amount, $.firstLoss);
        uint256 remaining = $.firstLoss - amount;
        uint256 target = Math.mulDiv(_poolAssets($) - amount, $.firstLossTargetBps, BPS);
        if (remaining < target) revert FirstLossBelowTarget(remaining, target);
        $.firstLoss = remaining;
        $.cash -= amount;
        emit FirstLossWithdrawn(to, amount);
        IERC20(asset()).safeTransfer(to, amount);
    }

    // =========================================================================================================
    // Books
    // =========================================================================================================

    /// @inheritdoc IInsurancePool
    function allocate(uint256 bookId, uint256 amount, bytes32 market) external nonReentrant {
        PoolStorage storage $ = _s();
        IBookFactory factory = IBookFactory($.config.factory());
        if (address(factory) == address(0) || factory.bookOf(bookId) != msg.sender) revert NotBook(bookId, msg.sender);
        if ($.allocationsPaused) revert AllocationsPaused();
        if (amount == 0) revert ZeroAmount();
        BookPosition storage p = $.books[bookId];
        if (p.book != address(0)) revert AlreadyAllocated(bookId);
        if (_withdrawalsDue($)) revert WithdrawalsDue(); // due withdrawals come first
        if ($.activeBooks.length >= MAX_ACTIVE_BOOKS) revert TooManyBooks();
        uint256 t = _poolAssets($);
        uint256 flTarget = Math.mulDiv(t, $.firstLossTargetBps, BPS);
        if ($.firstLoss < flTarget) revert FirstLossBelowTarget($.firstLoss, flTarget);
        uint256 cap = _marketRoom($, market);
        if (amount > cap) revert OverMarketCap(amount, cap);
        uint256 available = _allocatable($);
        if (amount > available) revert InsufficientFreeLiquidity(amount, available);

        BRTypes.BookComponents memory c = factory.componentsOf(bookId);
        if (c.vault == address(0) || c.router == address(0)) revert ZeroAddress();
        p.book = msg.sender;
        p.vault = c.vault;
        p.router = c.router;
        p.market = market;
        p.allocation = amount;
        p.claim = amount;
        p.lastMarkAt = uint64(block.timestamp);
        p.active = true;
        $.activeBooks.push(bookId);
        $.activeIndex[bookId] = $.activeBooks.length;
        $.marketAllocated[market] += amount;
        $.claims += amount;
        $.cash -= amount;
        emit Allocated(bookId, msg.sender, c.vault, market, amount);
        IERC20(asset()).safeTransfer(c.vault, amount);
    }

    /// @inheritdoc IInsurancePool
    function markBook(uint256 bookId, uint256 value, uint64 periodEnd, bool final_) external nonReentrant {
        PoolStorage storage $ = _s();
        BookPosition storage p = $.books[bookId];
        if (p.book == address(0) || msg.sender != p.book) revert NotBook(bookId, msg.sender);
        if (value > p.allocation) revert ExceedsAllocation(value, p.allocation);
        _revalue($, bookId, p, value);
        if (periodEnd > p.lastMarkAt) p.lastMarkAt = periodEnd;
        if (final_ && p.active) _deactivate($, bookId, p);
        emit BookMarked(bookId, value, periodEnd, final_);
    }

    /// @inheritdoc IInsurancePool
    function repay(uint256 bookId, uint256 amount) external nonReentrant {
        PoolStorage storage $ = _s();
        BookPosition storage p = $.books[bookId];
        if (p.vault == address(0) || msg.sender != p.vault) revert NotBookVault(bookId, msg.sender);
        if (amount == 0) revert ZeroAmount();
        if (amount > p.allocation) revert ExceedsAllocation(amount, p.allocation);
        // paying more than the pool valued is a recovery first (the book did better than its last mark)
        if (amount > p.claim) _revalue($, bookId, p, amount);
        p.claim -= amount;
        p.allocation -= amount;
        if (p.active) $.marketAllocated[p.market] -= amount;
        $.claims -= amount;
        $.cash += amount;
        emit Repaid(bookId, amount, p.allocation);
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @inheritdoc IInsurancePool
    function notifyPremium(uint256 bookId, uint256 amount) external nonReentrant {
        PoolStorage storage $ = _s();
        BookPosition storage p = $.books[bookId];
        if (p.router == address(0) || msg.sender != p.router) revert NotBookRouter(bookId, msg.sender);
        if (amount == 0) return;
        uint256 t = _poolAssets($);
        // no depositor shares: the whole premium is the slice's (never a gift to the next depositor)
        uint256 flShare = (t == 0 || totalSupply() == 0) ? amount : Math.mulDiv(amount, $.firstLoss, t);
        $.firstLoss += flShare;
        $.cash += amount;
        $.premiumsTotal += amount;
        emit PremiumReceived(bookId, amount, flShare);
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
    }

    // =========================================================================================================
    // Governance
    // =========================================================================================================

    /// @notice Timelock: sets a bounded parameter. premiumFloorBps <= 5000 (applies to charters filed afterwards);
    ///         marketCapBps 100..10000; bufferBps <= 9000; firstLossTargetBps <= 5000; cooldown <= 30 days;
    ///         processGrace 1 h..7 days; epochLength 1..30 days (pending until the queue is idle, so it never moves a
    ///         queued request).
    function setParam(bytes32 key, uint256 value) external {
        PoolStorage storage $ = _s();
        if (msg.sender != $.config.timelock()) revert NotTimelock();
        _setParam($, key, value);
    }

    /// @notice GUARDIAN or timelock: pause new deposits and / or new allocations. Lifting a pause is timelock only.
    ///         Exits (requestWithdraw, processing, claims, deposit cancellations) and book hooks are never paused.
    function setPaused(bool deposits, bool allocations) external {
        PoolStorage storage $ = _s();
        IBookrunnerConfig cfg = $.config;
        bool isTimelock = msg.sender == cfg.timelock();
        if (!isTimelock) {
            if (!cfg.hasRole(cfg.GUARDIAN_ROLE(), msg.sender)) revert NotGuardianOrTimelock();
            // the guardian only adds pauses
            if ((!deposits && $.depositsPaused) || (!allocations && $.allocationsPaused)) revert NotTimelock();
        }
        $.depositsPaused = deposits;
        $.allocationsPaused = allocations;
        emit PausedSet(deposits, allocations, msg.sender);
    }

    // =========================================================================================================
    // Views
    // =========================================================================================================

    /// @notice The depositors' assets: pool assets minus the first-loss slice (prices the shares).
    function totalAssets() public view override returns (uint256) {
        PoolStorage storage $ = _s();
        return _poolAssets($) - $.firstLoss;
    }

    /// @inheritdoc IInsurancePool
    function poolAssets() external view returns (uint256) {
        return _poolAssets(_s());
    }

    /// @inheritdoc IInsurancePool
    function freeLiquidity() external view returns (uint256) {
        PoolStorage storage $ = _s();
        return $.cash - $.reserved;
    }

    /// @inheritdoc IInsurancePool
    function firstLossAssets() external view returns (uint256) {
        return _s().firstLoss;
    }

    /// @inheritdoc IInsurancePool
    function claimsTotal() external view returns (uint256) {
        return _s().claims;
    }

    /// @inheritdoc IInsurancePool
    function utilisationBps() external view returns (uint256) {
        PoolStorage storage $ = _s();
        uint256 t = _poolAssets($);
        return t == 0 ? 0 : Math.mulDiv($.claims, BPS, t);
    }

    /// @notice First-loss slice as bps of the pool.
    function firstLossBps() external view returns (uint256) {
        PoolStorage storage $ = _s();
        uint256 t = _poolAssets($);
        return t == 0 ? 0 : Math.mulDiv($.firstLoss, BPS, t);
    }

    /// @notice Accounted cash, cash reserved for filled withdrawals, queued deposits, lifetime premiums and net losses.
    function ledger()
        external
        view
        returns (uint256 cash, uint256 reserved, uint256 depositsPending, uint256 premiumsTotal, uint256 lossesTotal)
    {
        PoolStorage storage $ = _s();
        return ($.cash, $.reserved, $.depositsPending, $.premiumsTotal, $.lossesTotal);
    }

    /// @inheritdoc IInsurancePool
    function bookPosition(uint256 bookId) external view returns (BookPosition memory) {
        return _s().books[bookId];
    }

    /// @notice The books whose marks gate epoch processing.
    function activeBooks() external view returns (uint256[] memory) {
        return _s().activeBooks;
    }

    /// @notice Allocation outstanding of the active books on `market` (per-market cap).
    function marketAllocated(bytes32 market) external view returns (uint256) {
        return _s().marketAllocated[market];
    }

    /// @notice Active books whose last mark predates `epochEnd`.
    function staleBooks(uint256 epochEnd_) external view returns (uint256) {
        return _staleBooks(_s(), epochEnd_);
    }

    /// @inheritdoc IInsurancePool
    function maxAllocation(uint256 bookId, bytes32 market) external view returns (uint256) {
        PoolStorage storage $ = _s();
        if ($.allocationsPaused || $.books[bookId].book != address(0) || $.activeBooks.length >= MAX_ACTIVE_BOOKS) {
            return 0;
        }
        if ($.firstLoss < Math.mulDiv(_poolAssets($), $.firstLossTargetBps, BPS) || _withdrawalsDue($)) return 0;
        return Math.min(_marketRoom($, market), _allocatable($));
    }

    /// @inheritdoc IInsurancePool
    function premiumFloorBps() external view returns (uint16) {
        return _s().premiumFloorBps;
    }

    /// @notice Every bounded parameter (`pendingEpochLength` 0 = none pending).
    function params()
        external
        view
        returns (
            uint16 premiumFloorBps_,
            uint16 marketCapBps,
            uint16 bufferBps,
            uint16 firstLossTargetBps,
            uint32 cooldown,
            uint32 epochLength,
            uint32 processGrace,
            uint32 pendingEpochLength
        )
    {
        PoolStorage storage $ = _s();
        return (
            $.premiumFloorBps,
            $.marketCapBps,
            $.bufferBps,
            $.firstLossTargetBps,
            $.cooldown,
            $.epochLength,
            $.processGrace,
            $.pendingEpochLength
        );
    }

    function paused() external view returns (bool deposits, bool allocations) {
        PoolStorage storage $ = _s();
        return ($.depositsPaused, $.allocationsPaused);
    }

    function config() external view returns (address) {
        return address(_s().config);
    }

    /// @notice When `owner` may transfer shares again (end of their last deposit epoch + cooldown; withdraw requests
    ///         are queued to an epoch ending after it).
    function cooldownEnds(address owner) external view returns (uint256) {
        PoolStorage storage $ = _s();
        return uint256($.lastDepositAt[owner]) + $.cooldown;
    }

    /// @notice The queue: oldest unprocessed epoch and its end, oldest epoch with unfilled withdrawals, escrowed
    ///         withdrawal shares not yet filled, cash reserved for claims.
    function queue()
        external
        view
        returns (uint64 procEpoch, uint64 procEndsAt, uint64 fillEpoch, uint256 pendingShares, uint256 reserved)
    {
        PoolStorage storage $ = _s();
        return ($.procEpoch, $.procEndsAt, $.fillEpoch, $.pendingShares, $.reserved);
    }

    /// @notice End of `epoch` on the current grid (stored once processed).
    function epochEnd(uint64 epoch) external view returns (uint256) {
        PoolStorage storage $ = _s();
        Epoch storage ep = $.epochs[epoch];
        return ep.processed ? ep.endsAt : _projectedEnd($, epoch);
    }

    function epochInfo(uint64 epoch) external view returns (Epoch memory) {
        return _s().epochs[epoch];
    }

    function requestInfo(uint256 requestId) external view returns (Request memory) {
        return _s().requests[requestId];
    }

    function depositInfo(uint256 depositId) external view returns (DepositRequest memory) {
        return _s().deposits[depositId];
    }

    function requestCount() external view returns (uint256) {
        return _s().requestCount;
    }

    /// @notice Escrowed deposit shares minted for processed deposits and not yet claimed.
    function depositSharesUnclaimed() external view returns (uint256) {
        return _s().depositSharesUnclaimed;
    }

    /// @notice Assets `requestId` can claim now (what its epoch has filled for it, minus what it claimed).
    function claimable(uint256 requestId) external view returns (uint256) {
        PoolStorage storage $ = _s();
        Request storage r = $.requests[requestId];
        if (r.owner == address(0)) return 0;
        return _entitled($, r) - r.claimed;
    }

    /// @notice Entry is queued: requestDeposit / claimDeposit.
    function maxDeposit(address) public pure override returns (uint256) {
        return 0;
    }

    function maxMint(address) public pure override returns (uint256) {
        return 0;
    }

    /// @notice Exit is queued: requestWithdraw / claim.
    function maxWithdraw(address) public pure override returns (uint256) {
        return 0;
    }

    function maxRedeem(address) public pure override returns (uint256) {
        return 0;
    }

    function deposit(uint256, address) public pure override returns (uint256) {
        revert QueuedOnly();
    }

    function mint(uint256, address) public pure override returns (uint256) {
        revert QueuedOnly();
    }

    function withdraw(uint256, address, address) public pure override returns (uint256) {
        revert QueuedOnly();
    }

    function redeem(uint256, address, address) public pure override returns (uint256) {
        revert QueuedOnly();
    }

    // =========================================================================================================
    // Internals
    // =========================================================================================================

    function _s() private pure returns (PoolStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return DECIMALS_OFFSET;
    }

    function _poolAssets(PoolStorage storage $) private view returns (uint256) {
        return $.cash - $.reserved + $.claims;
    }

    /// @dev Room left under the per-market cap: marketCapBps of T minus the active books' allocations on `market`.
    function _marketRoom(PoolStorage storage $, bytes32 market) private view returns (uint256) {
        uint256 cap = Math.mulDiv(_poolAssets($), $.marketCapBps, BPS);
        uint256 used = $.marketAllocated[market];
        return cap > used ? cap - used : 0;
    }

    /// @dev Free liquidity above the buffer.
    function _allocatable(PoolStorage storage $) private view returns (uint256) {
        uint256 free = $.cash - $.reserved;
        uint256 buffer = Math.mulDiv(_poolAssets($), $.bufferBps, BPS);
        return free > buffer ? free - buffer : 0;
    }

    function _entitled(PoolStorage storage $, Request storage r) private view returns (uint256) {
        Epoch storage ep = $.epochs[r.epoch];
        return ep.shares == 0 ? 0 : Math.mulDiv(r.shares, ep.assets, ep.shares);
    }

    /// @dev Moves a book's claim to `value` (<= allocation): a fall is a loss (first-loss slice first), a rise a
    ///      recovery of that book's losses (depositors first, the reverse order).
    function _revalue(PoolStorage storage $, uint256 bookId, BookPosition storage p, uint256 value) private {
        uint256 c = p.claim;
        if (value < c) {
            uint256 amount = c - value;
            uint256 fl = Math.min(amount, $.firstLoss);
            $.firstLoss -= fl;
            p.lossFirstLoss += fl;
            p.lossDepositors += amount - fl;
            $.lossesTotal += amount;
            $.claims -= amount;
            p.claim = value;
            emit LossReported(bookId, amount, fl, amount - fl, value);
        } else if (value > c) {
            uint256 amount = value - c;
            uint256 lossD = p.lossDepositors;
            uint256 d = Math.min(amount, lossD);
            uint256 f = amount - d;
            p.lossDepositors = lossD - d;
            p.lossFirstLoss -= f;
            // no depositor shares left: their part is the slice's (never a gift to the next depositor)
            $.firstLoss += totalSupply() == 0 ? amount : f;
            $.lossesTotal -= amount;
            $.claims += amount;
            p.claim = value;
            emit LossRecovered(bookId, amount, f, d, value);
        }
    }

    function _deactivate(PoolStorage storage $, uint256 bookId, BookPosition storage p) private {
        p.active = false;
        $.marketAllocated[p.market] -= p.allocation;
        uint256 idx = $.activeIndex[bookId];
        uint256 last = $.activeBooks.length;
        if (idx != last) {
            uint256 moved = $.activeBooks[last - 1];
            $.activeBooks[idx - 1] = moved;
            $.activeIndex[moved] = idx;
        }
        $.activeBooks.pop();
        delete $.activeIndex[bookId];
    }

    function _staleBooks(PoolStorage storage $, uint256 epochEnd_) private view returns (uint256 n) {
        uint256 len = $.activeBooks.length;
        for (uint256 i; i < len; ++i) {
            if ($.books[$.activeBooks[i]].lastMarkAt < epochEnd_) ++n;
        }
    }

    /// @dev End of the epoch `epoch` (>= procEpoch) on the current grid.
    function _projectedEnd(PoolStorage storage $, uint64 epoch) private view returns (uint256) {
        if (epoch < $.procEpoch) return $.epochs[epoch].endsAt;
        return uint256($.procEndsAt) + uint256(epoch - $.procEpoch) * $.epochLength;
    }

    /// @dev The first unprocessed epoch ending at or after `notBefore` (> now).
    function _openEpoch(PoolStorage storage $, uint256 notBefore) private view returns (uint64) {
        uint256 ends = $.procEndsAt;
        uint256 k = ends >= notBefore ? 0 : Math.ceilDiv(notBefore - ends, $.epochLength);
        return $.procEpoch + uint64(k);
    }

    /// @dev Withdrawals are due: a processed epoch still has unfilled shares, or an ended unprocessed epoch holds
    ///      withdrawal shares (scans at most DUE_SCAN_EPOCHS ended epochs; beyond that, assumed due).
    function _withdrawalsDue(PoolStorage storage $) private view returns (bool) {
        if ($.pendingShares == 0) return false;
        if ($.fillEpoch < $.procEpoch) return true;
        uint256 ends = $.procEndsAt;
        uint256 len = $.epochLength;
        uint64 e = $.procEpoch;
        for (uint256 i; i < DUE_SCAN_EPOCHS; ++i) {
            if (ends > block.timestamp) return false;
            if ($.epochs[e].shares != 0) return true;
            ++e;
            ends += len;
        }
        return true;
    }

    /// @dev Fills processed epochs' withdrawals oldest first from free liquidity, at the current share price.
    function _fillProcessed(PoolStorage storage $) private {
        while ($.fillEpoch < $.procEpoch) {
            uint64 e = $.fillEpoch;
            Epoch storage ep = $.epochs[e];
            uint256 remaining = ep.shares - ep.filledShares;
            if (remaining != 0) {
                uint256 free = $.cash - $.reserved;
                uint256 value = _convertToAssets(remaining, Math.Rounding.Floor);
                uint256 s = remaining;
                if (value > free) {
                    // partial: the shares free liquidity buys at the current price (assets <= free)
                    s = Math.min(_convertToShares(free, Math.Rounding.Floor), remaining);
                    value = _convertToAssets(s, Math.Rounding.Floor);
                }
                if (s != 0) {
                    _burn(address(this), s);
                    ep.filledShares += s;
                    ep.assets += value;
                    $.reserved += value;
                    $.pendingShares -= s;
                    emit EpochFilled(e, s, value, s == remaining);
                }
                if (s != remaining) return;
            }
            $.fillEpoch = e + 1;
        }
    }

    /// @dev Nothing queued (no escrowed withdrawal, no queued deposit): every ended epoch is empty, so the queue moves
    ///      to the current epoch in one step, applying a pending epoch length on a fresh grid.
    function _skipIdleEpochs(PoolStorage storage $) private {
        if ($.pendingShares != 0 || $.depositsPending != 0 || $.procEndsAt > block.timestamp) return;
        uint256 len = $.pendingEpochLength;
        bool applied = len != 0;
        if (applied) {
            $.epochLength = uint32(len);
            $.pendingEpochLength = 0;
        } else {
            len = $.epochLength;
        }
        uint64 next = _nextGridEnd(len);
        uint256 k = (uint256(next) - $.procEndsAt + len - 1) / len; // epochs skipped (>= 1)
        $.procEpoch += uint64(k);
        $.fillEpoch = $.procEpoch;
        $.procEndsAt = next;
        if (applied) emit EpochLengthApplied(len, next);
    }

    function _nextGridEnd(uint256 len) private view returns (uint64) {
        return uint64((block.timestamp / len + 1) * len);
    }

    /// @dev Share transfers: never into the pool directly (escrow only through requestWithdraw) and never out of an
    ///      account still in its deposit cooldown (closes the deposit-then-transfer bypass; the cooldown is set only by
    ///      the owner's own deposits, so nobody can extend someone else's). Mints, burns and escrow moves are free.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            if (to == address(this)) revert DirectEscrow();
            PoolStorage storage $ = _s();
            uint256 until = uint256($.lastDepositAt[from]) + $.cooldown;
            if (block.timestamp < until) revert SharesInCooldown(from, until);
        }
        super._update(from, to, value);
    }

    function _setParam(PoolStorage storage $, bytes32 key, uint256 value) private {
        if (key == PARAM_PREMIUM_FLOOR_BPS) {
            if (value > MAX_PREMIUM_BPS) revert ParamOutOfRange(key, value);
            $.premiumFloorBps = uint16(value);
        } else if (key == PARAM_MARKET_CAP_BPS) {
            if (value < 100 || value > BPS) revert ParamOutOfRange(key, value);
            $.marketCapBps = uint16(value);
        } else if (key == PARAM_BUFFER_BPS) {
            if (value > 9000) revert ParamOutOfRange(key, value);
            $.bufferBps = uint16(value);
        } else if (key == PARAM_FIRST_LOSS_TARGET_BPS) {
            if (value > 5000) revert ParamOutOfRange(key, value);
            $.firstLossTargetBps = uint16(value);
        } else if (key == PARAM_COOLDOWN) {
            if (value > 30 days) revert ParamOutOfRange(key, value);
            $.cooldown = uint32(value);
        } else if (key == PARAM_PROCESS_GRACE) {
            if (value < 1 hours || value > 7 days) revert ParamOutOfRange(key, value);
            $.processGrace = uint32(value);
        } else if (key == PARAM_EPOCH_LENGTH) {
            if (value < 1 days || value > 30 days) revert ParamOutOfRange(key, value);
            $.pendingEpochLength = uint32(value);
        } else {
            revert UnknownParam(key);
        }
        emit PoolParamSet(key, value);
    }

    /// @dev Upgrades only through the protocol timelock.
    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != _s().config.timelock()) revert NotTimelock();
    }
}
