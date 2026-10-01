// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {IBookrunnerConfig} from "../../src/interfaces/IBookrunnerConfig.sol";
import {BRTypes} from "../../src/interfaces/BRTypes.sol";

contract BookrunnerConfigTest is Test {
    BookrunnerConfig internal config;
    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        config = new BookrunnerConfig(admin);
        bytes32 guardianRole = config.GUARDIAN_ROLE();
        vm.prank(admin);
        config.grantRole(guardianRole, guardian);
    }

    // ---------------------------------------------------------------- construction / roles

    function test_constructor_defaults() public view {
        assertTrue(config.hasRole(config.DEFAULT_ADMIN_ROLE(), admin));
        assertEq(config.timelock(), admin);
        assertEq(config.carryBps(), 1000);
        assertEq(config.expenseCapBps(), 2000);
        assertEq(config.charterFeeUsd(), 5000e6);
        assertEq(config.sponsorBondBkrn(), 100_000e18);
        assertEq(config.committeeBondBkrn(), 250_000e18);
        assertEq(config.markInterval(), 86_400);
        assertEq(config.maxMarkAge(), 21_600);
        assertEq(config.maxPriceAge(), 300);
        assertEq(config.committeeWindow(), 172_800);
        assertEq(config.venueMinIfUsd(BRTypes.VENUE_ORDERLY), 25_000e6);
        assertEq(config.venueMinIfUsd(BRTypes.VENUE_POOL_ENGINE), 10_000e6);
        assertEq(config.venueMinIfUsd(7), 0);
        assertFalse(config.newBooksPaused());
        (uint256[] memory t, uint256[] memory b) = config.tiers();
        assertEq(t.length, 3);
        assertEq(t[0], 50_000e6);
        assertEq(t[1], 250_000e6);
        assertEq(t[2], 1_000_000e6);
        assertEq(b[0], 25_000e18);
        assertEq(b[1], 100_000e18);
        assertEq(b[2], 400_000e18);
        // unset addresses read as zero
        assertEq(config.usdc(), address(0));
        assertEq(config.factory(), address(0));
    }

    function test_constructor_revertsOnZeroAdmin() public {
        vm.expectRevert(BookrunnerConfig.ZeroAddress.selector);
        new BookrunnerConfig(address(0));
    }

    function test_constructor_emitsDefaults() public {
        vm.expectEmit(true, false, false, true);
        emit IBookrunnerConfig.AddressSet("timelock", admin);
        vm.expectEmit(true, false, false, true);
        emit IBookrunnerConfig.ParamSet("carryBps", 1000);
        new BookrunnerConfig(admin);
    }

    function test_roleIds() public view {
        assertEq(config.MARK_SIGNER_ROLE(), keccak256("MARK_SIGNER"));
        assertEq(config.RISK_ROLE(), keccak256("RISK"));
        assertEq(config.OPS_VENUE_ROLE(), keccak256("OPS_VENUE"));
        assertEq(config.JURY_ROLE(), keccak256("JURY"));
        assertEq(config.KEEPER_ROLE(), keccak256("KEEPER"));
        assertEq(config.GUARDIAN_ROLE(), keccak256("GUARDIAN"));
        assertEq(config.getRoleAdmin(config.KEEPER_ROLE()), config.DEFAULT_ADMIN_ROLE());
    }

    function test_grantRole_onlyAdmin() public {
        bytes32 keeperRole = config.KEEPER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                config.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(stranger);
        config.grantRole(keeperRole, stranger);

        vm.prank(admin);
        config.grantRole(keeperRole, stranger);
        assertTrue(config.hasRole(keeperRole, stranger));
    }

    // ---------------------------------------------------------------- addresses

    function _addressKeys() internal pure returns (bytes32[18] memory k) {
        k = [
            bytes32("usdc"),
            "bkrn",
            "staking",
            "feeRouter",
            "backstop",
            "markRegistry",
            "oracle",
            "stockRegistry",
            "charter",
            "committee",
            "factory",
            "poolEngine",
            "orderlyVault",
            "hedgeExecutor",
            "entryPoint",
            "timelock",
            "expenseRecipient",
            "slashRecipient"
        ];
    }

    function _getter(bytes32 key) internal view returns (address) {
        if (key == "usdc") return config.usdc();
        if (key == "bkrn") return config.bkrn();
        if (key == "staking") return config.staking();
        if (key == "feeRouter") return config.feeRouter();
        if (key == "backstop") return config.backstop();
        if (key == "markRegistry") return config.markRegistry();
        if (key == "oracle") return config.oracle();
        if (key == "stockRegistry") return config.stockRegistry();
        if (key == "charter") return config.charter();
        if (key == "committee") return config.committee();
        if (key == "factory") return config.factory();
        if (key == "poolEngine") return config.poolEngine();
        if (key == "orderlyVault") return config.orderlyVault();
        if (key == "hedgeExecutor") return config.hedgeExecutor();
        if (key == "entryPoint") return config.entryPoint();
        if (key == "timelock") return config.timelock();
        if (key == "expenseRecipient") return config.expenseRecipient();
        if (key == "slashRecipient") return config.slashRecipient();
        revert("bad key");
    }

    function test_setAddress_everyKey() public {
        bytes32[18] memory keys = _addressKeys();
        for (uint256 i; i < keys.length; ++i) {
            address value = address(uint160(0x1000 + i));
            assertTrue(config.isAddressKey(keys[i]));
            vm.expectEmit(true, false, false, true, address(config));
            emit IBookrunnerConfig.AddressSet(keys[i], value);
            vm.prank(admin);
            config.setAddress(keys[i], value);
            assertEq(_getter(keys[i]), value);
            assertEq(config.addressOf(keys[i]), value);
        }
    }

    function test_setAddress_keyConstantsMatchGetters() public view {
        assertEq(config.KEY_USDC(), bytes32("usdc"));
        assertEq(config.KEY_FEE_ROUTER(), bytes32("feeRouter"));
        assertEq(config.KEY_SLASH_RECIPIENT(), bytes32("slashRecipient"));
        assertEq(config.KEY_MARK_INTERVAL(), bytes32("markInterval"));
    }

    function test_setAddress_revertsUnknownKey() public {
        vm.expectRevert(abi.encodeWithSelector(BookrunnerConfig.UnknownKey.selector, bytes32("nope")));
        vm.prank(admin);
        config.setAddress("nope", address(1));
    }

    function test_setAddress_revertsZero() public {
        vm.expectRevert(BookrunnerConfig.ZeroAddress.selector);
        vm.prank(admin);
        config.setAddress("usdc", address(0));
    }

    function test_setAddress_onlyAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                guardian,
                config.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(guardian);
        config.setAddress("usdc", address(1));
    }

    function test_setAddresses_batch() public {
        bytes32[] memory keys = new bytes32[](2);
        address[] memory vals = new address[](2);
        (keys[0], vals[0]) = ("usdc", address(11));
        (keys[1], vals[1]) = ("bkrn", address(12));
        vm.prank(admin);
        config.setAddresses(keys, vals);
        assertEq(config.usdc(), address(11));
        assertEq(config.bkrn(), address(12));
    }

    function test_setAddresses_revertsLengthMismatch() public {
        vm.expectRevert(BookrunnerConfig.LengthMismatch.selector);
        vm.prank(admin);
        config.setAddresses(new bytes32[](2), new address[](1));
    }

    function test_setAddresses_onlyAdmin() public {
        vm.expectRevert();
        vm.prank(stranger);
        config.setAddresses(new bytes32[](0), new address[](0));
    }

    // ---------------------------------------------------------------- params

    function test_setParam_everyKey() public {
        vm.startPrank(admin);
        config.setParam("carryBps", 2500);
        config.setParam("expenseCapBps", 10_000);
        config.setParam("charterFeeUsd", 1);
        config.setParam("sponsorBondBkrn", 2);
        config.setParam("committeeBondBkrn", 3);
        config.setParam("markInterval", 300);
        config.setParam("maxMarkAge", 3600);
        config.setParam("maxPriceAge", 60);
        vm.expectEmit(true, false, false, true, address(config));
        emit IBookrunnerConfig.ParamSet("committeeWindow", 0);
        config.setParam("committeeWindow", 0);
        vm.stopPrank();
        assertEq(config.carryBps(), 2500);
        assertEq(config.expenseCapBps(), 10_000);
        assertEq(config.charterFeeUsd(), 1);
        assertEq(config.sponsorBondBkrn(), 2);
        assertEq(config.committeeBondBkrn(), 3);
        assertEq(config.markInterval(), 300);
        assertEq(config.maxMarkAge(), 3600);
        assertEq(config.maxPriceAge(), 60);
        assertEq(config.committeeWindow(), 0);
    }

    function test_setParam_rangeChecks() public {
        _expectOutOfRange("carryBps", 10_001);
        _expectOutOfRange("expenseCapBps", 10_001);
        _expectOutOfRange("markInterval", 0);
        _expectOutOfRange("markInterval", uint256(type(uint32).max) + 1);
        _expectOutOfRange("maxMarkAge", uint256(type(uint32).max) + 1);
        _expectOutOfRange("maxPriceAge", 0);
        _expectOutOfRange("maxPriceAge", uint256(type(uint32).max) + 1);
        _expectOutOfRange("committeeWindow", uint256(type(uint32).max) + 1);
        // boundaries accepted
        vm.startPrank(admin);
        config.setParam("markInterval", type(uint32).max);
        config.setParam("maxMarkAge", type(uint32).max);
        config.setParam("maxPriceAge", type(uint32).max);
        config.setParam("committeeWindow", type(uint32).max);
        vm.stopPrank();
        assertEq(config.markInterval(), type(uint32).max);
    }

    function _expectOutOfRange(bytes32 key, uint256 value) internal {
        vm.expectRevert(abi.encodeWithSelector(BookrunnerConfig.ParamOutOfRange.selector, key, value));
        vm.prank(admin);
        config.setParam(key, value);
    }

    function test_setParam_revertsUnknownKey() public {
        vm.expectRevert(abi.encodeWithSelector(BookrunnerConfig.UnknownKey.selector, bytes32("usdc")));
        vm.prank(admin);
        config.setParam("usdc", 1);
    }

    function test_setParam_onlyAdmin() public {
        vm.expectRevert();
        vm.prank(guardian);
        config.setParam("carryBps", 1);
    }

    function test_setParams_devnetOverrides() public {
        bytes32[] memory keys = new bytes32[](3);
        uint256[] memory vals = new uint256[](3);
        (keys[0], vals[0]) = ("markInterval", 300);
        (keys[1], vals[1]) = ("maxMarkAge", 3600);
        (keys[2], vals[2]) = ("committeeWindow", 172_800);
        vm.prank(admin);
        config.setParams(keys, vals);
        assertEq(config.markInterval(), 300);
        assertEq(config.maxMarkAge(), 3600);
        assertEq(config.committeeWindow(), 172_800);
    }

    function test_setParams_revertsLengthMismatch() public {
        vm.expectRevert(BookrunnerConfig.LengthMismatch.selector);
        vm.prank(admin);
        config.setParams(new bytes32[](1), new uint256[](0));
    }

    function test_setParams_onlyAdmin() public {
        vm.expectRevert();
        vm.prank(stranger);
        config.setParams(new bytes32[](0), new uint256[](0));
    }

    // ---------------------------------------------------------------- venue minimums

    function test_setVenueMinIf() public {
        vm.expectEmit(true, false, false, true, address(config));
        emit BookrunnerConfig.VenueMinIfSet(BRTypes.VENUE_ORDERLY, 1);
        vm.prank(admin);
        config.setVenueMinIf(BRTypes.VENUE_ORDERLY, 1);
        assertEq(config.venueMinIfUsd(BRTypes.VENUE_ORDERLY), 1);
    }

    function test_setVenueMinIf_onlyAdmin() public {
        vm.expectRevert();
        vm.prank(stranger);
        config.setVenueMinIf(0, 1);
    }

    // ---------------------------------------------------------------- tiers

    function test_agentTierBond_defaults() public view {
        assertEq(config.agentTierBond(0), 0);
        assertEq(config.agentTierBond(50_000e6 - 1), 0);
        assertEq(config.agentTierBond(50_000e6), 25_000e18);
        assertEq(config.agentTierBond(75_000e6), 25_000e18);
        assertEq(config.agentTierBond(250_000e6 - 1), 25_000e18);
        assertEq(config.agentTierBond(250_000e6), 100_000e18);
        assertEq(config.agentTierBond(1_000_000e6 - 1), 100_000e18);
        assertEq(config.agentTierBond(1_000_000e6), 400_000e18);
        assertEq(config.agentTierBond(type(uint256).max), 400_000e18);
    }

    function test_setTiers_replacesAndEmits() public {
        uint256[] memory t = new uint256[](2);
        uint256[] memory b = new uint256[](2);
        (t[0], b[0]) = (0, 1e18);
        (t[1], b[1]) = (10e6, 1e18);
        vm.expectEmit(false, false, false, true, address(config));
        emit BookrunnerConfig.TiersSet(t, b);
        vm.prank(admin);
        config.setTiers(t, b);
        assertEq(config.agentTierBond(0), 1e18);
        assertEq(config.agentTierBond(100e6), 1e18);
        (uint256[] memory t2,) = config.tiers();
        assertEq(t2.length, 2);
    }

    function test_setTiers_emptyMeansNoBond() public {
        vm.prank(admin);
        config.setTiers(new uint256[](0), new uint256[](0));
        assertEq(config.agentTierBond(type(uint256).max), 0);
    }

    function test_setTiers_reverts() public {
        uint256[] memory t = new uint256[](2);
        uint256[] memory b = new uint256[](2);
        (t[0], b[0]) = (10, 5);
        (t[1], b[1]) = (10, 6);
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerConfig.TiersNotAscending.selector, 1));
        config.setTiers(t, b); // equal thresholds

        (t[1], b[1]) = (11, 4);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerConfig.TiersNotAscending.selector, 1));
        config.setTiers(t, b); // decreasing bond

        vm.expectRevert(BookrunnerConfig.LengthMismatch.selector);
        config.setTiers(t, new uint256[](1));

        uint256[] memory big = new uint256[](17);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerConfig.TooManyTiers.selector, 17, 16));
        config.setTiers(big, big);
        vm.stopPrank();

        vm.expectRevert();
        vm.prank(stranger);
        config.setTiers(t, b);
    }

    function test_setTiers_maxTiers() public {
        uint256[] memory t = new uint256[](16);
        uint256[] memory b = new uint256[](16);
        for (uint256 i; i < 16; ++i) {
            t[i] = (i + 1) * 1e6;
            b[i] = (i + 1) * 1e18;
        }
        vm.prank(admin);
        config.setTiers(t, b);
        assertEq(config.agentTierBond(16e6), 16e18);
        assertEq(config.agentTierBond(1e6), 1e18);
        assertEq(config.agentTierBond(1e6 - 1), 0);
    }

    function testFuzz_agentTierBond_monotonic(uint256 a, uint256 b) public view {
        if (a > b) (a, b) = (b, a);
        assertLe(config.agentTierBond(a), config.agentTierBond(b));
    }

    // ---------------------------------------------------------------- pause

    function test_setNewBooksPaused_adminAndGuardian() public {
        vm.expectEmit(false, false, false, true, address(config));
        emit IBookrunnerConfig.NewBooksPaused(true);
        vm.prank(guardian);
        config.setNewBooksPaused(true);
        assertTrue(config.newBooksPaused());

        vm.prank(guardian);
        config.setNewBooksPaused(false);
        assertFalse(config.newBooksPaused());

        vm.prank(admin);
        config.setNewBooksPaused(true);
        assertTrue(config.newBooksPaused());
    }

    function test_setNewBooksPaused_revertsForOthers() public {
        vm.expectRevert(abi.encodeWithSelector(BookrunnerConfig.NotAdminOrGuardian.selector, stranger));
        vm.prank(stranger);
        config.setNewBooksPaused(true);
    }
}
