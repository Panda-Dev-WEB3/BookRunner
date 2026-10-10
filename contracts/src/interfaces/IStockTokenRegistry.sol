// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IStockTokenRegistry — canonical Stock Token registry + multiplier-aware valuer.
/// @notice A Stock Token's `multiplier` (WAD) = shares of the underlying equity represented by 1 whole
///         token (corporate actions move it). Oracle prices are per 1 share of the equity (WAD), keyed
///         by the token's `priceId`. value = qtyRaw * multiplier * price / (10^decimals * 1e18) — the
///         multiplier is applied EXACTLY once (red-team check: no double-apply).
///         Index ids: bytes32 with a non-zero upper 12 bytes; tokens: address left-padded to bytes32.
///         Multiplier source (VERIFY T2/C2): per token, either the stored governance value or the token's
///         own ERC-8056 `uiMultiplier()` (WAD) read live, bounded by a band around the stored value (the
///         governance anchor). Robinhood's Chainlink feeds quote PER TOKEN (share price x uiMultiplier);
///         the oracle service divides by the same `uiMultiplier()` before signing, so oracle prices stay
///         per share and the multiplier is applied once, here.
interface IStockTokenRegistry {
    struct StockToken {
        address token;
        bytes32 priceId; // oracle key for the underlying equity (e.g. "NVDA")
        uint256 multiplierWad;
        uint8 decimals;
        bool active;
        uint256 floatCapRaw; // max hedge inventory (raw units) — float caps (frictions §9)
    }

    struct IndexComponent {
        address token;
        uint256 weightBps; // sum == 1e4
    }

    function register(address token, bytes32 priceId, uint256 multiplierWad, uint256 floatCapRaw) external; // timelock
    function setMultiplier(address token, uint256 multiplierWad) external; // timelock / corporate-action ops
    function setFloatCap(address token, uint256 floatCapRaw) external;
    function registerIndex(bytes32 indexId, bytes32 priceId, IndexComponent[] calldata components) external;

    function isCanonical(address token) external view returns (bool);
    function getToken(address token) external view returns (StockToken memory);
    function getIndex(bytes32 indexId) external view returns (bytes32 priceId, IndexComponent[] memory);
    function isIndex(bytes32 underlying) external view returns (bool);
    /// @notice Oracle key for a charter underlying (token -> its priceId, index -> its priceId).
    function priceIdOf(bytes32 underlying) external view returns (bytes32);
    /// @notice USD (6dp) value of `qtyRaw` of `token` at the attested oracle price.
    function valueUsd(address token, uint256 qtyRaw) external view returns (uint256);
    /// @notice Same with an explicit price (WAD per share of equity).
    function valueUsdAt(address token, uint256 qtyRaw, uint256 priceWad) external view returns (uint256);
    /// @notice Effective multiplier (WAD) used by the valuation: stored, or the token's live `uiMultiplier()`
    ///         when `multiplierFromToken(token)` (reverts outside the band around the anchor).
    function multiplierOf(address token) external view returns (uint256);

    event TokenRegistered(address indexed token, bytes32 indexed priceId, uint256 multiplierWad);
    event MultiplierSet(address indexed token, uint256 multiplierWad);
    event FloatCapSet(address indexed token, uint256 floatCapRaw);
    event IndexRegistered(bytes32 indexed indexId, bytes32 priceId, uint256 components);
    event MultiplierSourceSet(address indexed token, bool fromToken);
    event NextMultiplierAnchorSet(address indexed token, uint256 multiplierWad);
    event MultiplierBandSet(uint16 bandBps);
}
