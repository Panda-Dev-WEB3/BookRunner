// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {BkrnToken} from "../../src/BkrnToken.sol";

contract BkrnTokenTest is Test {
    BkrnToken internal token;
    address internal community = makeAddr("community");
    address internal studio = makeAddr("studio");
    address internal liquidity = makeAddr("liquidity");
    address internal contributors = makeAddr("contributors");

    function setUp() public {
        token = new BkrnToken(community, studio, liquidity, contributors);
    }

    function test_metadata() public view {
        assertEq(token.name(), "Bookrunner");
        assertEq(token.symbol(), "BKRN");
        assertEq(token.decimals(), 18);
    }

    function test_fixedSupplySplit_80_10_5_5() public view {
        assertEq(token.totalSupply(), 1_000_000_000e18);
        assertEq(token.TOTAL_SUPPLY(), 1_000_000_000e18);
        assertEq(token.balanceOf(community), 800_000_000e18);
        assertEq(token.balanceOf(studio), 100_000_000e18);
        assertEq(token.balanceOf(liquidity), 50_000_000e18);
        assertEq(token.balanceOf(contributors), 50_000_000e18);
    }

    function test_constructor_emitsAllocation() public {
        vm.expectEmit(true, true, false, true);
        emit BkrnToken.InitialAllocation(
            community,
            studio,
            liquidity,
            contributors,
            800_000_000e18,
            100_000_000e18,
            50_000_000e18,
            50_000_000e18
        );
        new BkrnToken(community, studio, liquidity, contributors);
    }

    function test_constructor_revertsOnZeroRecipient() public {
        vm.expectRevert(BkrnToken.ZeroAddress.selector);
        new BkrnToken(address(0), studio, liquidity, contributors);
        vm.expectRevert(BkrnToken.ZeroAddress.selector);
        new BkrnToken(community, address(0), liquidity, contributors);
        vm.expectRevert(BkrnToken.ZeroAddress.selector);
        new BkrnToken(community, studio, address(0), contributors);
        vm.expectRevert(BkrnToken.ZeroAddress.selector);
        new BkrnToken(community, studio, liquidity, address(0));
    }

    function test_noMintAfterConstruction() public {
        (bool ok,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", community, 1));
        assertFalse(ok);
        assertEq(token.totalSupply(), 1_000_000_000e18);
    }

    function test_permit() public {
        uint256 pk = 0xB0B;
        address owner = vm.addr(pk);
        address spender = makeAddr("spender");
        vm.prank(community);
        token.transfer(owner, 100e18);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner,
                spender,
                40e18,
                token.nonces(owner),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        token.permit(owner, spender, 40e18, deadline, v, r, s);
        assertEq(token.allowance(owner, spender), 40e18);
        assertEq(token.nonces(owner), 1);

        vm.prank(spender);
        token.transferFrom(owner, spender, 40e18);
        assertEq(token.balanceOf(spender), 40e18);
    }

    function testFuzz_transfer(uint256 amount) public {
        amount = bound(amount, 0, 800_000_000e18);
        address to = makeAddr("to");
        vm.prank(community);
        token.transfer(to, amount);
        assertEq(token.balanceOf(to), amount);
        assertEq(token.totalSupply(), 1_000_000_000e18);
    }
}
