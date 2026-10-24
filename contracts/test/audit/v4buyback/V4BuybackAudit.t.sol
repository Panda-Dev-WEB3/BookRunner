// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Vm, console2} from "forge-std/Test.sol";
import {BkrnFeeRouter} from "../../../src/BkrnFeeRouter.sol";
import {BkrnV4Swapper} from "../../../src/BkrnV4Swapper.sol";
import {IV4PoolManager} from "../../../src/interfaces/external/IUniswapV4.sol";
import {UniswapV4Lib} from "../../../src/libraries/UniswapV4Lib.sol";
import {IMockV4Hook, MockV4PoolManager} from "../../mocks/UniswapV4Mocks.sol";
import {BkrnFeeRouterV4Base} from "../../core/BkrnFeeRouterV4.t.sol";

/// @dev Hook that calls PoolManager.sync(token) from afterSwap (any hook may: sync is global, not per locker).
contract SyncHook is IMockV4Hook {
    MockV4PoolManager internal immutable pm;
    address internal immutable token;

    constructor(MockV4PoolManager pm_, address token_) {
        pm = pm_;
        token = token_;
    }

    function beforeSwap(address, IV4PoolManager.PoolKey calldata, IV4PoolManager.SwapParams calldata, bytes calldata)
        external
        pure
        returns (int128)
    {
        return 0;
    }

    function afterSwap(address, IV4PoolManager.PoolKey calldata, IV4PoolManager.SwapParams calldata, int256, bytes calldata)
        external
        returns (int128)
    {
        pm.sync(token);
        return 0;
    }
}

/// @notice Security review 2026-10-23 (v4-buyback, d81de29): the PoCs, turned into regressions of the fixes
///         (M-1 hook-fee-aware limits + via-ETH budget split, I-1 native re-sync). Run with --match-test test_audit.
contract V4BuybackAuditTest is BkrnFeeRouterV4Base {
    function _usdcIsCurrency0() internal pure override returns (bool) {
        return true;
    }

    /// @dev M-1 (fixed): the limit now prices the hook fee in (`setV4Fees`): with a Pons-like hook taking 3% of the
    ///      output and a 3% allowance, a buyback too large for the pool stops at its limit, still clears the floor and
    ///      partially fills (the rest stays pending) at the FIRST attempt, instead of reverting at every size until
    ///      the keeper halves 4 times.
    function test_audit_limit_stop_with_hook_fee_reverts_instead_of_partial_fill() public {
        _useDirect(hookKey);
        hook.configure(0, 300, false); // Pons-like: 3% of the BKRN out (afterSwapReturnDelta)
        vm.prank(admin);
        fr.setV4Fees(300, 0);
        _seed(300_000e6);
        vm.prank(keeper);
        uint256 out = fr.executeBuyback(300_000e6, 0);
        uint256 spent = fr.totalBuybackUsdc();
        console2.log("first attempt: spent (USDG)", spent / 1e6, "of 300000; BKRN out", out / 1e18);
        assertGt(out, 0);
        assertLt(spent, 300_000e6);
        assertEq(fr.buybackPending(), 300_000e6 - spent);
        assertGe(out, spent * REF * (10_000 - SLIP) / 10_000 / 1e6);
    }

    /// @dev M-1 via ETH (fixed, then re-review 2 M-A): hop 1's limit follows the ETH hop 0 really delivered, so the
    ///      whole path meets the floor. Pools that together still clear it land above the floor; pools that together
    ///      cannot (3% worse each, 5% slippage) are refused inside the unlock (caught, nothing moves), never a swap
    ///      that then fails the floor.
    function test_audit_via_eth_two_limits_compound_below_floor() public {
        _use(_route(V4_ETH, ethBkrnKey));
        hook.configure(0, 0, false);
        pm.setPrice(ethUsdcKey, _sqrtEthUsdc(ETH_USD * 10_100 / 10_000));
        pm.setPrice(ethBkrnKey, _sqrtEthBkrn(BKRN_ETH * 9650 / 10_000));
        _seed(100_000e6);
        vm.prank(keeper);
        uint256 out = fr.executeBuyback(10e6, 0);
        assertGe(out, fr.buybackFloor(10e6));
        pm.setPrice(ethUsdcKey, _sqrtEthUsdc(ETH_USD * 10_300 / 10_000));
        pm.setPrice(ethBkrnKey, _sqrtEthBkrn(BKRN_ETH * 9700 / 10_000));
        uint256 pending = fr.buybackPending();
        vm.prank(keeper);
        assertEq(fr.executeBuyback(10e6, 0), 0); // BuybackV4Failed: hop 1 cannot meet the floor
        assertEq(fr.buybackPending(), pending);
    }

    /// @dev I-1 (fixed): an allow-listed hook on the ETH/BKRN pool that calls sync(USDG) no longer breaks
    ///      ROUTE_V3_WETH's native settle (the swapper re-syncs native first): the buyback lands.
    function test_audit_hook_sync_griefs_v3_weth_settle() public {
        SyncHook sh = new SyncHook(pm, address(usdc));
        IV4PoolManager.PoolKey memory k = _key(address(0), address(bkrn), 0, 200, address(sh));
        pm.initialize(k, _sqrtEthBkrn(BKRN_ETH), L_ETH_BKRN);
        vm.prank(admin);
        fr.setV4HookAllowed(address(sh), true);
        _use(_route(V3_WETH, k));
        _seed(100e6);
        vm.recordLogs();
        vm.prank(keeper);
        assertGt(fr.executeBuyback(10e6, 0), 0);
        _assertNoStuckBalances();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != BkrnFeeRouter.BuybackV4Failed.selector, "caught failure");
        }
    }

    /// @dev Router + embedded swapper initcode under EIP-170 / EIP-3860 (same optimizer profile as the deploy).
    function test_audit_sizes() public view {
        uint256 frRuntime = address(fr).code.length;
        uint256 swRuntime = address(swapper).code.length;
        uint256 frInit = type(BkrnFeeRouter).creationCode.length;
        console2.log("BkrnFeeRouter runtime", frRuntime);
        console2.log("BkrnFeeRouter initcode", frInit);
        console2.log("BkrnV4Swapper runtime", swRuntime);
        assertLt(frRuntime, 24_576);
        assertLt(swRuntime, 24_576);
        assertLt(frInit, 49_152);
    }
}
