// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {HedgeExecutor} from "../../src/HedgeExecutor.sol";
import {MandateBase} from "./utils/MandateBase.sol";
import {MandateMockSwapRouter} from "./utils/MandateMocks.sol";

/// @dev Desk-shaped caller: exposes book() and forwards swaps (approving the executor first).
contract ExecFakeDesk {
    address public book;
    HedgeExecutor internal immutable exec;

    constructor(HedgeExecutor e, address b) {
        exec = e;
        book = b;
    }

    function setBook(address b) external {
        book = b;
    }

    function swap(
        bytes32 venue,
        address tin,
        address tout,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external returns (uint256) {
        IERC20(tin).approve(address(exec), amountIn);
        return exec.swapExactIn(venue, tin, tout, 3000, amountIn, minOut, recipient);
    }
}

/// @dev A contract without book().
contract ExecNoBook {
    function swap(HedgeExecutor e, address tin, address tout) external {
        e.swapExactIn("UNIV3", tin, tout, 3000, 1, 0, address(this));
    }
}

contract HedgeExecutorTest is MandateBase {
    ExecFakeDesk internal fake;
    address internal fakeBook = makeAddr("fakeBook");

    event RouterSet(bytes32 indexed venue, address router);
    event Swapped(
        address indexed desk,
        bytes32 indexed venue,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    );

    function setUp() public override {
        super.setUp();
        fake = new ExecFakeDesk(exec, fakeBook);
        BRTypes.BookComponents memory c;
        c.book = fakeBook;
        c.desk = address(fake);
        c.vault = makeAddr("fakeVault");
        c.mandate = makeAddr("fakeMandate");
        c.adapter = makeAddr("fakeAdapter");
        c.router = makeAddr("fakeRouter");
        c.senior = makeAddr("fakeSenior");
        c.junior = makeAddr("fakeJunior");
        factory.register(99, c);
        usdc.mint(address(fake), 1_000_000e6);
    }

    function test_constructor() public {
        vm.expectRevert(HedgeExecutor.ZeroAddress.selector);
        new HedgeExecutor(address(0), address(router));
        HedgeExecutor e = new HedgeExecutor(address(cfg), address(0));
        assertEq(e.routerOf(UNIV3), address(0));
        assertEq(exec.routerOf(UNIV3), address(router));
        assertEq(address(exec.config()), address(cfg));
    }

    function test_setRouter_onlyTimelock() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.Unauthorized.selector, stranger));
        exec.setRouter(UNIV4, address(router));
        vm.prank(timelock);
        vm.expectRevert(HedgeExecutor.BadVenue.selector);
        exec.setRouter(bytes32(0), address(router));

        vm.expectEmit(true, false, false, true, address(exec));
        emit RouterSet(UNIV4, address(router));
        vm.prank(timelock);
        exec.setRouter(UNIV4, address(router));
        assertEq(exec.routerOf(UNIV4), address(router));

        vm.prank(timelock);
        exec.setRouter(UNIV4, address(0));
        assertEq(exec.routerOf(UNIV4), address(0));
    }

    function test_swap_buyAndSell() public {
        uint256 expectOut = router.quote(address(usdc), address(nvda), 1900e6);
        vm.expectEmit(true, true, false, true, address(exec));
        emit Swapped(address(fake), UNIV3, address(usdc), address(nvda), 1900e6, expectOut, address(fake));
        uint256 out = fake.swap(UNIV3, address(usdc), address(nvda), 1900e6, 9e18, address(fake));
        assertEq(out, 10e18);
        assertEq(nvda.balanceOf(address(fake)), 10e18);
        assertEq(router.lastFee(), 3000);

        uint256 usdcOut = fake.swap(UNIV3, address(nvda), address(usdc), 5e18, 0, address(fake));
        assertEq(usdcOut, 950e6);
        assertEq(nvda.balanceOf(address(exec)), 0);
        assertEq(usdc.balanceOf(address(exec)), 0);
    }

    function test_swap_realDeskPath() public {
        _fundDesk(10_000e6);
        adapter.setExposure(-20_000e6);
        uint256 out = _buyNvda(5700e6);
        assertEq(out, 30e18);
        assertEq(nvda.balanceOf(address(desk)), 30e18);
    }

    function test_swap_auth_rejectsNonDesks() public {
        // EOA
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.NotDesk.selector, stranger));
        exec.swapExactIn(UNIV3, address(usdc), address(nvda), 500, 1, 0, stranger);

        // contract that is not a factory component
        ExecFakeDesk rogue = new ExecFakeDesk(exec, address(book));
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.NotDesk.selector, address(rogue)));
        rogue.swap(UNIV3, address(usdc), address(nvda), 1, 0, address(rogue));

        // component of a book, but claims another book whose desk is someone else
        factory.setComponent(address(rogue), true);
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.NotDesk.selector, address(rogue)));
        rogue.swap(UNIV3, address(usdc), address(nvda), 1, 0, address(rogue));

        // component that claims a non-book
        rogue.setBook(stranger);
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.NotDesk.selector, address(rogue)));
        rogue.swap(UNIV3, address(usdc), address(nvda), 1, 0, address(rogue));
        rogue.setBook(address(0));
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.NotDesk.selector, address(rogue)));
        rogue.swap(UNIV3, address(usdc), address(nvda), 1, 0, address(rogue));

        // component without book()
        ExecNoBook nb = new ExecNoBook();
        factory.setComponent(address(nb), true);
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.NotDesk.selector, address(nb)));
        nb.swap(exec, address(usdc), address(nvda));

        // the book's vault is a component with book() but is not the desk
        vm.prank(address(vault));
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.NotDesk.selector, address(vault)));
        exec.swapExactIn(UNIV3, address(usdc), address(nvda), 500, 1, 0, address(vault));
    }

    function test_swap_univ4_notConfiguredUntilSet() public {
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.NotConfigured.selector, UNIV4));
        fake.swap(UNIV4, address(usdc), address(nvda), 190e6, 0, address(fake));
        bytes32 other = "ORDERLY";
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.NotConfigured.selector, other));
        fake.swap(other, address(usdc), address(nvda), 190e6, 0, address(fake));

        MandateMockSwapRouter v4 = new MandateMockSwapRouter(address(usdc));
        v4.setPrice(address(nvda), NVDA_PX);
        vm.prank(timelock);
        exec.setRouter(UNIV4, address(v4));
        assertEq(fake.swap(UNIV4, address(usdc), address(nvda), 190e6, 0, address(fake)), 1e18);
        assertEq(v4.calls(), 1);
    }

    function test_swap_inputValidation() public {
        vm.expectRevert(HedgeExecutor.ZeroAmount.selector);
        fake.swap(UNIV3, address(usdc), address(nvda), 0, 0, address(fake));
        vm.expectRevert(HedgeExecutor.ZeroAddress.selector);
        fake.swap(UNIV3, address(usdc), address(nvda), 1, 0, address(0));
        vm.expectRevert(HedgeExecutor.SameToken.selector);
        fake.swap(UNIV3, address(usdc), address(usdc), 1, 0, address(fake));
    }

    function test_swap_insufficientOutput_checkedByExecutor() public {
        router.setIgnoreMin(true);
        router.setUnderDeliver(true);
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.InsufficientOutput.selector, 5e18, 10e18));
        fake.swap(UNIV3, address(usdc), address(nvda), 1900e6, 10e18, address(fake));
    }

    function test_swap_refundsUnspentInput_andResetsApproval() public {
        router.setConsumeBps(5000);
        uint256 before = usdc.balanceOf(address(fake));
        uint256 out = fake.swap(UNIV3, address(usdc), address(nvda), 1900e6, 0, address(fake));
        assertEq(out, 5e18);
        assertEq(usdc.balanceOf(address(fake)), before - 950e6);
        assertEq(usdc.balanceOf(address(exec)), 0);
        assertEq(usdc.allowance(address(exec), address(router)), 0);
    }

    function testFuzz_swap_neverRetainsFunds(uint64 amountIn, uint16 consumeBps) public {
        uint256 amt = bound(uint256(amountIn), 1, 1_000_000e6);
        router.setConsumeBps(bound(uint256(consumeBps), 1, 10_000));
        fake.swap(UNIV3, address(usdc), address(nvda), amt, 0, address(fake));
        assertEq(usdc.balanceOf(address(exec)), 0);
        assertEq(nvda.balanceOf(address(exec)), 0);
        assertEq(usdc.allowance(address(exec), address(router)), 0);
    }
}
