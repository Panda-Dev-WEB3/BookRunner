// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";

/// @notice Regression tests (finding timelock-address-decoupled-from-admin-role): `config.timelock()` — the
///         address every 48h-gated power checks — follows `DEFAULT_ADMIN_ROLE`, so handing the admin role to
///         the TimelockController and renouncing the deployer can never leave the deployer with instant
///         upgrade power.
contract TimelockAdminCouplingTest is Test {
    bytes4 internal constant TIMELOCK_NOT_ADMIN = bytes4(keccak256("TimelockNotAdmin(address)"));

    address internal deployer = makeAddr("deployer");
    address internal controller = makeAddr("timelockController");
    BookrunnerConfig internal config;
    bytes32 internal adminRole;

    function setUp() public {
        config = new BookrunnerConfig(deployer);
        adminRole = config.DEFAULT_ADMIN_ROLE();
    }

    /// The documented handover done without repointing the timelock must not keep the deployer in power.
    function test_renouncedDeployer_losesTimelockPowers() public {
        assertEq(config.timelock(), deployer);
        vm.startPrank(deployer);
        config.grantRole(adminRole, controller);
        config.renounceRole(adminRole, deployer);
        vm.stopPrank();
        assertTrue(config.timelock() != deployer, "a deployer without the admin role is no timelock");
        assertEq(config.timelock(), address(0), "fails closed until the timelock is repointed");
        assertEq(config.addressOf("timelock"), address(0));

        // the controller (now admin) repoints it through its own delay
        vm.prank(controller);
        config.setAddress("timelock", controller);
        assertEq(config.timelock(), controller);
        assertEq(config.addressOf("timelock"), controller);
    }

    function test_fullHandover() public {
        vm.startPrank(deployer);
        config.grantRole(adminRole, controller);
        config.setAddress("timelock", controller);
        config.renounceRole(adminRole, deployer);
        vm.stopPrank();
        assertEq(config.timelock(), controller);
        assertFalse(config.hasRole(adminRole, deployer));
    }

    function test_setTimelock_requiresAdminRole() public {
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(TIMELOCK_NOT_ADMIN, controller));
        config.setAddress("timelock", controller);
        assertEq(config.timelock(), deployer);

        bytes32[] memory keys = new bytes32[](1);
        address[] memory vals = new address[](1);
        (keys[0], vals[0]) = ("timelock", controller);
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(TIMELOCK_NOT_ADMIN, controller));
        config.setAddresses(keys, vals);
    }

    function test_revokedTimelock_resolvesToZero() public {
        vm.startPrank(deployer);
        config.grantRole(adminRole, controller);
        config.setAddress("timelock", controller);
        vm.stopPrank();
        vm.prank(deployer);
        config.revokeRole(adminRole, controller);
        assertEq(config.timelock(), address(0));
    }
}
