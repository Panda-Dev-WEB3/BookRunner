// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Vm, console2} from "forge-std/Test.sol";
import {BkrnFeeRouter} from "../../../src/BkrnFeeRouter.sol";
import {IBkrnV4Swapper} from "../../../src/interfaces/IBkrnV4Swapper.sol";
import {BkrnFeeRouterV4ForkTest} from "../../core/BkrnFeeRouterV4Fork.t.sol";

/// @notice Security review 2026-10-23 (v4-buyback): fork PoCs on Robinhood Chain (skipped without ETH_RPC_URL),
///         the gas window one now a regression of the L-1 fix. Run with --match-test test_audit.
contract V4BuybackAuditForkTest is BkrnFeeRouterV4ForkTest {
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 internal constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    bytes32 internal constant BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;

    /// @dev Is the Pons hook an upgradeable proxy (its fee / behaviour could change after allow-listing)?
    function test_audit_fork_pons_hook_proxy_slots() public view {
        console2.log("Pons hook code size", PONS_HOOK.code.length);
        console2.logBytes32(vm.load(PONS_HOOK, IMPL_SLOT));
        console2.logBytes32(vm.load(PONS_HOOK, ADMIN_SLOT));
        console2.logBytes32(vm.load(PONS_HOOK, BEACON_SLOT));
    }

    function _setupV3Weth() internal {
        _deploy(PONS_ETH);
        uint256 usdgPerEth = _spot(_ethUsdg(), address(0));
        uint256 tokPerEth = _spot(_pons(address(0), PONS_ETH), address(0));
        IBkrnV4Swapper.V4Route memory r;
        r.kind = 2;
        r.bkrnPool = _pons(address(0), PONS_ETH);
        (r.v3Fee, r.weth) = (100, WETH);
        vm.startPrank(admin);
        fr.setBuybackParams(0, 1, 1000, 1_000_000e6);
        fr.setEthReference(usdgPerEth * 1005 / 1000, tokPerEth * 995 / 1000);
        fr.setReferenceSource(3);
        fr.setV4Route(r);
        fr.setBuybackVenue(1);
        vm.stopPrank();
    }

    /// @dev (ok, swapped) for an executeBuyback(10 USDG) frame given `g` gas, state rolled back.
    function _try(uint256 g) internal returns (bool ok, bool swapped) {
        uint256 snap = vm.snapshotState();
        vm.recordLogs();
        vm.prank(keeper);
        (ok,) = address(fr).call{gas: g}(abi.encodeCall(BkrnFeeRouter.executeBuyback, (10e6, 0)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(fr) && logs[i].topics[0] == keccak256("BuybackExecuted(uint256,uint256)")) {
                swapped = true;
            }
        }
        vm.revertToState(snap);
    }

    /// @dev Gas window where executeBuyback SUCCEEDS but only via the catch (inner OOG -> BuybackV4Failed): a gas
    ///      limit there wastes the tx. Measures the lowest succeeding limit and the lowest swapping limit.
    function test_audit_fork_try_catch_gas_window() public {
        _setupV3Weth();
        uint256 lo = 50_000;
        uint256 hi = 3_000_000;
        (bool okHi, bool swHi) = _try(hi);
        assertTrue(okHi && swHi, "full gas must swap");
        // lowest limit that does not revert
        uint256 a = lo;
        uint256 b = hi;
        while (a + 1 < b) {
            uint256 m = (a + b) / 2;
            (bool ok,) = _try(m);
            if (ok) b = m;
            else a = m;
        }
        uint256 minOk = b;
        // lowest limit that swaps
        a = lo;
        b = hi;
        while (a + 1 < b) {
            uint256 m = (a + b) / 2;
            (, bool sw) = _try(m);
            if (sw) b = m;
            else a = m;
        }
        uint256 minSwap = b;
        (bool okAt, bool swAt) = _try(minOk);
        console2.log("lowest non-reverting gas", minOk, okAt ? "ok" : "revert", swAt ? "swapped" : "NOT swapped");
        console2.log("lowest swapping gas    ", minSwap);
        console2.log("catch-only window (gas)", minSwap > minOk ? minSwap - minOk : 0);
        // L-1 (fixed): an inner out-of-gas is re-raised, so the lowest non-reverting limit swaps (no window)
        assertTrue(okAt && swAt, "a non-reverting gas limit landed without swapping");
        assertLe(minSwap, minOk);
        // what eth_estimateGas converges to (geth >= 1.13: lo = usedGas - 1 of the full-gas run) and the keeper's
        // bufferedGas (x1.3 + 30k): is the buffered limit above the lowest swapping limit?
        vm.prank(keeper);
        uint256 g0 = gasleft();
        fr.executeBuyback(10e6, 0);
        uint256 used = g0 - gasleft();
        uint256 net = used - used / 5; // worst case: the EIP-3529 refund cap (1/5) applied in full
        console2.log("full run: gas used (exec)", used);
        console2.log("estimate >= net used    ", net);
        console2.log("keeper bufferedGas      ", net * 13 / 10 + 30_000);
        assertGt(net * 13 / 10 + 30_000, minSwap, "keeper buffer below the swapping limit");
    }
}
