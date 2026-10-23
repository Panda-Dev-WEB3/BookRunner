// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IV4PoolManager, IV4UnlockCallback} from "../../src/interfaces/external/IUniswapV4.sol";
import {UniswapV4Lib} from "../../src/libraries/UniswapV4Lib.sol";

/// @notice Test hook surface (v4-core shapes, simplified): beforeSwap may take `specified` input (BeforeSwapDelta
///         specified part), afterSwap may take `unspecified` output (afterSwapReturnDelta), and either may revert.
interface IMockV4Hook {
    function beforeSwap(
        address sender,
        IV4PoolManager.PoolKey calldata key,
        IV4PoolManager.SwapParams calldata params,
        bytes calldata hookData
    ) external returns (int128 specified);

    function afterSwap(
        address sender,
        IV4PoolManager.PoolKey calldata key,
        IV4PoolManager.SwapParams calldata params,
        int256 delta,
        bytes calldata hookData
    ) external returns (int128 unspecified);
}

/// @notice Uniswap v4 PoolManager stand-in with the real flash accounting: `unlock` -> callback -> every delta
///         back to zero or `CurrencyNotSettled`; `swap` / `take` / `settle` only while unlocked; `sync` + transfer +
///         `settle` credits exactly what arrived; per-(target, currency) deltas and the non-zero delta count are
///         readable through `exttload` at the v4-core slots, pool slot0 through `extsload` at the v4-core
///         StateLibrary slot. Swaps are exact-input only, priced on one full-range position of liquidity `L`
///         (v4 SqrtPriceMath, static LP fee in pips), and stop at `sqrtPriceLimitX96` (partial fill). Hooks
///         (any non-zero `hooks`) are called with the v4 delta rules: callerDelta = swapDelta - hookDelta.
contract MockV4PoolManager is IV4PoolManager {
    using SafeCast for uint256;
    using SafeCast for int256;

    error ManagerLocked();
    error AlreadyUnlocked();
    error CurrencyNotSettled();
    error PoolNotInitialized();
    error PoolAlreadyInitialized();
    error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96);
    error PriceLimitOutOfBounds(uint160 sqrtPriceLimitX96);
    error SwapAmountCannotBeZero();
    error ExactOutputUnsupported();

    uint256 private constant Q96 = 1 << 96;
    bytes32 private constant NONZERO_DELTA_COUNT_SLOT = bytes32(uint256(keccak256("NonzeroDeltaCount")) - 1);

    struct Pool {
        uint160 sqrtPriceX96;
        uint128 liquidity;
    }

    bool public unlocked;
    uint256 public nonzeroDeltaCount;
    address public syncedCurrency;
    uint256 public syncedReserves;
    mapping(bytes32 id => Pool) public pools;
    mapping(bytes32 slot => int256) private _delta;
    mapping(bytes32 slot => bytes32) private _ext;
    /// @dev Test knob: extra settlement owed reported to the caller (a broken manager), 0 = faithful.
    int128 public extraOwed;

    modifier onlyUnlocked() {
        if (!unlocked) revert ManagerLocked();
        _;
    }

    // ------------------------------------------------------------------------------------------- test setup

    function initialize(PoolKey memory key, uint160 sqrtPriceX96, uint128 liquidity) external {
        bytes32 id = UniswapV4Lib.poolId(key);
        if (pools[id].sqrtPriceX96 != 0) revert PoolAlreadyInitialized();
        pools[id] = Pool(sqrtPriceX96, liquidity);
        _writeSlot0(id, sqrtPriceX96);
    }

    /// @dev Moves the pool (a trade by someone else).
    function setPrice(PoolKey memory key, uint160 sqrtPriceX96) external {
        bytes32 id = UniswapV4Lib.poolId(key);
        pools[id].sqrtPriceX96 = sqrtPriceX96;
        _writeSlot0(id, sqrtPriceX96);
    }

    function setExtraOwed(int128 v) external {
        extraOwed = v;
    }

    // ------------------------------------------------------------------------------------------- IPoolManager

    function unlock(bytes calldata data) external returns (bytes memory result) {
        if (unlocked) revert AlreadyUnlocked();
        unlocked = true;
        result = IV4UnlockCallback(msg.sender).unlockCallback(data);
        if (nonzeroDeltaCount != 0) revert CurrencyNotSettled();
        unlocked = false;
    }

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        onlyUnlocked
        returns (int256)
    {
        int128 hookSpecified;
        if (key.hooks != address(0)) hookSpecified = IMockV4Hook(key.hooks).beforeSwap(msg.sender, key, params, hookData);
        (int128 input, int128 output) = _core(key, params, uint256(-(params.amountSpecified + hookSpecified)));
        int256 swapDelta = params.zeroForOne ? _pack(input, output) : _pack(output, input);

        int128 hookUnspecified;
        if (key.hooks != address(0)) {
            hookUnspecified = IMockV4Hook(key.hooks).afterSwap(msg.sender, key, params, swapDelta, hookData);
        }
        // hookDelta in (specified = input, unspecified = output) terms; callerDelta = swapDelta - hookDelta
        int128 callerIn = input - hookSpecified - extraOwed;
        int128 callerOut = output - hookUnspecified;
        (address cIn, address cOut) = params.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        _account(cIn, msg.sender, callerIn);
        _account(cOut, msg.sender, callerOut);
        if (key.hooks != address(0)) {
            _account(cIn, key.hooks, hookSpecified);
            _account(cOut, key.hooks, hookUnspecified);
        }
        return params.zeroForOne ? _pack(callerIn, callerOut) : _pack(callerOut, callerIn);
    }

    /// @dev Checks, prices and moves the pool; swapDelta sides (input -used, output +out, caller's view).
    function _core(PoolKey memory key, SwapParams memory params, uint256 toSwap)
        private
        returns (int128 input, int128 output)
    {
        bytes32 id = UniswapV4Lib.poolId(key);
        Pool storage p = pools[id];
        uint160 sqrtP = p.sqrtPriceX96;
        if (sqrtP == 0) revert PoolNotInitialized();
        if (params.amountSpecified == 0) revert SwapAmountCannotBeZero();
        if (params.amountSpecified > 0) revert ExactOutputUnsupported();
        _checkLimit(sqrtP, params);
        (uint256 used, uint256 out, uint160 next) = _swapMath(p, sqrtP, toSwap, key.fee, params);
        p.sqrtPriceX96 = next;
        _writeSlot0(id, next);
        input = -used.toInt256().toInt128();
        output = out.toInt256().toInt128();
    }

    function sync(address currency) external {
        syncedCurrency = currency;
        syncedReserves = currency == address(0) ? 0 : IERC20(currency).balanceOf(address(this));
    }

    function settle() external payable onlyUnlocked returns (uint256 paid) {
        address c = syncedCurrency;
        if (c == address(0)) {
            paid = msg.value;
        } else {
            require(msg.value == 0, "NonzeroNativeValue");
            paid = IERC20(c).balanceOf(address(this)) - syncedReserves;
            syncedCurrency = address(0);
        }
        _account(c, msg.sender, paid.toInt256().toInt128());
    }

    function take(address currency, address to, uint256 amount) external onlyUnlocked {
        _account(currency, msg.sender, -amount.toInt256().toInt128());
        if (currency == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "take native");
        } else {
            require(IERC20(currency).transfer(to, amount), "take");
        }
    }

    /// @dev Native ETH reserves (pool liquidity in tests).
    receive() external payable {}

    function extsload(bytes32 slot) external view returns (bytes32) {
        return _ext[slot];
    }

    function exttload(bytes32 slot) external view returns (bytes32) {
        if (slot == NONZERO_DELTA_COUNT_SLOT) return bytes32(nonzeroDeltaCount);
        return bytes32(uint256(_delta[slot]));
    }

    function currencyDelta(address target, address currency) external view returns (int256) {
        return _delta[UniswapV4Lib.deltaSlot(target, currency)];
    }

    // ------------------------------------------------------------------------------------------- internals

    function _checkLimit(uint160 sqrtP, SwapParams memory params) private pure {
        uint160 limit = params.sqrtPriceLimitX96;
        if (params.zeroForOne) {
            if (limit >= sqrtP) revert PriceLimitAlreadyExceeded(sqrtP, limit);
            if (limit <= UniswapV4Lib.MIN_SQRT_PRICE) revert PriceLimitOutOfBounds(limit);
        } else {
            if (limit <= sqrtP) revert PriceLimitAlreadyExceeded(sqrtP, limit);
            if (limit >= UniswapV4Lib.MAX_SQRT_PRICE) revert PriceLimitOutOfBounds(limit);
        }
    }

    /// @dev One range of liquidity L: v4 SqrtPriceMath (input rounded up, output rounded down).
    function _swapMath(Pool storage p, uint160 sqrtP, uint256 amountIn, uint24 fee, SwapParams memory params)
        private
        view
        returns (uint256 used, uint256 out, uint160 next)
    {
        uint256 lessFee = Math.mulDiv(amountIn, 1e6 - fee, 1e6);
        uint256 need;
        uint256 n;
        (n, need, out) = params.zeroForOne
            ? _down(p.liquidity, sqrtP, lessFee, params.sqrtPriceLimitX96)
            : _up(p.liquidity, sqrtP, lessFee, params.sqrtPriceLimitX96);
        used = need == 0 ? amountIn : Math.mulDiv(need, 1e6, 1e6 - fee, Math.Rounding.Ceil);
        if (used > amountIn) used = amountIn;
        next = uint160(n);
    }

    /// @dev zeroForOne: (next price, input needed when the limit binds (0 = all used), output).
    function _down(uint256 l, uint256 sqrtP, uint256 lessFee, uint256 limit)
        private
        pure
        returns (uint256 n, uint256 need, uint256 out)
    {
        uint256 num = l << 96;
        n = Math.mulDiv(num, sqrtP, num + lessFee * sqrtP, Math.Rounding.Ceil);
        if (n < limit) {
            n = limit;
            need = Math.mulDiv(Math.mulDiv(num, sqrtP - n, sqrtP, Math.Rounding.Ceil), 1, n, Math.Rounding.Ceil);
        }
        out = Math.mulDiv(l, sqrtP - n, Q96);
    }

    /// @dev oneForZero: (next price, input needed when the limit binds (0 = all used), output).
    function _up(uint256 l, uint256 sqrtP, uint256 lessFee, uint256 limit)
        private
        pure
        returns (uint256 n, uint256 need, uint256 out)
    {
        n = sqrtP + Math.mulDiv(lessFee, Q96, l);
        if (n > limit) {
            n = limit;
            need = Math.mulDiv(l, n - sqrtP, Q96, Math.Rounding.Ceil);
        }
        out = Math.mulDiv(Math.mulDiv(l << 96, n - sqrtP, n), 1, sqrtP);
    }

    function _account(address currency, address target, int128 d) private {
        if (d == 0) return;
        bytes32 slot = UniswapV4Lib.deltaSlot(target, currency);
        int256 prev = _delta[slot];
        int256 nxt = prev + d;
        if (prev == 0) ++nonzeroDeltaCount;
        else if (nxt == 0) --nonzeroDeltaCount;
        _delta[slot] = nxt;
    }

    function _writeSlot0(bytes32 id, uint160 sqrtPriceX96) private {
        _ext[keccak256(abi.encodePacked(id, UniswapV4Lib.POOLS_SLOT))] = bytes32(uint256(sqrtPriceX96));
    }

    function _pack(int128 a0, int128 a1) private pure returns (int256) {
        return (int256(a0) << 128) | int256(uint256(uint128(a1)));
    }
}

