// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IV4PoolManager} from "../interfaces/external/IUniswapV4.sol";

/// @title UniswapV4Lib — Uniswap v4 PoolManager reads and maths for the BKRN buyback (no v4-core dependency).
/// @notice Storage / transient layouts are those of v4-core (StateLibrary, CurrencyDelta, NonzeroDeltaCount):
///         pool state at `keccak256(abi.encodePacked(poolId, POOLS_SLOT = 6))`, slot0 = sqrtPriceX96 (160 bits) |
///         tick (24) | protocolFee (24) | lpFee (24); a currency delta at `keccak256(abi.encode(target, currency))`
///         (transient, read with `exttload`). The fork test (test/core/BkrnFeeRouterV4Fork.t.sol) checks them
///         against the deployed PoolManager / StateView on Robinhood Chain.
library UniswapV4Lib {
    /// @notice v4-core TickMath.MIN_SQRT_PRICE / MAX_SQRT_PRICE (a price limit must lie strictly inside).
    uint160 internal constant MIN_SQRT_PRICE = 4_295_128_739;
    uint160 internal constant MAX_SQRT_PRICE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;
    /// @notice v4-core StateLibrary.POOLS_SLOT.
    bytes32 internal constant POOLS_SLOT = bytes32(uint256(6));

    /// @notice v4-core PoolIdLibrary.toId: keccak256 of the 5-word key.
    function poolId(IV4PoolManager.PoolKey memory key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    /// @notice Current sqrtPriceX96 of the pool (0 = not initialized).
    function sqrtPriceX96(address manager, IV4PoolManager.PoolKey memory key) internal view returns (uint160) {
        bytes32 slot = keccak256(abi.encodePacked(poolId(key), POOLS_SLOT));
        return uint160(uint256(IV4PoolManager(manager).extsload(slot)));
    }

    /// @notice Transient slot of `target`'s open delta in `currency` (v4-core CurrencyDelta._computeSlot).
    function deltaSlot(address target, address currency) internal pure returns (bytes32) {
        return keccak256(abi.encode(target, currency));
    }

    /// @notice BalanceDelta -> (amount0, amount1).
    function split(int256 delta) internal pure returns (int128 amount0, int128 amount1) {
        amount0 = int128(delta >> 128);
        amount1 = int128(delta);
    }

    /// @notice sqrtPriceX96 limit of an exact-input swap selling `decIn`-decimal tokens for `decOut`-decimal tokens
    ///         at the worst acceptable price `minOutPerInWad` (whole out per whole in, WAD, > 0): the pool's marginal
    ///         price never goes past it. Raw price (token1 per token0, Uniswap v3 / v4 convention) r = p x 10^decOut /
    ///         (10^decIn x 1e18): zeroForOne (selling currency0, the price falls) the limit is sqrt(r), otherwise
    ///         (selling currency1, the price rises) sqrt(1 / r), both x 2^96, computed as sqrt(x * 2^128) * 2^32 (no
    ///         overflow for any price; relative error < 1e-12 at real prices). Rounding toward the stricter side
    ///         for oneForZero, within 2^-64 relative for zeroForOne. Clamped strictly inside (MIN, MAX)_SQRT_PRICE.
    function priceLimit(uint256 minOutPerInWad, uint8 decIn, uint8 decOut, bool zeroForOne)
        internal
        pure
        returns (uint160)
    {
        uint256 inScale = 10 ** (uint256(decIn) + 18);
        uint256 outScale = 10 ** uint256(decOut);
        uint256 x = zeroForOne
            ? Math.mulDiv(minOutPerInWad, (1 << 128) * outScale, inScale)
            : Math.mulDiv(1 << 128, inScale, minOutPerInWad * outScale);
        uint256 s = Math.sqrt(x) << 32;
        if (s <= MIN_SQRT_PRICE) return MIN_SQRT_PRICE + 1;
        if (s >= MAX_SQRT_PRICE) return MAX_SQRT_PRICE - 1;
        return uint160(s);
    }
}
