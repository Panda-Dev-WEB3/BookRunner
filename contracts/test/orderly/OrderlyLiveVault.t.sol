// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {OrderlyAdapter} from "../../src/OrderlyAdapter.sol";
import {OrderlyVaultAllowListMock} from "../mocks/OrderlyVaultAllowListMock.sol";
import {OrderlyFixture} from "./utils/OrderlyFixture.sol";

/// @notice VERIFY O17 (live-venue rehearsal): an Orderly book on a vault with Orderly's allow lists. The adapter binds
///         only when `getAllowedToken(keccak256("USDG"))` is the settlement token, deposits only while the token and
///         our broker stay allowed (re-checked on every deposit), and a vault that allows nothing (RH testnet today)
///         refuses the book at initialize.
contract OrderlyLiveVaultTest is OrderlyFixture {
    bytes32 internal constant USDG_HASH = keccak256("USDG");
    OrderlyVaultAllowListMock internal live;

    function _liveSetUp(bool tokenAllowed, bool brokerAllowed) internal {
        live = new OrderlyVaultAllowListMock();
        live.changeTokenAddressAndAllow(USDG_HASH, address(usdc));
        if (!tokenAllowed) live.setAllowedToken(USDG_HASH, false);
        live.setAllowedBroker(BROKER_HASH, brokerAllowed);
        cfg.setOrderlyVault(address(live));
        impl = new OrderlyAdapter(BROKER_HASH, USDG_HASH); // DEPLOY_ORDERLY_TOKEN=USDG
    }

    function test_liveVault_bindsAndDeposits() public {
        _liveSetUp(true, true);
        OrderlyAdapter a = _deployAdapter(BOOK_ID, true);
        assertEq(address(a.orderlyVault()), address(live));
        assertEq(a.tokenHash(), USDG_HASH);
        assertEq(a.brokerHash(), BROKER_HASH);
        uwVault.setAdapter(address(a));
        usdc.watch(address(a), address(uwVault), address(router), address(live));
        usdc.setIfAccount(a.ifAccount());
        uwVault.deployToVenue(IF, 101e6); // > 100 USDG: Orderly testnet's per-market IF requirement
        assertEq(live.deposits(), 101e6);
        assertEq(usdc.balanceOf(address(live)), 101e6);
        assertEq(a.insuranceEquityUsd(), 101e6);
        assertEq(usdc.violations(), 0);
    }

    function test_liveVault_allowingNoToken_refusesTheBook() public {
        _liveSetUp(false, true);
        _expectDeployRevert(
            abi.encodeWithSelector(OrderlyAdapter.TokenNotAllowedByVenue.selector, USDG_HASH, address(0)), BOOK_ID, true
        );
    }

    function test_liveVault_tokenDelistedLater_blocksDeposits() public {
        _liveSetUp(true, true);
        OrderlyAdapter a = _deployAdapter(BOOK_ID, true);
        uwVault.setAdapter(address(a));
        live.setAllowedToken(USDG_HASH, false);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.TokenNotAllowedByVenue.selector, USDG_HASH, address(0)));
        uwVault.deployToVenue(IF, 101e6);
    }

    function test_liveVault_brokerNotAllowed_depositReverts() public {
        _liveSetUp(true, false);
        OrderlyAdapter a = _deployAdapter(BOOK_ID, true);
        uwVault.setAdapter(address(a));
        vm.expectRevert(OrderlyVaultAllowListMock.BrokerNotAllowed.selector);
        uwVault.deployToVenue(IF, 101e6);
    }
}
