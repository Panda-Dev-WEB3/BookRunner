// SPDX-License-Identifier: MIT
// Not part of the BUSL-1.1 Licensed Work: MIT (LICENSE-MIT), Copyright (c) 2026 Panda-Dev-WEB3 (BookRunner).
//
// sqrtRatioAtTick: the algorithm and the per-bit constants are those of Uniswap v4-core TickMath.getSqrtPriceAtTick,
// Copyright 2023 Universal Navigation Inc. (Uniswap Labs), MIT License (notice reproduced in LICENSE-MIT):
// https://github.com/Uniswap/v4-core/blob/main/src/libraries/TickMath.sol
// meanTick and quoteAtTick are written here from the formulas below; no code is taken from Uniswap v3-core or
// v3-periphery (GPL-2.0-or-later).
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUniswapV3PoolView} from "../interfaces/external/IUniswapV3.sol";

/// @title UniswapV3Twap — time-weighted average price reads from a Uniswap v3 pool's oracle.
/// @notice The Uniswap v3 oracle maths (a pool's tick accumulator and its 1.0001^tick price), for 0.8 (checked
///         arithmetic, OZ `Math.mulDiv`):
///           meanTick = floor((tickCumulative[now] - tickCumulative[now - window]) / window)  (rounds to -inf)
///           price(token1 per token0) = 1.0001^tick, sqrtPriceX96 = sqrt(1.0001^tick) * 2^96.
///         The per-bit constants are 2^128 / sqrt(1.0001)^(2^i) (verified to < 1e-27 relative error;
///         `test/core/UniswapV3Twap.t.sol` pins MIN/MAX/±1/... vectors to the canonical values).
library UniswapV3Twap {
    int24 internal constant MIN_TICK = -887_272;
    int24 internal constant MAX_TICK = 887_272;

    error TickOutOfRange(int24 tick);
    error ZeroWindow();

    /// @notice Arithmetic mean tick of `pool` over the last `window` seconds (reverts "OLD" in the pool
    ///         when the pool's observation buffer does not reach back that far).
    function meanTick(address pool, uint32 window) internal view returns (int24 tick) {
        if (window == 0) revert ZeroWindow();
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        (int56[] memory cum,) = IUniswapV3PoolView(pool).observe(ago);
        // floor division: Solidity rounds toward zero, so a negative non-zero remainder means one tick lower
        int56 elapsed = int56(uint56(window));
        int56 q = (cum[1] - cum[0]) / elapsed;
        if ((cum[1] - cum[0]) % elapsed < 0) q -= 1;
        tick = int24(q);
    }

    /// @notice Current (spot) tick of `pool`.
    function spotTick(address pool) internal view returns (int24 tick) {
        (, tick,,,,,) = IUniswapV3PoolView(pool).slot0();
    }

    /// @notice `quoteToken` amount (raw units) worth `baseAmount` (raw units) of `baseToken` at `tick`
    ///         (tick price = token1 per token0, raw units).
    function quoteAtTick(int24 tick, uint128 baseAmount, address baseToken, address quoteToken)
        internal
        pure
        returns (uint256 quoteAmount)
    {
        // price(token1 per token0) = sqrtP^2 / 2^192 with sqrtP = sqrtRatioAtTick(tick) (Q64.96). base = token0:
        // quote = base * price; base = token1: quote = base / price, with price = num / den:
        // den = 2^192 keeps every bit while sqrtP^2 fits in 256 bits (sqrtP < 2^128); above that, sqrtP^2 / 2^64
        // against den = 2^128 (the floor loses < 1 part in 2^192 there, and it never overflows: sqrtP < 2^160).
        (uint256 num, uint256 den) = _price(sqrtRatioAtTick(tick));
        quoteAmount = baseToken < quoteToken ? Math.mulDiv(baseAmount, num, den) : Math.mulDiv(baseAmount, den, num);
    }

    function _price(uint160 sqrtP) private pure returns (uint256 num, uint256 den) {
        if (sqrtP >> 128 == 0) return (uint256(sqrtP) * uint256(sqrtP), 1 << 192);
        return (Math.mulDiv(sqrtP, sqrtP, 1 << 64), 1 << 128);
    }

    /// @notice sqrt(1.0001^tick) as a Q64.96, rounded up (Uniswap v4-core TickMath.getSqrtPriceAtTick, MIT; the
    ///         constants are 2^128 / sqrt(1.0001)^(2^i) rounded to the nearest integer).
    function sqrtRatioAtTick(int24 tick) internal pure returns (uint160) {
        if (tick < MIN_TICK || tick > MAX_TICK) revert TickOutOfRange(tick);
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        uint256 ratio =
            absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;
        if (tick > 0) ratio = type(uint256).max / ratio;
        // Q128.128 -> Q64.96, rounded up (the result's tick, read back, is `tick`).
        return uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }
}
