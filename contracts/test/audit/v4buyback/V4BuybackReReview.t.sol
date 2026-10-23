// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {BkrnFeeRouter} from "../../../src/BkrnFeeRouter.sol";
import {BkrnFeeRouterV4Base} from "../../core/BkrnFeeRouterV4.t.sol";

/// @notice Re-review 2026-10-24 (8bf8b49): PoCs kept as regressions of the fixes. Run with --match-test test_rereview.
contract V4BuybackReReviewTest is BkrnFeeRouterV4Base {
    function _usdcIsCurrency0() internal pure override returns (bool) {
        return true;
    }

    /// @dev M-A (fixed): ETH 1.3% above the fixed refUsdcPerEthWad with the BKRN/USDG reference exact no longer
    ///      blocks via-ETH buybacks: hop 0 only has a wide sanity tolerance and hop 1's limit follows the ETH hop 0
    ///      really delivered. The via-ETH and the direct route both buy at the same market.
    function test_rereview_via_eth_stalls_on_small_eth_move() public {
        _use(_route(V4_ETH, ethBkrnKey));
        _seed(100e6);
        pm.setPrice(ethUsdcKey, _sqrtEthUsdc(ETH_USD * 10_130 / 10_000));
        pm.setPrice(ethBkrnKey, _sqrtEthBkrn(BKRN_ETH * 10_000 / 10_130));
        assertEq(fr.v4BlockedHop(), 0);
        vm.prank(keeper);
        uint256 viaEth = fr.executeBuyback(10e6, 0);
        assertGe(viaEth, fr.buybackFloor(10e6));
        _useDirect(key);
        vm.prank(keeper);
        assertGt(fr.executeBuyback(10e6, 0), 0);
    }
}
