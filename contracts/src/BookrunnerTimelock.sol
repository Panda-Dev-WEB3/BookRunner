// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {AccessControlEnumerable} from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title BookrunnerTimelock — OpenZeppelin TimelockController whose role holders are enumerable.
/// @notice Behaviour is exactly TimelockController's (same roles, delays, operations); AccessControlEnumerable only
///         records the holders, so script/VerifyHandover.s.sol can prove the proposer / executor / canceller /
///         admin sets are exactly the expected ones (audit 2026-10 D: a stray holder must fail the handover).
contract BookrunnerTimelock is TimelockController, AccessControlEnumerable {
    /// @param minDelay Initial minimum delay (seconds) for operations.
    /// @param proposers Accounts granted PROPOSER_ROLE and CANCELLER_ROLE.
    /// @param executors Accounts granted EXECUTOR_ROLE (address(0) = anyone may execute).
    /// @param admin Optional extra DEFAULT_ADMIN_ROLE holder (address(0): the timelock administers itself).
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}

    /// @inheritdoc TimelockController
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(TimelockController, AccessControlEnumerable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _grantRole(bytes32 role, address account)
        internal
        override(AccessControl, AccessControlEnumerable)
        returns (bool)
    {
        return super._grantRole(role, account);
    }

    function _revokeRole(bytes32 role, address account)
        internal
        override(AccessControl, AccessControlEnumerable)
        returns (bool)
    {
        return super._revokeRole(role, account);
    }
}
