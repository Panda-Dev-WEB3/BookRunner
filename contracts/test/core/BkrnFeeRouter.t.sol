// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {CoreFixture} from "./utils/CoreFixture.sol";
import {CoreMisbehavingRouter, CoreReentrantRouter} from "./utils/CoreMocks.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {BkrnFeeRouter} from "../../src/BkrnFeeRouter.sol";
import {IBkrnFeeRouter, IBackstop} from "../../src/interfaces/IBkrnFeeRouter.sol";
import {IBkrnStaking} from "../../src/interfaces/IBkrnStaking.sol";
import {MockSwapRouter} from "../../src/mocks/MockSwapRouter.sol";

contract BkrnFeeRouterTest is CoreFixture {
    /// @dev The book's RevenueRouter clone is a registered component.
    function _carry(uint256 amount) internal {
        usdc.mint(address(feeRouter), amount);
        vm.prank(address(router));
        feeRouter.notifyCarry(BOOK_ID, amount);
    }

    // ---------------------------------------------------------------- construction

    function test_constructor() public view {
        assertEq(address(feeRouter.config()), address(config));
        assertEq(address(feeRouter.usdc()), address(usdc));
        assertEq(address(feeRouter.bkrn()), address(bkrn));
        assertEq(feeRouter.buybackRouter(), address(swapRouter));
    }

    function test_constructor_reverts() public {
        vm.expectRevert(BkrnFeeRouter.ZeroAddress.selector);
        new BkrnFeeRouter(address(0));
        BookrunnerConfig fresh = new BookrunnerConfig(admin);
        vm.expectRevert(BkrnFeeRouter.ZeroAddress.selector);
        new BkrnFeeRouter(address(fresh));
        vm.prank(admin);
        fresh.setAddress("usdc", address(usdc));
        vm.expectRevert(BkrnFeeRouter.ZeroAddress.selector);
        new BkrnFeeRouter(address(fresh)); // bkrn unset
    }

    // ---------------------------------------------------------------- notifyCarry

    function test_notifyCarry_split_oddUnitToBackstop() public {
        usdc.mint(address(feeRouter), 101);
        vm.expectEmit(true, false, false, true, address(feeRouter));
        emit IBkrnFeeRouter.CarryReceived(BOOK_ID, 101, 50, 51);
        vm.expectEmit(true, false, false, true, address(backstop));
        emit IBackstop.Deposited(address(feeRouter), 51);
        vm.prank(address(router));
        feeRouter.notifyCarry(BOOK_ID, 101);

        assertEq(feeRouter.buybackPending(), 50);
        assertEq(usdc.balanceOf(address(feeRouter)), 50);
        assertEq(usdc.balanceOf(address(backstop)), 51);
        assertEq(backstop.accountedBalance(), 51);
        assertEq(feeRouter.totalCarryReceived(), 101);
        assertEq(feeRouter.totalToBackstop(), 51);
    }

    function test_notifyCarry_one() public {
        _carry(1);
        assertEq(feeRouter.buybackPending(), 0);
        assertEq(usdc.balanceOf(address(backstop)), 1);
    }

    function test_notifyCarry_revertsForNonComponent() public {
        usdc.mint(address(feeRouter), 10);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.NotComponent.selector, alice));
        vm.prank(alice);
        feeRouter.notifyCarry(BOOK_ID, 10);
    }

    function test_notifyCarry_revertsWhenFactoryUnset() public {
        BookrunnerConfig c2 = new BookrunnerConfig(admin);
        vm.startPrank(admin);
        c2.setAddress("usdc", address(usdc));
        c2.setAddress("bkrn", address(bkrn));
        vm.stopPrank();
        BkrnFeeRouter fr = new BkrnFeeRouter(address(c2));
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.NotComponent.selector, address(router)));
        vm.prank(address(router));
        fr.notifyCarry(BOOK_ID, 0);
    }

    function test_notifyCarry_revertsWhenBackstopUnset() public {
        BookrunnerConfig c2 = new BookrunnerConfig(admin);
        vm.startPrank(admin);
        c2.setAddress("usdc", address(usdc));
        c2.setAddress("bkrn", address(bkrn));
        c2.setAddress("factory", address(factory));
        vm.stopPrank();
        BkrnFeeRouter fr = new BkrnFeeRouter(address(c2));
        usdc.mint(address(fr), 10);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.NotConfigured.selector, bytes32("backstop")));
        vm.prank(address(router));
        fr.notifyCarry(BOOK_ID, 10);
    }

    function test_notifyCarry_zeroIsNoop() public {
        vm.prank(address(router));
        feeRouter.notifyCarry(BOOK_ID, 0);
        assertEq(feeRouter.totalCarryReceived(), 0);
    }

    function test_notifyCarry_revertsWhenNotReceived() public {
        usdc.mint(address(feeRouter), 99);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.CarryNotReceived.selector, 100, 99));
        vm.prank(address(router));
        feeRouter.notifyCarry(BOOK_ID, 100);
    }

    function test_notifyCarry_cannotDoubleCountPendingBuyback() public {
        _carry(100); // 50 pending stays in the router
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.CarryNotReceived.selector, 60, 50));
        vm.prank(address(router));
        feeRouter.notifyCarry(BOOK_ID, 10);
    }

    function testFuzz_notifyCarry_split(uint256 amount) public {
        amount = bound(amount, 1, 1e30);
        _carry(amount);
        uint256 toBuyback = feeRouter.buybackPending();
        uint256 toBackstop = usdc.balanceOf(address(backstop));
        assertEq(toBuyback + toBackstop, amount);
        assertEq(toBuyback, amount / 2);
        assertLe(toBackstop - toBuyback, 1);
        assertEq(usdc.balanceOf(address(feeRouter)), toBuyback);
    }

    // ---------------------------------------------------------------- executeBuyback

    function test_executeBuyback() public {
        _stake(alice, 1000e18);
        _carry(200e6); // 100 USDC to buyback
        vm.expectEmit(false, false, false, true, address(feeRouter));
        emit IBkrnFeeRouter.BuybackExecuted(60e6, 1200e18);
        vm.expectEmit(false, false, false, true, address(staking));
        emit IBkrnStaking.RewardNotified(1200e18);
        vm.prank(keeper);
        uint256 out = feeRouter.executeBuyback(60e6, 1200e18, 3000);
        assertEq(out, 1200e18);
        assertEq(feeRouter.buybackPending(), 40e6);
        assertEq(usdc.balanceOf(address(feeRouter)), 40e6);
        assertEq(bkrn.balanceOf(address(feeRouter)), 0);
        assertEq(usdc.allowance(address(feeRouter), address(swapRouter)), 0);
        assertEq(staking.earned(alice), 1200e18);
        assertEq(feeRouter.totalBuybackUsdc(), 60e6);
        assertEq(feeRouter.totalBkrnDistributed(), 1200e18);
    }

    function test_executeBuyback_reverts() public {
        _carry(200e6);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.NotKeeper.selector, alice));
        vm.prank(alice);
        feeRouter.executeBuyback(1, 1, 3000);

        vm.startPrank(keeper);
        vm.expectRevert(BkrnFeeRouter.ZeroAmount.selector);
        feeRouter.executeBuyback(0, 1, 3000);
        vm.expectRevert(BkrnFeeRouter.ZeroAmount.selector);
        feeRouter.executeBuyback(1, 0, 3000);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.InsufficientPending.selector, 100e6, 100e6 + 1));
        feeRouter.executeBuyback(100e6 + 1, 1, 3000);
        // slippage enforced by the router
        vm.expectRevert(abi.encodeWithSelector(MockSwapRouter.TooLittleReceived.selector, 20e18, 20e18 + 1));
        feeRouter.executeBuyback(1e6, 20e18 + 1, 3000);
        vm.stopPrank();
    }

    function test_executeBuyback_revertsWhenRouterUnset() public {
        BookrunnerConfig c2 = new BookrunnerConfig(admin);
        vm.startPrank(admin);
        c2.setAddress("usdc", address(usdc));
        c2.setAddress("bkrn", address(bkrn));
        c2.grantRole(c2.KEEPER_ROLE(), keeper);
        vm.stopPrank();
        BkrnFeeRouter fr = new BkrnFeeRouter(address(c2));
        // seed buyback pending through a registered component (no buyback router / staking on c2)
        vm.startPrank(admin);
        c2.setAddress("factory", address(factory));
        c2.setAddress("backstop", address(backstop));
        vm.stopPrank();
        usdc.mint(address(fr), 10);
        vm.prank(address(router));
        fr.notifyCarry(BOOK_ID, 10);

        vm.expectRevert(
            abi.encodeWithSelector(BkrnFeeRouter.NotConfigured.selector, bytes32("buybackRouter"))
        );
        vm.prank(keeper);
        fr.executeBuyback(5, 1, 3000);

        vm.prank(admin);
        fr.setBuybackRouter(address(swapRouter));
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.NotConfigured.selector, bytes32("staking")));
        vm.prank(keeper);
        fr.executeBuyback(5, 1, 3000);
    }

    function test_executeBuyback_partialPullRefundsPending() public {
        CoreMisbehavingRouter bad = new CoreMisbehavingRouter();
        _giveBkrn(address(bad), 1000e18);
        bad.configure(5000, 100e18, 0); // pulls half, pays 100 BKRN, reports 0
        vm.prank(admin);
        feeRouter.setBuybackRouter(address(bad));
        _stake(alice, 1e18);
        _carry(200e6);

        vm.prank(keeper);
        uint256 out = feeRouter.executeBuyback(100e6, 100e18, 500);
        assertEq(out, 100e18); // measured by balance delta, not the router's return value
        assertEq(feeRouter.buybackPending(), 50e6);
        assertEq(usdc.balanceOf(address(feeRouter)), 50e6);
        assertEq(usdc.allowance(address(feeRouter), address(bad)), 0);
        assertEq(feeRouter.totalBuybackUsdc(), 50e6);
    }

    function test_executeBuyback_revertsWhenRouterUnderpays() public {
        CoreMisbehavingRouter bad = new CoreMisbehavingRouter();
        _giveBkrn(address(bad), 1000e18);
        bad.configure(10_000, 1e18, 1e30); // pays 1 BKRN but reports a huge amount
        vm.prank(admin);
        feeRouter.setBuybackRouter(address(bad));
        _carry(200e6);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.InsufficientOutput.selector, 1e18, 2e18));
        vm.prank(keeper);
        feeRouter.executeBuyback(100e6, 2e18, 500);
    }

    function test_executeBuyback_reentrancyBlocked() public {
        CoreReentrantRouter evil = new CoreReentrantRouter();
        vm.prank(admin);
        feeRouter.setBuybackRouter(address(evil));
        _carry(200e6);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        vm.prank(keeper);
        feeRouter.executeBuyback(10e6, 1, 500);
    }

    function test_executeBuyback_noStakersQueuesReward() public {
        _carry(2e6);
        vm.prank(keeper);
        feeRouter.executeBuyback(1e6, 20e18, 3000);
        assertEq(staking.queuedReward(), 20e18);
        _stake(bob, 1e18);
        _carry(2e6);
        vm.prank(keeper);
        feeRouter.executeBuyback(1e6, 20e18, 3000);
        assertEq(staking.earned(bob), 40e18);
    }

    // ---------------------------------------------------------------- admin

    function test_setBuybackRouter() public {
        address r = makeAddr("r");
        vm.expectEmit(false, false, false, true, address(feeRouter));
        emit BkrnFeeRouter.BuybackRouterSet(r);
        vm.prank(admin);
        feeRouter.setBuybackRouter(r);
        assertEq(feeRouter.buybackRouter(), r);

        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.NotAdmin.selector, keeper));
        vm.prank(keeper);
        feeRouter.setBuybackRouter(r);

        vm.expectRevert(BkrnFeeRouter.ZeroAddress.selector);
        vm.prank(admin);
        feeRouter.setBuybackRouter(address(0));
    }

    function testFuzz_buybackConservation(uint256 carry, uint256 amountIn) public {
        carry = bound(carry, 2, 1e12); // router holds 10M BKRN of liquidity
        _stake(alice, 1e18);
        _carry(carry);
        uint256 pending = feeRouter.buybackPending();
        amountIn = bound(amountIn, 1, pending);
        uint256 quoted = swapRouter.quote(address(usdc), address(bkrn), amountIn);
        vm.assume(quoted > 0);
        vm.prank(keeper);
        uint256 out = feeRouter.executeBuyback(amountIn, quoted, 3000);
        assertEq(out, quoted);
        assertEq(feeRouter.buybackPending(), pending - amountIn);
        assertEq(usdc.balanceOf(address(feeRouter)), feeRouter.buybackPending());
        assertEq(bkrn.balanceOf(address(staking)), 1e18 + out);
    }
}