/// @notice Hook that takes `inBps` of the input (beforeSwap specified delta) and `outBps` of the output
///         (afterSwapReturnDelta), collecting both with `take` like a fee-taking launchpad hook; or reverts.
contract MockV4Hook is IMockV4Hook {
    IV4PoolManager public immutable manager;
    uint256 public inBps;
    uint256 public outBps;
    bool public revertSwaps;

    error HookRevert();

    constructor(IV4PoolManager manager_) {
        manager = manager_;
    }

    /// @dev Native ETH fees (`take` of currency 0).
    receive() external payable {}

    function configure(uint256 inBps_, uint256 outBps_, bool revertSwaps_) external {
        (inBps, outBps, revertSwaps) = (inBps_, outBps_, revertSwaps_);
    }

    function beforeSwap(address, IV4PoolManager.PoolKey calldata, IV4PoolManager.SwapParams calldata params, bytes calldata)
        external
        view
        returns (int128)
    {
        if (revertSwaps) revert HookRevert();
        return int128(int256(uint256(-params.amountSpecified) * inBps / 10_000));
    }

    function afterSwap(
        address,
        IV4PoolManager.PoolKey calldata key,
        IV4PoolManager.SwapParams calldata params,
        int256 delta,
        bytes calldata
    ) external returns (int128) {
        (int128 a0, int128 a1) = UniswapV4Lib.split(delta);
        (address cIn, address cOut) = params.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        uint256 feeIn = uint256(-params.amountSpecified) * inBps / 10_000;
        uint256 out = uint256(uint128(params.zeroForOne ? a1 : a0));
        uint256 feeOut = out * outBps / 10_000;
        if (feeIn > 0) manager.take(cIn, address(this), feeIn);
        if (feeOut > 0) manager.take(cOut, address(this), feeOut);
        return int128(int256(feeOut));
    }
}

/// @notice WETH9 stand-in: `withdraw` pays with `transfer` (the 2300-gas stipend of WETH9).
contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        payable(msg.sender).transfer(amount);
    }
}
