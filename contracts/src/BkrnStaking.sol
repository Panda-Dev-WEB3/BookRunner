// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IBkrnStaking} from "./interfaces/IBkrnStaking.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";

/// @title BkrnStaking — $BKRN staking, bonds (locks) and slashing.
/// @notice Stake is the basis for access and bonding: sponsor bonds (MarketCharter), committee member
///         bonds (RiskCommittee) and agent tier bonds (each book's MMMandate) are *locks* on stake.
///         Locks are keyed `(account, lockId)` and owned by the locker that created them; only that
///         locker can unlock or slash them. Locked stake and stake in cooldown cannot be re-locked;
///         locked stake cannot be unstaked. Slashing reduces the lock and the stake and sends the
///         slashed BKRN to `config.slashRecipient()`.
///
///         Buyback distribution: BKRN bought back by `BkrnFeeRouter` is STREAMED to stakers over
///         `rewardsDuration` (timelock-set, default 7 days; Synthetix rewardRate / periodFinish): a
///         notification adds its amount plus the unstreamed rest of the current period to a new period
///         starting now. Stake earns pro-rata to its EARNING balance `staked - pendingUnstake`: stake in
///         its unstake cooldown earns nothing, and the cooldown is at least MIN_COOLDOWN (1 day). Together
///         this removes the just-in-time stake (front-run the keeper's buyback, or flash-stake) that the
///         previous instant allocation paid a full pro-rata share of carry accrued before it was staked.
///         Rewards streamed while nothing earns, and the exact division remainder of every accrual, are
///         carried forward into the next notification; per-account flooring dust stays in the contract.
/// @dev Invariants: for every account `staked >= locked + pendingUnstake`;
///      `totalEarning == sum(staked - pendingUnstake)`; `bkrn.balanceOf(this) >= totalStaked + rewardReserve`;
///      the sum of all `earned` is `<= rewardReserve - queuedReward - unstreamedReward`.
contract BkrnStaking is IBkrnStaking, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes32 private constant DEFAULT_ADMIN_ROLE = 0x00;
    uint256 private constant PRECISION = 1e18;

    /// @notice Default unstake cooldown.
    uint64 public constant DEFAULT_COOLDOWN = 7 days;
    /// @notice Maximum configurable cooldown.
    uint64 public constant MAX_COOLDOWN = 90 days;
    /// @notice Minimum configurable cooldown (no same-block stake/unstake round trips).
    uint64 public constant MIN_COOLDOWN = 1 days;
    /// @notice Default period over which a buyback notification is streamed.
    uint64 public constant DEFAULT_REWARDS_DURATION = 7 days;
    /// @notice Bounds of the configurable rewards duration.
    uint64 public constant MIN_REWARDS_DURATION = 1 days;
    uint64 public constant MAX_REWARDS_DURATION = 90 days;

    struct Account {
        uint256 staked;
        uint256 locked;
        uint256 pendingUnstake;
        uint64 unstakeAvailableAt;
    }

    struct LockData {
        uint256 amount;
        address locker;
    }

    /// @notice Protocol registry.
    IBookrunnerConfig public immutable config;
    /// @notice The staked token (config.bkrn() at deployment).
    IERC20 public immutable bkrn;

    /// @notice Unstake cooldown in seconds (admin-settable, default 7 days, >= MIN_COOLDOWN).
    uint64 public cooldown;
    /// @notice Streaming period of each reward notification (admin-settable, default 7 days).
    uint64 public rewardsDuration;
    /// @notice End of the current reward stream (0 before the first notification).
    uint64 public periodFinish;
    /// @notice Last time the accumulator was brought forward (capped at periodFinish).
    uint64 public lastUpdateTime;
    /// @notice Sum of all staked balances (including locked and cooling-down stake).
    uint256 public totalStaked;
    /// @notice Sum of earning balances (`staked - pendingUnstake`): the reward denominator.
    uint256 public totalEarning;
    /// @notice Current stream rate: BKRN wei per second, scaled by 1e18.
    uint256 public rewardRate;

    /// @inheritdoc IBkrnStaking
    mapping(address locker => bool) public isLocker;

    mapping(address account => Account) private _accounts;
    mapping(address account => mapping(bytes32 lockId => LockData)) private _locks;

    // ---- rewards ----
    /// @notice Cumulative reward per staked token, scaled by 1e18.
    uint256 public rewardPerTokenStored;
    /// @notice BKRN notified as rewards and not yet claimed (includes `queuedReward` and rounding dust).
    uint256 public rewardReserve;
    /// @dev Rewards not yet allocated to stakers, scaled by 1e18: everything streamed while nothing was
    ///      earning plus the exact division remainder of each accrual and of each rate computation.
    ///      Carried into the next notification, so nothing is double counted.
    uint256 private _unallocatedScaled;
    /// @notice Snapshot of `rewardPerTokenStored` at the account's last reward update.
    mapping(address account => uint256) public userRewardPerTokenPaid;
    mapping(address account => uint256) private _rewards;

    // ---------------------------------------------------------------------------------------------
    // Errors / events
    // ---------------------------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientAvailable(uint256 available, uint256 requested);
    error NothingPending();
    error CooldownActive(uint64 availableAt);
    error CooldownTooLong(uint64 cooldown, uint64 max);
    error CooldownTooShort(uint64 cooldown, uint64 min);
    error BadRewardsDuration(uint64 duration);
    error NotAdmin(address caller);
    error NotAdminOrFactory(address caller);
    error NotLocker(address caller);
    error NotLockOwner(address owner, address caller);
    error NotFeeRouter(address caller);
    error RewardNotReceived(uint256 required, uint256 balance);
    error SlashRecipientUnset();

    /// @notice `locker` was added (`allowed`) or removed as a locker.
    event LockerSet(address indexed locker, bool allowed, address indexed by);
    /// @notice Unstake cooldown changed.
    event CooldownSet(uint64 cooldown);
    /// @notice Rewards streaming duration changed (applies from the next notification).
    event RewardsDurationSet(uint64 duration);
    /// @notice A pending unstake request was cancelled; the amount is available again.
    event UnstakeCancelled(address indexed account, uint256 amount);

    // ---------------------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------------------

    /// @param config_ BookrunnerConfig; `config_.bkrn()` must already be set.
    constructor(address config_) {
        if (config_ == address(0)) revert ZeroAddress();
        config = IBookrunnerConfig(config_);
        address token = IBookrunnerConfig(config_).bkrn();
        if (token == address(0)) revert ZeroAddress();
        bkrn = IERC20(token);
        cooldown = DEFAULT_COOLDOWN;
        rewardsDuration = DEFAULT_REWARDS_DURATION;
        emit CooldownSet(DEFAULT_COOLDOWN);
        emit RewardsDurationSet(DEFAULT_REWARDS_DURATION);
    }

    // ---------------------------------------------------------------------------------------------
    // Staking
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IBkrnStaking
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _updateReward(msg.sender);
        _accounts[msg.sender].staked += amount;
        totalStaked += amount;
        totalEarning += amount;
        emit Staked(msg.sender, amount);
        bkrn.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @inheritdoc IBkrnStaking
    /// @dev Adds to any existing pending request and restarts the cooldown for the whole pending amount.
    ///      Stake pending unstake stops earning rewards immediately.
    function requestUnstake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 available = availableOf(msg.sender);
        if (available < amount) revert InsufficientAvailable(available, amount);
        _updateReward(msg.sender);
        Account storage a = _accounts[msg.sender];
        a.pendingUnstake += amount;
        totalEarning -= amount;
        uint64 availableAt = uint64(block.timestamp) + cooldown;
        a.unstakeAvailableAt = availableAt;
        emit UnstakeRequested(msg.sender, amount, availableAt);
    }

    /// @notice Cancels the caller's pending unstake request; the amount becomes available (and earns) again.
    function cancelUnstake() external returns (uint256 amount) {
        Account storage a = _accounts[msg.sender];
        amount = a.pendingUnstake;
        if (amount == 0) revert NothingPending();
        _updateReward(msg.sender);
        totalEarning += amount;
        a.pendingUnstake = 0;
        a.unstakeAvailableAt = 0;
        emit UnstakeCancelled(msg.sender, amount);
    }

    /// @inheritdoc IBkrnStaking
    function unstake() external nonReentrant returns (uint256 amount) {
        Account storage a = _accounts[msg.sender];
        amount = a.pendingUnstake;
        if (amount == 0) revert NothingPending();
        if (block.timestamp < a.unstakeAvailableAt) revert CooldownActive(a.unstakeAvailableAt);
        _updateReward(msg.sender);
        a.pendingUnstake = 0;
        a.unstakeAvailableAt = 0;
        a.staked -= amount;
        totalStaked -= amount;
        emit Unstaked(msg.sender, amount);
        bkrn.safeTransfer(msg.sender, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Locks (bonds)
    // ---------------------------------------------------------------------------------------------

    /// @notice Adds or removes a locker. Callable by the config admin (timelock) or by
    ///         `config.factory()` (which registers each book's MMMandate clone).
    /// @dev Removing a locker prevents new locks and slashes; it can still unlock its existing locks so
    ///      bonds can never be stranded.
    function setLocker(address locker, bool allowed) external {
        if (!config.hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && msg.sender != config.factory()) {
            revert NotAdminOrFactory(msg.sender);
        }
        if (locker == address(0)) revert ZeroAddress();
        isLocker[locker] = allowed;
        emit LockerSet(locker, allowed, msg.sender);
    }

    /// @inheritdoc IBkrnStaking
    /// @dev Only lockers. Requires `availableOf(account) >= amount`. If the lock already exists it must be
    ///      owned by the caller and `amount` is added to it. A zero `amount` records ownership only.
    function lock(address account, bytes32 lockId, uint256 amount) external {
        if (!isLocker[msg.sender]) revert NotLocker(msg.sender);
        if (account == address(0)) revert ZeroAddress();
        LockData storage l = _locks[account][lockId];
        address owner = l.locker;
        if (owner != address(0) && owner != msg.sender) revert NotLockOwner(owner, msg.sender);
        uint256 available = availableOf(account);
        if (available < amount) revert InsufficientAvailable(available, amount);
        if (owner == address(0)) l.locker = msg.sender;
        l.amount += amount;
        _accounts[account].locked += amount;
        emit Locked(account, lockId, msg.sender, amount);
    }

    /// @inheritdoc IBkrnStaking
    /// @dev Only the locker that created the lock (even if since removed as a locker). Releasing a lock
    ///      that does not exist is a no-op returning 0, so revocation paths never revert.
    function unlock(address account, bytes32 lockId) external returns (uint256 released) {
        LockData storage l = _locks[account][lockId];
        address owner = l.locker;
        if (owner == address(0)) return 0;
        if (owner != msg.sender) revert NotLockOwner(owner, msg.sender);
        released = l.amount;
        delete _locks[account][lockId];
        _accounts[account].locked -= released;
        emit Unlocked(account, lockId, released);
    }

    /// @inheritdoc IBkrnStaking
    /// @dev Only an active locker that owns the lock. Slashes `min(amount, lock)`; reduces the lock, the
    ///      account's locked and staked balances, and transfers the BKRN to `config.slashRecipient()`.
    function slash(address account, bytes32 lockId, uint256 amount)
        external
        nonReentrant
        returns (uint256 slashed)
    {
        if (!isLocker[msg.sender]) revert NotLocker(msg.sender);
        LockData storage l = _locks[account][lockId];
        address owner = l.locker;
        if (owner != msg.sender) revert NotLockOwner(owner, msg.sender);
        slashed = amount < l.amount ? amount : l.amount;
        if (slashed == 0) return 0;
        address recipient = config.slashRecipient();
        if (recipient == address(0)) revert SlashRecipientUnset();

        _updateReward(account);
        Account storage a = _accounts[account];
        l.amount -= slashed;
        a.locked -= slashed;
        a.staked -= slashed;
        totalStaked -= slashed;
        totalEarning -= slashed; // slashed <= locked, so the pending-unstake part is untouched
        emit Slashed(account, lockId, slashed, recipient);
        bkrn.safeTransfer(recipient, slashed);
    }

    // ---------------------------------------------------------------------------------------------
    // Rewards
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IBkrnStaking
    /// @dev Only `config.feeRouter()`, which must have transferred `bkrnAmount` BKRN to this contract
    ///      first (checked against `totalStaked + rewardReserve`). Starts a new stream of
    ///      `rewardsDuration` carrying `bkrnAmount`, the unstreamed rest of the current stream and the
    ///      unallocated carry (rewards streamed while nothing was earning + rounding remainders).
    function notifyReward(uint256 bkrnAmount) external nonReentrant {
        if (msg.sender != config.feeRouter()) revert NotFeeRouter(msg.sender);
        if (bkrnAmount == 0) return;
        uint256 required = totalStaked + rewardReserve + bkrnAmount;
        uint256 bal = bkrn.balanceOf(address(this));
        if (bal < required) revert RewardNotReceived(required, bal);

        _accrue();
        rewardReserve += bkrnAmount;
        uint256 scaled = _unallocatedScaled + bkrnAmount * PRECISION;
        uint256 finish = periodFinish;
        if (block.timestamp < finish) scaled += (finish - block.timestamp) * rewardRate;
        uint256 duration = rewardsDuration;
        uint256 rate = scaled / duration;
        rewardRate = rate;
        _unallocatedScaled = scaled - rate * duration;
        lastUpdateTime = uint64(block.timestamp);
        periodFinish = uint64(block.timestamp + duration);
        emit RewardNotified(bkrnAmount);
    }

    /// @inheritdoc IBkrnStaking
    function claimReward() external nonReentrant returns (uint256 reward) {
        _updateReward(msg.sender);
        reward = _rewards[msg.sender];
        if (reward == 0) return 0;
        _rewards[msg.sender] = 0;
        rewardReserve -= reward;
        emit RewardClaimed(msg.sender, reward);
        bkrn.safeTransfer(msg.sender, reward);
    }

    /// @inheritdoc IBkrnStaking
    function earned(address account) public view returns (uint256) {
        (uint256 rpt,) = _accrued();
        return _rewards[account] + (_earningOf(account) * (rpt - userRewardPerTokenPaid[account])) / PRECISION;
    }

    /// @notice Cumulative reward per earning token (scaled by 1e18), including the stream up to now.
    function rewardPerToken() external view returns (uint256 rpt) {
        (rpt,) = _accrued();
    }

    /// @notice Stake that currently earns rewards: `staked - pendingUnstake`.
    function earningOf(address account) external view returns (uint256) {
        return _earningOf(account);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    /// @notice Sets the unstake cooldown (applies to requests made afterwards), within
    ///         [MIN_COOLDOWN, MAX_COOLDOWN]. Config admin only.
    function setCooldown(uint64 newCooldown) external {
        if (!config.hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        if (newCooldown > MAX_COOLDOWN) revert CooldownTooLong(newCooldown, MAX_COOLDOWN);
        if (newCooldown < MIN_COOLDOWN) revert CooldownTooShort(newCooldown, MIN_COOLDOWN);
        cooldown = newCooldown;
        emit CooldownSet(newCooldown);
    }

    /// @notice Sets the streaming period of later reward notifications (the running stream keeps its
    ///         rate and end), within [MIN_REWARDS_DURATION, MAX_REWARDS_DURATION]. Config admin only.
    function setRewardsDuration(uint64 duration) external {
        if (!config.hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        if (duration < MIN_REWARDS_DURATION || duration > MAX_REWARDS_DURATION) revert BadRewardsDuration(duration);
        rewardsDuration = duration;
        emit RewardsDurationSet(duration);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Rewards notified but not allocated to stakers (BKRN wei): rewards streamed while nothing
    ///         was earning, plus rounding carry. Re-streamed by the next notification.
    function queuedReward() external view returns (uint256) {
        (, uint256 unallocated) = _accrued();
        return unallocated / PRECISION;
    }

    /// @notice Rewards of the current stream not yet streamed (BKRN wei, floored).
    function unstreamedReward() external view returns (uint256) {
        uint256 finish = periodFinish;
        if (block.timestamp >= finish) return 0;
        return ((finish - block.timestamp) * rewardRate) / PRECISION;
    }

    /// @inheritdoc IBkrnStaking
    function stakedOf(address account) external view returns (uint256) {
        return _accounts[account].staked;
    }

    /// @inheritdoc IBkrnStaking
    function lockedOf(address account) external view returns (uint256) {
        return _accounts[account].locked;
    }

    /// @inheritdoc IBkrnStaking
    function availableOf(address account) public view returns (uint256) {
        Account storage a = _accounts[account];
        return a.staked - a.locked - a.pendingUnstake;
    }

    /// @inheritdoc IBkrnStaking
    function lockOf(address account, bytes32 lockId) external view returns (uint256) {
        return _locks[account][lockId].amount;
    }

    /// @notice Lock amount and owning locker (zero locker = no lock).
    function lockInfo(address account, bytes32 lockId)
        external
        view
        returns (uint256 amount, address locker)
    {
        LockData storage l = _locks[account][lockId];
        return (l.amount, l.locker);
    }

    /// @notice Pending unstake amount and the time it becomes withdrawable.
    function pendingUnstakeOf(address account) external view returns (uint256 amount, uint64 availableAt) {
        Account storage a = _accounts[account];
        return (a.pendingUnstake, a.unstakeAvailableAt);
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    /// @dev Brings the global accumulator forward to min(now, periodFinish).
    function _accrue() private {
        (uint256 rpt, uint256 unallocated) = _accrued();
        rewardPerTokenStored = rpt;
        _unallocatedScaled = unallocated;
        uint256 t = _lastTimeApplicable();
        if (t > lastUpdateTime) lastUpdateTime = uint64(t);
    }

    /// @dev (rewardPerTokenStored, _unallocatedScaled) as of min(now, periodFinish). The stream since
    ///      lastUpdateTime is split over totalEarning; its division remainder (or all of it while nothing
    ///      earns) is added to the unallocated carry.
    function _accrued() private view returns (uint256 rpt, uint256 unallocated) {
        rpt = rewardPerTokenStored;
        unallocated = _unallocatedScaled;
        uint256 t = _lastTimeApplicable();
        uint256 last = lastUpdateTime;
        if (t <= last) return (rpt, unallocated);
        uint256 streamed = (t - last) * rewardRate;
        uint256 earning = totalEarning;
        if (earning == 0) return (rpt, unallocated + streamed);
        uint256 increment = streamed / earning;
        return (rpt + increment, unallocated + (streamed - increment * earning));
    }

    function _lastTimeApplicable() private view returns (uint256) {
        uint256 finish = periodFinish;
        return block.timestamp < finish ? block.timestamp : finish;
    }

    function _earningOf(address account) private view returns (uint256) {
        Account storage a = _accounts[account];
        return a.staked - a.pendingUnstake;
    }

    /// @dev Accrues globally, then settles `account`'s earning balance up to the current accumulator.
    ///      Call before any change of the account's staked or pendingUnstake.
    function _updateReward(address account) private {
        _accrue();
        uint256 rpt = rewardPerTokenStored;
        uint256 paid = userRewardPerTokenPaid[account];
        if (rpt != paid) {
            _rewards[account] += (_earningOf(account) * (rpt - paid)) / PRECISION;
            userRewardPerTokenPaid[account] = rpt;
        }
    }
}
