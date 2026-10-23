// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {TransientSlot} from "@openzeppelin/contracts/utils/TransientSlot.sol";
import {IBkrnV4Swapper} from "./interfaces/IBkrnV4Swapper.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {ISwapRouter02} from "./interfaces/external/ISwapRouter02.sol";
import {IV4PoolManager, IV4UnlockCallback} from "./interfaces/external/IUniswapV4.sol";
import {IWETH9} from "./interfaces/external/IWETH9.sol";
import {UniswapV4Lib} from "./libraries/UniswapV4Lib.sol";

/// @title BkrnV4Swapper — the BKRN buyback's Uniswap v4 executor (no router), created by and bound to one
///        BkrnFeeRouter.
/// @notice `swap` (fee router only) calls `manager.unlock`; the PoolManager calls back `unlockCallback` (only that
///         manager, only during this swap) which runs the route exact-input: each v4 hop is a `swap` with its
///         price limit, the settlement token owed is paid straight from the fee router (`sync` + `transferFrom` +
///         `settle`; the fee router grants exactly `amountIn` and resets it), the BKRN is `take`n to the fee
///         router. Via ETH the intermediate is consumed in full by the BKRN hop (a partial BKRN hop reverts:
///         nothing is left half-swapped); ROUTE_V4_ETH never moves ETH (the hop deltas cancel), ROUTE_V3_WETH
///         unwraps the v3 WETH output and settles it with `settle{value:}`. Every delta of this contract
///         (settlement token, BKRN, native ETH) must be closed and its ETH balance unchanged when the callback
///         returns, else the unlock reverts. Holds nothing between calls; the price checks and the floor live in
///         BkrnFeeRouter.
contract BkrnV4Swapper is IBkrnV4Swapper, IV4UnlockCallback {
    using SafeERC20 for IERC20;
    using TransientSlot for *;

    uint8 internal constant ROUTE_DIRECT = 0;
    uint8 internal constant ROUTE_V4_ETH = 1;
    uint8 internal constant ROUTE_V3_WETH = 2;
    address private constant NATIVE = address(0);
    bytes32 private constant DEFAULT_ADMIN_ROLE = 0x00;
    /// @dev Transient: the PoolManager of the swap in progress (0 = none).
    bytes32 private constant MANAGER_SLOT = bytes32(uint256(keccak256("bookrunner.BkrnV4Swapper.manager")) - 1);
    /// @dev Transient: set until the (single) callback of the swap in progress has started.
    bytes32 private constant PENDING_SLOT = bytes32(uint256(keccak256("bookrunner.BkrnV4Swapper.pending")) - 1);
    /// @dev Transient: the WETH that may send native ETH during the callback (ROUTE_V3_WETH unwrap).
    bytes32 private constant WETH_SLOT = bytes32(uint256(keccak256("bookrunner.BkrnV4Swapper.weth")) - 1);

    /// @notice The BkrnFeeRouter that created this swapper (the only caller of `swap`).
    address public immutable feeRouter;
    IBookrunnerConfig public immutable config;
    IERC20 public immutable usdc;
    IERC20 public immutable bkrn;

    error NotFeeRouter(address caller);
    error NotAdmin(address caller);
    error ZeroAddress();
    /// @notice unlockCallback from anything but the PoolManager of the swap in progress, or a second callback.
    error NotPoolManager(address caller);
    error Busy();
    /// @notice A hop's deltas are not those of an exact-input swap of at most its input.
    error V4BadDelta(int128 inDelta, int128 outDelta);
    /// @notice A delta of this contract is open, ETH is left, or a settle paid a different amount.
    error V4DeltaNotSettled();
    /// @notice The ETH -> BKRN hop did not consume all the ETH of the first hop.
    error V4HopPartialFill(uint256 ethIn, uint256 used);
    /// @notice Native ETH from anything but WETH / the PoolManager, or outside a swap.
    error UnexpectedEth(address from);

    /// @notice Native ETH forced in outside a swap was swept out.
    event NativeSwept(address indexed to, uint256 amount);

    constructor(address config_, address usdc_, address bkrn_) {
        feeRouter = msg.sender;
        config = IBookrunnerConfig(config_);
        usdc = IERC20(usdc_);
        bkrn = IERC20(bkrn_);
    }

    /// @inheritdoc IBkrnV4Swapper
    function swap(address manager, V4Job calldata job) external returns (uint256 paid, uint256 bkrnOut) {
        if (msg.sender != feeRouter) revert NotFeeRouter(msg.sender);
        if (MANAGER_SLOT.asAddress().tload() != address(0)) revert Busy();
        MANAGER_SLOT.asAddress().tstore(manager);
        PENDING_SLOT.asBoolean().tstore(true);
        bytes memory ret = IV4PoolManager(manager).unlock(abi.encode(job));
        MANAGER_SLOT.asAddress().tstore(address(0));
        PENDING_SLOT.asBoolean().tstore(false);
        (paid, bkrnOut) = abi.decode(ret, (uint256, uint256));
    }

    /// @notice Uniswap v4 PoolManager callback (see the contract notice).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        address m = MANAGER_SLOT.asAddress().tload();
        if (m == address(0) || msg.sender != m || !PENDING_SLOT.asBoolean().tload()) revert NotPoolManager(msg.sender);
        PENDING_SLOT.asBoolean().tstore(false);
        V4Job memory job = abi.decode(data, (V4Job));
        uint256 ethBefore = address(this).balance;
        address u = address(usdc);
        uint256 paid;
        uint256 out;
        if (job.route.kind == ROUTE_DIRECT) {
            (paid, out) = _hop(m, job.route.bkrnPool, u, job.amountIn, job.limit0);
            _settleFromRouter(m, paid);
        } else {
            uint256 ethIn;
            if (job.route.kind == ROUTE_V4_ETH) {
                (paid, ethIn) = _hop(m, job.route.ethPool, u, job.amountIn, job.limit0);
                _settleFromRouter(m, paid);
            } else {
                (paid, ethIn) = _v3WethHop(job);
            }
            (uint256 used, uint256 o) = _hop(m, job.route.bkrnPool, NATIVE, ethIn, job.limit1);
            if (used != ethIn) revert V4HopPartialFill(ethIn, used);
            out = o;
            // ROUTE_V4_ETH: hop 0's ETH credit (+ethIn) is closed by hop 1 (-ethIn); nothing moves
            if (job.route.kind == ROUTE_V3_WETH) {
                // sync is global: reset it to native so a hook's sync(token) during hop 1 cannot turn this native
                // settle into an ERC-20 one (review I-1)
                IV4PoolManager(m).sync(NATIVE);
                if (IV4PoolManager(m).settle{value: ethIn}() != ethIn) revert V4DeltaNotSettled();
            }
        }
        if (out > 0) IV4PoolManager(m).take(address(bkrn), feeRouter, out);
        if (_open(m, u) || _open(m, address(bkrn)) || _open(m, NATIVE) || address(this).balance != ethBefore) {
            revert V4DeltaNotSettled();
        }
        return abi.encode(paid, out);
    }

    /// @dev One exact-input v4 swap of `amountIn` `currencyIn` along `key`, stopping at `limit`; returns (input owed,
    ///      output credited) and refuses deltas that are not those of an exact-input swap.
    function _hop(address m, IV4PoolManager.PoolKey memory key, address currencyIn, uint256 amountIn, uint160 limit)
        private
        returns (uint256 owed, uint256 out)
    {
        bool zfo = key.currency0 == currencyIn;
        int256 delta = IV4PoolManager(m)
            .swap(
                key,
                IV4PoolManager.SwapParams({
                    zeroForOne: zfo, amountSpecified: -SafeCast.toInt256(amountIn), sqrtPriceLimitX96: limit
                }),
                ""
            );
        (int128 a0, int128 a1) = UniswapV4Lib.split(delta);
        (int128 dIn, int128 dOut) = zfo ? (a0, a1) : (a1, a0);
        if (dIn > 0 || dOut < 0 || uint256(uint128(-dIn)) > amountIn) revert V4BadDelta(dIn, dOut);
        owed = uint256(uint128(-dIn));
        out = uint256(uint128(dOut));
    }

    /// @dev Pays `amount` settlement token owed to the PoolManager straight from the fee router.
    function _settleFromRouter(address m, uint256 amount) private {
        if (amount == 0) return;
        IV4PoolManager(m).sync(address(usdc));
        usdc.safeTransferFrom(feeRouter, m, amount);
        if (IV4PoolManager(m).settle() != amount) revert V4DeltaNotSettled();
    }

    /// @dev ROUTE_V3_WETH hop 0: pulls `amountIn` from the fee router, swaps it to WETH through the v3 router (tier
    ///      `v3Fee`, price limit `limit0`, exact approval reset after), returns any unspent settlement token to the
    ///      fee router and unwraps the WETH for the v4 BKRN hop.
    function _v3WethHop(V4Job memory job) private returns (uint256 paid, uint256 ethOut) {
        IERC20 weth = IERC20(job.route.weth);
        uint256 wBefore = weth.balanceOf(address(this));
        uint256 uBefore = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(feeRouter, address(this), job.amountIn);
        usdc.forceApprove(job.v3Router, job.amountIn);
        ISwapRouter02(job.v3Router)
            .exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: address(usdc),
                    tokenOut: address(weth),
                    fee: job.route.v3Fee,
                    recipient: address(this),
                    amountIn: job.amountIn,
                    amountOutMinimum: 1,
                    sqrtPriceLimitX96: job.limit0
                })
            );
        usdc.forceApprove(job.v3Router, 0);
        uint256 left = usdc.balanceOf(address(this)) - uBefore;
        paid = job.amountIn - left;
        if (left > 0) usdc.safeTransfer(feeRouter, left);
        ethOut = weth.balanceOf(address(this)) - wBefore;
        WETH_SLOT.asAddress().tstore(address(weth));
        IWETH9(address(weth)).withdraw(ethOut);
        WETH_SLOT.asAddress().tstore(address(0));
    }

    function _open(address m, address currency) private view returns (bool) {
        return IV4PoolManager(m).exttload(UniswapV4Lib.deltaSlot(address(this), currency)) != 0;
    }

    /// @dev Native ETH only from the unwrapping WETH or the swap's PoolManager, and only during a swap (cheap:
    ///      transient reads only, so a 2300-gas `transfer` from WETH9 succeeds).
    receive() external payable {
        address m = MANAGER_SLOT.asAddress().tload();
        if (m == address(0) || (msg.sender != m && msg.sender != WETH_SLOT.asAddress().tload())) {
            revert UnexpectedEth(msg.sender);
        }
    }

    /// @notice Sends native ETH forced in outside a swap (selfdestruct / coinbase; a swap never leaves any) to `to`.
    ///         Config admin (timelock) only.
    function sweepNative(address payable to) external {
        if (!config.hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = address(this).balance;
        emit NativeSwept(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert UnexpectedEth(to);
    }
}
