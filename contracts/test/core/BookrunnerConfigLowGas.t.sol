// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {IBookrunnerConfig} from "../../src/interfaces/IBookrunnerConfig.sol";
import {IBookrunnerConfigTradeAge} from "../../src/PoolEngine.sol";

/// @notice LOW_GAS.md §1 parameter `maxTradePriceAge` (default 15 s, timelock-settable up to MAX_TRADE_PRICE_AGE = 15 s).
contract BookrunnerConfigLowGasTest is Test {
    BookrunnerConfig internal config;
    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        config = new BookrunnerConfig(admin);
    }

    function test_maxTradePriceAge_default() public view {
        assertEq(config.maxTradePriceAge(), 15);
        assertEq(config.KEY_MAX_TRADE_PRICE_AGE(), bytes32("maxTradePriceAge"));
        // the engine reads it through IBookrunnerConfigTradeAge
        assertEq(IBookrunnerConfigTradeAge(address(config)).maxTradePriceAge(), 15);
    }

    function test_maxTradePriceAge_constructorEmits() public {
        vm.expectEmit(true, false, false, true);
        emit IBookrunnerConfig.ParamSet("maxTradePriceAge", 15);
        new BookrunnerConfig(admin);
    }

    function test_maxTradePriceAge_setByAdminOnly() public {
        vm.expectEmit(true, false, false, true, address(config));
        emit IBookrunnerConfig.ParamSet("maxTradePriceAge", 10);
        vm.prank(admin);
        config.setParam("maxTradePriceAge", 10);
        assertEq(config.maxTradePriceAge(), 10);

        bytes32 adminRole = config.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole)
        );
        vm.prank(stranger);
        config.setParam("maxTradePriceAge", 1);
        assertEq(config.maxTradePriceAge(), 10);
    }

    function test_maxTradePriceAge_rangeChecks() public {
        vm.startPrank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(BookrunnerConfig.ParamOutOfRange.selector, bytes32("maxTradePriceAge"), 0)
        );
        config.setParam("maxTradePriceAge", 0);
        // audit 2026-10 L-2: capped at MAX_TRADE_PRICE_AGE (15 s)
        uint256 tooBig = config.MAX_TRADE_PRICE_AGE() + 1;
        vm.expectRevert(
            abi.encodeWithSelector(BookrunnerConfig.ParamOutOfRange.selector, bytes32("maxTradePriceAge"), tooBig)
        );
        config.setParam("maxTradePriceAge", tooBig);
        config.setParam("maxTradePriceAge", 15);
        assertEq(config.maxTradePriceAge(), 15);
        config.setParam("maxTradePriceAge", 1);
        assertEq(config.maxTradePriceAge(), 1);
        vm.stopPrank();
    }

    /// @dev Packed next to the other uint32 params: setting it never disturbs its slot neighbours.
    function test_maxTradePriceAge_independentOfOtherParams() public {
        vm.startPrank(admin);
        config.setParam("maxTradePriceAge", 12);
        config.setParam("maxPriceAge", 77);
        config.setParam("committeeWindow", 1 days + 9);
        config.setNewBooksPaused(true);
        vm.stopPrank();
        assertEq(config.maxTradePriceAge(), 12);
        assertEq(config.maxPriceAge(), 77);
        assertEq(config.committeeWindow(), 1 days + 9);
        assertTrue(config.newBooksPaused());
        assertEq(config.markInterval(), 86_400);
        assertEq(config.carryBps(), 1000);

        bytes32[] memory keys = new bytes32[](2);
        uint256[] memory vals = new uint256[](2);
        (keys[0], vals[0]) = ("maxTradePriceAge", 14);
        (keys[1], vals[1]) = ("maxPriceAge", 300);
        vm.prank(admin);
        config.setParams(keys, vals);
        assertEq(config.maxTradePriceAge(), 14);
        assertEq(config.maxPriceAge(), 300);
        assertTrue(config.newBooksPaused());
    }
}
