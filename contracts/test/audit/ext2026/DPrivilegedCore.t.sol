// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {CoreFixture} from "../../core/utils/CoreFixture.sol";
import {Backstop} from "../../../src/Backstop.sol";
import {BkrnFeeRouter} from "../../../src/BkrnFeeRouter.sol";

/// @notice Audit 2026-10, privileged operations (D):
///         - the guardian could lift a pause the timelock set (config.setNewBooksPaused in both directions);
///         - Backstop and BkrnFeeRouter had no migration path: repointing config.backstop() / config.feeRouter()
///           stranded their USDC.
contract DPrivilegedCoreTest is CoreFixture {
    // ------------------------------------------------------------------ guardian: pause, never lift a timelock pause

    /// @dev PoC: the timelock pauses new books; the guardian lifted it in one call.
    function test_D_poc_guardianCannotLiftTimelockPause() public {
        vm.prank(admin);
        config.setNewBooksPaused(true);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSignature("PausedByTimelock()"));
        config.setNewBooksPaused(false);
        assertTrue(config.newBooksPaused(), "still paused");

        vm.prank(admin);
        config.setNewBooksPaused(false);
        assertFalse(config.newBooksPaused());
    }

    function test_D_guardianPause_liftableByGuardianAndTimelock() public {
        vm.prank(guardian);
        config.setNewBooksPaused(true);
        vm.prank(guardian);
        config.setNewBooksPaused(false);
        assertFalse(config.newBooksPaused());

        vm.prank(guardian);
        config.setNewBooksPaused(true);
        vm.prank(admin);
        config.setNewBooksPaused(false);
        assertFalse(config.newBooksPaused());
    }

    /// @dev The timelock taking over a guardian pause makes it a timelock pause.
    function test_D_timelockConfirmsGuardianPause_guardianCannotLift() public {
        vm.prank(guardian);
        config.setNewBooksPaused(true);
        vm.prank(admin);
        config.setNewBooksPaused(true);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSignature("PausedByTimelock()"));
        config.setNewBooksPaused(false);
        // a guardian re-pause does not downgrade it either
        vm.prank(guardian);
        config.setNewBooksPaused(true);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSignature("PausedByTimelock()"));
        config.setNewBooksPaused(false);
    }

    // ------------------------------------------------------------------ Backstop migration

    function _fundBackstop(uint256 amount) internal {
        usdc.mint(address(backstop), amount);
        backstop.notifyDeposit(amount);
    }

    /// @dev PoC: after the timelock repoints config.backstop() to a new Backstop, the old one's USDC had no way out.
    function test_D_poc_backstopRepoint_balanceMigrates() public {
        _fundBackstop(10_000e6);
        usdc.mint(address(backstop), 7); // an unacknowledged donation moves too
        Backstop next = new Backstop(address(config));
        vm.prank(admin);
        config.setAddress("backstop", address(next));

        (bool ok,) = address(backstop).call(abi.encodeWithSignature("migrate()"));
        assertTrue(ok, "migrate() exists and runs once repointed");
        assertEq(usdc.balanceOf(address(backstop)), 0);
        assertEq(next.balance(), 10_000e6 + 7);
        assertEq(next.accountedBalance(), 10_000e6 + 7, "acknowledged by the new backstop");
    }

    function test_D_backstopMigrate_refusedWhileCurrent() public {
        _fundBackstop(1e6);
        vm.expectRevert(abi.encodeWithSignature("StillCurrent()"));
        Backstop(address(backstop)).migrate();
    }

    // ------------------------------------------------------------------ BkrnFeeRouter migration

    /// @dev PoC: buyback USDC pending in the old fee router was stranded by a repoint.
    function test_D_poc_feeRouterRepoint_pendingMigrates() public {
        usdc.mint(address(feeRouter), 1000e6);
        vm.prank(address(router));
        feeRouter.notifyCarry(BOOK_ID, 1000e6); // 500 pending buyback, 500 to the backstop
        assertEq(feeRouter.buybackPending(), 500e6);

        BkrnFeeRouter next = new BkrnFeeRouter(address(config));
        vm.prank(admin);
        config.setAddress("feeRouter", address(next));

        (bool ok,) = address(feeRouter).call(abi.encodeWithSignature("migrate()"));
        assertTrue(ok, "migrate() exists and runs once repointed");
        assertEq(feeRouter.buybackPending(), 0);
        assertEq(usdc.balanceOf(address(feeRouter)), 0);
        assertEq(next.buybackPending(), 500e6, "pending buyback continues on the new router");
        assertEq(usdc.balanceOf(address(next)), 500e6);
    }

    function test_D_feeRouterMigrate_refusedWhileCurrent() public {
        vm.expectRevert(abi.encodeWithSignature("StillCurrent()"));
        BkrnFeeRouter(address(feeRouter)).migrate();
    }

    /// @dev notifyMigration only credits USDC that actually arrived and is not yet pending.
    function test_D_feeRouterNotifyMigration_onlyArrivedUsdc() public {
        BkrnFeeRouter next = new BkrnFeeRouter(address(config));
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.CarryNotReceived.selector, 1, 0));
        next.notifyMigration(1);
        usdc.mint(address(next), 5);
        next.notifyMigration(5);
        assertEq(next.buybackPending(), 5);
    }
}
