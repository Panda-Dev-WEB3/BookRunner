// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IBkrnFeeRouter, IBackstop} from "./interfaces/IBkrnFeeRouter.sol";
import {IBkrnStaking} from "./interfaces/IBkrnStaking.sol";
import {IBookFactory} from "./interfaces/IBookFactory.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {ISwapRouter02} from "./interfaces/external/ISwapRouter02.sol";

/// @title BkrnFeeRouter — splits protocol carry 50% buyback-to-stakers / 50% syndicate backstop.
/// @notice Each book's RevenueRouter transfers its carry here and calls `notifyCarry`. The backstop half
///         (plus any odd unit) is forwarded to the Backstop immediately; the buyback half accumulates in
///         `buybackPending` until a KEEPER swaps it to BKRN through `buybackRouter`
///         (`ISwapRouter02.exactInputSingle`) and the BKRN is distributed to stakers via
///         `BkrnStaking.notifyReward`.
/// @dev Accounting: the only USDC this contract is meant to hold is `buybackPending`; `notifyCarry`
///      requires the USDC balance to cover `buybackPending + amount` (push-then-notify).
contract BkrnFeeRouter is IBkrnFeeRouter, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes32 private constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 private constant KEEPER_ROLE = keccak256("KEEPER");

    /// @notice Protocol registry.
    IBookrunnerConfig public immutable config;
    /// @notice USDC (config.usdc() at deployment).
    IERC20 public immutable usdc;
    /// @notice BKRN (config.bkrn() at deployment).
    IERC20 public immutable bkrn;

    /// @inheritdoc IBkrnFeeRouter
    uint256 public buybackPending;
    /// @notice Uniswap v3 SwapRouter02-compatible router used for buybacks (VERIFY on RHC; devnet:
    ///         MockSwapRouter).
    address public buybackRouter;

    /// @notice Lifetime carry received (USDC 6dp).
    uint256 public totalCarryReceived;
    /// @notice Lifetime USDC forwarded to the Backstop.
    uint256 public totalToBackstop;
    /// @notice Lifetime USDC swapped in buybacks.
    uint256 public totalBuybackUsdc;
    /// @notice Lifetime BKRN bought back and distributed to stakers.
    uint256 public totalBkrnDistributed;

    error ZeroAddress();
    error ZeroAmount();
    error NotComponent(address caller);
    error NotKeeper(address caller);
    error NotAdmin(address caller);
    error NotConfigured(bytes32 what);
    error CarryNotReceived(uint256 required, uint256 balance);
    error InsufficientPending(uint256 pending, uint256 requested);
    error InsufficientOutput(uint256 received, uint256 minimum);

    /// @notice Buyback router changed.
    event BuybackRouterSet(address router);

    /// @param config_ BookrunnerConfig; `usdc()` and `bkrn()` must already be set.
    constructor(address config_) {
        if (config_ == address(0)) revert ZeroAddress();
        config = IBookrunnerConfig(config_);
        address usdc_ = IBookrunnerConfig(config_).usdc();
        address bkrn_ = IBookrunnerConfig(config_).bkrn();
        if (usdc_ == address(0) || bkrn_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        bkrn = IERC20(bkrn_);
    }

    /// @inheritdoc IBkrnFeeRouter
    /// @dev Only a component registered by `config.factory()` (a book's RevenueRouter). The caller must
    ///      have transferred `amount` USDC first. Split: `amount / 2` to buyback, the rest (including an
    ///      odd unit) to the Backstop, which is notified via `IBackstop.notifyDeposit`.
    function notifyCarry(uint256 bookId, uint256 amount) external nonReentrant {
        address factory = config.factory();
        if (factory == address(0) || !IBookFactory(factory).isComponent(msg.sender)) {
            revert NotComponent(msg.sender);
        }
        if (amount == 0) return;
        uint256 required = buybackPending + amount;
        uint256 bal = usdc.balanceOf(address(this));
        if (bal < required) revert CarryNotReceived(required, bal);
        address backstop = config.backstop();
        if (backstop == address(0)) revert NotConfigured("backstop");

        uint256 toBuyback = amount / 2;
        uint256 toBackstop = amount - toBuyback;
        buybackPending += toBuyback;
        totalCarryReceived += amount;
        totalToBackstop += toBackstop;
        emit CarryReceived(bookId, amount, toBuyback, toBackstop);

        usdc.safeTransfer(backstop, toBackstop);
        IBackstop(backstop).notifyDeposit(toBackstop);
    }

    /// @inheritdoc IBkrnFeeRouter
    /// @dev KEEPER only. `minBkrnOut` must be non-zero (slippage protection is mandatory). The BKRN
    ///      received is measured by balance delta; any USDC the router did not pull returns to
    ///      `buybackPending`. The approval is reset to zero after the swap.
    function executeBuyback(uint256 amountIn, uint256 minBkrnOut, uint24 poolFee)
        external
        nonReentrant
        returns (uint256 bkrnOut)
    {
        if (!config.hasRole(KEEPER_ROLE, msg.sender)) revert NotKeeper(msg.sender);
        if (amountIn == 0 || minBkrnOut == 0) revert ZeroAmount();
        uint256 pending = buybackPending;
        if (amountIn > pending) revert InsufficientPending(pending, amountIn);
        address router = buybackRouter;
        if (router == address(0)) revert NotConfigured("buybackRouter");
        address staking = config.staking();
        if (staking == address(0)) revert NotConfigured("staking");

        buybackPending = pending - amountIn;

        uint256 usdcBefore = usdc.balanceOf(address(this));
        uint256 bkrnBefore = bkrn.balanceOf(address(this));
        usdc.forceApprove(router, amountIn);
        ISwapRouter02(router)
            .exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: address(usdc),
                    tokenOut: address(bkrn),
                    fee: poolFee,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: minBkrnOut,
                    sqrtPriceLimitX96: 0
                })
            );
        usdc.forceApprove(router, 0);

        uint256 usdcAfter = usdc.balanceOf(address(this));
        uint256 spent = usdcBefore > usdcAfter ? usdcBefore - usdcAfter : 0;
        // spent <= amountIn: the router's allowance is exactly amountIn.
        if (spent < amountIn) buybackPending += amountIn - spent;
        bkrnOut = bkrn.balanceOf(address(this)) - bkrnBefore;
        if (bkrnOut < minBkrnOut) revert InsufficientOutput(bkrnOut, minBkrnOut);

        totalBuybackUsdc += spent;
        totalBkrnDistributed += bkrnOut;
        emit BuybackExecuted(spent, bkrnOut);

        bkrn.safeTransfer(staking, bkrnOut);
        IBkrnStaking(staking).notifyReward(bkrnOut);
    }

    /// @notice Sets the buyback router. Config admin (timelock) only.
    function setBuybackRouter(address router) external {
        if (!config.hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        if (router == address(0)) revert ZeroAddress();
        buybackRouter = router;
        emit BuybackRouterSet(router);
    }
}
