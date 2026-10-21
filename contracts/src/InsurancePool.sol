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
/// @notice ERC-4626 over the settlement token (`config.usdc()` at initialize; shares "ib<symbol>", 12 decimals).
///
///         Value. Pool assets T = free liquidity + book claims, where free liquidity = accounted cash - cash reserved
///         for filled withdrawals, and a book's claim is its allocation marked down by the losses it reported. T splits
///         into the treasury's first-loss slice FL (own accounting, no shares) and the depositors' assets D = T - FL,
///         which is `totalAssets()` and prices the shares.
///           - premium (`notifyPremium`, from a book's RevenueRouter): T += p, FL += p * FL / T (same rate as D);
///           - loss (`reportLoss`, from a book whose IF equity fell below its claim): FL absorbs first, then D;
///           - recovery (`reportRecovery`, the IF refilled up to the allocation): reverses that book's loss, D first;
///           - allocate / repay move cash <-> claims and never change T, deposits and filled withdrawals happen at
///             the share price (rounding in the pool's favour), so the price never moves on them.
///         Cash is tracked, never read from `balanceOf`: a donation changes nothing (inflation attack), on top of the
///         ERC-4626 virtual offset of 6 decimals.
///
///         Exits. `requestWithdraw` escrows shares into the first weekly epoch that ends after now and after the
///         owner's cooldown (7 days from their last deposit); it is never refused. Once an epoch has ended its escrowed
///         shares are filled oldest epoch first from free liquidity at the share price of that moment (partially if
///         cash is short; the rest stays escrowed, still exposed to premiums and losses, until cash returns), so losses
///         reported before a withdrawal is filled hit it. `claim` pays the filled part pro-rata. Deposits are paused by
///         the guardian, exits never.
///
///         Books. `allocate` only from the BookFactory's book for the id (its closeWindow), once per book, within the
///         per-market cap (30% of T) and the free liquidity above the buffer (20% of T); the book, its vault and router
///         are recorded then and authenticate every later hook.
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
    /// @notice Epochs `repay` and `claim` close on the way (processQueue takes any number). With nothing queued the
    ///         queue jumps to the current epoch in one step, so only epochs that still hold escrowed shares count.
    uint256 public constant AUTO_FILL_EPOCHS = 8;
    /// @notice Epochs `allocate` closes before it requires the queue to be caught up.
    uint256 public constant ALLOCATE_FILL_EPOCHS = 32;

    bytes32 public constant PARAM_PREMIUM_FLOOR_BPS = "premiumFloorBps";
    bytes32 public constant PARAM_MARKET_CAP_BPS = "marketCapBps";
    bytes32 public constant PARAM_BUFFER_BPS = "bufferBps";
    bytes32 public constant PARAM_COOLDOWN = "cooldown";
    bytes32 public constant PARAM_EPOCH_LENGTH = "epochLength";
    bytes32 public constant PARAM_FIRST_LOSS_TARGET_BPS = "firstLossTargetBps";

    struct Epoch {
        uint256 shares; // escrowed for this epoch
        uint256 filledShares; // burned at fill
        uint256 assets; // reserved for them at fill (claimed pro-rata)
    }

    struct Request {
        address owner;
        uint64 epoch;
        uint256 shares;
        uint256 claimed; // assets paid so far
    }

    /// @custom:storage-location erc7201:bookrunner.storage.InsurancePool
    struct PoolStorage {
        IBookrunnerConfig config;
        uint256 cash; // settlement token accounted by the pool (balanceOf may be higher: donations)
        uint256 reserved; // cash owed to filled withdrawals, not yet claimed (dust of pro-rata claims stays here)
        uint256 claims; // sum of the books' claims
        uint256 firstLoss; // the first-loss slice (treasury), part of T
        uint256 premiumsTotal;
        uint256 lossesTotal; // reported losses net of recoveries
        mapping(uint256 bookId => BookPosition) books;
        mapping(address owner => uint64) lastDepositAt;
        // ---- queue ----
        uint64 fillEpoch; // oldest epoch not yet closed
        uint64 fillEpochEndsAt;
        uint256 pendingShares; // escrowed, not yet filled (all epochs)
        mapping(uint64 epoch => Epoch) epochs;
        uint256 requestCount;
        mapping(uint256 id => Request) requests;
        // ---- parameters (timelock, bounded) ----
        uint16 premiumFloorBps;
        uint16 marketCapBps;
        uint16 bufferBps;
        uint16 firstLossTargetBps;
        uint32 cooldown;
        uint32 epochLength;
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
    error AlreadyAllocated(uint256 bookId);
    error AllocationsPaused();
    error DepositsPaused();
    error ReceiverNotCaller(address receiver);
    error QueueBehind(uint64 epoch);
    error OverMarketCap(uint256 amount, uint256 cap);
    error InsufficientFreeLiquidity(uint256 amount, uint256 available);
    error ExceedsClaim(uint256 amount, uint256 claim);
    error ExceedsLosses(uint256 amount, uint256 losses);
    error SharesInCooldown(address owner, uint256 until);
    error DirectEscrow();
    error QueuedWithdrawalsOnly();
    error UnknownRequest(uint256 requestId);
    error NothingToClaim(uint256 requestId);
    error UnknownParam(bytes32 key);
    error ParamOutOfRange(bytes32 key, uint256 value);
    error FirstLossBelowTarget(uint256 remaining, uint256 target);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Proxy initializer. Caches `config.usdc()` as the asset; name "BookRunner Insurance Pool <sym>",
    ///         symbol "ib<sym>". Defaults: premium floor 12%, per-market cap 30%, buffer 20%, first-loss target 10%,
    ///         cooldown 7 days, weekly epochs (the first ends one epoch after initialization).
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
        _setParam($, PARAM_EPOCH_LENGTH, 7 days);
        $.fillEpochEndsAt = uint64(block.timestamp) + $.epochLength;
    }

    // =========================================================================================================
    // Depositors
    // =========================================================================================================

    /// @inheritdoc IInsurancePool
    function requestWithdraw(uint256 shares) external nonReentrant returns (uint256 requestId) {
        if (shares == 0) revert ZeroAmount();
        PoolStorage storage $ = _s();
        _skipIdleEpochs($);
        address owner = msg.sender;
        uint256 len = $.epochLength;
        uint256 ends = $.fillEpochEndsAt;
        uint256 needed = Math.max(block.timestamp + 1, uint256($.lastDepositAt[owner]) + $.cooldown);
        uint256 k = ends >= needed ? 0 : Math.ceilDiv(needed - ends, len);
        uint64 epoch = $.fillEpoch + uint64(k);
        // escrow without the transfer rules of _update (exits are never blocked by the cooldown)
        ERC20Upgradeable._update(owner, address(this), shares);
        $.epochs[epoch].shares += shares;
        $.pendingShares += shares;
        requestId = ++$.requestCount;
        $.requests[requestId] = Request({owner: owner, epoch: epoch, shares: shares, claimed: 0});
        emit WithdrawRequested(requestId, owner, shares, epoch, uint64(ends + k * len));
    }

    /// @inheritdoc IInsurancePool
    function claim(uint256 requestId) external nonReentrant returns (uint256 assets) {
        PoolStorage storage $ = _s();
        _fill($, AUTO_FILL_EPOCHS);
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
    function processQueue(uint256 maxEpochs) external nonReentrant {
        _fill(_s(), maxEpochs);
    }

    /// @notice Anyone: adds `amount` to the first-loss slice (pulled from the caller). Never paused.
    function depositFirstLoss(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        PoolStorage storage $ = _s();
        $.cash += amount;
        $.firstLoss += amount;
        emit FirstLossDeposited(msg.sender, amount);
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Timelock: withdraws `amount` of the first-loss slice to `to`, from free liquidity, keeping the slice at
    ///         or above `firstLossTargetBps` of the pool after the withdrawal.
    function withdrawFirstLoss(uint256 amount, address to) external nonReentrant {
        PoolStorage storage $ = _s();
        if (msg.sender != $.config.timelock()) revert NotTimelock();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
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
    function allocate(uint256 bookId, uint256 amount) external nonReentrant {
        PoolStorage storage $ = _s();
        IBookFactory factory = IBookFactory($.config.factory());
        if (address(factory) == address(0) || factory.bookOf(bookId) != msg.sender) revert NotBook(bookId, msg.sender);
        if ($.allocationsPaused) revert AllocationsPaused();
        if (amount == 0) revert ZeroAmount();
        BookPosition storage p = $.books[bookId];
        if (p.book != address(0)) revert AlreadyAllocated(bookId);
        // withdrawals that are due come first
        if (!_fill($, ALLOCATE_FILL_EPOCHS)) revert QueueBehind($.fillEpoch);
        uint256 cap = _marketCap($);
        if (amount > cap) revert OverMarketCap(amount, cap);
        uint256 available = _allocatable($);
        if (amount > available) revert InsufficientFreeLiquidity(amount, available);

        BRTypes.BookComponents memory c = factory.componentsOf(bookId);
        if (c.vault == address(0) || c.router == address(0)) revert ZeroAddress();
        p.book = msg.sender;
        p.vault = c.vault;
        p.router = c.router;
        p.allocation = amount;
        p.claim = amount;
        $.claims += amount;
        $.cash -= amount;
        emit Allocated(bookId, msg.sender, c.vault, amount, _poolAssets($));
        IERC20(asset()).safeTransfer(c.vault, amount);
    }

    /// @inheritdoc IInsurancePool
    function reportLoss(uint256 bookId, uint256 amount) external nonReentrant {
        PoolStorage storage $ = _s();
        BookPosition storage p = _bookCaller($, bookId);
        if (amount == 0) revert ZeroAmount();
        uint256 c = p.claim;
        if (amount > c) revert ExceedsClaim(amount, c);
        p.claim = c - amount;
        $.claims -= amount;
        $.lossesTotal += amount;
        uint256 fl = Math.min(amount, $.firstLoss);
        $.firstLoss -= fl;
        p.lossFirstLoss += fl;
        p.lossDepositors += amount - fl;
        emit LossReported(bookId, amount, fl, amount - fl, p.claim);
    }

    /// @inheritdoc IInsurancePool
    function reportRecovery(uint256 bookId, uint256 amount) external nonReentrant {
        PoolStorage storage $ = _s();
        BookPosition storage p = _bookCaller($, bookId);
        if (amount == 0) revert ZeroAmount();
        uint256 lossD = p.lossDepositors;
        uint256 lossF = p.lossFirstLoss;
        if (amount > lossD + lossF) revert ExceedsLosses(amount, lossD + lossF);
        uint256 d = Math.min(amount, lossD);
        uint256 f = amount - d;
        p.lossDepositors = lossD - d;
        p.lossFirstLoss = lossF - f;
        // no depositor shares left: their part is the slice's (never a gift to the next depositor)
        $.firstLoss += totalSupply() == 0 ? amount : f;
        p.claim += amount;
        $.claims += amount;
        $.lossesTotal -= amount;
        emit LossRecovered(bookId, amount, f, d, p.claim);
    }

    /// @inheritdoc IInsurancePool
    function repay(uint256 bookId, uint256 amount) external nonReentrant {
        PoolStorage storage $ = _s();
        BookPosition storage p = $.books[bookId];
        if (p.vault == address(0) || msg.sender != p.vault) revert NotBookVault(bookId, msg.sender);
        if (amount == 0) revert ZeroAmount();
        uint256 c = p.claim;
        if (amount > c) revert ExceedsClaim(amount, c);
        p.claim = c - amount;
        p.allocation -= amount;
        $.claims -= amount;
        $.cash += amount;
        emit Repaid(bookId, amount, p.claim);
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        _fill($, AUTO_FILL_EPOCHS);
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

    /// @notice Timelock: sets a bounded parameter. premiumFloorBps <= 5000; marketCapBps 100..10000; bufferBps <= 9000;
    ///         firstLossTargetBps <= 5000; cooldown <= 30 days; epochLength 1..30 days (applies from the next epoch).
    function setParam(bytes32 key, uint256 value) external {
        PoolStorage storage $ = _s();
        if (msg.sender != $.config.timelock()) revert NotTimelock();
        _setParam($, key, value);
    }

    /// @notice GUARDIAN or timelock: pause new deposits and / or new allocations. Lifting a pause is timelock only.
    ///         Exits (requestWithdraw, fills, claims) and book hooks (loss, recovery, repay, premium) are never paused.
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

    /// @notice Accounted cash, cash reserved for filled withdrawals, lifetime premiums and net reported losses.
    function ledger()
        external
        view
        returns (uint256 cash, uint256 reserved, uint256 premiumsTotal, uint256 lossesTotal)
    {
        PoolStorage storage $ = _s();
        return ($.cash, $.reserved, $.premiumsTotal, $.lossesTotal);
    }

    /// @inheritdoc IInsurancePool
    function bookPosition(uint256 bookId) external view returns (BookPosition memory) {
        return _s().books[bookId];
    }

    /// @inheritdoc IInsurancePool
    function maxAllocation(uint256 bookId) external view returns (uint256) {
        PoolStorage storage $ = _s();
        if ($.allocationsPaused || $.books[bookId].book != address(0)) return 0;
        return Math.min(_marketCap($), _allocatable($));
    }

    /// @inheritdoc IInsurancePool
    function premiumFloorBps() external view returns (uint16) {
        return _s().premiumFloorBps;
    }

    /// @notice Every bounded parameter.
    function params()
        external
        view
        returns (
            uint16 premiumFloorBps_,
            uint16 marketCapBps,
            uint16 bufferBps,
            uint16 firstLossTargetBps,
            uint32 cooldown,
            uint32 epochLength
        )
    {
        PoolStorage storage $ = _s();
        return ($.premiumFloorBps, $.marketCapBps, $.bufferBps, $.firstLossTargetBps, $.cooldown, $.epochLength);
    }

    function paused() external view returns (bool deposits, bool allocations) {
        PoolStorage storage $ = _s();
        return ($.depositsPaused, $.allocationsPaused);
    }

    function config() external view returns (address) {
        return address(_s().config);
    }

    /// @notice When `owner` may transfer shares again (their last deposit + cooldown; withdraw requests are queued
    ///         to an epoch ending after it).
    function cooldownEnds(address owner) external view returns (uint256) {
        PoolStorage storage $ = _s();
        return uint256($.lastDepositAt[owner]) + $.cooldown;
    }

    /// @notice The queue: oldest open epoch, its end, escrowed shares not yet filled, cash reserved for claims.
    function queue() external view returns (uint64 epoch, uint64 endsAt, uint256 pendingShares, uint256 reserved) {
        PoolStorage storage $ = _s();
        return ($.fillEpoch, $.fillEpochEndsAt, $.pendingShares, $.reserved);
    }

    function epochInfo(uint64 epoch) external view returns (Epoch memory) {
        return _s().epochs[epoch];
    }

    function requestInfo(uint256 requestId) external view returns (Request memory) {
        return _s().requests[requestId];
    }

    function requestCount() external view returns (uint256) {
        return _s().requestCount;
    }

    /// @notice Assets `requestId` can claim now (what its epoch has filled for it, minus what it claimed).
    function claimable(uint256 requestId) external view returns (uint256) {
        PoolStorage storage $ = _s();
        Request storage r = $.requests[requestId];
        if (r.owner == address(0)) return 0;
        return _entitled($, r) - r.claimed;
    }

    /// @notice Depositing is ERC-4626 to the caller's own account only (the cooldown is the owner's); 0 while paused.
    function maxDeposit(address) public view override returns (uint256) {
        return _s().depositsPaused ? 0 : type(uint256).max;
    }

    function maxMint(address) public view override returns (uint256) {
        return _s().depositsPaused ? 0 : type(uint256).max;
    }

    /// @notice No instant exit: withdrawals go through requestWithdraw / claim.
    function maxWithdraw(address) public pure override returns (uint256) {
        return 0;
    }

    function maxRedeem(address) public pure override returns (uint256) {
        return 0;
    }

    /// @notice Reverts: exits go through requestWithdraw (queued) and claim.
    function withdraw(uint256, address, address) public pure override returns (uint256) {
        revert QueuedWithdrawalsOnly();
    }

    /// @notice Reverts: exits go through requestWithdraw (queued) and claim.
    function redeem(uint256, address, address) public pure override returns (uint256) {
        revert QueuedWithdrawalsOnly();
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

    function _marketCap(PoolStorage storage $) private view returns (uint256) {
        return Math.mulDiv(_poolAssets($), $.marketCapBps, BPS);
    }

    /// @dev Free liquidity above the buffer.
    function _allocatable(PoolStorage storage $) private view returns (uint256) {
        uint256 free = $.cash - $.reserved;
        uint256 buffer = Math.mulDiv(_poolAssets($), $.bufferBps, BPS);
        return free > buffer ? free - buffer : 0;
    }

    function _bookCaller(PoolStorage storage $, uint256 bookId) private view returns (BookPosition storage p) {
        p = $.books[bookId];
        if (p.book == address(0) || msg.sender != p.book) revert NotBook(bookId, msg.sender);
    }

    function _entitled(PoolStorage storage $, Request storage r) private view returns (uint256) {
        Epoch storage ep = $.epochs[r.epoch];
        return ep.shares == 0 ? 0 : Math.mulDiv(r.shares, ep.assets, ep.shares);
    }

    /// @dev Fills ended epochs oldest first from free liquidity, at most `maxEpochs` closes. Returns true when no ended
    ///      epoch is left unfilled (the queue is caught up). Never reverts.
    function _fill(PoolStorage storage $, uint256 maxEpochs) private returns (bool caughtUp) {
        for (uint256 i; i < maxEpochs; ++i) {
            if (_skipIdleEpochs($)) return true;
            uint64 e = $.fillEpoch;
            uint64 ends = $.fillEpochEndsAt;
            if (ends > block.timestamp) return true;
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
                if (s != remaining) return false;
            }
            uint64 next = ends + $.epochLength;
            $.fillEpoch = e + 1;
            $.fillEpochEndsAt = next;
            emit EpochClosed(e, next);
        }
        return $.fillEpochEndsAt > block.timestamp;
    }

    /// @dev Nothing escrowed in any epoch: the ended epochs are all empty, so the queue moves to the current epoch in one
    ///      step (keeping the epoch grid). Returns true when nothing is queued.
    function _skipIdleEpochs(PoolStorage storage $) private returns (bool idle) {
        if ($.pendingShares != 0) return false;
        uint256 ends = $.fillEpochEndsAt;
        if (ends <= block.timestamp) {
            uint256 len = $.epochLength;
            uint256 k = (block.timestamp - ends) / len + 1;
            uint64 next = uint64(ends + k * len);
            uint64 last = $.fillEpoch + uint64(k) - 1;
            $.fillEpoch = last + 1;
            $.fillEpochEndsAt = next;
            emit EpochClosed(last, next);
        }
        return true;
    }

    /// @dev Deposits only to the caller's own account (their cooldown starts now), not while paused; cash tracked.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        PoolStorage storage $ = _s();
        if ($.depositsPaused) revert DepositsPaused();
        if (receiver != caller) revert ReceiverNotCaller(receiver);
        if (assets == 0 || shares == 0) revert ZeroAmount();
        $.lastDepositAt[receiver] = uint64(block.timestamp);
        $.cash += assets;
        super._deposit(caller, receiver, assets, shares);
    }


    /// @dev Share transfers: never into the pool directly (escrow only through requestWithdraw) and never out of an
    ///      account still in its deposit cooldown (closes the deposit-then-transfer bypass; the cooldown is set only by
    ///      the owner's own deposits, so nobody can extend someone else's). Mints, burns and the escrow are free.
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
        } else if (key == PARAM_EPOCH_LENGTH) {
            if (value < 1 days || value > 30 days) revert ParamOutOfRange(key, value);
            $.epochLength = uint32(value);
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
