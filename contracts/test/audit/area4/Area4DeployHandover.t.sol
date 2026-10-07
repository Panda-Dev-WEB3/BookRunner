// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {Deploy} from "../../../script/Deploy.s.sol";
import {BookrunnerConfig} from "../../../src/BookrunnerConfig.sol";
import {StockTokenRegistry} from "../../../src/StockTokenRegistry.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";

/// @notice Runs Deploy.s.sol's own wiring steps (no broadcast, no deployments/*.json write) as the deployer.
contract DeployHarness is Deploy {
    function deployAll() external {
        _roles(vm.deriveKey(DEFAULT_MNEMONIC, 0), DEFAULT_MNEMONIC);
        vm.startPrank(deployer);
        _deployCore(300);
        _deployVenuesAndGovernance();
        _registerImplementations();
        _grantRoles();
        vm.stopPrank();
    }

    function deployerAddr() external view returns (address) {
        return deployer;
    }

    function configAddr() external view returns (address) {
        return address(config);
    }

    function registryAddr() external view returns (address) {
        return address(registry);
    }
}

/// @notice AREA 4 audit PoC — A4-04: following docs/RUNBOOK.md's mainnet handover on a Deploy.s.sol
///         deployment leaves the deployer with un-timelocked powers that the RUNBOOK's post-condition
///         ("the deployer holds no role") does not detect.
contract Area4DeployHandoverTest is Test {
    DeployHarness internal h;
    BookrunnerConfig internal config;
    StockTokenRegistry internal registry;
    address internal dep;
    TimelockController internal tl;
    address internal multisig = makeAddr("multisig");

    function setUp() public {
        h = new DeployHarness();
        h.deployAll();
        dep = h.deployerAddr();
        config = BookrunnerConfig(h.configAddr());
        registry = StockTokenRegistry(h.registryAddr());

        // RUNBOOK.md "Deployment" step 1 handover.
        address[] memory ms = new address[](1);
        ms[0] = multisig;
        tl = new TimelockController(48 hours, ms, ms, address(0));
        vm.startPrank(dep);
        config.grantRole(config.DEFAULT_ADMIN_ROLE(), address(tl));
        config.setAddress("timelock", address(tl));
        config.renounceRole(config.GUARDIAN_ROLE(), dep);
        config.renounceRole(config.DEFAULT_ADMIN_ROLE(), dep);
        vm.stopPrank();

        // RUNBOOK post-conditions hold.
        assertEq(config.timelock(), address(tl));
        assertFalse(config.hasRole(config.DEFAULT_ADMIN_ROLE(), dep));
        assertFalse(config.hasRole(config.GUARDIAN_ROLE(), dep));
        assertFalse(config.hasRole(config.MARK_SIGNER_ROLE(), dep));
        assertFalse(config.hasRole(config.RISK_ROLE(), dep));
        assertFalse(config.hasRole(config.OPS_VENUE_ROLE(), dep));
        assertFalse(config.hasRole(config.JURY_ROLE(), dep));
        assertFalse(config.hasRole(config.KEEPER_ROLE(), dep));
    }

    /// @notice The deployer is still StockTokenRegistry.admin: it can register canonical tokens / indices,
    ///         change multipliers and float caps, or deactivate tokens with no 48h delay.
    function test_audit_deployerKeepsRegistryAdminAfterHandover() public {
        MockERC20 fake = new MockERC20("Fake Stock Token", "FAKE", 18);
        vm.prank(dep);
        (bool ok,) = address(registry).call(
            abi.encodeCall(StockTokenRegistry.register, (address(fake), bytes32("FAKE"), 1e18, 1e30))
        );
        assertFalse(ok, "deployer still governs StockTokenRegistry after the RUNBOOK handover (no timelock)");
    }

    /// @notice Charter fees (expenseRecipient) and every slashed bond (slashRecipient) still flow to the
    ///         renounced deployer key.
    function test_audit_recipientsStillDeployerAfterHandover() public view {
        assertTrue(config.expenseRecipient() != dep, "charter fees still forwarded to the deployer EOA");
        assertTrue(config.slashRecipient() != dep, "slashed BKRN still sent to the deployer EOA");
    }
}
