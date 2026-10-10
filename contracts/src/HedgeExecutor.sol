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
import {IUniswapV3Factory} from "./interfaces/external/IUniswapV3.sol";

/// @title HedgeExecutor — executes long-spot hedge legs (settlement token <-> canonical Stock Token) for
///        book desks.
/// @notice Only a factory-registered BookrunnerDesk may call {swapExactIn}; the desk itself enforces the
///         mandate (allow-list, band, float caps, long-only) and the oracle-referenced slippage bound
///         (`maxSlippageBps` per swap + per-mark-period budget, measured on the oracle value of what was
///         given vs received) around the call. The executor holds no balances between calls: it pulls
///         `amountIn` from the desk, swaps, delivers `tokenOut` straight to `recipient` and refunds any
///         unspent input.
///
///         Routes (governance, not key-chosen): every swap is one side the settlement token
///         (`config.usdc()`: USDG on Robinhood Chain) and the other a Stock Token, and goes through the
///         timelock-set route of that Stock Token for the venue: a direct pool (`fee`) or a two-pool path
///         through `hop` (e.g. WETH, `fee` on the settlement/hop pool, `hopFee` on the hop/asset pool).
///         A desk/key may pass `poolFee = 0` (use the route) or the route's `fee`; anything else reverts,
///         so a bookrunner key can never pick a thin or manipulated pool. No route => the swap reverts.
///
///         Venues: "UNIV3" -> Uniswap v3 SwapRouter02 `exactInputSingle` (direct) / `exactInput` (hop).
///         "UNIV4" reverts NotConfigured until a router is set; a UNIV4 router must expose the same
///         SwapRouter02 surface (a thin v4 / UniversalRouter adapter) — docs/VERIFY.md U3.
/// @dev Non-upgradeable (redeploy + `config.setAddress("hedgeExecutor", ..)` through the timelock).
///      Routers, routes and the pool factory are settable only by `config.timelock()`.
contract HedgeExecutor is IHedgeExecutor, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes32 public constant VENUE_UNIV3 = "UNIV3";
    bytes32 public constant VENUE_UNIV4 = "UNIV4";
    /// @notice Uniswap v3 fees are < 1,000,000 (hundredths of a bip).
    uint24 public constant MAX_POOL_FEE = 999_999;

    /// @notice Governance route of one Stock Token on one venue (see contract notice).
    struct Route {
        uint24 fee; // settlement/asset pool fee (direct) or settlement/hop pool fee; 0 = no route
        address hop; // address(0) = direct pool
        uint24 hopFee; // hop/asset pool fee (hop routes only)
    }

    IBookrunnerConfig public immutable config;
    mapping(bytes32 venue => address router) internal _routers;
    mapping(bytes32 venue => mapping(address asset => Route)) internal _routes;
    /// @notice Optional Uniswap v3 factory: when set, `setRoute` on UNIV3 requires every pool of the
    ///         route to exist (`getPool != 0`). VERIFY U1 (`0x1f7d...2efa` on RHC).
    address public v3Factory;

    error ZeroAddress();
    error ZeroAmount();
    error SameToken();
    error BadVenue();
    error NotConfigured(bytes32 venue);
    error NotDesk(address caller);
    error Unauthorized(address caller);
    error InsufficientOutput(uint256 amountOut, uint256 minAmountOut);
    error NotSettlementPair(address tokenIn, address tokenOut);
    error RouteNotSet(bytes32 venue, address asset);
    error PoolFeeMismatch(uint24 requested, uint24 route);
    error BadRoute();
    error PoolNotFound(address tokenA, address tokenB, uint24 fee);

    event RouterSet(bytes32 indexed venue, address router);
    event RouteSet(bytes32 indexed venue, address indexed asset, uint24 fee, address hop, uint24 hopFee);
    event V3FactorySet(address factory);
    event Swapped(
        address indexed desk,
        bytes32 indexed venue,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    );

    /// @param config_ BookrunnerConfig (timelock + factory + settlement token).
    /// @param univ3Router Initial Uniswap v3 SwapRouter02 (VERIFY on RHC; devnet MockSwapRouter); may be 0.
    constructor(address config_, address univ3Router) {
        if (config_ == address(0)) revert ZeroAddress();
        config = IBookrunnerConfig(config_);
        if (univ3Router != address(0)) {
            _routers[VENUE_UNIV3] = univ3Router;
            emit RouterSet(VENUE_UNIV3, univ3Router);
        }
    }

    modifier onlyTimelock() {
        if (msg.sender != config.timelock()) revert Unauthorized(msg.sender);
        _;
    }

    // ------------------------------------------------------------------ governance

    /// @notice Timelock: set (or clear with address(0)) the router used for `venue`.
    function setRouter(bytes32 venue, address router) external onlyTimelock {
        if (venue == bytes32(0)) revert BadVenue();
        _routers[venue] = router;
        emit RouterSet(venue, router);
    }

    /// @notice Timelock: set (or clear with address(0)) the Uniswap v3 factory used to check routes.
    function setV3Factory(address factory_) external onlyTimelock {
        v3Factory = factory_;
        emit V3FactorySet(factory_);
    }

    /// @notice Timelock: route of Stock Token `asset` on `venue`. `fee == 0` clears the route.
    /// @param fee Settlement/asset pool fee (direct) or settlement/hop pool fee (`hop != 0`).
    /// @param hop Intermediate token of a two-pool route (e.g. WETH), or address(0) for a direct pool.
    /// @param hopFee Hop/asset pool fee (must be 0 for a direct route, > 0 for a hop route).
    function setRoute(bytes32 venue, address asset, uint24 fee, address hop, uint24 hopFee)
        external
        onlyTimelock
    {
        if (venue == bytes32(0)) revert BadVenue();
        if (asset == address(0)) revert ZeroAddress();
        if (fee == 0) {
            if (hop != address(0) || hopFee != 0) revert BadRoute();
            delete _routes[venue][asset];
            emit RouteSet(venue, asset, 0, address(0), 0);
            return;
        }
        address settlement = config.usdc();
        if (settlement == address(0)) revert NotConfigured("usdc");
        if (asset == settlement || fee > MAX_POOL_FEE) revert BadRoute();
        if (hop == address(0) ? hopFee != 0 : (hopFee == 0 || hopFee > MAX_POOL_FEE || hop == asset || hop == settlement)) {
            revert BadRoute();
        }
        address f = v3Factory;
        if (venue == VENUE_UNIV3 && f != address(0)) {
            if (hop == address(0)) {
                _requirePool(f, settlement, asset, fee);
            } else {
                _requirePool(f, settlement, hop, fee);
                _requirePool(f, hop, asset, hopFee);
            }
        }
        _routes[venue][asset] = Route({fee: fee, hop: hop, hopFee: hopFee});
        emit RouteSet(venue, asset, fee, hop, hopFee);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IHedgeExecutor
    function routerOf(bytes32 venue) external view override returns (address) {
        return _routers[venue];
    }

    /// @inheritdoc IHedgeExecutor
    function routeOf(bytes32 venue, address asset)
        external
        view
        override
        returns (uint24 fee, address hop, uint24 hopFee)
    {
        Route memory r = _routes[venue][asset];
        return (r.fee, r.hop, r.hopFee);
    }

    /// @notice Packed Uniswap v3 path the executor would use for `tokenIn -> tokenOut` on `venue` (empty
    ///         for a direct route or no route). For off-chain quoting (QuoterV2.quoteExactInput).
    function pathOf(bytes32 venue, address tokenIn, address tokenOut) external view returns (bytes memory) {
        (Route memory r, bool buy) = _resolve(venue, tokenIn, tokenOut);
        if (r.hop == address(0)) return "";
        return _path(r, tokenIn, tokenOut, buy);
    }

    // ------------------------------------------------------------------ swaps

    /// @inheritdoc IHedgeExecutor
    /// @dev Caller must be the registered desk of a factory book. `poolFee` must be 0 or the route's
    ///      `fee`. Returns the amount of `tokenOut` actually received by `recipient` (balance delta), which
    ///      must be >= `minAmountOut`.
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
        (Route memory r, bool buy) = _resolve(venue, tokenIn, tokenOut);
        if (r.fee == 0) revert RouteNotSet(venue, buy ? tokenOut : tokenIn);
        if (poolFee != 0 && poolFee != r.fee) revert PoolFeeMismatch(poolFee, r.fee);

        amountOut = _pullRouteRefund(
            venue,
            amountIn,
            Leg({
                router: router,
                route: r,
                buy: buy,
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                amountIn: 0,
                minAmountOut: minAmountOut,
                recipient: recipient
            })
        );
    }

    /// @dev Pulls `amountIn` from the desk (amount actually received is swapped), routes, refunds any
    ///      unspent input to the desk.
    function _pullRouteRefund(bytes32 venue, uint256 amountIn, Leg memory l) internal returns (uint256 amountOut) {
        IERC20 tin = IERC20(l.tokenIn);
        uint256 inBefore = tin.balanceOf(address(this));
        tin.safeTransferFrom(msg.sender, address(this), amountIn);
        l.amountIn = tin.balanceOf(address(this)) - inBefore;

        amountOut = _routeExactIn(l);

        uint256 leftover = tin.balanceOf(address(this)) - inBefore;
        if (leftover != 0) tin.safeTransfer(msg.sender, leftover);
        emit Swapped(msg.sender, venue, l.tokenIn, l.tokenOut, l.amountIn - leftover, amountOut, l.recipient);
    }

    /// @dev One routed swap (memory-packed to keep the stack shallow).
    struct Leg {
        address router;
        Route route;
        bool buy;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        address recipient;
    }

    /// @dev Exact approval, router call, approval reset; output measured as the recipient's balance delta.
    function _routeExactIn(Leg memory l) internal returns (uint256 amountOut) {
        IERC20 tin = IERC20(l.tokenIn);
        IERC20 tout = IERC20(l.tokenOut);
        uint256 outBefore = tout.balanceOf(l.recipient);
        tin.forceApprove(l.router, l.amountIn);
        if (l.route.hop == address(0)) {
            ISwapRouter02(l.router)
                .exactInputSingle(
                    ISwapRouter02.ExactInputSingleParams({
                        tokenIn: l.tokenIn,
                        tokenOut: l.tokenOut,
                        fee: l.route.fee,
                        recipient: l.recipient,
                        amountIn: l.amountIn,
                        amountOutMinimum: l.minAmountOut,
                        sqrtPriceLimitX96: 0
                    })
                );
        } else {
            ISwapRouter02(l.router)
                .exactInput(
                    ISwapRouter02.ExactInputParams({
                        path: _path(l.route, l.tokenIn, l.tokenOut, l.buy),
                        recipient: l.recipient,
                        amountIn: l.amountIn,
                        amountOutMinimum: l.minAmountOut
                    })
                );
        }
        if (tin.allowance(address(this), l.router) != 0) tin.forceApprove(l.router, 0);
        amountOut = tout.balanceOf(l.recipient) - outBefore;
        if (amountOut < l.minAmountOut) revert InsufficientOutput(amountOut, l.minAmountOut);
    }

    /// @dev Route of the Stock Token side of a settlement-token pair; `buy` = settlement token in.
    function _resolve(bytes32 venue, address tokenIn, address tokenOut)
        internal
        view
        returns (Route memory r, bool buy)
    {
        address settlement = config.usdc();
        if (tokenIn == settlement) buy = true;
        else if (tokenOut != settlement) revert NotSettlementPair(tokenIn, tokenOut);
        r = _routes[venue][buy ? tokenOut : tokenIn];
    }

    /// @dev settlement -fee-> hop -hopFee-> asset (buy), reversed for a sell.
    function _path(Route memory r, address tokenIn, address tokenOut, bool buy)
        internal
        pure
        returns (bytes memory)
    {
        return buy
            ? abi.encodePacked(tokenIn, r.fee, r.hop, r.hopFee, tokenOut)
            : abi.encodePacked(tokenIn, r.hopFee, r.hop, r.fee, tokenOut);
    }

    function _requirePool(address f, address a, address b, uint24 fee) internal view {
        if (IUniswapV3Factory(f).getPool(a, b, fee) == address(0)) revert PoolNotFound(a, b, fee);
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
