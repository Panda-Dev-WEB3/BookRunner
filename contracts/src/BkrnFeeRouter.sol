// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAttestedOracle} from "./interfaces/IAttestedOracle.sol";
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
///         `BkrnStaking.notifyReward` (which streams it to stakers over its rewards duration).
///
///         Buyback price bound (on-chain, not keeper-chosen): the pool fee tier is pinned by the timelock
///         (`buybackPoolFee`), and every swap's `amountOutMinimum` is at least
///         `buybackFloor(amountIn) = amountIn x referenceBkrnPerUsdc() x (1 - maxSlippageBps)`. The
///         reference price is the AttestedOracle price of `bkrnPriceId` when the timelock set one (the
///         oracle service does not price BKRN today), otherwise the timelock-set `refBkrnPerUsdcWad`.
///         Each call is capped at `maxBuybackPerCall` USDC, which bounds the loss if the reference is
///         stale in the keeper's favour. A stale reference in the other direction (BKRN up) only makes
///         buybacks revert until governance updates it: fail-safe, the USDC stays in `buybackPending`.
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

    /// @notice Uniswap v3 fee tier of the buyback pool (timelock-set; 0 = buybacks not configured).
    uint24 public buybackPoolFee;
    /// @notice Max swap slippage below the reference price (bps, <= MAX_SLIPPAGE_BPS).
    uint16 public maxSlippageBps;
    /// @notice Governance reference price: whole BKRN per whole USDC (WAD). Used unless `bkrnPriceId` is set.
    uint256 public refBkrnPerUsdcWad;
    /// @notice Max USDC (6dp) per executeBuyback call.
    uint256 public maxBuybackPerCall;
    /// @notice Optional AttestedOracle price id of BKRN (USD per BKRN, WAD); 0 = use `refBkrnPerUsdcWad`.
    bytes32 public bkrnPriceId;

    /// @notice Upper bound of `maxSlippageBps` (20%).
    uint16 public constant MAX_SLIPPAGE_BPS = 2000;
    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;
    uint256 private constant USDC_UNIT = 1e6;

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
    error BuybackTooLarge(uint256 amountIn, uint256 maxPerCall);
    error BadBuybackParams();

    /// @notice Buyback router changed.
    event BuybackRouterSet(address router);
    /// @notice Buyback pool fee / reference price / slippage bound / per-call cap changed.
    event BuybackParamsSet(uint24 poolFee, uint256 refBkrnPerUsdcWad, uint16 maxSlippageBps, uint256 maxPerCall);
    /// @notice Oracle price id used as the buyback reference changed (0 = governance price).
    event BkrnPriceIdSet(bytes32 priceId);

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
    /// @dev KEEPER only, through the pinned `buybackPoolFee` tier, at most `maxBuybackPerCall`. The
    ///      swap's minimum is `max(minBkrnOut, buybackFloor(amountIn))` (the keeper may only tighten the
    ///      on-chain bound) and must be non-zero. The BKRN received is measured by balance delta; any USDC
    ///      the router did not pull returns to `buybackPending`. The approval is reset to zero after the swap.
    function executeBuyback(uint256 amountIn, uint256 minBkrnOut)
        external
        nonReentrant
        returns (uint256 bkrnOut)
    {
        if (!config.hasRole(KEEPER_ROLE, msg.sender)) revert NotKeeper(msg.sender);
        if (amountIn == 0) revert ZeroAmount();
        uint256 pending = buybackPending;
        if (amountIn > pending) revert InsufficientPending(pending, amountIn);
        address router = buybackRouter;
        if (router == address(0)) revert NotConfigured("buybackRouter");
        uint24 poolFee = buybackPoolFee;
        if (poolFee == 0) revert NotConfigured("buybackParams");
        if (amountIn > maxBuybackPerCall) revert BuybackTooLarge(amountIn, maxBuybackPerCall);
        address staking = config.staking();
        if (staking == address(0)) revert NotConfigured("staking");
        uint256 floor = buybackFloor(amountIn);
        if (minBkrnOut < floor) minBkrnOut = floor;
        if (minBkrnOut == 0) revert ZeroAmount();

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

    /// @notice Reference price: whole BKRN per whole USDC (WAD). From the AttestedOracle when `bkrnPriceId`
    ///         is set (reverts `StalePrice` when stale; USDC valued at $1), else `refBkrnPerUsdcWad`.
    function referenceBkrnPerUsdc() public view returns (uint256) {
        bytes32 id = bkrnPriceId;
        if (id == bytes32(0)) return refBkrnPerUsdcWad;
        address oracle = config.oracle();
        if (oracle == address(0)) revert NotConfigured("oracle");
        (uint256 usdPerBkrn,) = IAttestedOracle(oracle).priceOf(id);
        if (usdPerBkrn == 0) revert NotConfigured("bkrnPrice");
        return (WAD * WAD) / usdPerBkrn;
    }

    /// @notice Minimum BKRN any buyback of `amountIn` USDC must return:
    ///         `amountIn x referenceBkrnPerUsdc() x (10000 - maxSlippageBps) / 10000` (floored).
    function buybackFloor(uint256 amountIn) public view returns (uint256) {
        uint256 atRef = Math.mulDiv(amountIn, referenceBkrnPerUsdc(), USDC_UNIT);
        return Math.mulDiv(atRef, BPS - maxSlippageBps, BPS);
    }

    /// @notice Pins the buyback pool fee tier and sets the price bound. Config admin (timelock) only.
    /// @param poolFee Uniswap v3 fee tier of the deep BKRN/USDC pool (> 0; VERIFY on RHC).
    /// @param refBkrnPerUsdcWad_ Reference price, whole BKRN per whole USDC (WAD, > 0); used while
    ///        `bkrnPriceId` is unset. Must be kept near market: too high stalls buybacks (fail-safe),
    ///        too low loosens the bound (bounded by `maxPerCall`).
    /// @param maxSlippageBps_ Tolerance below the reference (<= MAX_SLIPPAGE_BPS).
    /// @param maxPerCall Max USDC (6dp) per executeBuyback (> 0).
    function setBuybackParams(uint24 poolFee, uint256 refBkrnPerUsdcWad_, uint16 maxSlippageBps_, uint256 maxPerCall)
        external
    {
        if (!config.hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        if (poolFee == 0 || refBkrnPerUsdcWad_ == 0 || maxSlippageBps_ > MAX_SLIPPAGE_BPS || maxPerCall == 0) {
            revert BadBuybackParams();
        }
        buybackPoolFee = poolFee;
        refBkrnPerUsdcWad = refBkrnPerUsdcWad_;
        maxSlippageBps = maxSlippageBps_;
        maxBuybackPerCall = maxPerCall;
        emit BuybackParamsSet(poolFee, refBkrnPerUsdcWad_, maxSlippageBps_, maxPerCall);
    }

    /// @notice Uses the AttestedOracle price `priceId` (USD per BKRN) as the buyback reference instead of
    ///         `refBkrnPerUsdcWad`; 0 reverts to the governance price. Config admin (timelock) only.
    function setBkrnPriceId(bytes32 priceId) external {
        if (!config.hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        bkrnPriceId = priceId;
        emit BkrnPriceIdSet(priceId);
    }

    /// @notice Sets the buyback router. Config admin (timelock) only.
    function setBuybackRouter(address router) external {
        if (!config.hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        if (router == address(0)) revert ZeroAddress();
        buybackRouter = router;
        emit BuybackRouterSet(router);
    }
}
