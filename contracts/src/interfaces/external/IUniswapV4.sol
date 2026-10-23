// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IV4PoolManager — the Uniswap v4 PoolManager surface the BKRN buyback uses (no router).
/// @notice ABI-compatible with v4-core `IPoolManager` / `IExtsload` / `IExttload`: `Currency` and `IHooks` are
///         addresses, `BalanceDelta` is an int256 packing amount0 (upper 128 bits) and amount1 (lower 128 bits),
///         both from the caller's side (negative = the caller owes the pool, positive = the pool owes the caller).
///         `amountSpecified < 0` is an exact-input swap. Robinhood Chain 4663: PoolManager
///         `0x8366a39cc670b4001a1121b8f6a443a643e40951` (docs/VERIFY.md U2).
interface IV4PoolManager {
    /// @notice v4-core PoolKey: currency0 < currency1 (address(0) = native), fee in pips (0x800000 = dynamic),
    ///         tickSpacing, hooks (permissions encoded in the address's low 14 bits).
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    /// @notice v4-core IPoolManager.SwapParams.
    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Calls `IV4UnlockCallback(msg.sender).unlockCallback(data)`; reverts `CurrencyNotSettled` unless every
    ///         delta opened during the callback is back to zero when it returns.
    function unlock(bytes calldata data) external returns (bytes memory);

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);

    /// @notice Snapshots `currency`'s balance of the PoolManager before an ERC-20 settle.
    function sync(address currency) external;

    /// @notice Credits the caller with the synced currency transferred in since `sync`.
    function settle() external payable returns (uint256 paid);

    function take(address currency, address to, uint256 amount) external;

    function extsload(bytes32 slot) external view returns (bytes32);

    function exttload(bytes32 slot) external view returns (bytes32);
}

/// @title IV4UnlockCallback — v4-core IUnlockCallback.
interface IV4UnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}
