// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IBkrnStaking — staking, bonds (locks) and slashing for $BKRN. Access and bonding only.
interface IBkrnStaking {
    function stake(uint256 amount) external;
    /// @notice Starts the cooldown for `amount` of unlocked stake.
    function requestUnstake(uint256 amount) external;
    /// @notice Withdraws stake whose cooldown elapsed.
    function unstake() external returns (uint256 amount);

    function stakedOf(address account) external view returns (uint256);
    function lockedOf(address account) external view returns (uint256);
    /// @notice staked - locked - pending unstake.
    function availableOf(address account) external view returns (uint256);
    function lockOf(address account, bytes32 lockId) external view returns (uint256);

    // ---- lockers: MarketCharter (sponsor bonds), RiskCommittee (member bonds), MMMandate (agent tiers) ----
    function isLocker(address locker) external view returns (bool);
    function lock(address account, bytes32 lockId, uint256 amount) external;
    function unlock(address account, bytes32 lockId) external returns (uint256 released);
    function slash(address account, bytes32 lockId, uint256 amount) external returns (uint256 slashed);

    // ---- buyback distribution (BKRN bought back by BkrnFeeRouter) ----
    function notifyReward(uint256 bkrnAmount) external; // only feeRouter
    function earned(address account) external view returns (uint256);
    function claimReward() external returns (uint256);

    event Staked(address indexed account, uint256 amount);
    event UnstakeRequested(address indexed account, uint256 amount, uint64 availableAt);
    event Unstaked(address indexed account, uint256 amount);
    event Locked(address indexed account, bytes32 indexed lockId, address indexed locker, uint256 amount);
    event Unlocked(address indexed account, bytes32 indexed lockId, uint256 amount);
    event Slashed(address indexed account, bytes32 indexed lockId, uint256 amount, address to);
    event RewardNotified(uint256 amount);
    event RewardClaimed(address indexed account, uint256 amount);
}
