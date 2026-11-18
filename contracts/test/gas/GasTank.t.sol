// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {GasTank} from "../../src/GasTank.sol";

/// @dev A recipient that re-enters topUp (must fail: nonReentrant).
contract Reenterer {
    GasTank public tank;
    bool public tried;
    bool public reverted;

    constructor(GasTank t) {
        tank = t;
    }

    receive() external payable {
        tried = true;
        try tank.topUp(address(this)) {}
        catch {
            reverted = true;
        }
    }
}

/// @dev A recipient that rejects ETH.
contract Rejecter {
    receive() external payable {
        revert("no");
    }
}

contract GasTankTest is Test {
    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");
    address internal svcA = makeAddr("svcA");
    address internal svcB = makeAddr("svcB");
    address internal treasury = makeAddr("treasury");

    BookrunnerConfig internal config;
    GasTank internal tank;

    uint256 internal constant FLOOR = 0.002 ether;
    uint256 internal constant TARGET = 0.01 ether;
    uint256 internal constant SVC_CAP = 0.02 ether;
    uint256 internal constant GLOBAL_CAP = 0.1 ether;

    function setUp() public {
        vm.warp(1_800_000_000);
        config = new BookrunnerConfig(admin);
        bytes32 guardianRole = config.GUARDIAN_ROLE();
        vm.prank(admin);
        config.grantRole(guardianRole, guardian);
        tank = new GasTank(address(config));
        vm.startPrank(admin);
        tank.setService(svcA, FLOOR, TARGET, SVC_CAP);
        tank.setService(svcB, FLOOR, TARGET, SVC_CAP);
        tank.setGlobalDailyCap(GLOBAL_CAP);
        vm.stopPrank();
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(tank).call{value: 1 ether}("");
        assertTrue(ok);
    }

    // ---------------------------------------------------------------- top-up

    function test_topUp_fillsToTarget() public {
        vm.deal(svcA, 0.0005 ether);
        vm.prank(keeper);
        uint256 sent = tank.topUp(svcA);
        assertEq(sent, TARGET - 0.0005 ether);
        assertEq(svcA.balance, TARGET);
        (,,,, uint256 today) = tank.serviceInfo(svcA);
        assertEq(today, sent);
        assertEq(tank.globalSentToday(), sent);
    }

    function test_topUp_emitsEvent() public {
        vm.deal(svcA, 0);
        vm.expectEmit(true, true, false, true, address(tank));
        emit GasTank.ToppedUp(svcA, TARGET, TARGET, keeper);
        vm.prank(keeper);
        tank.topUp(svcA);
    }

    function test_topUp_revertsAtOrAboveFloor() public {
        vm.deal(svcA, FLOOR);
        vm.expectRevert(abi.encodeWithSelector(GasTank.AboveFloor.selector, svcA, FLOOR, FLOOR));
        tank.topUp(svcA);
        (uint256 q, uint8 why) = tank.topUpQuote(svcA);
        assertEq(q, 0);
        assertEq(why, 2);
    }

    function test_topUp_revertsNotListed() public {
        address x = makeAddr("x");
        vm.expectRevert(abi.encodeWithSelector(GasTank.NotListed.selector, x));
        tank.topUp(x);
    }

    function test_topUp_serviceCap() public {
        // each top-up sends TARGET (0.01); the 0.02 cap allows two, the third has no room
        vm.deal(svcA, 0);
        tank.topUp(svcA);
        vm.deal(svcA, 0);
        tank.topUp(svcA);
        vm.deal(svcA, 0);
        (uint256 q, uint8 why) = tank.topUpQuote(svcA);
        assertEq(q, 0);
        assertEq(why, 3);
        vm.expectRevert(abi.encodeWithSelector(GasTank.CapReached.selector, svcA, false));
        tank.topUp(svcA);
        // next UTC day: allowed again
        vm.warp(block.timestamp + 1 days);
        assertEq(tank.topUp(svcA), TARGET);
    }

    function test_topUp_partialWhenCapIsTight() public {
        vm.prank(admin);
        tank.setService(svcA, FLOOR, TARGET, 0.012 ether);
        vm.deal(svcA, 0);
        tank.topUp(svcA); // 0.01
        vm.deal(svcA, 0);
        // 0.002 of the cap is left: a partial top-up
        assertEq(tank.topUp(svcA), 0.002 ether);
    }

    function test_topUp_globalCap() public {
        vm.prank(admin);
        tank.setGlobalDailyCap(0.015 ether);
        vm.deal(svcA, 0);
        vm.deal(svcB, 0);
        tank.topUp(svcA); // 0.01
        assertEq(tank.topUp(svcB), 0.005 ether); // only 0.005 of the global cap is left
        vm.deal(svcA, 0);
        (uint256 q, uint8 why) = tank.topUpQuote(svcA);
        assertEq(q, 0);
        assertEq(why, 4);
        vm.expectRevert(abi.encodeWithSelector(GasTank.CapReached.selector, svcA, true));
        tank.topUp(svcA);
    }

    function test_topUp_emptyTankAndPartialTank() public {
        vm.prank(admin);
        tank.withdraw(payable(treasury), address(tank).balance - 0.004 ether);
        vm.deal(svcA, 0);
        assertEq(tank.topUp(svcA), 0.004 ether); // limited by the tank
        vm.deal(svcA, 0);
        vm.expectRevert(abi.encodeWithSelector(GasTank.TankEmpty.selector, 0));
        tank.topUp(svcA);
    }

    function test_topUp_paused() public {
        vm.prank(guardian);
        tank.pause();
        vm.deal(svcA, 0);
        vm.expectRevert(GasTank.IsPaused.selector);
        tank.topUp(svcA);
        (, uint8 why) = tank.topUpQuote(svcA);
        assertEq(why, 1);
    }

    function test_topUp_reentrancyBlocked() public {
        Reenterer r = new Reenterer(tank);
        vm.prank(admin);
        tank.setService(address(r), FLOOR, TARGET, SVC_CAP);
        tank.topUp(address(r));
        assertTrue(r.tried());
        assertTrue(r.reverted());
        assertEq(address(r).balance, TARGET); // exactly one top-up landed
    }

    function test_topUp_rejectingRecipientRevertsWholly() public {
        Rejecter r = new Rejecter();
        vm.prank(admin);
        tank.setService(address(r), FLOOR, TARGET, SVC_CAP);
        uint256 before_ = address(tank).balance;
        vm.expectRevert(abi.encodeWithSelector(GasTank.TopUpFailed.selector, address(r)));
        tank.topUp(address(r));
        assertEq(address(tank).balance, before_);
        (,,,, uint256 today) = tank.serviceInfo(address(r));
        assertEq(today, 0); // the counters rolled back with the revert
    }

    // ---------------------------------------------------------------- governance

    function test_governance_onlyTimelock() public {
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(GasTank.NotAdmin.selector, keeper));
        tank.setService(svcA, FLOOR, TARGET, SVC_CAP);
        vm.expectRevert(abi.encodeWithSelector(GasTank.NotAdmin.selector, keeper));
        tank.removeService(svcA);
        vm.expectRevert(abi.encodeWithSelector(GasTank.NotAdmin.selector, keeper));
        tank.setGlobalDailyCap(1);
        vm.expectRevert(abi.encodeWithSelector(GasTank.NotAdmin.selector, keeper));
        tank.withdraw(payable(keeper), 1);
        vm.expectRevert(abi.encodeWithSelector(GasTank.NotAdmin.selector, keeper));
        tank.unpause();
        vm.expectRevert(abi.encodeWithSelector(GasTank.NotAdminOrGuardian.selector, keeper));
        tank.pause();
        vm.stopPrank();
        // the guardian cannot lift a pause or touch the money
        vm.startPrank(guardian);
        tank.pause();
        vm.expectRevert(abi.encodeWithSelector(GasTank.NotAdmin.selector, guardian));
        tank.unpause();
        vm.expectRevert(abi.encodeWithSelector(GasTank.NotAdmin.selector, guardian));
        tank.withdraw(payable(guardian), 1);
        vm.stopPrank();
        vm.prank(admin);
        tank.unpause();
        assertFalse(tank.paused());
    }

    function test_setService_bounds() public {
        vm.startPrank(admin);
        vm.expectRevert(GasTank.ZeroAddress.selector);
        tank.setService(address(0), FLOOR, TARGET, SVC_CAP);
        vm.expectRevert(GasTank.BadParams.selector);
        tank.setService(svcA, 0, TARGET, SVC_CAP); // floor 0
        vm.expectRevert(GasTank.BadParams.selector);
        tank.setService(svcA, TARGET, TARGET, SVC_CAP); // floor == target
        vm.expectRevert(GasTank.BadParams.selector);
        tank.setService(svcA, FLOOR, 1 ether + 1, 2 ether); // target above the ceiling
        vm.expectRevert(GasTank.BadParams.selector);
        tank.setService(svcA, FLOOR, TARGET, TARGET - 1); // cap below the target
        vm.expectRevert(GasTank.BadParams.selector);
        tank.setService(svcA, FLOOR, TARGET, 2 ether + 1); // cap above the ceiling
        vm.expectRevert(GasTank.BadParams.selector);
        tank.setGlobalDailyCap(5 ether + 1);
        vm.stopPrank();
    }

    function test_setService_keepsTodaysUsage() public {
        vm.deal(svcA, 0);
        tank.topUp(svcA);
        vm.prank(admin);
        tank.setService(svcA, FLOOR, TARGET, SVC_CAP);
        (,,,, uint256 today) = tank.serviceInfo(svcA);
        assertEq(today, TARGET);
    }

    function test_removeService() public {
        assertEq(tank.services().length, 2);
        vm.prank(admin);
        tank.removeService(svcA);
        address[] memory l = tank.services();
        assertEq(l.length, 1);
        assertEq(l[0], svcB);
        vm.deal(svcA, 0);
        vm.expectRevert(abi.encodeWithSelector(GasTank.NotListed.selector, svcA));
        tank.topUp(svcA);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(GasTank.NotListed.selector, svcA));
        tank.removeService(svcA);
    }

    function test_maxServices() public {
        vm.startPrank(admin);
        for (uint256 i = 2; i < 32; ++i) {
            tank.setService(address(uint160(0x1000 + i)), FLOOR, TARGET, SVC_CAP);
        }
        vm.expectRevert(GasTank.TooManyServices.selector);
        tank.setService(address(0x9999), FLOOR, TARGET, SVC_CAP);
        vm.stopPrank();
    }

    function test_withdraw() public {
        vm.prank(admin);
        tank.withdraw(payable(treasury), 0.4 ether);
        assertEq(treasury.balance, 0.4 ether);
        vm.prank(admin);
        vm.expectRevert(GasTank.ZeroAddress.selector);
        tank.withdraw(payable(address(0)), 1);
        vm.prank(admin);
        vm.expectRevert(GasTank.WithdrawFailed.selector);
        tank.withdraw(payable(treasury), 100 ether);
    }

    function test_constructor_zero() public {
        vm.expectRevert(GasTank.ZeroAddress.selector);
        new GasTank(address(0));
    }

    // ---------------------------------------------------------------- fuzz

    /// @dev Whatever the sequence, one UTC day never sends more than the service cap or the global cap.
    function testFuzz_dailyCapsHold(uint256 seed, uint8 n) public {
        n = uint8(bound(n, 1, 40));
        uint256 sentA;
        uint256 sentB;
        for (uint256 i; i < n; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address who = seed % 2 == 0 ? svcA : svcB;
            vm.deal(who, (seed >> 8) % FLOOR); // always below the floor
            try tank.topUp(who) returns (uint256 sent) {
                if (who == svcA) sentA += sent;
                else sentB += sent;
            } catch {}
        }
        assertLe(sentA, SVC_CAP);
        assertLe(sentB, SVC_CAP);
        assertLe(sentA + sentB, GLOBAL_CAP);
        assertEq(tank.globalSentToday(), sentA + sentB);
    }

    function testFuzz_neverAboveTarget(uint256 bal) public {
        bal = bound(bal, 0, FLOOR - 1);
        vm.deal(svcA, bal);
        uint256 sent = tank.topUp(svcA);
        assertLe(svcA.balance, TARGET);
        assertEq(svcA.balance, bal + sent);
    }

    function testFuzz_quoteMatchesTopUp(uint256 bal, uint256 tankBal) public {
        bal = bound(bal, 0, FLOOR - 1);
        tankBal = bound(tankBal, 1, 0.05 ether);
        vm.prank(admin);
        tank.withdraw(payable(treasury), address(tank).balance - tankBal);
        vm.deal(svcA, bal);
        (uint256 q,) = tank.topUpQuote(svcA);
        assertGt(q, 0);
        assertEq(tank.topUp(svcA), q);
    }
}
