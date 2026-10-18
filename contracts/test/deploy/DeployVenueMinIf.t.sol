// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {Deploy} from "../../script/Deploy.s.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {BRTypes} from "../../src/interfaces/BRTypes.sol";

contract MinIfDeployHarness is Deploy {
    function checked(bool testnet, uint256 minIf) external pure returns (uint256) {
        return _checkedVenueMinIfOrderly(testnet, minIf);
    }

    function deployCore() external returns (BookrunnerConfig) {
        _roles(vm.deriveKey(DEFAULT_MNEMONIC, 0), DEFAULT_MNEMONIC);
        vm.startPrank(deployer);
        _deployCore(300);
        vm.stopPrank();
        return config;
    }
}

/// @notice VERIFY O10: Deploy.s.sol sets venueMinIf[Orderly] per network, strictly above Orderly's per-market IF
///         requirement (testnet 100 USDG -> 101e6; devnet keeps the mainnet figure 25,001e6, as the launch charters assume).
contract DeployVenueMinIfTest is Test {
    function test_defaultPerNetwork() public {
        MinIfDeployHarness h = new MinIfDeployHarness();
        assertEq(h.deployCore().venueMinIfUsd(BRTypes.VENUE_ORDERLY), 25_001e6, "devnet (31337): config default");
        vm.chainId(46630);
        MinIfDeployHarness t = new MinIfDeployHarness();
        BookrunnerConfig cfg = t.deployCore();
        assertEq(cfg.venueMinIfUsd(BRTypes.VENUE_ORDERLY), 101e6, "testnet: > 100 USDG");
        assertEq(cfg.venueMinIfUsd(BRTypes.VENUE_POOL_ENGINE), 10_000e6, "PoolEngine unchanged");
    }

    function test_overrideMustStayAboveTheRequirement() public {
        MinIfDeployHarness h = new MinIfDeployHarness();
        assertEq(h.checked(true, 250e6), 250e6);
        assertEq(h.checked(true, 100e6 + 1), 100e6 + 1);
        vm.expectRevert(bytes("Deploy.s.sol: venueMinIf[Orderly] must be above Orderly's IF requirement (VERIFY O10)"));
        h.checked(true, 100e6); // exactly the requirement fails Orderly's strict check
        assertEq(h.checked(false, 25_001e6), 25_001e6);
        vm.expectRevert(bytes("Deploy.s.sol: venueMinIf[Orderly] must be above Orderly's IF requirement (VERIFY O10)"));
        h.checked(false, 25_000e6);
    }
}
