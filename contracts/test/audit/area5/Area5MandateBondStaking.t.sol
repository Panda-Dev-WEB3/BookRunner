// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MandateBase} from "../../mandate/utils/MandateBase.sol";
import {MandateMockStaking} from "../../mandate/utils/MandateMocks.sol";

/// @notice AUDIT area 5 — MMMandate releases operator tier bonds on `config.staking()` at release time,
///         not on the staking contract that holds the lock. MarketCharter (Escrow.staking) and
///         RiskCommittee (_bondStaking) pin the staking contract precisely so a timelock repoint of
///         config.staking() never strands a bond; MMMandate does not. After a repoint the release
///         "succeeds" on the new staking (no lock there -> returns 0), bondOf is zeroed, and the
///         operator's BKRN stays locked forever in the old staking (only the mandate can unlock it,
///         and it never addresses the old contract again).
contract Area5MandateBondStakingTest is MandateBase {
    function test_audit_mandateBondStrandedAfterStakingRepoint() public {
        bytes32 lockId = mandate.keyLockId(key);
        uint256 bond = mandate.bondOf(key);
        assertGt(bond, 0);
        assertEq(staking.lockOf(operator, lockId), bond); // locked in the original staking

        // timelock migrates staking (supported: charter / committee pin their staking for this case);
        // the new staking authorises existing mandates as lockers
        MandateMockStaking staking2 = new MandateMockStaking();
        staking2.setLocker(address(mandate), true);
        cfg.setStaking(address(staking2));

        // operator rotates out: revoke -> bond "released"
        vm.prank(operator);
        mandate.revokeKey(key, "ROTATE");
        assertEq(mandate.bondOf(key), 0, "mandate believes the bond was released");

        // retry path cannot help either: bondOf is 0 -> NoBond
        // secure behaviour: the lock in the staking that holds it is released
        assertEq(staking.lockOf(operator, lockId), 0, "operator bond stranded in the old staking");
    }
}
