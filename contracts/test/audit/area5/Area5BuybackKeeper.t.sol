// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CoreFixture} from "../../core/utils/CoreFixture.sol";
import {ISwapRouter02} from "../../../src/interfaces/external/ISwapRouter02.sol";

/// @dev Uniswap-v3-like SwapRouter02 stand-in: the pool is picked by the caller's `fee` tier. Tier 3000
///      is the deep, fairly priced pool; tier 10000 is a pool anyone can create permissionlessly and seed
///      with a skewed, thin position (here: pays 1 wei of BKRN for any input and keeps the USDC, which the
///      pool creator then withdraws). Honours amountOutMinimum like the real router.
contract FeeTierRouter {
    IERC20 public immutable usdc;
    IERC20 public immutable bkrn;
    uint256 public fairBkrnPerUsdc; // 18dp BKRN per 1 USDC (6dp)

    error TooLittleReceived();

    constructor(IERC20 usdc_, IERC20 bkrn_, uint256 fair) {
        (usdc, bkrn, fairBkrnPerUsdc) = (usdc_, bkrn_, fair);
    }

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p)
        external
        payable
        returns (uint256 out)
    {
        usdc.transferFrom(msg.sender, address(this), p.amountIn);
        out = p.fee == 10_000 ? 1 : (p.amountIn * fairBkrnPerUsdc) / 1e6;
        if (out < p.amountOutMinimum) revert TooLittleReceived();
        bkrn.transfer(p.recipient, out);
    }
}

/// @notice AUDIT area 5 — executeBuyback trusts the KEEPER's minBkrnOut and poolFee entirely: there is no
///         on-chain price reference, so a compromised / buggy keeper (a hot key on the ops server) routes
///         the whole buybackPending through an attacker-seeded fee tier with minBkrnOut = 1.
contract Area5BuybackKeeperTest is CoreFixture {
    FeeTierRouter internal v3;

    function setUp() public override {
        super.setUp();
        v3 = new FeeTierRouter(IERC20(address(usdc)), IERC20(address(bkrn)), 20e18);
        vm.prank(liquidity);
        bkrn.transfer(address(v3), 10_000_000e18);
        vm.prank(admin);
        feeRouter.setBuybackRouter(address(v3)); // the real SwapRouter02 on mainnet
        _stake(alice, 1_000_000e18);
    }

    function test_audit_buybackKeeperRoutesToRoguePool() public {
        // 100k USDC of carry -> 50k USDC pending buyback (fair value: 1,000,000 BKRN)
        usdc.mint(address(feeRouter), 100_000e6);
        vm.prank(address(router));
        feeRouter.notifyCarry(BOOK_ID, 100_000e6);
        uint256 pending = feeRouter.buybackPending();
        assertEq(pending, 50_000e6);

        uint256 fairOut = (pending * 20e18) / 1e6;

        // keeper key: rogue fee tier + minOut = 1 (the only on-chain check is minOut != 0)
        vm.prank(keeper);
        try feeRouter.executeBuyback(pending, 1, 10_000) returns (uint256 out) {
            // 50,000 USDC of stakers' buyback swapped for 1 wei of BKRN; the USDC sits in the rogue pool.
            assertGe(out * 100, fairOut * 95, "buyback executed >5% below fair value (no on-chain price bound)");
        } catch {
            // secure: the contract refuses a swap priced far from a reference price / non-pinned fee tier
        }
    }
}
