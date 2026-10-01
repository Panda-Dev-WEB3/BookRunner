// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MockSwapRouter} from "../../src/mocks/MockSwapRouter.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {ISwapRouter02} from "../../src/interfaces/external/ISwapRouter02.sol";
import {IAttestedOracle} from "../../src/interfaces/IAttestedOracle.sol";
import {CoreMockOracle} from "./utils/CoreMocks.sol";

contract MockSwapRouterTest is Test {
    MockSwapRouter internal swap;
    MockERC20 internal usdc;
    MockERC20 internal nvda; // Stock Token, 18 decimals
    MockERC20 internal bkrn;
    CoreMockOracle internal oracle;
    address internal owner = makeAddr("owner");
    address internal user = makeAddr("user");
    bytes32 internal constant NVDA_ID = bytes32("NVDA");

    function setUp() public {
        swap = new MockSwapRouter(owner);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        nvda = new MockERC20("NVIDIA Stock Token", "NVDA", 18);
        bkrn = new MockERC20("Bookrunner", "BKRN", 18);
        oracle = new CoreMockOracle();
        oracle.set(NVDA_ID, 190e18, false, false);
        vm.startPrank(owner);
        swap.setUsdPrice(address(usdc), 1e18);
        swap.setOracleFeed(address(nvda), address(oracle), NVDA_ID, 1e18);
        swap.setMintOnDemand(address(nvda), true);
        swap.setMintOnDemand(address(usdc), true);
        vm.stopPrank();
        usdc.mint(user, 1_000_000e6);
        vm.prank(user);
        usdc.approve(address(swap), type(uint256).max);
        vm.prank(user);
        nvda.approve(address(swap), type(uint256).max);
    }

    function _params(address tin, address tout, uint256 amountIn, uint256 minOut)
        internal
        view
        returns (ISwapRouter02.ExactInputSingleParams memory)
    {
        return ISwapRouter02.ExactInputSingleParams({
            tokenIn: tin,
            tokenOut: tout,
            fee: 3000,
            recipient: user,
            amountIn: amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0
        });
    }

    function test_oraclePricedHedge_buyAndSell() public {
        vm.prank(user);
        uint256 out = swap.exactInputSingle(_params(address(usdc), address(nvda), 1900e6, 10e18));
        assertEq(out, 10e18);
        assertEq(nvda.balanceOf(user), 10e18);
        assertEq(usdc.balanceOf(address(swap)), 1900e6);

        vm.prank(user);
        uint256 back = swap.exactInputSingle(_params(address(nvda), address(usdc), 5e18, 950e6));
        assertEq(back, 950e6);
        assertEq(nvda.balanceOf(user), 5e18);
    }

    function test_multiplierAppliedOnce() public {
        // Stock Token with multiplier 2.0 (2 shares per token): worth exactly 2x per token
        vm.prank(owner);
        swap.setOracleFeed(address(nvda), address(oracle), NVDA_ID, 2e18);
        assertEq(swap.usdPriceOf(address(nvda)), 380e18);
        assertEq(swap.quote(address(usdc), address(nvda), 3800e6), 10e18);
        assertEq(swap.quote(address(nvda), address(usdc), 1e18), 380e6);
    }

    function test_stalePriceReverts() public {
        oracle.set(NVDA_ID, 190e18, false, true);
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.StalePrice.selector, NVDA_ID, uint64(0)));
        vm.prank(user);
        swap.exactInputSingle(_params(address(usdc), address(nvda), 1e6, 0));
    }

    function test_pairPrice_decimalsAware() public {
        vm.prank(owner);
        swap.setPrice(address(usdc), address(bkrn), 20e18); // 20 BKRN per USDC
        assertEq(swap.quote(address(usdc), address(bkrn), 1e6), 20e18);
        assertEq(swap.quote(address(usdc), address(bkrn), 1), 20e12);
        // pair price takes precedence over USD valuations
        vm.prank(owner);
        swap.setUsdPrice(address(bkrn), 1e18);
        assertEq(swap.quote(address(usdc), address(bkrn), 1e6), 20e18);
    }

    function test_setPriceBoth_inverse() public {
        vm.prank(owner);
        swap.setPriceBoth(address(usdc), address(bkrn), 20e18);
        assertEq(swap.pairPrice(address(bkrn), address(usdc)), 5e16);
        assertEq(swap.quote(address(bkrn), address(usdc), 20e18), 1e6);
        vm.expectRevert(MockSwapRouter.ZeroAmount.selector);
        vm.prank(owner);
        swap.setPriceBoth(address(usdc), address(bkrn), 0);
    }

    function test_inventoryAndLiquidity() public {
        vm.prank(owner);
        swap.setPrice(address(usdc), address(bkrn), 20e18);
        // bkrn is not mint-on-demand and the router holds none
        vm.expectRevert(
            abi.encodeWithSelector(MockSwapRouter.InsufficientLiquidity.selector, address(bkrn), 0, 20e18)
        );
        vm.prank(user);
        swap.exactInputSingle(_params(address(usdc), address(bkrn), 1e6, 0));

        bkrn.mint(address(swap), 100e18);
        vm.prank(user);
        assertEq(swap.exactInputSingle(_params(address(usdc), address(bkrn), 1e6, 20e18)), 20e18);
        assertEq(bkrn.balanceOf(address(swap)), 80e18);

        vm.prank(owner);
        swap.withdraw(address(bkrn), owner, 80e18);
        assertEq(bkrn.balanceOf(owner), 80e18);
    }

    function test_fee() public {
        vm.prank(owner);
        swap.setFeeBps(30);
        assertEq(swap.quote(address(usdc), address(nvda), 1900e6), 9.97e18);
        vm.expectRevert(abi.encodeWithSelector(MockSwapRouter.InvalidFee.selector, 10_000));
        vm.prank(owner);
        swap.setFeeBps(10_000);
    }

    function test_reverts() public {
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(MockSwapRouter.TooLittleReceived.selector, 10e18, 10e18 + 1));
        swap.exactInputSingle(_params(address(usdc), address(nvda), 1900e6, 10e18 + 1));

        vm.expectRevert(MockSwapRouter.ZeroAmount.selector);
        swap.exactInputSingle(_params(address(usdc), address(nvda), 0, 0));

        ISwapRouter02.ExactInputSingleParams memory p = _params(address(usdc), address(nvda), 1e6, 0);
        p.recipient = address(0);
        vm.expectRevert(MockSwapRouter.ZeroAddress.selector);
        swap.exactInputSingle(p);

        vm.deal(user, 1 ether);
        vm.expectRevert(MockSwapRouter.EthNotAccepted.selector);
        swap.exactInputSingle{value: 1}(_params(address(usdc), address(nvda), 1e6, 0));

        vm.expectRevert(abi.encodeWithSelector(MockSwapRouter.NoPrice.selector, address(usdc), address(bkrn)));
        swap.exactInputSingle(_params(address(usdc), address(bkrn), 1e6, 0));

        vm.expectRevert(MockSwapRouter.SameToken.selector);
        swap.exactInputSingle(_params(address(usdc), address(usdc), 1e6, 0));
        vm.stopPrank();
    }

    function test_ownerOnly() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user);
        vm.startPrank(user);
        vm.expectRevert(err);
        swap.setPrice(address(usdc), address(bkrn), 1);
        vm.expectRevert(err);
        swap.setPriceBoth(address(usdc), address(bkrn), 1);
        vm.expectRevert(err);
        swap.setUsdPrice(address(usdc), 1);
        vm.expectRevert(err);
        swap.setOracleFeed(address(nvda), address(oracle), NVDA_ID, 1e18);
        vm.expectRevert(err);
        swap.setMintOnDemand(address(nvda), false);
        vm.expectRevert(err);
        swap.setFeeBps(1);
        vm.expectRevert(err);
        swap.withdraw(address(usdc), user, 0);
        vm.stopPrank();
    }

    function test_configValidation() public {
        vm.startPrank(owner);
        vm.expectRevert(MockSwapRouter.ZeroAddress.selector);
        swap.setPrice(address(0), address(bkrn), 1);
        vm.expectRevert(MockSwapRouter.SameToken.selector);
        swap.setPrice(address(bkrn), address(bkrn), 1);
        vm.expectRevert(MockSwapRouter.ZeroAddress.selector);
        swap.setUsdPrice(address(0), 1);
        vm.expectRevert(MockSwapRouter.ZeroAddress.selector);
        swap.setOracleFeed(address(0), address(oracle), NVDA_ID, 1e18);
        vm.expectRevert(MockSwapRouter.ZeroAmount.selector);
        swap.setOracleFeed(address(nvda), address(oracle), NVDA_ID, 0);
        vm.expectRevert(MockSwapRouter.ZeroAddress.selector);
        swap.setMintOnDemand(address(0), true);
        // clearing the oracle feed falls back to the fixed USD price
        swap.setOracleFeed(address(nvda), address(0), 0, 0);
        swap.setUsdPrice(address(nvda), 100e18);
        vm.stopPrank();
        assertEq(swap.usdPriceOf(address(nvda)), 100e18);
    }

    function testFuzz_roundTripNeverProfits(uint256 amountIn, uint256 price) public {
        amountIn = bound(amountIn, 1, 1e12 * 1e6);
        price = bound(price, 1e15, 1e24);
        oracle.set(NVDA_ID, price, false, false);
        usdc.mint(user, amountIn);
        vm.startPrank(user);
        uint256 tokens = swap.exactInputSingle(_params(address(usdc), address(nvda), amountIn, 0));
        if (tokens == 0) return;
        uint256 back = swap.exactInputSingle(_params(address(nvda), address(usdc), tokens, 0));
        vm.stopPrank();
        assertLe(back, amountIn);
    }
}
