// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LowGasMarkBase} from "../../integration/LowGasMark.t.sol";

/// @notice AREA 3 — OrderlyAdapter report/flow ordering. `_storeReport` rejects only `asOf < lastFlowAt`, so a
///         venue snapshot taken in the SAME second as an on-chain flow (deposit / confirmWithdraw), but before the
///         venue reflected it, is accepted forever after (until a newer report or flow), by ANY relayer of the
///         signed `reportSigned` payload. On fast L2s many blocks share a timestamp, and the ops-venue's
///         pre-signing checks (pending withdrawals, `totalDepositedUsd` credited) read the chain BEFORE the flow
///         lands. The signed payload is public (keeper calldata), so any relayer can apply it later.
///         Effect: venue-side figures overwritten with pre-flow values — a confirmed withdrawal counted twice
///         (venue-side + in transit: NAV inflated) or a deposit erased (NAV deflated + MM inventory cap reopened).
contract Area3ReportSameSecondTest is LowGasMarkBase {
    /// Withdrawal variant: snapshot at T while the 20k recall was still Requested and undebited (MM 75k);
    /// the venue debits and ops-venue confirms in the same second T (MM 55k + 20k in transit, lastFlowAt = T).
    function test_audit_sameSecondConfirm_staleSnapshotDoubleCountsWithdrawal() public {
        _toMarkTime();
        vm.prank(keeper);
        vault.recall(MM, 20_000e6); // Requested, still venue-side
        vm.warp(block.timestamp + 30);
        uint64 t = uint64(block.timestamp);
        bytes memory sig = _signReport(OPS_PK, 25_000e6, 75_000e6, 0, t); // pre-debit snapshot at T

        vm.prank(opsSigner);
        adapter.confirmWithdraw(1); // same second T
        assertEq(adapter.deployedValueUsd(), 100_000e6, "25k IF + 55k MM + 20k in transit");

        // an hour later, anyone relays the public pre-debit payload
        vm.warp(block.timestamp + 3600);
        vm.prank(griefer);
        try adapter.reportSigned(25_000e6, 75_000e6, 0, t, sig) {} catch {}

        // SECURE: a snapshot not strictly after the last flow must not overwrite the flow-adjusted figures
        assertEq(adapter.deployedValueUsd(), 100_000e6, "20k counted twice: stale venue-side + in transit");
    }

    /// Deposit variant: snapshot at T (MM 75k, venue had credited every deposit known at T); a 10k deposit to MM
    /// lands in the same second T (lastFlowAt = T, MM 85k). Relaying the snapshot erases the deposit.
    function test_audit_sameSecondDeposit_staleSnapshotErasesDeposit() public {
        _toMarkTime();
        uint64 t = uint64(block.timestamp);
        bytes memory sig = _signReport(OPS_PK, 25_000e6, 75_000e6, 0, t);

        usdc.mint(address(vault), 10_000e6);
        vm.prank(desk); // desk InventoryToVenue (mandate-checked: 75k + 10k vs the cap) -> vault.deployToVenue
        vault.deployToVenue(MM, 10_000e6);
        assertEq(adapter.marginEquityUsd(), int256(85_000e6));

        vm.warp(block.timestamp + 3600);
        vm.prank(griefer);
        try adapter.reportSigned(25_000e6, 75_000e6, 0, t, sig) {} catch {}

        // SECURE: the deposit stays counted (and the mandate's MM inventory check keeps seeing it)
        assertEq(adapter.marginEquityUsd(), int256(85_000e6), "same-second deposit erased by a pre-deposit snapshot");
        assertEq(adapter.deployedValueUsd(), 110_000e6);
    }
}
