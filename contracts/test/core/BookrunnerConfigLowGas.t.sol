// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {IBookrunnerConfig} from "../../src/interfaces/IBookrunnerConfig.sol";
import {IBookrunnerConfigTradeAge} from "../../src/PoolEngine.sol";

/// @notice LOW_GAS.md §1 parameter `maxTradePriceAge` (default 15 s, timelock-settable).
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
        emit IBookrunnerConfig.ParamSet("maxTradePriceAge", 30);
        vm.prank(admin);
        config.setParam("maxTradePriceAge", 30);
        assertEq(config.maxTradePriceAge(), 30);

        bytes32 adminRole = config.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole)
        );
        vm.prank(stranger);
        config.setParam("maxTradePriceAge", 1);
        assertEq(config.maxTradePriceAge(), 30);
    }

    function test_maxTradePriceAge_rangeChecks() public {
        vm.startPrank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(BookrunnerConfig.ParamOutOfRange.selector, bytes32("maxTradePriceAge"), 0)
        );
        config.setParam("maxTradePriceAge", 0);
        uint256 tooBig = uint256(type(uint32).max) + 1;
        vm.expectRevert(
            abi.encodeWithSelector(BookrunnerConfig.ParamOutOfRange.selector, bytes32("maxTradePriceAge"), tooBig)
        );
        config.setParam("maxTradePriceAge", tooBig);
        config.setParam("maxTradePriceAge", type(uint32).max);
        assertEq(config.maxTradePriceAge(), type(uint32).max);
        config.setParam("maxTradePriceAge", 1);
        assertEq(config.maxTradePriceAge(), 1);
        vm.stopPrank();
    }

    /// @dev Packed next to the other uint32 params: setting it never disturbs its slot neighbours.
    function test_maxTradePriceAge_independentOfOtherParams() public {
        vm.startPrank(admin);
        config.setParam("maxTradePriceAge", 42);
        config.setParam("maxPriceAge", 77);
        config.setParam("committeeWindow", 9);
        config.setNewBooksPaused(true);
        vm.stopPrank();
        assertEq(config.maxTradePriceAge(), 42);
        assertEq(config.maxPriceAge(), 77);
        assertEq(config.committeeWindow(), 9);
        assertTrue(config.newBooksPaused());
        assertEq(config.markInterval(), 86_400);
        assertEq(config.carryBps(), 1000);

        bytes32[] memory keys = new bytes32[](2);
        uint256[] memory vals = new uint256[](2);
        (keys[0], vals[0]) = ("maxTradePriceAge", 20);
        (keys[1], vals[1]) = ("maxPriceAge", 300);
        vm.prank(admin);
        config.setParams(keys, vals);
        assertEq(config.maxTradePriceAge(), 20);
        assertEq(config.maxPriceAge(), 300);
        assertTrue(config.newBooksPaused());
    }
}
