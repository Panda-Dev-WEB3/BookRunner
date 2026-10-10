// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapRouter02} from "../../src/interfaces/external/ISwapRouter02.sol";
import {IUniswapV3PoolView, IUniswapV3Factory} from "../../src/interfaces/external/IUniswapV3.sol";
import {UniswapV3Twap} from "../../src/libraries/UniswapV3Twap.sol";

/// @title UniV3MockPool — a Uniswap v3 pool stand-in that behaves like the real one where the protocol
///        depends on it: sorted token0/token1, fee tier, `slot0` / `liquidity` / `observe` (tick
///        cumulatives with the "OLD" revert past the oldest observation), and swaps priced from the
///        pool's own reserves (constant product after the input fee) — so price impact, fee tiers and
///        depth matter. Concentrated-liquidity maths is NOT reproduced (no fork available offline).
contract UniV3MockPool is IUniswapV3PoolView {
    address public immutable override token0;
    address public immutable override token1;
    uint24 public immutable override fee;
    address public immutable router;

    uint128 public override liquidity = 1e18;
    int24 public currentTick;
    // observation history: tick active from time[i] on, cumulative at time[i]
    uint32[] internal _obsTime;
    int56[] internal _obsCum;
    int24[] internal _obsTick;

    constructor(address tokenA, address tokenB, uint24 fee_, int24 tick_, address router_) {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        fee = fee_;
        router = router_;
        currentTick = tick_;
        _obsTime.push(uint32(block.timestamp));
        _obsCum.push(0);
        _obsTick.push(tick_);
    }

    function setLiquidity(uint128 l) external {
        liquidity = l;
    }

    /// @notice Moves the pool tick now (records an observation, like a swap would).
    function setTick(int24 t) external {
        uint256 n = _obsTime.length;
        uint32 last = _obsTime[n - 1];
        int56 cum = _obsCum[n - 1] + int56(_obsTick[n - 1]) * int56(uint56(uint32(block.timestamp) - last));
        if (uint32(block.timestamp) == last) {
            _obsTick[n - 1] = t;
        } else {
            _obsTime.push(uint32(block.timestamp));
            _obsCum.push(cum);
            _obsTick.push(t);
        }
        currentTick = t;
    }

    function slot0()
        external
        view
        override
        returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16 card, uint16 cardNext, uint8, bool)
    {
        tick = currentTick;
        sqrtPriceX96 = UniswapV3Twap.sqrtRatioAtTick(tick);
        card = uint16(_obsTime.length);
        cardNext = card;
        return (sqrtPriceX96, tick, card - 1, card, cardNext, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        override
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 k; k < secondsAgos.length; ++k) {
            uint32 target = uint32(block.timestamp) - secondsAgos[k];
            require(target >= _obsTime[0], "OLD");
            uint256 i = _obsTime.length - 1;
            while (_obsTime[i] > target) i--;
            tickCumulatives[k] = _obsCum[i] + int56(_obsTick[i]) * int56(uint56(target - _obsTime[i]));
        }
    }

    /// @notice Router-only: `amountIn` of the input token has already been paid in. Constant product on
    ///         the reserves after the input fee; pays `recipient`.
    function swap(bool zeroForOne, uint256 amountIn, address recipient) external returns (uint256 amountOut) {
        require(msg.sender == router, "router only");
        (IERC20 tin, IERC20 tout) = zeroForOne ? (IERC20(token0), IERC20(token1)) : (IERC20(token1), IERC20(token0));
        uint256 reserveIn = tin.balanceOf(address(this)) - amountIn;
        uint256 reserveOut = tout.balanceOf(address(this));
        uint256 inAfterFee = amountIn * (1e6 - fee) / 1e6;
        amountOut = reserveOut * inAfterFee / (reserveIn + inAfterFee);
        require(amountOut > 0, "IIA");
        require(tout.transfer(recipient, amountOut), "T");
    }
}

/// @title UniV3MockFactory — `getPool` in either token order, `createPool` for tests.
contract UniV3MockFactory is IUniswapV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) public override getPool;
    address public router;

    function setRouter(address r) external {
        router = r;
    }

    function createPool(address a, address b, uint24 fee, int24 tick) external returns (UniV3MockPool pool) {
        require(getPool[a][b][fee] == address(0), "exists");
        pool = new UniV3MockPool(a, b, fee, tick, router);
        getPool[a][b][fee] = address(pool);
        getPool[b][a][fee] = address(pool);
    }
}

/// @title UniV3MockRouter — SwapRouter02 `exactInputSingle` / `exactInput` with the real router's
///        observable behaviour: the pool is found by (tokenIn, tokenOut, fee) (no pool for that tier =>
///        revert), the first hop's input is pulled from `msg.sender` with transferFrom (approval needed),
///        intermediate hops are held by the router, the output goes to `recipient`, and the final output
///        is checked against `amountOutMinimum` ("Too little received").
contract UniV3MockRouter is ISwapRouter02 {
    UniV3MockFactory public immutable factory;
    uint256 public calls;
    bytes public lastPath;
    uint24 public lastFee;

    constructor(UniV3MockFactory f) {
        factory = f;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        require(p.sqrtPriceLimitX96 == 0, "limit unsupported");
        calls++;
        lastFee = p.fee;
        amountOut = _hop(p.tokenIn, p.tokenOut, p.fee, p.amountIn, msg.sender, p.recipient);
        require(amountOut >= p.amountOutMinimum, "Too little received");
    }

    function exactInput(ExactInputParams calldata p) external payable returns (uint256 amountOut) {
        calls++;
        lastPath = p.path;
        bytes calldata path = p.path;
        require(path.length >= 43 && (path.length - 20) % 23 == 0, "path");
        uint256 hops = (path.length - 20) / 23;
        amountOut = p.amountIn;
        address payer = msg.sender;
        for (uint256 i; i < hops; ++i) {
            uint256 o = 23 * i;
            address tin = address(bytes20(path[o:o + 20]));
            uint24 fee_ = uint24(bytes3(path[o + 20:o + 23]));
            address tout = address(bytes20(path[o + 23:o + 43]));
            address to = i + 1 == hops ? p.recipient : address(this);
            amountOut = _hop(tin, tout, fee_, amountOut, payer, to);
            payer = address(this);
        }
        require(amountOut >= p.amountOutMinimum, "Too little received");
    }

    function _hop(address tin, address tout, uint24 fee_, uint256 amountIn, address payer, address to)
        internal
        returns (uint256)
    {
        address pool = factory.getPool(tin, tout, fee_);
        require(pool != address(0), "no pool");
        if (payer == address(this)) require(IERC20(tin).transfer(pool, amountIn), "STF");
        else require(IERC20(tin).transferFrom(payer, pool, amountIn), "STF");
        return UniV3MockPool(pool).swap(tin < tout, amountIn, to);
    }
}
