// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IHedgeExecutor} from "./interfaces/IHedgeExecutor.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {IBookFactory} from "./interfaces/IBookFactory.sol";
import {IBookrunnerDesk} from "./interfaces/IBookrunnerDesk.sol";
import {ISwapRouter02} from "./interfaces/external/ISwapRouter02.sol";

/// @title HedgeExecutor — executes long-spot hedge legs (USDC <-> canonical Stock Token) for book desks.
/// @notice Only a factory-registered BookrunnerDesk may call {swapExactIn}; the desk itself enforces the
///         mandate (allow-list, band, float caps, long-only) around the call. The executor holds no
///         balances between calls: it pulls `amountIn` from the desk, swaps, delivers `tokenOut` straight
///         to `recipient` and refunds any unspent input.
///         Venues: "UNIV3" -> Uniswap v3 SwapRouter02 `exactInputSingle`. "UNIV4" reverts NotConfigured
///         until a router is set; a UNIV4 router must expose the same `exactInputSingle` surface
///         (a thin v4 / UniversalRouter adapter) — VERIFY v4 router + Stock Token pools on RHC.
/// @dev Non-upgradeable. Routers per venue settable only by `config.timelock()`.
contract HedgeExecutor is IHedgeExecutor, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes32 public constant VENUE_UNIV3 = "UNIV3";
    bytes32 public constant VENUE_UNIV4 = "UNIV4";

    IBookrunnerConfig public immutable config;
    mapping(bytes32 venue => address router) internal _routers;

    error ZeroAddress();
    error ZeroAmount();
    error SameToken();
    error BadVenue();
    error NotConfigured(bytes32 venue);
    error NotDesk(address caller);
    error Unauthorized(address caller);
    error InsufficientOutput(uint256 amountOut, uint256 minAmountOut);

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

    /// @param config_ BookrunnerConfig (timelock + factory).
    /// @param univ3Router Initial Uniswap v3 SwapRouter02 (VERIFY on RHC; devnet MockSwapRouter); may be 0.
    constructor(address config_, address univ3Router) {
        if (config_ == address(0)) revert ZeroAddress();
        config = IBookrunnerConfig(config_);
        if (univ3Router != address(0)) {
            _routers[VENUE_UNIV3] = univ3Router;
            emit RouterSet(VENUE_UNIV3, univ3Router);
        }
    }

    /// @notice Timelock: set (or clear with address(0)) the router used for `venue`.
    function setRouter(bytes32 venue, address router) external {
        if (msg.sender != config.timelock()) revert Unauthorized(msg.sender);
        if (venue == bytes32(0)) revert BadVenue();
        _routers[venue] = router;
        emit RouterSet(venue, router);
    }

    /// @inheritdoc IHedgeExecutor
    function routerOf(bytes32 venue) external view override returns (address) {
        return _routers[venue];
    }

    /// @inheritdoc IHedgeExecutor
    /// @dev Caller must be the registered desk of a factory book. Returns the amount of `tokenOut`
    ///      actually received by `recipient` (balance delta), which must be >= `minAmountOut`.
    function swapExactIn(
        bytes32 venue,
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external override nonReentrant returns (uint256 amountOut) {
        _requireDesk(msg.sender);
        address router = _routers[venue];
        if (router == address(0)) revert NotConfigured(venue);
        if (amountIn == 0) revert ZeroAmount();
        if (tokenIn == address(0) || tokenOut == address(0) || recipient == address(0)) revert ZeroAddress();
        if (tokenIn == tokenOut) revert SameToken();

        IERC20 tin = IERC20(tokenIn);
        uint256 inBefore = tin.balanceOf(address(this));
        tin.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 received = tin.balanceOf(address(this)) - inBefore;

        amountOut = _routeExactIn(
            router,
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: poolFee,
                recipient: recipient,
                amountIn: received,
                amountOutMinimum: minAmountOut,
                sqrtPriceLimitX96: 0
            })
        );

        uint256 leftover = tin.balanceOf(address(this)) - inBefore;
        if (leftover != 0) tin.safeTransfer(msg.sender, leftover);
        emit Swapped(msg.sender, venue, tokenIn, tokenOut, received - leftover, amountOut, recipient);
    }

    /// @dev Exact approval, router call, approval reset; output measured as the recipient's balance delta.
    function _routeExactIn(address router, ISwapRouter02.ExactInputSingleParams memory p)
        internal
        returns (uint256 amountOut)
    {
        IERC20 tin = IERC20(p.tokenIn);
        IERC20 tout = IERC20(p.tokenOut);
        uint256 outBefore = tout.balanceOf(p.recipient);
        tin.forceApprove(router, p.amountIn);
        ISwapRouter02(router).exactInputSingle(p);
        if (tin.allowance(address(this), router) != 0) tin.forceApprove(router, 0);
        amountOut = tout.balanceOf(p.recipient) - outBefore;
        if (amountOut < p.amountOutMinimum) revert InsufficientOutput(amountOut, p.amountOutMinimum);
    }

    /// @dev `caller` must be a factory component AND the desk of the book it claims to belong to.
    function _requireDesk(address caller) internal view {
        if (caller.code.length == 0) revert NotDesk(caller);
        IBookFactory f = IBookFactory(config.factory());
        if (!f.isComponent(caller)) revert NotDesk(caller);
        address b;
        try IBookrunnerDesk(caller).book() returns (address b_) {
            b = b_;
        } catch {
            revert NotDesk(caller);
        }
        if (b == address(0) || !f.isBook(b) || f.componentsOf(f.bookIdOf(b)).desk != caller) {
            revert NotDesk(caller);
        }
    }
}
