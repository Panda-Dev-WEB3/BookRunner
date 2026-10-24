// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAttestedOracle} from "./interfaces/IAttestedOracle.sol";
import {IBkrnFeeRouter, IBackstop} from "./interfaces/IBkrnFeeRouter.sol";
import {IBkrnStaking} from "./interfaces/IBkrnStaking.sol";
import {IBookFactory} from "./interfaces/IBookFactory.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {ISwapRouter02} from "./interfaces/external/ISwapRouter02.sol";
import {IUniswapV3PoolView} from "./interfaces/external/IUniswapV3.sol";
import {IV4PoolManager} from "./interfaces/external/IUniswapV4.sol";
import {IBkrnV4Swapper} from "./interfaces/IBkrnV4Swapper.sol";
import {BkrnV4Swapper} from "./BkrnV4Swapper.sol";
import {UniswapV3Twap} from "./libraries/UniswapV3Twap.sol";
import {UniswapV4Lib} from "./libraries/UniswapV4Lib.sol";

/// @title BkrnFeeRouter — splits protocol carry 50% buyback-to-stakers / 50% syndicate backstop.
/// @notice Each book's RevenueRouter transfers its carry here and calls `notifyCarry`. The backstop half
///         (plus any odd unit) is forwarded to the Backstop immediately; the buyback half accumulates in
///         `buybackPending` until a KEEPER swaps it to BKRN through `buybackRouter`
///         (`ISwapRouter02.exactInputSingle`) and the BKRN is distributed to stakers via
///         `BkrnStaking.notifyReward` (which streams it to stakers over its rewards duration).
///
///         Buyback price bound (on-chain, not keeper-chosen): the pool fee tier is pinned by the timelock
///         (`buybackPoolFee`), and every swap's `amountOutMinimum` is at least
///         `buybackFloor(amountIn) = amountIn x referenceBkrnPerUsdc() x (1 - maxSlippageBps)`. The
///         reference source is chosen by governance (`referenceSource`):
///           - REF_FIXED: the timelock-set `refBkrnPerUsdcWad`;
///           - REF_TWAP: the arithmetic-mean-tick price of the BKRN/settlement-token Uniswap v3 pool
///             `twapPool` over `twapWindow` seconds (OracleLibrary.consult maths), refused while the pool's
///             spot tick is more than `twapMaxTickDeviation` ticks from the mean (manipulation in
///             progress); window and deviation are bounded by the MIN/MAX constants;
///           - REF_ATTESTED: the AttestedOracle price of `bkrnPriceId` (USD per BKRN; the settlement token
///             is valued at $1);
///           - REF_FIXED_ETH: BKRN/ETH x ETH/USD from the timelock-set `refBkrnPerEthWad` / `refUsdcPerEthWad`
///             (a BKRN quoted in ETH; no ETH/USD feed is wired on Robinhood Chain, none verified).
///         Each call is capped at `maxBuybackPerCall`, which bounds the loss if the reference is
///         stale/manipulated in the keeper's favour. A reference off in the other direction (BKRN up) only
///         makes buybacks revert until it recovers or governance acts: fail-safe, the settlement token
///         stays in `buybackPending`. "USDC" in names = the protocol settlement token (`config.usdc()`:
///         USDG on Robinhood Chain; 6 decimals enforced by BookrunnerConfig).
///
///         Venue (governance, `buybackVenue`): VENUE_UNIV3 (default) swaps through `buybackRouter` as above;
///         VENUE_UNIV4 swaps directly against the Uniswap v4 PoolManager `v4PoolManager` (no router: `unlock` ->
///         `unlockCallback` -> `swap` exact input -> `sync` + transfer + `settle` the settlement token -> `take`
///         BKRN) along the timelock-set route `v4Route()`: a BKRN launched on Pons graduates into a locked v4
///         pool, possibly with a hook, most likely BKRN/native ETH (ROUTE_V4_ETH: USDG -> ETH in a v4 ETH/USDG
///         pool, then ETH -> BKRN, one unlock; ROUTE_V3_WETH: USDG -> WETH through the v3 router, unwrap, ETH ->
///         BKRN, inside the same unlock) or BKRN/USDG (ROUTE_DIRECT). The route is chosen off-chain
///         (scripts/buyback-route.ts). v4 has no TWAP oracle: VENUE_UNIV4 works with REF_FIXED / REF_ATTESTED /
///         REF_FIXED_ETH (REF_TWAP and VENUE_UNIV4 refuse each other). Every hop carries a `sqrtPriceLimitX96` at
///         the worst price whose net (LP fee, hook fee allowance `v4HookFeeBps`) meets the floor (a moved pool or a
///         sandwich fills less, never worse; the unspent input stays pending; via ETH the slippage is split between
///         the hops), the BKRN out must clear `buybackFloor(spent)` over the whole path, and
///         `maxBuybackPerCall` applies. While the route is unset or a pool uninitialized (before graduation) a v4
///         buyback is a no-op (`BuybackDeferred`): the settlement token waits in `buybackPending`. A revert inside
///         the unlock (a hook, a pool, a hop) is caught: `BuybackV4Failed`, nothing moves. Native ETH is accepted
///         only from WETH / the PoolManager during the swap, and none may remain after it. Fee distribution
///         (`notifyCarry`) never touches the venue.
/// @dev Accounting: the only USDC this contract is meant to hold is `buybackPending`; `notifyCarry`
///      requires the USDC balance to cover `buybackPending + amount` (push-then-notify).
contract BkrnFeeRouter is IBkrnFeeRouter, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes32 private constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 private constant KEEPER_ROLE = keccak256("KEEPER");

    /// @notice Protocol registry.
    IBookrunnerConfig public immutable config;
    /// @notice USDC (config.usdc() at deployment).
    IERC20 public immutable usdc;
    /// @notice BKRN (config.bkrn() at deployment).
    IERC20 public immutable bkrn;

    /// @inheritdoc IBkrnFeeRouter
    uint256 public buybackPending;
    /// @notice Uniswap v3 SwapRouter02-compatible router used for buybacks (VERIFY on RHC; devnet:
    ///         MockSwapRouter).
    address public buybackRouter;

    /// @notice Uniswap v3 fee tier of the buyback pool (timelock-set; 0 = buybacks not configured).
    uint24 public buybackPoolFee;
    /// @notice Max swap slippage below the reference price (bps, <= MAX_SLIPPAGE_BPS).
    uint16 public maxSlippageBps;
    /// @notice Governance reference price: whole BKRN per whole USDC (WAD). Used unless `bkrnPriceId` is set.
    uint256 public refBkrnPerUsdcWad;
    /// @notice Max USDC (6dp) per executeBuyback call.
    uint256 public maxBuybackPerCall;
    /// @notice AttestedOracle price id of BKRN (USD per BKRN, WAD) read by the REF_ATTESTED source.
    bytes32 public bkrnPriceId;

    /// @notice Buyback reference sources (governance-chosen).
    uint8 public constant REF_FIXED = 0;
    uint8 public constant REF_TWAP = 1;
    uint8 public constant REF_ATTESTED = 2;
    /// @notice BKRN/ETH x ETH/USD from the fixed `refBkrnPerEthWad` / `refUsdcPerEthWad` (`setEthReference`).
    uint8 public constant REF_FIXED_ETH = 3;
    /// @notice Active reference source (REF_FIXED by default).
    uint8 public referenceSource;
    /// @notice TWAP averaging window (seconds), within [MIN_TWAP_WINDOW, MAX_TWAP_WINDOW].
    uint32 public twapWindow;
    /// @notice Max |spot tick - mean tick| for the TWAP to be usable (1..MAX_TWAP_TICK_DEVIATION).
    uint24 public twapMaxTickDeviation;
    /// @notice BKRN/settlement-token Uniswap v3 pool read by the REF_TWAP source.
    address public twapPool;

    /// @notice TWAP window bounds: >= 10 min (a single-block push is averaged out), <= 2 days.
    uint32 public constant MIN_TWAP_WINDOW = 10 minutes;
    uint32 public constant MAX_TWAP_WINDOW = 2 days;
    /// @notice Upper bound of `twapMaxTickDeviation` (2,000 ticks ~ a 22% price move).
    uint24 public constant MAX_TWAP_TICK_DEVIATION = 2000;

    /// @notice Upper bound of `maxSlippageBps` (20%).
    uint16 public constant MAX_SLIPPAGE_BPS = 2000;
    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;
    uint256 private constant USDC_UNIT = 1e6;

    /// @notice Buyback venues (governance-chosen, `buybackVenue`).
    uint8 public constant VENUE_UNIV3 = 0;
    uint8 public constant VENUE_UNIV4 = 1;
    /// @notice Active buyback venue (VENUE_UNIV3 by default).
    uint8 public buybackVenue;
    /// @notice Uniswap v4 PoolManager (code checked; VERIFY U2 on RHC). Changing it clears the route.
    address public v4PoolManager;
    /// @notice Hooks a v4 buyback pool may carry (timelock allow-list; a hook can take fees or revert).
    mapping(address hook => bool) public v4HookAllowed;

    /// @notice v4 buyback routes (`V4Route.kind`). Native ETH is v4 currency address(0).
    /// @dev USDG -> BKRN in one v4 pool.
    uint8 public constant ROUTE_DIRECT = 0;
    /// @dev USDG -> ETH (v4 ETH/USDG pool) -> BKRN (v4 ETH/BKRN pool) in one unlock: ETH never leaves the PoolManager.
    uint8 public constant ROUTE_V4_ETH = 1;
    /// @dev USDG -> WETH (v3 `buybackRouter`, tier `v3Fee`) -> unwrap -> ETH -> BKRN (v4 ETH/BKRN pool), all inside
    ///      the unlock (a failure anywhere reverts the whole path).
    uint8 public constant ROUTE_V3_WETH = 2;

    /// @dev The v4 route (bkrnPool.currency1 == 0: not set).
    IBkrnV4Swapper.V4Route private _route;
    /// @notice The v4 executor this router created (holds nothing between buybacks).
    IBkrnV4Swapper public immutable v4Swapper;
    /// @notice Fixed ETH reference: whole settlement token per whole ETH (WAD); splits the via-ETH price limits.
    uint256 public refUsdcPerEthWad;
    /// @notice Fixed BKRN/ETH reference: whole BKRN per whole ETH (WAD), read by REF_FIXED_ETH.
    uint256 public refBkrnPerEthWad;
    /// @notice Hook fee allowance (bps) priced into the price limit of every hop through a hooked pool, so a swap
    ///         stopped at its limit still clears the floor net of the hook's take (review M-1). Timelock-set,
    ///         <= MAX_V4_HOOK_FEE_BPS and below `maxSlippageBps`. A dynamic-fee pool's LP fee belongs in it too.
    uint16 public v4HookFeeBps;
    /// @notice Sanity tolerance (bps) of a via-ETH route's USDG -> ETH hop around the fixed `refUsdcPerEthWad`
    ///         (0 = DEFAULT_V4_ETH_TOLERANCE_BPS, 20%; <= MAX_V4_ETH_TOLERANCE_BPS). It only stops a grossly moved /
    ///         manipulated ETH pool: the ETH -> BKRN hop's limit is set from the ETH the first hop really delivered
    ///         (review 2 M-A), so value is bounded end to end by the floor, not by the ETH reference.
    uint16 public v4EthToleranceBps;
    uint16 public constant DEFAULT_V4_ETH_TOLERANCE_BPS = 2000;
    uint16 public constant MAX_V4_ETH_TOLERANCE_BPS = 5000;
    /// @notice Gas forwarded to every v4 swap (0 = DEFAULT_V4_SWAP_GAS), timelock-set within [MIN, MAX]_V4_SWAP_GAS:
    ///         the swap sees the same gas whatever the transaction's limit, and executeBuyback refuses to start
    ///         (`V4SwapGasTooLow`) without that much plus V4_POST_SWAP_GAS, so a failure it catches never depends on
    ///         the caller's gas limit (review 2 L-1).
    uint32 public v4SwapGas;
    uint32 public constant DEFAULT_V4_SWAP_GAS = 1_000_000;
    uint32 public constant MIN_V4_SWAP_GAS = 200_000;
    uint32 public constant MAX_V4_SWAP_GAS = 5_000_000;
    /// @dev Gas kept for the work after the swap (balances, approvals, the staking notification).
    uint256 private constant V4_POST_SWAP_GAS = 200_000;
    /// @notice Upper bound of `v4HookFeeBps` (10%).
    uint16 public constant MAX_V4_HOOK_FEE_BPS = 1000;
    /// @dev Pips (1e6) and the LP fee flag of a dynamic-fee v4 pool (its LP fee is set by the hook).
    uint256 private constant PIPS = 1e6;
    uint24 private constant DYNAMIC_FEE_FLAG = 0x800000;
    address private constant NATIVE = address(0);

    /// @notice Lifetime carry received (USDC 6dp).
    uint256 public totalCarryReceived;
    /// @notice Lifetime USDC forwarded to the Backstop.
    uint256 public totalToBackstop;
    /// @notice Lifetime USDC swapped in buybacks.
    uint256 public totalBuybackUsdc;
    /// @notice Lifetime BKRN bought back and distributed to stakers.
    uint256 public totalBkrnDistributed;

    error ZeroAddress();
    error ZeroAmount();
    error NotComponent(address caller);
    error NotKeeper(address caller);
    error NotAdmin(address caller);
    error NotConfigured(bytes32 what);
    error CarryNotReceived(uint256 required, uint256 balance);
    error InsufficientPending(uint256 pending, uint256 requested);
    error InsufficientOutput(uint256 received, uint256 minimum);
    error BuybackTooLarge(uint256 amountIn, uint256 maxPerCall);
    error BadBuybackParams();
    error BadTwapParams();
    error BadReferenceSource(uint8 source);
    error TwapDeviation(int24 spotTick, int24 meanTick);
    /// @notice migrate() while this contract is still config.feeRouter().
    error StillCurrent();
    error BadVenue(uint8 venue);
    /// @notice previewBuyback's result (it always reverts: eth_call only): settlement token spent, BKRN out.
    error BuybackPreview(uint256 usdcIn, uint256 bkrnOut);
    /// @notice The v4 swap reverted without data or out of gas: re-raised, so a transaction never "succeeds"
    ///         without swapping (review L-1).
    error V4SwapNoReason();
    /// @notice Not enough gas left to forward `v4SwapGas` and finish the buyback: refused before any swap.
    error V4SwapGasTooLow(uint256 gasLeft, uint256 needed);
    error BadV4Pool();
    /// @notice The pool's price is already past the slippage limit (moved pool / stale reference).
    error V4PriceBeyondLimit(uint160 sqrtPriceX96, uint160 limitX96);
    /// @notice The v4 swapper's reported amounts disagree with the balances.
    error V4DeltaNotSettled();

    /// @notice Buyback router changed.
    event BuybackRouterSet(address router);
    /// @notice Buyback pool fee / reference price / slippage bound / per-call cap changed.
    event BuybackParamsSet(uint24 poolFee, uint256 refBkrnPerUsdcWad, uint16 maxSlippageBps, uint256 maxPerCall);
    /// @notice Oracle price id used as the buyback reference changed (0 = governance price).
    event BkrnPriceIdSet(bytes32 priceId);
    /// @notice Buyback reference source changed (REF_FIXED / REF_TWAP / REF_ATTESTED).
    event ReferenceSourceSet(uint8 source);
    /// @notice TWAP source parameters changed.
    event TwapParamsSet(address pool, uint32 window, uint24 maxTickDeviation);
    /// @notice The whole USDC balance moved to the fee router config now points at (audit 2026-10 D).
    event Migrated(address indexed to, uint256 amount);
    /// @notice USDC acknowledged as pending buyback by notifyMigration.
    event MigrationReceived(address indexed from, uint256 amount);
    /// @notice Buyback venue changed (VENUE_UNIV3 / VENUE_UNIV4).
    event BuybackVenueSet(uint8 venue);
    /// @notice Uniswap v4 PoolManager changed (the route is cleared).
    event V4PoolManagerSet(address poolManager);
    /// @notice A hook was allowed / disallowed for the v4 buyback pools.
    event V4HookAllowedSet(address indexed hook, bool allowed);
    /// @notice The v4 buyback route was set.
    event V4RouteSet(uint8 kind, bytes32 indexed bkrnPoolId, bytes32 ethPoolId, uint24 v3Fee, address weth);
    /// @notice The v4 buyback route was cleared (PoolManager changed or a hook disallowed).
    event V4RouteCleared();
    /// @notice Fixed ETH references changed.
    event EthReferenceSet(uint256 usdcPerEthWad, uint256 bkrnPerEthWad);
    /// @notice VENUE_UNIV4 buyback with no initialized pool set (before graduation): nothing swapped.
    event BuybackDeferred(uint256 amountIn);
    /// @notice A v4 swap ran but spent nothing (no liquidity between the price and the limit): nothing bought.
    event BuybackNoFill(uint256 amountIn);
    /// @notice v4 hook fee allowance / via-ETH first-hop tolerance changed.
    event V4FeesSet(uint16 hookFeeBps, uint16 ethToleranceBps);
    /// @notice Gas forwarded to v4 swaps changed.
    event V4SwapGasSet(uint32 gas);
    /// @notice The v4 unlock reverted (hook or pool): nothing swapped, `amountIn` stays pending.
    event BuybackV4Failed(uint256 amountIn, bytes reason);

    /// @param config_ BookrunnerConfig; `usdc()` and `bkrn()` must already be set.
    constructor(address config_) {
        if (config_ == address(0)) revert ZeroAddress();
        config = IBookrunnerConfig(config_);
        address usdc_ = IBookrunnerConfig(config_).usdc();
        address bkrn_ = IBookrunnerConfig(config_).bkrn();
        if (usdc_ == address(0) || bkrn_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        bkrn = IERC20(bkrn_);
        v4Swapper = new BkrnV4Swapper(config_, usdc_, bkrn_);
    }

    /// @inheritdoc IBkrnFeeRouter
    /// @dev Only a component registered by `config.factory()` (a book's RevenueRouter). The caller must
    ///      have transferred `amount` USDC first. Split: `amount / 2` to buyback, the rest (including an
    ///      odd unit) to the Backstop, which is notified via `IBackstop.notifyDeposit`.
    function notifyCarry(uint256 bookId, uint256 amount) external nonReentrant {
        address factory = config.factory();
        if (factory == address(0) || !IBookFactory(factory).isComponent(msg.sender)) {
            revert NotComponent(msg.sender);
        }
        if (amount == 0) return;
        uint256 required = buybackPending + amount;
        uint256 bal = usdc.balanceOf(address(this));
        if (bal < required) revert CarryNotReceived(required, bal);
        address backstop = config.backstop();
        if (backstop == address(0)) revert NotConfigured("backstop");

        uint256 toBuyback = amount / 2;
        uint256 toBackstop = amount - toBuyback;
        buybackPending += toBuyback;
        totalCarryReceived += amount;
        totalToBackstop += toBackstop;
        emit CarryReceived(bookId, amount, toBuyback, toBackstop);

        usdc.safeTransfer(backstop, toBackstop);
        IBackstop(backstop).notifyDeposit(toBackstop);
    }

    /// @notice Migration (audit 2026-10 D): once the timelock has repointed `config.feeRouter()` to a new
    ///         BkrnFeeRouter, anyone may move this contract's whole USDC balance (the pending buyback plus any
    ///         donation) there; the new router adds it to its `buybackPending` (`notifyMigration`). RevenueRouters
    ///         read `config.feeRouter()` at every distribution, so no new carry arrives here once repointed.
    function migrate() external nonReentrant returns (uint256 moved) {
        address next = config.feeRouter();
        if (next == address(this)) revert StillCurrent();
        if (next == address(0)) revert NotConfigured("feeRouter");
        moved = usdc.balanceOf(address(this));
        buybackPending = 0;
        emit Migrated(next, moved);
        if (moved > 0) {
            usdc.safeTransfer(next, moved);
            BkrnFeeRouter(next).notifyMigration(moved);
        }
    }

    /// @notice Anyone: acknowledges `amount` USDC that has arrived here and is not pending yet (a predecessor's
    ///         `migrate`, or a donation) as pending buyback. Push-then-notify, like notifyCarry.
    function notifyMigration(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 required = buybackPending + amount;
        uint256 bal = usdc.balanceOf(address(this));
        if (bal < required) revert CarryNotReceived(required, bal);
        buybackPending = required;
        emit MigrationReceived(msg.sender, amount);
    }

    /// @inheritdoc IBkrnFeeRouter
    /// @dev KEEPER only, through the pinned `buybackPoolFee` tier, at most `maxBuybackPerCall`. The
    ///      swap's minimum is `max(minBkrnOut, buybackFloor(amountIn))` (the keeper may only tighten the
    ///      on-chain bound) and must be non-zero. The BKRN received is measured by balance delta; any USDC
    ///      the router did not pull returns to `buybackPending`. The approval is reset to zero after the swap.
    function executeBuyback(uint256 amountIn, uint256 minBkrnOut)
        external
        nonReentrant
        returns (uint256 bkrnOut)
    {
        if (!config.hasRole(KEEPER_ROLE, msg.sender)) revert NotKeeper(msg.sender);
        if (amountIn == 0) revert ZeroAmount();
        uint256 pending = buybackPending;
        if (amountIn > pending) revert InsufficientPending(pending, amountIn);
        if (buybackVenue == VENUE_UNIV4) return _buybackV4(amountIn, minBkrnOut, pending);
        address router = buybackRouter;
        if (router == address(0)) revert NotConfigured("buybackRouter");
        uint24 poolFee = buybackPoolFee;
        if (poolFee == 0) revert NotConfigured("buybackParams");
        if (amountIn > maxBuybackPerCall) revert BuybackTooLarge(amountIn, maxBuybackPerCall);
        address staking = config.staking();
        if (staking == address(0)) revert NotConfigured("staking");
        uint256 floor = buybackFloor(amountIn);
        if (minBkrnOut < floor) minBkrnOut = floor;
        if (minBkrnOut == 0) revert ZeroAmount();

        buybackPending = pending - amountIn;

        uint256 usdcBefore = usdc.balanceOf(address(this));
        uint256 bkrnBefore = bkrn.balanceOf(address(this));
        usdc.forceApprove(router, amountIn);
        ISwapRouter02(router)
            .exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: address(usdc),
                    tokenOut: address(bkrn),
                    fee: poolFee,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: minBkrnOut,
                    sqrtPriceLimitX96: 0
                })
            );
        usdc.forceApprove(router, 0);

        uint256 usdcAfter = usdc.balanceOf(address(this));
        uint256 spent = usdcBefore > usdcAfter ? usdcBefore - usdcAfter : 0;
        // spent <= amountIn: the router's allowance is exactly amountIn.
        if (spent < amountIn) buybackPending += amountIn - spent;
        bkrnOut = bkrn.balanceOf(address(this)) - bkrnBefore;
        if (bkrnOut < minBkrnOut) revert InsufficientOutput(bkrnOut, minBkrnOut);

        totalBuybackUsdc += spent;
        totalBkrnDistributed += bkrnOut;
        emit BuybackExecuted(spent, bkrnOut);

        bkrn.safeTransfer(staking, bkrnOut);
        IBkrnStaking(staking).notifyReward(bkrnOut);
    }

    /// @notice Reference price: whole BKRN per whole settlement token (WAD), from `referenceSource`:
    ///         REF_FIXED `refBkrnPerUsdcWad`; REF_TWAP `twapBkrnPerUsdc()`; REF_ATTESTED the AttestedOracle
    ///         price of `bkrnPriceId` (reverts `StalePrice` when stale; settlement token valued at $1).
    function referenceBkrnPerUsdc() public view returns (uint256) {
        uint8 src = referenceSource;
        if (src == REF_TWAP) return twapBkrnPerUsdc();
        if (src == REF_FIXED_ETH) return Math.mulDiv(refBkrnPerEthWad, WAD, refUsdcPerEthWad);
        if (src == REF_ATTESTED) {
            address oracle = config.oracle();
            if (oracle == address(0)) revert NotConfigured("oracle");
            (uint256 usdPerBkrn,) = IAttestedOracle(oracle).priceOf(bkrnPriceId);
            if (usdPerBkrn == 0) revert NotConfigured("bkrnPrice");
            return (WAD * WAD) / usdPerBkrn;
        }
        return refBkrnPerUsdcWad;
    }

    /// @notice TWAP of `twapPool` over `twapWindow`: whole BKRN per whole settlement token (WAD). Reverts
    ///         `TwapDeviation` when the spot tick is more than `twapMaxTickDeviation` from the mean tick,
    ///         and (in the pool: "OLD") when its observation buffer does not cover the window.
    function twapBkrnPerUsdc() public view returns (uint256) {
        address pool = twapPool;
        if (pool == address(0)) revert NotConfigured("twap");
        int24 mean = UniswapV3Twap.meanTick(pool, twapWindow);
        int24 spot = UniswapV3Twap.spotTick(pool);
        int256 d = int256(spot) - int256(mean);
        if ((d < 0 ? -d : d) > int256(uint256(twapMaxTickDeviation))) revert TwapDeviation(spot, mean);
        // BKRN raw (18dp) for one whole settlement token (6dp) == whole BKRN per whole token, in WAD.
        return UniswapV3Twap.quoteAtTick(mean, uint128(USDC_UNIT), address(usdc), address(bkrn));
    }

    /// @notice Minimum BKRN any buyback of `amountIn` USDC must return:
    ///         `amountIn x referenceBkrnPerUsdc() x (10000 - maxSlippageBps) / 10000` (floored).
    function buybackFloor(uint256 amountIn) public view returns (uint256) {
        return _floorAt(amountIn, referenceBkrnPerUsdc());
    }

    function _floorAt(uint256 amountIn, uint256 ref) private view returns (uint256) {
        return Math.mulDiv(Math.mulDiv(amountIn, ref, USDC_UNIT), BPS - maxSlippageBps, BPS);
    }

    // ------------------------------------------------------------------------------------------- Uniswap v4

    /// @dev VENUE_UNIV4 buyback; `pending` = buybackPending (>= amountIn). A no-op before graduation (no route, or
    ///      a v4 pool of the route uninitialized). Every hop's price is checked against its limit first, then
    ///      the whole path runs inside one PoolManager unlock under try/catch: a hook / pool / hop revert leaves
    ///      everything as it was. The keeper minimum is pro-rated to the input actually spent (the first hop's
    ///      price limit may stop it early) and the output must clear `buybackFloor(spent)` (the whole path).
    function _buybackV4(uint256 amountIn, uint256 minBkrnOut, uint256 pending) private returns (uint256 bkrnOut) {
        address staking = _v4Checks(amountIn);
        if (!_v4RouteLive()) {
            emit BuybackDeferred(amountIn);
            return 0;
        }
        uint256 ref = referenceBkrnPerUsdc();
        IBkrnV4Swapper.V4Job memory job = _checkedJob(amountIn, ref);

        buybackPending = pending - amountIn;
        uint256 spent;
        bool failed;
        (spent, bkrnOut, failed) = _runV4(job);
        if (spent < amountIn) buybackPending += amountIn - spent; // a caught failure spends nothing
        if (spent == 0) {
            // a caught failure (BuybackV4Failed emitted) or no fill: zero liquidity up to the limit (review L-2)
            if (bkrnOut != 0) revert V4DeltaNotSettled();
            if (!failed) emit BuybackNoFill(amountIn);
            return 0;
        }
        uint256 minOut = Math.max(Math.mulDiv(minBkrnOut, spent, amountIn, Math.Rounding.Ceil), _floorAt(spent, ref));
        if (bkrnOut == 0 || bkrnOut < minOut) revert InsufficientOutput(bkrnOut, minOut);

        totalBuybackUsdc += spent;
        totalBkrnDistributed += bkrnOut;
        emit BuybackExecuted(spent, bkrnOut);

        bkrn.safeTransfer(staking, bkrnOut);
        IBkrnStaking(staking).notifyReward(bkrnOut);
    }

    /// @dev Size and wiring checks shared by executeBuyback (v4) and previewBuyback; returns staking.
    function _v4Checks(uint256 amountIn) private view returns (address staking) {
        uint256 maxPerCall = maxBuybackPerCall;
        if (maxPerCall == 0) revert NotConfigured("buybackParams");
        if (amountIn > maxPerCall) revert BuybackTooLarge(amountIn, maxPerCall);
        staking = config.staking();
        if (staking == address(0)) revert NotConfigured("staking");
    }

    /// @notice KEEPER, eth_call only: runs the v4 swap `executeBuyback(amountIn, 0)` would run and always reverts
    ///         `BuybackPreview(usdcIn, bkrnOut)` (both 0 when the swap fails inside the unlock), so the keeper sets
    ///         its minimum from a simulated fill instead of the fixed floor alone (review M-2). VENUE_UNIV4 with a
    ///         live route only; reverts like executeBuyback otherwise (V4PriceBeyondLimit, NotConfigured, ...).
    function previewBuyback(uint256 amountIn) external returns (uint256, uint256) {
        // always reverts (nothing persists); refused inside another entry point all the same
        if (_reentrancyGuardEntered()) revert ReentrancyGuardReentrantCall();
        if (!config.hasRole(KEEPER_ROLE, msg.sender)) revert NotKeeper(msg.sender);
        if (buybackVenue != VENUE_UNIV4) revert BadVenue(buybackVenue);
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > buybackPending) revert InsufficientPending(buybackPending, amountIn);
        _v4Checks(amountIn);
        if (!_v4RouteLive()) revert NotConfigured("v4Route");
        (uint256 spent, uint256 out,) = _runV4(_checkedJob(amountIn, referenceBkrnPerUsdc()));
        revert BuybackPreview(spent, out);
    }

    /// @dev `_v4Job` with every v4 pool checked against its limit (V4PriceBeyondLimit when already past it).
    function _checkedJob(uint256 amountIn, uint256 ref) private view returns (IBkrnV4Swapper.V4Job memory job) {
        job = _v4Job(amountIn, ref);
        (uint8 hop, uint160 p, uint160 limit) = _blocked(job);
        if (hop != 0) revert V4PriceBeyondLimit(p, limit);
    }

    /// @dev Runs `job` through `v4Swapper` (one PoolManager unlock; exact allowance of `amountIn`, reset after);
    ///      (settlement token spent, BKRN received), both measured by balance and required to match what the
    ///      swapper reports. A revert inside the swap with data is caught: `BuybackV4Failed`, (0, 0), nothing
    ///      moved; one without data (a bare revert) or that burnt the call's gas (out of gas at any depth) is
    ///      re-raised (`V4SwapNoReason`), so a gas-starved call reverts instead of landing without a swap (L-1).
    function _runV4(IBkrnV4Swapper.V4Job memory job) private returns (uint256 spent, uint256 bkrnOut, bool failed) {
        uint256 usdcBefore = usdc.balanceOf(address(this));
        uint256 bkrnBefore = bkrn.balanceOf(address(this));
        address swapper = address(v4Swapper);
        uint256 swapGas = v4SwapGas == 0 ? DEFAULT_V4_SWAP_GAS : v4SwapGas;
        uint256 needed = (swapGas * 64) / 63 + V4_POST_SWAP_GAS;
        if (gasleft() < needed) revert V4SwapGasTooLow(gasleft(), needed);
        usdc.forceApprove(swapper, job.amountIn);
        uint256 gasBefore = gasleft();
        try v4Swapper.swap{gas: swapGas}(v4PoolManager, job) returns (uint256 paid, uint256 out) {
            usdc.forceApprove(swapper, 0);
            uint256 usdcAfter = usdc.balanceOf(address(this));
            spent = usdcBefore > usdcAfter ? usdcBefore - usdcAfter : 0;
            bkrnOut = bkrn.balanceOf(address(this)) - bkrnBefore;
            // the swapper paid exactly `paid` (<= amountIn, the allowance) and sent `out`; a mismatch = a broken venue
            if (spent != paid || bkrnOut != out) revert V4DeltaNotSettled();
        } catch (bytes memory reason) {
            // the swap had exactly `swapGas`: a revert that burnt most of it is an out-of-gas at some depth (v4 wraps
            // a hook's revert, so the data need not be empty), i.e. `v4SwapGas` is too low for this route; with no
            // data, or too little gas left here, re-raise too: a transaction never lands without a swap
            if (reason.length == 0 || gasBefore - gasleft() > (swapGas * 7) / 8 || gasleft() < V4_POST_SWAP_GAS / 2) {
                revert V4SwapNoReason();
            }
            usdc.forceApprove(swapper, 0);
            emit BuybackV4Failed(job.amountIn, reason);
            return (0, 0, true);
        }
    }

    /// @dev The swap job for `amountIn` at the reference `ref` (whole BKRN per whole settlement token) with
    ///      per-hop price limits (checked against the pools by `_blocked`).
    ///      A limit is the worst MARGINAL gross price the hop may reach. It is set so that the hop's NET output
    ///      at that price (less the pool's static LP fee and, for a hooked pool, `v4HookFeeBps`) still meets the
    ///      floor, plus 1 bp for rounding (review M-1): a swap stopped at its limit clears the floor, so the
    ///      unspent input simply stays pending. Via ETH (review 2 M-A): hop 0 only has to stay within the wide
    ///      `v4EthToleranceBps` of the fixed ETH reference (a sanity bound on a moved ETH pool); hop 1's limit is
    ///      computed in the swapper from the ETH hop 0 really delivered, so paid USDG -> ETH -> BKRN meets the floor
    ///      price `minBkrnPerUsdcWad` net of the BKRN pool's fees, whatever ETH did. A hook taking more than its
    ///      allowance only makes the floor refuse (InsufficientOutput).
    function _v4Job(uint256 amountIn, uint256 ref) private view returns (IBkrnV4Swapper.V4Job memory job) {
        job.route = _route;
        job.amountIn = amountIn;
        job.v3Router = buybackRouter;
        uint256 floorPrice = Math.mulDiv(ref, BPS - maxSlippageBps, BPS); // net BKRN per USDG, whole, WAD
        address u = address(usdc);
        if (job.route.kind == ROUTE_DIRECT) {
            bool zfo = job.route.bkrnPool.currency0 == u;
            job.limit0 = UniswapV4Lib.priceLimit(UniswapV4Lib.grossPrice(floorPrice, _netPpm(job.route.bkrnPool)), 6, 18, zfo);
            return job;
        }
        // via ETH: hop 0 only within a wide tolerance of the fixed ETH reference; hop 1's limit is set in the
        // swapper from the ETH hop 0 really delivered, against this floor price
        job.minBkrnPerUsdcWad = floorPrice;
        job.bkrnNetPpm = _netPpm(job.route.bkrnPool);
        uint256 ethRef = refUsdcPerEthWad;
        if (ethRef == 0) revert NotConfigured("ethReference");
        uint256 tol = v4EthToleranceBps == 0 ? DEFAULT_V4_ETH_TOLERANCE_BPS : v4EthToleranceBps;
        uint256 minEthPerUsdc = Math.mulDiv(WAD * WAD, BPS - tol, ethRef * BPS); // net
        if (job.route.kind == ROUTE_V4_ETH) {
            bool zfo0 = job.route.ethPool.currency0 == u;
            job.limit0 = UniswapV4Lib.priceLimit(UniswapV4Lib.grossPrice(minEthPerUsdc, _netPpm(job.route.ethPool)), 6, 18, zfo0);
        } else {
            job.limit0 = UniswapV4Lib.priceLimit(
                UniswapV4Lib.grossPrice(minEthPerUsdc, PIPS - job.route.v3Fee), 6, 18, u < job.route.weth
            );
        }
    }

    /// @dev Net output share (ppm) of a v4 pool's gross price: less its static LP fee and, if hooked, v4HookFeeBps.
    function _netPpm(IV4PoolManager.PoolKey memory key) private view returns (uint256) {
        uint256 lp = (key.fee & DYNAMIC_FEE_FLAG) != 0 || key.fee >= PIPS ? 0 : key.fee;
        uint256 h = key.hooks == address(0) ? 0 : uint256(v4HookFeeBps) * 100;
        return Math.mulDiv(PIPS - lp, PIPS - h, PIPS);
    }


    /// @dev The first v4 pool of `job` already past its limit (no fill possible): (hop, its sqrtPrice, the limit);
    ///      hop 1 = the first hop (direct pool or ETH/USDG within its tolerance), 0 = none. The ETH -> BKRN hop's
    ///      limit depends on the first hop's real fill and is checked in the swapper; the v3 hop of ROUTE_V3_WETH
    ///      is not pre-checked (its pool reverts "SPL" inside the unlock: caught).
    function _blocked(IBkrnV4Swapper.V4Job memory job) private view returns (uint8, uint160, uint160) {
        address u = address(usdc);
        if (job.route.kind == ROUTE_DIRECT) {
            (bool past, uint160 p) = _past(job.route.bkrnPool, job.route.bkrnPool.currency0 == u, job.limit0);
            return past ? (1, p, job.limit0) : (0, 0, 0);
        }
        if (job.route.kind == ROUTE_V4_ETH) {
            (bool past0, uint160 p0) = _past(job.route.ethPool, job.route.ethPool.currency0 == u, job.limit0);
            if (past0) return (1, p0, job.limit0);
        }
        return (0, 0, 0);
    }

    function _past(IV4PoolManager.PoolKey memory key, bool zeroForOne, uint160 limit) private view returns (bool, uint160) {
        uint160 p = UniswapV4Lib.sqrtPriceX96(v4PoolManager, key);
        return (zeroForOne ? p <= limit : p >= limit, p);
    }

    /// @notice Which hop of the live v4 route would stop a buyback now: 0 none (or venue v3 / no live route), 1 the
    ///         first hop (the direct pool, or ETH/USDG beyond its tolerance of the ETH reference), 2 the ETH -> BKRN
    ///         hop (ROUTE_V4_ETH: estimated from the ETH/USDG pool's spot; it cannot meet the floor price: the BKRN
    ///         reference is stale or BKRN fell). Read by services/alerts `buyback_v4_reference_stale`. Reverts only
    ///         when the reference does (stale oracle).
    function v4BlockedHop() external view returns (uint8 hop) {
        if (buybackVenue != VENUE_UNIV4 || !_v4RouteLive()) return 0;
        IBkrnV4Swapper.V4Job memory job = _v4Job(0, referenceBkrnPerUsdc());
        (hop,,) = _blocked(job);
        if (hop != 0 || job.route.kind != ROUTE_V4_ETH) return hop;
        // ETH -> BKRN: the net BKRN per ETH the floor needs at the ETH pool's spot (ETH is currency0)
        uint256 sp = UniswapV4Lib.sqrtPriceX96(v4PoolManager, job.route.ethPool);
        uint256 usdcPerEthWad = Math.mulDiv(Math.mulDiv(sp, sp, 1 << 96), 1e30, 1 << 96); // whole USDG per ETH
        uint256 minNet = Math.mulDiv(job.minBkrnPerUsdcWad, usdcPerEthWad, WAD) * PIPS / _netPpm(job.route.ethPool);
        uint160 limit1 = UniswapV4Lib.priceLimit(UniswapV4Lib.grossPrice(minNet, job.bkrnNetPpm), 18, 18, true);
        (bool past1,) = _past(job.route.bkrnPool, true, limit1);
        return past1 ? 2 : 0;
    }

    /// @notice The v4 buyback route (bkrnPool.currency1 == 0: not set).
    function v4Route() external view returns (IBkrnV4Swapper.V4Route memory) {
        return _route;
    }

    /// @notice Whether a buyback would swap on v4 now: VENUE_UNIV4 and every v4 pool of the route initialized.
    ///         False with VENUE_UNIV4 = buybacks defer (before graduation).
    function v4BuybackReady() external view returns (bool) {
        return buybackVenue == VENUE_UNIV4 && _v4RouteLive();
    }

    function _v4RouteLive() private view returns (bool) {
        address m = v4PoolManager;
        if (m == address(0) || _route.bkrnPool.currency1 == address(0)) return false;
        if (UniswapV4Lib.sqrtPriceX96(m, _route.bkrnPool) == 0) return false;
        return _route.kind != ROUTE_V4_ETH || UniswapV4Lib.sqrtPriceX96(m, _route.ethPool) != 0;
    }

    /// @notice Selects the buyback venue. VENUE_UNIV4 refuses REF_TWAP (v4 has no TWAP oracle) and may be selected
    ///         before the pool exists (buybacks defer until `setV4Route`). Config admin (timelock) only.
    function setBuybackVenue(uint8 venue) external {
        _onlyAdmin();
        if (venue > VENUE_UNIV4 || (venue == VENUE_UNIV4 && referenceSource == REF_TWAP)) revert BadVenue(venue);
        buybackVenue = venue;
        emit BuybackVenueSet(venue);
    }

    /// @notice Sets the hook fee allowance priced into hooked hops' limits (<= MAX_V4_HOOK_FEE_BPS, below
    ///         `maxSlippageBps`) and the via-ETH first-hop sanity tolerance around `refUsdcPerEthWad` (0 = 20%,
    ///         <= MAX_V4_ETH_TOLERANCE_BPS). Config admin (timelock) only.
    function setV4Fees(uint16 hookFeeBps, uint16 ethToleranceBps) external {
        _onlyAdmin();
        if (
            hookFeeBps > MAX_V4_HOOK_FEE_BPS || ethToleranceBps > MAX_V4_ETH_TOLERANCE_BPS
                || !_feesFit(hookFeeBps, maxSlippageBps)
        ) revert BadBuybackParams();
        v4HookFeeBps = hookFeeBps;
        v4EthToleranceBps = ethToleranceBps;
        emit V4FeesSet(hookFeeBps, ethToleranceBps);
    }

    /// @dev The hook fee allowance stays strictly below the slippage (else every hooked limit sits past the pool).
    function _feesFit(uint16 hookFeeBps, uint16 slippageBps) private pure returns (bool) {
        return hookFeeBps == 0 || hookFeeBps < slippageBps;
    }

    /// @notice Sets the gas forwarded to every v4 swap (0 = DEFAULT_V4_SWAP_GAS; else within [MIN, MAX]_V4_SWAP_GAS).
    ///         Size it above the route's measured swap gas (fork: ~0.35M for a Pons-hooked V3_WETH swap) with margin:
    ///         a swap running out of it reverts the buyback (`V4SwapNoReason`). Config admin (timelock) only.
    function setV4SwapGas(uint32 gas) external {
        _onlyAdmin();
        if (gas != 0 && (gas < MIN_V4_SWAP_GAS || gas > MAX_V4_SWAP_GAS)) revert BadBuybackParams();
        v4SwapGas = gas;
        emit V4SwapGasSet(gas);
    }

    /// @notice Sets the Uniswap v4 PoolManager (must have code) and clears the route. Config admin only.
    function setV4PoolManager(address manager) external {
        _onlyAdmin();
        if (manager.code.length == 0) revert BadV4Pool();
        v4PoolManager = manager;
        emit V4PoolManagerSet(manager);
        _clearRoute();
    }

    /// @notice Allows / disallows a hook for the v4 buyback pools (a hook can take fees or revert: fees are bounded
    ///         by the floor, a reverting hook only makes buybacks fail safe with `BuybackV4Failed`). Disallowing a
    ///         hook of the current route clears the route. Config admin (timelock) only.
    function setV4HookAllowed(address hook, bool allowed) external {
        _onlyAdmin();
        if (hook == address(0) || (allowed && hook.code.length == 0)) revert BadV4Pool();
        v4HookAllowed[hook] = allowed;
        emit V4HookAllowedSet(hook, allowed);
        if (!allowed && (_route.bkrnPool.hooks == hook || _route.ethPool.hooks == hook)) _clearRoute();
    }

    /// @notice Fixed ETH reference (whole settlement token per whole ETH, WAD, > 0): splits the via-ETH price limits
    ///         and, with `bkrnPerEthWad` (whole BKRN per whole ETH, 0 = unset), feeds REF_FIXED_ETH
    ///         (BKRN/ETH x ETH/USD). No ETH/USD feed on Robinhood Chain is wired (none verified): keep it near market
    ///         (a stale value only makes via-ETH buybacks stop early or fail safe). Config admin (timelock) only.
    function setEthReference(uint256 usdcPerEthWad, uint256 bkrnPerEthWad) external {
        _onlyAdmin();
        if (usdcPerEthWad == 0 || (bkrnPerEthWad == 0 && referenceSource == REF_FIXED_ETH)) revert BadBuybackParams();
        refUsdcPerEthWad = usdcPerEthWad;
        refBkrnPerEthWad = bkrnPerEthWad;
        emit EthReferenceSet(usdcPerEthWad, bkrnPerEthWad);
    }

    /// @notice Sets the v4 buyback route (discovery is off-chain: scripts/buyback-route.ts; an on-chain choice could
    ///         be steered). Pools must be initialized on `v4PoolManager`, their hooks 0 or allow-listed, and:
    ///           - ROUTE_DIRECT: `bkrnPool` = {settlement token, BKRN} (v4 order); `ethPool`, `v3Fee`, `weth` zero;
    ///           - ROUTE_V4_ETH: `bkrnPool` = {native ETH, BKRN}, `ethPool` = {native ETH, settlement token};
    ///             `v3Fee`, `weth` zero; `refUsdcPerEthWad` set;
    ///           - ROUTE_V3_WETH: `bkrnPool` = {native ETH, BKRN}, `ethPool` zero, `v3Fee` in (0, 1e6), `weth` with
    ///             code (WETH9), `buybackRouter` set (SwapRouter02, its USDG/WETH `v3Fee` pool); `refUsdcPerEthWad` set.
    ///         Config admin (timelock) only.
    function setV4Route(IBkrnV4Swapper.V4Route calldata r) external {
        _onlyAdmin();
        address m = v4PoolManager;
        if (m == address(0)) revert NotConfigured("v4PoolManager");
        (address u, address b) = (address(usdc), address(bkrn));
        bool viaEth = r.kind != ROUTE_DIRECT;
        if (r.kind > ROUTE_V3_WETH) revert BadV4Pool();
        if (viaEth && refUsdcPerEthWad == 0) revert NotConfigured("ethReference");
        if (viaEth ? !_pair(r.bkrnPool, NATIVE, b) : !_pair(r.bkrnPool, u, b)) revert BadV4Pool();
        _checkPool(m, r.bkrnPool);
        if (r.kind == ROUTE_V4_ETH) {
            if (!_pair(r.ethPool, NATIVE, u) || r.v3Fee != 0 || r.weth != address(0)) revert BadV4Pool();
            _checkPool(m, r.ethPool);
        } else {
            if (!_isEmpty(r.ethPool)) revert BadV4Pool();
            if (r.kind == ROUTE_V3_WETH) {
                if (r.v3Fee == 0 || r.v3Fee >= 1e6 || r.weth.code.length == 0) revert BadV4Pool();
                if (buybackRouter == address(0)) revert NotConfigured("buybackRouter");
            } else if (r.v3Fee != 0 || r.weth != address(0)) {
                revert BadV4Pool();
            }
        }
        _route = r;
        emit V4RouteSet(
            r.kind,
            UniswapV4Lib.poolId(r.bkrnPool),
            r.kind == ROUTE_V4_ETH ? UniswapV4Lib.poolId(r.ethPool) : bytes32(0),
            r.v3Fee,
            r.weth
        );
    }

    /// @dev `key` is exactly the pair {a, b} in v4 order (currency0 < currency1).
    function _pair(IV4PoolManager.PoolKey calldata key, address a, address b) private pure returns (bool) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return key.currency0 == c0 && key.currency1 == c1;
    }

    function _isEmpty(IV4PoolManager.PoolKey calldata key) private pure returns (bool) {
        return key.currency0 == address(0) && key.currency1 == address(0) && key.fee == 0 && key.tickSpacing == 0
            && key.hooks == address(0);
    }

    function _checkPool(address m, IV4PoolManager.PoolKey calldata key) private view {
        if (key.hooks != address(0) && !v4HookAllowed[key.hooks]) revert BadV4Pool();
        if (UniswapV4Lib.sqrtPriceX96(m, key) == 0) revert BadV4Pool();
    }

    function _clearRoute() private {
        if (_route.bkrnPool.currency1 == address(0)) return;
        delete _route;
        emit V4RouteCleared();
    }

    /// @notice Pins the buyback pool fee tier and sets the price bound. Config admin (timelock) only.
    /// @param poolFee Uniswap v3 fee tier of the deep BKRN/USDC pool (VERIFY on RHC); 0 = no v3 pool (VENUE_UNIV3
    ///        buybacks revert NotConfigured; VENUE_UNIV4 uses the fee of its pool key).
    /// @param refBkrnPerUsdcWad_ Reference price, whole BKRN per whole USDC (WAD, > 0); used while
    ///        `bkrnPriceId` is unset. Must be kept near market: too high stalls buybacks (fail-safe),
    ///        too low loosens the bound (bounded by `maxPerCall`).
    /// @param maxSlippageBps_ Tolerance below the reference (<= MAX_SLIPPAGE_BPS).
    /// @param maxPerCall Max USDC (6dp) per executeBuyback (> 0).
    function setBuybackParams(uint24 poolFee, uint256 refBkrnPerUsdcWad_, uint16 maxSlippageBps_, uint256 maxPerCall)
        external
    {
        if (!config.hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        if (
            refBkrnPerUsdcWad_ == 0 || maxSlippageBps_ > MAX_SLIPPAGE_BPS || maxPerCall == 0
                || !_feesFit(v4HookFeeBps, maxSlippageBps_)
        ) {
            revert BadBuybackParams();
        }
        buybackPoolFee = poolFee;
        refBkrnPerUsdcWad = refBkrnPerUsdcWad_;
        maxSlippageBps = maxSlippageBps_;
        maxBuybackPerCall = maxPerCall;
        emit BuybackParamsSet(poolFee, refBkrnPerUsdcWad_, maxSlippageBps_, maxPerCall);
    }

    /// @notice Sets the AttestedOracle price id of BKRN (USD per BKRN) and selects REF_ATTESTED; 0 clears
    ///         it and, if REF_ATTESTED was active, returns to REF_FIXED. Config admin (timelock) only.
    function setBkrnPriceId(bytes32 priceId) external {
        _onlyAdmin();
        bkrnPriceId = priceId;
        emit BkrnPriceIdSet(priceId);
        if (priceId != bytes32(0)) _setReferenceSource(REF_ATTESTED);
        else if (referenceSource == REF_ATTESTED) _setReferenceSource(REF_FIXED);
    }

    /// @notice Configures the TWAP source (does not select it). Config admin (timelock) only.
    /// @param pool Uniswap v3 pool whose tokens are exactly {settlement token, BKRN} (VERIFY: the deep BKRN
    ///        pool on RHC; its observation cardinality must cover `window`, else reads revert "OLD").
    /// @param window Averaging window in seconds, in [MIN_TWAP_WINDOW, MAX_TWAP_WINDOW].
    /// @param maxTickDeviation Max |spot - mean| in ticks, in [1, MAX_TWAP_TICK_DEVIATION].
    function setTwapParams(address pool, uint32 window, uint24 maxTickDeviation) external {
        _onlyAdmin();
        if (pool.code.length == 0) revert BadTwapParams();
        if (window < MIN_TWAP_WINDOW || window > MAX_TWAP_WINDOW) revert BadTwapParams();
        if (maxTickDeviation == 0 || maxTickDeviation > MAX_TWAP_TICK_DEVIATION) revert BadTwapParams();
        address t0 = IUniswapV3PoolView(pool).token0();
        address t1 = IUniswapV3PoolView(pool).token1();
        (address u, address b) = (address(usdc), address(bkrn));
        if (!((t0 == u && t1 == b) || (t0 == b && t1 == u))) revert BadTwapParams();
        twapPool = pool;
        twapWindow = window;
        twapMaxTickDeviation = maxTickDeviation;
        emit TwapParamsSet(pool, window, maxTickDeviation);
    }

    /// @notice Selects the buyback reference source, which must be configured (REF_FIXED: buyback params
    ///         set; REF_TWAP: `setTwapParams`, never with VENUE_UNIV4; REF_ATTESTED: `bkrnPriceId`). Config admin
    ///         (timelock) only.
    function setReferenceSource(uint8 source) external {
        _onlyAdmin();
        bool ok = source == REF_FIXED
            ? refBkrnPerUsdcWad != 0
            : source == REF_TWAP
                ? twapPool != address(0) && buybackVenue != VENUE_UNIV4
                : source == REF_ATTESTED
                    ? bkrnPriceId != bytes32(0)
                    : source == REF_FIXED_ETH && refBkrnPerEthWad != 0 && refUsdcPerEthWad != 0;
        if (!ok) revert BadReferenceSource(source);
        _setReferenceSource(source);
    }

    function _setReferenceSource(uint8 source) private {
        referenceSource = source;
        emit ReferenceSourceSet(source);
    }

    function _onlyAdmin() private view {
        if (!config.hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
    }

    /// @notice Sets the buyback router. Config admin (timelock) only.
    function setBuybackRouter(address router) external {
        if (!config.hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        if (router == address(0)) revert ZeroAddress();
        buybackRouter = router;
        emit BuybackRouterSet(router);
    }
}
