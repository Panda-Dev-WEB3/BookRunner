// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {CoreFixture} from "./utils/CoreFixture.sol";
import {CoreMockBook} from "./utils/CoreMocks.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {RevenueRouter} from "../../src/RevenueRouter.sol";
import {IRevenueRouter} from "../../src/interfaces/IRevenueRouter.sol";
import {IBkrnFeeRouter} from "../../src/interfaces/IBkrnFeeRouter.sol";
import {BRTypes} from "../../src/interfaces/BRTypes.sol";

contract RevenueRouterTest is CoreFixture {
    function setUp() public override {
        super.setUp();
        // live book: both tranches have supply
        senior.mint(address(senior), 700_000e6);
        junior.mint(address(junior), 300_000e6);
    }

    // ---------------------------------------------------------------- initialization

    function test_initialize() public view {
        assertEq(address(router.config()), address(config));
        assertEq(router.bookId(), BOOK_ID);
        assertEq(router.book(), address(book));
        assertEq(address(router.usdc()), address(usdc));
    }

    function test_implementationLocked() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        routerImpl.initialize(address(config), 1, address(book));
    }

    function test_initialize_onlyOnce() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        router.initialize(address(config), 1, address(book));
    }

    function test_initialize_reverts() public {
        RevenueRouter r = RevenueRouter(Clones.clone(address(routerImpl)));
        vm.expectRevert(RevenueRouter.ZeroAddress.selector);
        r.initialize(address(0), 1, address(book));
        vm.expectRevert(RevenueRouter.ZeroAddress.selector);
        r.initialize(address(config), 1, address(0));
        BookrunnerConfig fresh = new BookrunnerConfig(admin);
        vm.expectRevert(RevenueRouter.ZeroAddress.selector);
        r.initialize(address(fresh), 1, address(book)); // usdc unset
    }

    // ---------------------------------------------------------------- notifySettlement

    function test_notifySettlement() public {
        usdc.mint(address(router), 1000e6);
        vm.expectEmit(true, true, false, true, address(router));
        emit IRevenueRouter.SettlementReceived(BOOK_ID, BRTypes.SRC_VENUE_TAKER_SHARE, 600e6);
        vm.prank(alice);
        router.notifySettlement(BRTypes.SRC_VENUE_TAKER_SHARE, 600e6);
        assertEq(router.pendingGross(), 600e6);

        router.notifySettlement(BRTypes.SRC_OTHER, 400e6);
        assertEq(router.pendingGross(), 1000e6);

        // nothing left to acknowledge
        vm.expectRevert(
            abi.encodeWithSelector(RevenueRouter.SettlementNotReceived.selector, 1000e6 + 1, 1000e6)
        );
        router.notifySettlement(BRTypes.SRC_OTHER, 1);
    }

    function test_notifySettlement_revertsWhenNotReceived() public {
        usdc.mint(address(router), 10);
        vm.expectRevert(abi.encodeWithSelector(RevenueRouter.SettlementNotReceived.selector, 11, 10));
        router.notifySettlement(BRTypes.SRC_ENGINE_FEES, 11);
    }

    function test_notifySettlement_revertsInvalidSource() public {
        vm.expectRevert(abi.encodeWithSelector(RevenueRouter.InvalidSource.selector, 5));
        router.notifySettlement(5, 0);
    }

    function test_notifySettlement_zeroIsNoop() public {
        vm.recordLogs();
        router.notifySettlement(BRTypes.SRC_FUNDING, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(router.pendingGross(), 0);
    }

    // ---------------------------------------------------------------- distribute

    function test_distribute_fullWaterfall() public {
        _settle(router, 1000e6);
        // gross 1000; expenses min(50, 20% * 1000) = 50; net 950; carry 95; rest 855; senior 60% = 513; junior 342
        vm.expectEmit(true, true, false, true, address(router));
        emit IRevenueRouter.Distributed(BOOK_ID, 600, [uint256(1000e6), 50e6, 95e6, 513e6, 342e6]);
        vm.expectEmit(true, false, false, true, address(feeRouter));
        emit IBkrnFeeRouter.CarryReceived(BOOK_ID, 95e6, 47_500_000, 47_500_000);
        vm.prank(keeper);
        IRevenueRouter.Amounts memory a = router.distribute(600, 50e6);

        assertEq(a.gross, 1000e6);
        assertEq(a.expenses, 50e6);
        assertEq(a.carry, 95e6);
        assertEq(a.senior, 513e6);
        assertEq(a.junior, 342e6);

        assertEq(usdc.balanceOf(expenseRecipient), 50e6);
        assertEq(usdc.balanceOf(vault), 855e6);
        assertEq(feeRouter.buybackPending(), 47_500_000);
        assertEq(usdc.balanceOf(address(backstop)), 47_500_000);
        assertEq(book.creditedSenior(), 513e6);
        assertEq(book.creditedJunior(), 342e6);
        assertEq(book.creditCalls(), 1);

        assertEq(router.pendingGross(), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertTrue(router.distributed(600));
        uint256[5] memory t = router.totals();
        assertEq(t[0], 1000e6);
        assertEq(t[4], 342e6);
    }

    function test_distribute_expensesCapped() public {
        _settle(router, 1000e6);
        vm.prank(keeper);
        IRevenueRouter.Amounts memory a = router.distribute(1, type(uint256).max);
        assertEq(a.expenses, 200e6); // expenseCapBps 2000
        assertEq(a.carry, 80e6);
        assertEq(a.senior + a.junior, 720e6);
    }

    function test_distribute_zeroGrossMarksPeriod() public {
        vm.expectEmit(true, true, false, true, address(router));
        emit IRevenueRouter.Distributed(BOOK_ID, 7, [uint256(0), 0, 0, 0, 0]);
        vm.prank(keeper);
        IRevenueRouter.Amounts memory a = router.distribute(7, 10e6);
        assertEq(a.gross, 0);
        assertTrue(router.distributed(7));
        assertEq(book.creditCalls(), 0);
        vm.expectRevert(abi.encodeWithSelector(RevenueRouter.AlreadyDistributed.selector, 7));
        vm.prank(keeper);
        router.distribute(7, 0);
    }

    function test_distribute_oncePerPeriod() public {
        _settle(router, 100e6);
        vm.prank(keeper);
        router.distribute(300, 0);
        _settle(router, 100e6);
        vm.expectRevert(abi.encodeWithSelector(RevenueRouter.AlreadyDistributed.selector, 300));
        vm.prank(keeper);
        router.distribute(300, 0);
        vm.prank(keeper);
        router.distribute(600, 0);
        assertEq(router.pendingGross(), 0);
    }

    function test_distribute_onlyKeeper() public {
        vm.expectRevert(abi.encodeWithSelector(RevenueRouter.NotKeeper.selector, alice));
        vm.prank(alice);
        router.distribute(1, 0);
    }

    function test_distribute_noSeniorSupply_allToJunior() public {
        senior.burn(address(senior), senior.totalSupply());
        _settle(router, 1000e6);
        vm.prank(keeper);
        IRevenueRouter.Amounts memory a = router.distribute(1, 0);
        assertEq(a.senior, 0);
        assertEq(a.junior, 900e6);
    }

    function test_distribute_noJuniorSupply_allToSenior() public {
        junior.burn(address(junior), junior.totalSupply());
        _settle(router, 1000e6);
        vm.prank(keeper);
        IRevenueRouter.Amounts memory a = router.distribute(1, 0);
        assertEq(a.senior, 900e6);
        assertEq(a.junior, 0);
    }

    function test_distribute_noCarryWhenCarryBpsZero() public {
        vm.prank(admin);
        config.setParam("carryBps", 0);
        _settle(router, 1000e6);
        vm.prank(keeper);
        IRevenueRouter.Amounts memory a = router.distribute(1, 0);
        assertEq(a.carry, 0);
        assertEq(feeRouter.totalCarryReceived(), 0);
        assertEq(usdc.balanceOf(vault), 1000e6);
    }

    function test_distribute_allExpenses_noVaultCredit() public {
        vm.prank(admin);
        config.setParam("expenseCapBps", 10_000);
        _settle(router, 1000e6);
        vm.prank(keeper);
        IRevenueRouter.Amounts memory a = router.distribute(1, 1000e6);
        assertEq(a.expenses, 1000e6);
        assertEq(book.creditCalls(), 0);
    }

    function test_distribute_donationAcknowledgedLater() public {
        usdc.mint(address(router), 500e6); // pushed but not yet notified
        vm.prank(keeper);
        router.distribute(1, 0);
        assertEq(router.pendingGross(), 0);
        assertEq(usdc.balanceOf(address(router)), 500e6);
        router.notifySettlement(BRTypes.SRC_OTHER, 500e6);
        vm.prank(keeper);
        IRevenueRouter.Amounts memory a = router.distribute(2, 0);
        assertEq(a.gross, 500e6);
    }

    function test_distribute_revertsWhenRecipientsUnset() public {
        // fresh config without expenseRecipient / feeRouter
        BookrunnerConfig c2 = new BookrunnerConfig(admin);
        vm.startPrank(admin);
        c2.setAddress("usdc", address(usdc));
        c2.grantRole(c2.KEEPER_ROLE(), keeper);
        vm.stopPrank();
        CoreMockBook b2 = new CoreMockBook();
        RevenueRouter r2 = RevenueRouter(Clones.clone(address(routerImpl)));
        r2.initialize(address(c2), 9, address(b2));
        b2.setComponents(
            BRTypes.BookComponents({
                book: address(b2),
                senior: address(senior),
                junior: address(junior),
                vault: address(0),
                mandate: address(0),
                router: address(r2),
                desk: address(0),
                adapter: address(0)
            })
        );
        b2.setHurdle(5000);

        _settle(r2, 100e6);
        vm.expectRevert(
            abi.encodeWithSelector(RevenueRouter.NotConfigured.selector, bytes32("expenseRecipient"))
        );
        vm.prank(keeper);
        r2.distribute(1, 1e6);

        vm.expectRevert(abi.encodeWithSelector(RevenueRouter.NotConfigured.selector, bytes32("feeRouter")));
        vm.prank(keeper);
        r2.distribute(1, 0);

        vm.prank(admin);
        c2.setParam("carryBps", 0);
        vm.expectRevert(abi.encodeWithSelector(RevenueRouter.NotConfigured.selector, bytes32("vault")));
        vm.prank(keeper);
        r2.distribute(1, 0);
    }

    function test_distribute_revertsIfBookRejectsCredit() public {
        // the book only accepts credits from its own router: a router not registered as the book's router
        CoreMockBook b2 = new CoreMockBook();
        RevenueRouter r2 = RevenueRouter(Clones.clone(address(routerImpl)));
        r2.initialize(address(config), 9, address(b2));
        b2.setComponents(
            BRTypes.BookComponents({
                book: address(b2),
                senior: address(senior),
                junior: address(junior),
                vault: vault,
                mandate: address(0),
                router: address(router), // not r2
                desk: address(0),
                adapter: address(0)
            })
        );
        vm.prank(admin);
        config.setParam("carryBps", 0);
        _settle(r2, 100e6);
        vm.expectRevert(CoreMockBook.NotRouter.selector);
        vm.prank(keeper);
        r2.distribute(1, 0);
        // the revert rolled back the period marker
        assertFalse(r2.distributed(1));
        assertEq(r2.pendingGross(), 100e6);
    }

    // ---------------------------------------------------------------- preview / pure split

    function test_previewSplit_matchesDistribute() public {
        _settle(router, 12_345_678);
        IRevenueRouter.Amounts memory p = router.previewSplit(12_345_678, 1_000_000);
        vm.prank(keeper);
        IRevenueRouter.Amounts memory a = router.distribute(1, 1_000_000);
        assertEq(abi.encode(p), abi.encode(a));
    }

    function test_computeSplit_revertsBpsOutOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(RevenueRouter.BpsOutOfRange.selector, 10_001));
        router.computeSplit(1, 0, 10_001, 0, 0, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(RevenueRouter.BpsOutOfRange.selector, 10_001));
        router.computeSplit(1, 0, 0, 10_001, 0, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(RevenueRouter.BpsOutOfRange.selector, 10_001));
        router.computeSplit(1, 0, 0, 0, 10_001, 1, 1);
    }

    function test_distribute_revertsOnInvalidHurdle() public {
        book.setHurdle(10_001);
        _settle(router, 100e6);
        vm.expectRevert(abi.encodeWithSelector(RevenueRouter.BpsOutOfRange.selector, 10_001));
        vm.prank(keeper);
        router.distribute(1, 0);
    }

    // ---------------------------------------------------------------- fuzz: waterfall ordering + conservation

    function testFuzz_computeSplit_conservationAndOrder(
        uint256 gross,
        uint256 expensesRequested,
        uint16 expenseCapBps,
        uint16 carryBps,
        uint16 hurdle,
        uint256 sSupply,
        uint256 jSupply
    ) public view {
        gross = bound(gross, 0, 1e30);
        expenseCapBps = uint16(bound(expenseCapBps, 0, 10_000));
        carryBps = uint16(bound(carryBps, 0, 10_000));
        hurdle = uint16(bound(hurdle, 0, 10_000));
        IRevenueRouter.Amounts memory a =
            router.computeSplit(gross, expensesRequested, expenseCapBps, carryBps, hurdle, sSupply, jSupply);
        assertEq(a.gross, gross);
        assertEq(a.expenses + a.carry + a.senior + a.junior, gross);
        assertLe(a.expenses, expensesRequested);
        assertLe(a.expenses, (gross * expenseCapBps) / 10_000);
        uint256 net = gross - a.expenses;
        assertEq(a.carry, (net * carryBps) / 10_000);
        uint256 rest = net - a.carry;
        if (sSupply == 0) assertEq(a.senior, 0);
        else if (jSupply == 0) assertEq(a.junior, 0);
        else assertEq(a.senior, (rest * hurdle) / 10_000);
    }

    function testFuzz_distribute_conservesUsdc(uint256 gross, uint256 expenses, uint16 hurdle) public {
        gross = bound(gross, 0, 1e18);
        hurdle = uint16(bound(hurdle, 0, 10_000));
        book.setHurdle(hurdle);
        if (gross > 0) _settle(router, gross);
        vm.prank(keeper);
        IRevenueRouter.Amounts memory a = router.distribute(1, expenses);
        assertEq(
            usdc.balanceOf(expenseRecipient) + usdc.balanceOf(address(feeRouter))
                + usdc.balanceOf(address(backstop)) + usdc.balanceOf(vault),
            gross
        );
        assertEq(usdc.balanceOf(vault), a.senior + a.junior);
        assertEq(book.creditedSenior(), a.senior);
        assertEq(book.creditedJunior(), a.junior);
        assertEq(usdc.balanceOf(address(router)), 0);
    }
}
