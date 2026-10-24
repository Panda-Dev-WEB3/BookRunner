// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Vm, console2} from "forge-std/Test.sol";
import {BkrnFeeRouter} from "../../../src/BkrnFeeRouter.sol";
import {V4BuybackAuditForkTest} from "./V4BuybackAuditFork.t.sol";

/// @notice Re-review 2026-10-24 (8bf8b49): linear gas scan of executeBuyback(10 USDG) on the real V3_WETH route, to
///         find any non-monotonic pocket where the tx succeeds without swapping (binary search would miss it). Kept
///         as the regression of the fixed forwarded swap gas (BkrnFeeRouter.v4SwapGas): no pocket at any limit.
contract V4BuybackReReviewForkTest is V4BuybackAuditForkTest {
    function test_rereview_fork_gas_scan_no_catch_pocket() public {
        _setupV3Weth();
        uint256 pockets;
        uint256 firstOk;
        uint256 firstSwap;
        // L-1 regression (fixed forwarded swap gas): the reviewer's pockets were at 300-306k, 382-406k, 442-446k
        for (uint256 g = 200_000; g <= 1_600_000; g += 2_000) {
            (bool ok, bool sw) = _try(g);
            if (ok && firstOk == 0) firstOk = g;
            if (sw && firstSwap == 0) firstSwap = g;
            if (ok && !sw) {
                ++pockets;
                console2.log("ok without swap at gas", g);
            }
        }
        console2.log("first ok", firstOk, "first swap", firstSwap);
        console2.log("pockets", pockets);
        assertEq(pockets, 0);
        assertGt(firstSwap, 0, "never swapped in range");
        assertEq(firstOk, firstSwap); // the first non-reverting limit already swaps
    }

    /// @dev Above the first swapping limit (now ~1.29M: v4SwapGas x 64/63 + the post-swap reserve), no gas limit
    ///      reverts or lands without swapping (the keeper's buffered estimate lands here).
    function test_rereview_fork_gas_scan_reverts_above_first_swap() public {
        _setupV3Weth();
        uint256 reverts;
        for (uint256 g = 1_300_000; g <= 1_700_000; g += 2_000) {
            (bool ok, bool sw) = _try(g);
            if (!ok) {
                ++reverts;
                console2.log("REVERT at gas", g);
            } else if (!sw) {
                console2.log("ok without swap at gas", g);
            }
        }
        console2.log("reverting limits in [1.3M, 1.7M]", reverts);
        assertEq(reverts, 0);
    }

    /// @dev The former pockets (304k / 400k / 444k) now revert up front (no BuybackV4Failed is logged), and a coarse
    ///      scan of the keeper's range (1.3M..2.5M) always swaps.
    function test_rereview_fork_pocket_reason_and_high_range() public {
        _setupV3Weth();
        uint256[3] memory gs = [uint256(304_000), 400_000, 444_000];
        for (uint256 i; i < 3; ++i) {
            uint256 snap = vm.snapshotState();
            vm.recordLogs();
            vm.prank(keeper);
            (bool ok,) = address(fr).call{gas: gs[i]}(abi.encodeCall(BkrnFeeRouter.executeBuyback, (10e6, 0)));
            assertFalse(ok, "a former pocket no longer reverts up front");
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 j; j < logs.length; ++j) {
                if (logs[j].emitter == address(fr) && logs[j].topics[0] == BkrnFeeRouter.BuybackV4Failed.selector) {
                    (, bytes memory reason) = abi.decode(logs[j].data, (uint256, bytes));
                    console2.log("pocket gas", gs[i], ok ? "ok" : "revert");
                    console2.logBytes(reason);
                }
            }
            vm.revertToState(snap);
        }
        uint256 bad;
        for (uint256 g = 1_300_000; g <= 2_500_000; g += 10_000) {
            (bool ok, bool sw) = _try(g);
            if (!(ok && sw)) {
                ++bad;
                console2.log("not swapped at", g, ok ? "ok" : "revert");
            }
        }
        console2.log("bad limits in [1.3M, 2.5M]", bad);
        assertEq(bad, 0);
    }
}
