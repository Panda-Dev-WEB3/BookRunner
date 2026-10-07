// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {CoreFixture} from "./utils/CoreFixture.sol";
import {BkrnStaking} from "../../src/BkrnStaking.sol";
import {BkrnToken} from "../../src/BkrnToken.sol";

/// @notice Drives BkrnStaking with random stake / unstake / lock / unlock / slash / reward actions.
contract StakingHandler is Test {
    BkrnStaking internal staking;
    BkrnToken internal bkrn;
    address internal feeRouter;
    address internal funder;
    address[] internal lockers;

    address[] public actors;
    bytes32[] public lockIds;
    uint256 public totalNotified;
    uint256 public totalClaimed;
    uint256 public totalSlashed;

    constructor(BkrnStaking s, BkrnToken t, address feeRouter_, address funder_, address l1, address l2) {
        staking = s;
        bkrn = t;
        feeRouter = feeRouter_;
        funder = funder_;
        lockers.push(l1);
        lockers.push(l2);
        for (uint256 i; i < 4; ++i) {
            actors.push(makeAddr(string(abi.encodePacked("actor", vm.toString(i)))));
        }
        lockIds.push(keccak256("A"));
        lockIds.push(keccak256("B"));
        lockIds.push(keccak256("C"));
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function lockIdCount() external view returns (uint256) {
        return lockIds.length;
    }

    function stake(uint256 who, uint256 amount) external {
        address a = actors[who % actors.length];
        amount = bound(amount, 1, 10_000_000e18);
        vm.prank(funder);
        bkrn.transfer(a, amount);
        vm.startPrank(a);
        bkrn.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    function requestUnstake(uint256 who, uint256 amount) external {
        address a = actors[who % actors.length];
        uint256 avail = staking.availableOf(a);
        if (avail == 0) return;
        amount = bound(amount, 1, avail);
        vm.prank(a);
        staking.requestUnstake(amount);
    }

    function cancelUnstake(uint256 who) external {
        address a = actors[who % actors.length];
        (uint256 pending,) = staking.pendingUnstakeOf(a);
        if (pending == 0) return;
        vm.prank(a);
        staking.cancelUnstake();
    }

    function unstake(uint256 who) external {
        address a = actors[who % actors.length];
        (uint256 pending, uint64 at) = staking.pendingUnstakeOf(a);
        if (pending == 0) return;
        if (block.timestamp < at) vm.warp(at);
        vm.prank(a);
        staking.unstake();
    }

    function lock(uint256 who, uint256 lockerIdx, uint256 idIdx, uint256 amount) external {
        address a = actors[who % actors.length];
        address l = lockers[lockerIdx % lockers.length];
        bytes32 id = lockIds[idIdx % lockIds.length];
        (, address owner) = staking.lockInfo(a, id);
        if (owner != address(0) && owner != l) return;
        uint256 avail = staking.availableOf(a);
        amount = bound(amount, 0, avail);
        vm.prank(l);
        staking.lock(a, id, amount);
    }

    function unlock(uint256 who, uint256 idIdx) external {
        address a = actors[who % actors.length];
        bytes32 id = lockIds[idIdx % lockIds.length];
        (, address owner) = staking.lockInfo(a, id);
        if (owner == address(0)) return;
        vm.prank(owner);
        staking.unlock(a, id);
    }

    function slash(uint256 who, uint256 idIdx, uint256 amount) external {
        address a = actors[who % actors.length];
        bytes32 id = lockIds[idIdx % lockIds.length];
        (, address owner) = staking.lockInfo(a, id);
        if (owner == address(0)) return;
        vm.prank(owner);
        totalSlashed += staking.slash(a, id, amount);
    }

    function notifyReward(uint256 amount) external {
        amount = bound(amount, 0, 1_000_000e18);
        vm.prank(funder);
        bkrn.transfer(feeRouter, amount);
        vm.startPrank(feeRouter);
        bkrn.transfer(address(staking), amount);
        staking.notifyReward(amount);
        vm.stopPrank();
        totalNotified += amount;
    }

    function claim(uint256 who) external {
        address a = actors[who % actors.length];
        vm.prank(a);
        totalClaimed += staking.claimReward();
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 10 days));
    }
}

contract BkrnStakingInvariantTest is CoreFixture {
    StakingHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new StakingHandler(staking, bkrn, address(feeRouter), community, locker, locker2);
        targetContract(address(handler));
    }

    /// @dev Token conservation: staking always holds every staked token plus every unclaimed reward.
    function invariant_solvent() public view {
        assertGe(bkrn.balanceOf(address(staking)), staking.totalStaked() + staking.rewardReserve());
    }

    /// @dev Sum of stakes == totalStaked; per account staked >= locked + pending; locks sum to locked.
    function invariant_accounting() public view {
        uint256 sum;
        uint256 earningSum;
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            address a = handler.actors(i);
            uint256 st = staking.stakedOf(a);
            uint256 lk = staking.lockedOf(a);
            (uint256 pending,) = staking.pendingUnstakeOf(a);
            assertGe(st, lk + pending);
            assertEq(staking.earningOf(a), st - pending);
            earningSum += st - pending;
            assertEq(staking.availableOf(a), st - lk - pending);
            uint256 lockSum;
            for (uint256 j; j < handler.lockIdCount(); ++j) {
                lockSum += staking.lockOf(a, handler.lockIds(j));
            }
            assertEq(lockSum, lk);
            sum += st;
        }
        assertEq(sum, staking.totalStaked());
        assertEq(earningSum, staking.totalEarning());
    }

    /// @dev Rewards owed never exceed rewards notified minus claimed (and the queued remainder).
    function invariant_rewardsBounded() public view {
        uint256 owed;
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            owed += staking.earned(handler.actors(i));
        }
        assertEq(staking.rewardReserve(), handler.totalNotified() - handler.totalClaimed());
        assertLe(owed + staking.queuedReward() + staking.unstreamedReward(), staking.rewardReserve());
    }

    /// @dev Slashed BKRN goes only to the slash recipient.
    function invariant_slashRecipient() public view {
        assertEq(bkrn.balanceOf(slashRecipient), handler.totalSlashed());
    }
}
