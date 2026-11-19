// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {IBuybackGuard} from "./interfaces/IBuybackGuard.sol";
import {IBkrnV4Swapper} from "./interfaces/IBkrnV4Swapper.sol";
import {IUniswapV3PoolView} from "./interfaces/external/IUniswapV3.sol";
import {UniswapV3Twap} from "./libraries/UniswapV3Twap.sol";
import {UniswapV4Lib} from "./libraries/UniswapV4Lib.sol";

/// @dev The BkrnFeeRouter getters the guard reads (all public on the router).
interface IBuybackRouterView {
    function buybackVenue() external view returns (uint8);
    function twapPool() external view returns (address);
    function buybackPoolFee() external view returns (uint24);
    function bkrn() external view returns (address);
    function v4PoolManager() external view returns (address);
    function v4Route() external view returns (IBkrnV4Swapper.V4Route memory);
}

interface IDecimals {
    function decimals() external view returns (uint8);
}

/// @title BuybackGuard — the buyback's ETH reference (on-chain TWAP) and its depth-bounded size (tech update #9).
/// @notice Two jobs for BkrnFeeRouter, both read-only for it (the router keeps its own price floor and per-call cap):
///
///         1. ETH reference. The router prices a via-ETH route (USDG -> ETH -> BKRN) and REF_FIXED_ETH with "USDG per ETH".
///            That number used to be set by governance (and mirrored into a service env). Here it is read on chain from
///            the Uniswap v3 WETH / USDG pool's oracle: `pokeEthReference()` (anyone; the keeper does) stores the mean tick
///            of the last `ethWindow` seconds, accepted only when
///              - the pool's in-range liquidity is at least `ethMinLiquidity` (a thin pool is refused),
///              - the spot tick is within `ethMaxTickDeviation` ticks of the mean (a spot push in progress is refused),
///              - the pool history covers the window (the pool reverts "OLD" otherwise);
///            and each update moves the stored value by at most `ethMaxMoveBps` from the previous one (a clamp, so a
///            manipulated window can only drag the reference slowly, and at most once per MIN_POKE_INTERVAL). The stored
///            value is trusted for `ethMaxAge`; after that the governance FALLBACK value is used while it has not expired
///            (`setEthFallback(value, expiry)`, expiry at most MAX_FALLBACK_TTL ahead); with neither, `ethUsdcPerEth()`
///            reverts and via-ETH buybacks wait (fail-safe). A TWAP over a window cannot be moved by a one-block spot
///            push: the push adds (jump x its duration / window) ticks to the mean, and an unreverted push also trips the
///            spot-vs-mean deviation check.
///
///         2. Size. `maxBuyback()` is the most USDG one buyback may spend so that, on the BKRN pool's current in-range
///            liquidity, it moves the price by at most `maxImpactBps` (governance, default 100 = 1%). The router refuses a
///            larger call (`BuybackTooLarge`); the keeper splits a larger pending amount over several calls spaced apart,
///            so arbitrage can restore the price in between. The estimate is the constant-liquidity one inside the active
///            tick range (the LP fee is grossed up); a swap crossing a tick boundary can move the price a little more. The
///            hard bounds stay the router's: the reference floor (`buybackFloor`) and `maxBuybackPerCall`.
/// @dev Not upgradeable. Roles come from the config: the timelock (DEFAULT_ADMIN) sets everything; nothing here moves funds.
contract BuybackGuard is IBuybackGuard {
    bytes32 private constant DEFAULT_ADMIN_ROLE = 0x00;
    uint256 private constant Q96 = 1 << 96;
    uint256 private constant BPS = 10_000;

    /// @notice TWAP window bounds (a window shorter than 10 minutes can be dragged by a few blocks of spot).
    uint32 public constant MIN_ETH_WINDOW = 10 minutes;
    uint32 public constant MAX_ETH_WINDOW = 1 days;
    /// @notice Upper bound of the spot-vs-mean tick deviation (2,000 ticks ~ 22%).
    uint24 public constant MAX_TICK_DEVIATION = 2000;
    /// @notice The stored reference moves at most this often (the keeper pokes every few minutes).
    uint32 public constant MIN_POKE_INTERVAL = 5 minutes;
    /// @notice Bounds of the stored-reference trust time.
    uint32 public constant MIN_ETH_MAX_AGE = 10 minutes;
    uint32 public constant MAX_ETH_MAX_AGE = 1 days;
    /// @notice Bounds of the per-update move (bps of the previous value).
    uint16 public constant MIN_MOVE_BPS = 10;
    uint16 public constant MAX_MOVE_BPS = 2000;
    /// @notice The governance fallback expires within this time of being set.
    uint64 public constant MAX_FALLBACK_TTL = 30 days;
    /// @notice Sanity range of any ETH reference (USDG per ETH, WAD): a typo or a broken pool is refused, not used.
    uint256 public constant MIN_ETH_USD_WAD = 100e18;
    uint256 public constant MAX_ETH_USD_WAD = 100_000e18;
    /// @notice Price impact bounds (bps of the BKRN price) and the default.
    uint16 public constant MAX_IMPACT_BPS = 1000;
    uint16 public constant DEFAULT_IMPACT_BPS = 100;

    /// @notice Protocol registry (the timelock holds DEFAULT_ADMIN).
    IBookrunnerConfig public immutable config;
    /// @notice The BkrnFeeRouter this guard serves (venue, pools and route are read from it).
    IBuybackRouterView public immutable router;
    /// @notice Settlement token (config.usdc() at deployment): USDG, 6 decimals.
    address public immutable usdc;

    // ---- ETH reference
    /// @notice Uniswap v3 pool of {WETH, settlement token} read for the TWAP (0 = TWAP not configured).
    address public ethPool;
    /// @notice The pool's other token (WETH, 18 decimals).
    address public weth;
    uint32 public ethWindow;
    uint24 public ethMaxTickDeviation;
    /// @notice Minimum in-range liquidity of the pool (raw v3 liquidity units) for an update to be accepted.
    uint128 public ethMinLiquidity;
    uint16 public ethMaxMoveBps;
    uint32 public ethMaxAge;
    /// @notice The last accepted reference (USDG per ETH, WAD) and when.
    uint256 public ethRefWad;
    uint64 public ethRefAt;
    /// @notice Governance fallback (USDG per ETH, WAD) and its expiry (unix s); 0 = none.
    uint256 public fallbackWad;
    uint64 public fallbackExpiry;

    // ---- size
    /// @notice Max price impact of one buyback on the BKRN pool (bps), governance.
    uint16 public maxImpactBps = DEFAULT_IMPACT_BPS;
    /// @notice The cap (settlement token, 6dp) while there is no usable depth source: no BKRN pool set on the router, a pool that is
    ///         not the swap pool, or no live v4 route. Never "unlimited": a new token's pool may hold little. Timelock-set.
    uint256 public maxBuybackNoDepth = 2_000e6;

    error ZeroAddress();
    error NotAdmin(address caller);
    error BadParams();
    error NotConfigured();
    error TooSoon(uint256 nextAt);
    error EthPoolThin(uint128 liquidity, uint128 minimum);
    error TwapDeviation(int24 spotTick, int24 meanTick);
    error ReferenceOutOfRange(uint256 valueWad);
    error EthReferenceUnavailable();

    event EthReferenceUpdated(uint256 twapWad, uint256 storedWad);
    event EthTwapSet(address pool, uint32 window, uint24 maxTickDeviation, uint128 minLiquidity, uint16 maxMoveBps, uint32 maxAge);
    event EthFallbackSet(uint256 valueWad, uint64 expiry);
    event MaxImpactSet(uint16 bps);
    event MaxBuybackNoDepthSet(uint256 amount);

    constructor(address config_, address router_) {
        if (config_ == address(0) || router_ == address(0)) revert ZeroAddress();
        config = IBookrunnerConfig(config_);
        router = IBuybackRouterView(router_);
        address u = IBookrunnerConfig(config_).usdc();
        if (u == address(0)) revert ZeroAddress();
        usdc = u;
    }

    // ------------------------------------------------------------------------------------------ ETH reference

    /// @notice Anyone: stores the pool's TWAP as the ETH reference, within the bounds above. Returns the stored value.
    function pokeEthReference() external returns (uint256 stored) {
        address pool = ethPool;
        if (pool == address(0)) revert NotConfigured();
        uint64 at = ethRefAt;
        if (at != 0 && block.timestamp < uint256(at) + MIN_POKE_INTERVAL) revert TooSoon(uint256(at) + MIN_POKE_INTERVAL);
        uint128 liq = IUniswapV3PoolView(pool).liquidity();
        if (liq < ethMinLiquidity) revert EthPoolThin(liq, ethMinLiquidity);
        int24 mean = UniswapV3Twap.meanTick(pool, ethWindow);
        int24 spot = UniswapV3Twap.spotTick(pool);
        int256 d = int256(spot) - int256(mean);
        if ((d < 0 ? -d : d) > int256(uint256(ethMaxTickDeviation))) revert TwapDeviation(spot, mean);
        // raw settlement token (6dp) for one whole WETH (1e18) == USDG per ETH x 1e6; WAD = x 1e12
        uint256 twap = UniswapV3Twap.quoteAtTick(mean, 1e18, weth, usdc) * 1e12;
        if (twap < MIN_ETH_USD_WAD || twap > MAX_ETH_USD_WAD) revert ReferenceOutOfRange(twap);
        stored = twap;
        // the anchor of the move bound is the previous stored value while it is still trusted (<= ethMaxAge old). A stale or
        // never-stored value is no anchor: the TWAP is then stored as it is (liquidity floor, deviation bound and history all
        // passed), so a stale number is never clamped, and never reported as fresh, after an outage
        uint256 anchor = (at != 0 && block.timestamp <= uint256(at) + ethMaxAge) ? ethRefWad : 0;
        if (anchor != 0) {
            uint256 lo = Math.mulDiv(anchor, BPS - ethMaxMoveBps, BPS);
            uint256 hi = Math.mulDiv(anchor, BPS + ethMaxMoveBps, BPS);
            if (stored < lo) stored = lo;
            else if (stored > hi) stored = hi;
        }
        ethRefWad = stored;
        ethRefAt = uint64(block.timestamp);
        emit EthReferenceUpdated(twap, stored);
    }

    /// @inheritdoc IBuybackGuard
    function ethUsdcPerEth() public view returns (uint256) {
        (uint256 v, uint8 source,) = ethReference();
        if (source < 1) revert EthReferenceUnavailable();
        return v;
    }

    /// @notice The reference in force: (value, source, stored-at). source 1 = the on-chain TWAP (trusted for `ethMaxAge`),
    ///         2 = the unexpired governance fallback, 0 = none (value 0).
    function ethReference() public view returns (uint256 value, uint8 source, uint64 updatedAt) {
        if (ethRefAt != 0 && block.timestamp <= uint256(ethRefAt) + ethMaxAge) return (ethRefWad, 1, ethRefAt);
        if (fallbackWad != 0 && block.timestamp <= fallbackExpiry) return (fallbackWad, 2, 0);
        return (0, 0, 0);
    }

    // ----------------------------------------------------------------------------------------------- sizing

    /// @inheritdoc IBuybackGuard
    function maxBuyback() external view returns (uint256) {
        uint256 bps = maxImpactBps;
        if (router.buybackVenue() == 0) {
            // Uniswap v3 venue: the BKRN / settlement pool the router already knows (twapPool, configured for the TWAP source
            // or for depth alone)
            address pool = router.twapPool();
            if (pool == address(0) || !_isSwapPool(pool)) return maxBuybackNoDepth;
            (uint160 sp,,,,,,) = IUniswapV3PoolView(pool).slot0();
            return _spend(IUniswapV3PoolView(pool).liquidity(), sp, IUniswapV3PoolView(pool).token1() == usdc, IUniswapV3PoolView(pool).fee(), false, bps);
        }
        IBkrnV4Swapper.V4Route memory r = router.v4Route();
        address m = router.v4PoolManager();
        if (m == address(0) || r.bkrnPool.currency1 == address(0)) return maxBuybackNoDepth; // no route yet (the buyback defers)
        uint160 p = UniswapV4Lib.sqrtPriceX96(m, r.bkrnPool);
        if (p == 0) return maxBuybackNoDepth; // not initialized (the buyback defers)
        // direct: the quote currency is the settlement token; via ETH: native ETH (currency0 of {ETH, BKRN})
        bool viaEth = r.kind != 0;
        bool quoteIsToken1 = viaEth ? false : r.bkrnPool.currency1 == usdc;
        uint256 fee = (r.bkrnPool.fee & 0x800000) != 0 ? 0 : r.bkrnPool.fee;
        return _spend(UniswapV4Lib.liquidity(m, r.bkrnPool), p, quoteIsToken1, fee, viaEth, bps);
    }

    /// @dev The depth pool is the pool the router swaps in: tokens {settlement token, BKRN} and the fee tier the router pins
    ///      (`buybackPoolFee`); any other pool says nothing about the swap's price impact.
    function _isSwapPool(address pool) private view returns (bool) {
        address t0 = IUniswapV3PoolView(pool).token0();
        address t1 = IUniswapV3PoolView(pool).token1();
        address b = router.bkrn();
        return ((t0 == usdc && t1 == b) || (t0 == b && t1 == usdc)) && IUniswapV3PoolView(pool).fee() == router.buybackPoolFee();
    }

    /// @dev Quote-token amount (raw) that moves the price of a constant-liquidity position by `bps`, grossed up for the LP
    ///      fee, as settlement token (6dp). Price p = sqrtP^2; a price move of x moves sqrtP by about x / 2.
    function _spend(uint128 liq, uint160 sqrtP, bool quoteIsToken1, uint256 feePips, bool quoteIsEth, uint256 bps)
        private
        view
        returns (uint256 usdcRaw)
    {
        if (liq == 0) return 0;
        uint256 q = quoteIsToken1
            ? Math.mulDiv(uint256(liq) * bps, sqrtP, 2 * BPS * Q96)
            : Math.mulDiv(uint256(liq) * bps, Q96, uint256(sqrtP) * 2 * BPS);
        if (feePips != 0 && feePips < 1e6) q = Math.mulDiv(q, 1e6, 1e6 - feePips);
        // ETH (18 decimals) -> settlement token (6 decimals) at the ETH reference (USDG per ETH, WAD)
        usdcRaw = quoteIsEth ? Math.mulDiv(q, ethUsdcPerEth(), 1e30) : q;
    }

    // ----------------------------------------------------------------------------------------------- governance

    /// @notice Timelock: configures the ETH TWAP. `pool` must be a Uniswap v3 pool of exactly {settlement token, an 18-decimal
    ///         token (WETH)}; `window` in [MIN_ETH_WINDOW, MAX_ETH_WINDOW] (its observation buffer must cover it, else
    ///         pokes revert "OLD"); `maxTickDeviation` in [1, MAX_TICK_DEVIATION]; `minLiquidity` > 0; `maxMoveBps` in
    ///         [MIN_MOVE_BPS, MAX_MOVE_BPS]; `maxAge` in [MIN_ETH_MAX_AGE, MAX_ETH_MAX_AGE] and at least 2 x MIN_POKE_INTERVAL.
    ///         A different pool drops the stored value (the fallback, if live, covers until the first poke).
    function setEthTwap(
        address pool,
        uint32 window,
        uint24 maxTickDeviation,
        uint128 minLiquidity,
        uint16 maxMoveBps,
        uint32 maxAge
    ) external {
        _onlyAdmin();
        if (pool.code.length == 0) revert BadParams();
        if (window < MIN_ETH_WINDOW || window > MAX_ETH_WINDOW) revert BadParams();
        if (maxTickDeviation == 0 || maxTickDeviation > MAX_TICK_DEVIATION || minLiquidity == 0) revert BadParams();
        if (maxMoveBps < MIN_MOVE_BPS || maxMoveBps > MAX_MOVE_BPS) revert BadParams();
        if (maxAge < MIN_ETH_MAX_AGE || maxAge > MAX_ETH_MAX_AGE || maxAge < 2 * MIN_POKE_INTERVAL) revert BadParams();
        address t0 = IUniswapV3PoolView(pool).token0();
        address t1 = IUniswapV3PoolView(pool).token1();
        address other = t0 == usdc ? t1 : t1 == usdc ? t0 : address(0);
        if (other == address(0) || IDecimals(other).decimals() != 18) revert BadParams();
        if (pool != ethPool) {
            ethRefWad = 0;
            ethRefAt = 0;
        }
        ethPool = pool;
        weth = other;
        ethWindow = window;
        ethMaxTickDeviation = maxTickDeviation;
        ethMinLiquidity = minLiquidity;
        ethMaxMoveBps = maxMoveBps;
        ethMaxAge = maxAge;
        emit EthTwapSet(pool, window, maxTickDeviation, minLiquidity, maxMoveBps, maxAge);
    }

    /// @notice Timelock: the governance fallback ETH reference, used only while the TWAP value is missing or older than
    ///         `ethMaxAge`, and only until `expiry`. (0, 0) clears it. `valueWad` in [MIN_ETH_USD_WAD, MAX_ETH_USD_WAD],
    ///         `expiry` in (now, now + MAX_FALLBACK_TTL]. Renewing it is a deliberate governance act.
    function setEthFallback(uint256 valueWad, uint64 expiry) external {
        _onlyAdmin();
        if (valueWad == 0 && expiry == 0) {
            fallbackWad = 0;
            fallbackExpiry = 0;
            emit EthFallbackSet(0, 0);
            return;
        }
        if (valueWad < MIN_ETH_USD_WAD || valueWad > MAX_ETH_USD_WAD) revert BadParams();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_FALLBACK_TTL) revert BadParams();
        fallbackWad = valueWad;
        fallbackExpiry = expiry;
        emit EthFallbackSet(valueWad, expiry);
    }

    /// @notice Timelock: the largest price impact (bps of the BKRN price) one buyback may have; default 100.
    function setMaxImpactBps(uint16 bps) external {
        _onlyAdmin();
        if (bps == 0 || bps > MAX_IMPACT_BPS) revert BadParams();
        maxImpactBps = bps;
        emit MaxImpactSet(bps);
    }

    /// @notice Timelock: the cap used while there is no usable depth pool (> 0, at most 1,000,000 USDG).
    function setMaxBuybackNoDepth(uint256 amount) external {
        _onlyAdmin();
        if (amount == 0 || amount > 1_000_000e6) revert BadParams();
        maxBuybackNoDepth = amount;
        emit MaxBuybackNoDepthSet(amount);
    }

    function _onlyAdmin() private view {
        if (!config.hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
    }
}
