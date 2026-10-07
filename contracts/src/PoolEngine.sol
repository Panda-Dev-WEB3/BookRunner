// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolEngine} from "./interfaces/IPoolEngine.sol";
import {IAttestedOracle} from "./interfaces/IAttestedOracle.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {IBookFactory} from "./interfaces/IBookFactory.sol";

/// @title IBookrunnerConfigTradeAge — LOW_GAS.md §1 parameter read by the engine.
/// @dev Implemented by BookrunnerConfig; kept off IBookrunnerConfig so existing config stand-ins compile.
interface IBookrunnerConfigTradeAge {
    /// @notice Max age (seconds) of the price any engine trade may use.
    function maxTradePriceAge() external view returns (uint32);
}

/// @title PoolEngineMath — fixed-point helpers for PoolEngine (pure, internal).
/// @dev Units: size 1e18 = 1 unit; prices WAD; "wadUsd" = USD with 18 decimals; "usd" = USD 6 decimals.
library PoolEngineMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 1e4;
    /// @dev wadUsd -> usd (6dp)
    int256 internal constant WAD_TO_USD = 1e12;
    /// @dev size(1e18) * price(1e18) -> usd (6dp)
    uint256 internal constant SIZE_PRICE_TO_USD = 1e30;

    function abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }

    /// @dev floor(a / b) for b > 0 (rounds toward -inf).
    function floorDiv(int256 a, int256 b) internal pure returns (int256 q) {
        q = a / b;
        if (a % b != 0 && a < 0) q -= 1;
    }

    /// @dev ceil(a / b) for b > 0 (rounds toward +inf).
    function ceilDiv(int256 a, int256 b) internal pure returns (int256 q) {
        q = a / b;
        if (a % b != 0 && a > 0) q += 1;
    }

    /// @dev size * price / 1e18 (wadUsd), truncated toward zero. Used symmetrically for aggregates.
    function contrib(int256 size, uint256 priceLike) internal pure returns (int256) {
        return (size * int256(priceLike)) / int256(WAD);
    }

    /// @dev size * index / 1e18 (wadUsd), truncated toward zero.
    function contribSigned(int256 size, int256 index) internal pure returns (int256) {
        return (size * index) / int256(WAD);
    }

    /// @dev |size| * price in usd (6dp), floor.
    function notionalUsd(int256 size, uint256 price) internal pure returns (uint256) {
        return Math.mulDiv(abs(size), price, SIZE_PRICE_TO_USD);
    }

    /// @dev ceil(|size| * price * bps / 1e4) in usd (6dp): a margin requirement.
    function requirementUsd(int256 size, uint256 price, uint256 bps) internal pure returns (uint256) {
        return Math.mulDiv(abs(size), price * bps, SIZE_PRICE_TO_USD * BPS, Math.Rounding.Ceil);
    }

    /// @dev Trader PnL of `size` opened at `entry` valued at `price`, usd (6dp), floored (against trader).
    function pnlUsd(int256 size, uint256 entry, uint256 price) internal pure returns (int256) {
        return floorDiv(size * (int256(price) - int256(entry)), int256(SIZE_PRICE_TO_USD));
    }

    /// @dev Funding owed BY the trader (positive) or TO the trader (negative), usd (6dp), ceiled
    ///      (in the pool's favour).
    function fundingOwedUsd(int256 size, int256 indexNow, int256 indexAtEntry)
        internal
        pure
        returns (int256)
    {
        return ceilDiv(size * (indexNow - indexAtEntry), int256(WAD) * WAD_TO_USD);
    }

    /// @dev True when the move old -> new opens, increases or flips a position.
    function isNewRisk(int256 oldSize, int256 newSize) internal pure returns (bool) {
        if (newSize == 0) return false;
        if (oldSize == 0) return true;
        if ((oldSize > 0) != (newSize > 0)) return true;
        return abs(newSize) > abs(oldSize);
    }

    /// @dev Average-entry update. Increases average in (rounded against the trader); reductions keep the
    ///      entry; flips/open take the fill; a full close resets to 0.
    function newEntry(int256 oldSize, int256 newSize, uint256 oldEntry, uint256 fill)
        internal
        pure
        returns (uint256)
    {
        if (newSize == 0) return 0;
        if (oldSize == 0 || (oldSize > 0) != (newSize > 0)) return fill;
        uint256 absOld = abs(oldSize);
        uint256 absNew = abs(newSize);
        if (absNew <= absOld) return oldEntry;
        uint256 num = absOld * oldEntry + (absNew - absOld) * fill;
        return newSize > 0 ? Math.ceilDiv(num, absNew) : num / absNew;
    }

    /// @dev Signed size closed by `delta` against `oldSize` (same sign as oldSize; 0 if no reduction).
    function closedSize(int256 oldSize, int256 delta) internal pure returns (int256) {
        if (oldSize == 0 || (oldSize > 0) == (delta > 0)) return 0;
        uint256 c = Math.min(abs(oldSize), abs(delta));
        return oldSize > 0 ? int256(c) : -int256(c);
    }

    /// @dev wadUsd -> usd floored.
    function wadToUsdFloor(int256 x) internal pure returns (int256) {
        return floorDiv(x, WAD_TO_USD);
    }
}

/// @title PoolEngine — in-house pool-vs-trader perpetual engine shared by every in-house book.
/// @notice One market per in-house book, owned by that book's PoolEngineAdapter. The book's MM capital is
///         the pool (counterparty to all traders); the book's IF absorbs bad debt; once the IF is empty the
///         shortfall is socialised inside that market only (ADL) — markets never share balances.
///         Isolated margin, average-entry positions, skew-based funding on a cumulative index, O(1)
///         aggregate accounting (no loops over traders anywhere).
/// @dev    Non-upgradeable (ARCHITECTURE §2.0, §2.8). Conservation: for every market,
///         poolCash + insurance + feesAccrued + totalMargin is exactly the USDC this contract holds for it.
///         Every voluntary trade (open, increase, reduce, close, flip) needs a live price no older than
///         min(maxPriceAge, NEW_RISK_MAX_PRICE_AGE, maxTradePriceAge): off-hours (oracle `held`) or stale, no
///         trade fills (a held / stale price is a free option against the pool, audit A2-01 / A2-03). A
///         margin withdrawal with a position needs a non-held price no older than
///         min(maxPriceAge, NEW_RISK_MAX_PRICE_AGE). Market reduce-only blocks new risk only. Margin top-ups,
///         liquidations and wind-down close-outs keep working at the latest (held) price; while held, the
///         maintenance requirement is OFF_HOURS_MARGIN_MULTIPLE x initial margin (audit A2-02).
///         Pull oracle (LOW_GAS.md §1): `trade` / `liquidate` overloads take a trailing signed `priceData`
///         bundle and call `AttestedOracle.update(priceData)` first, so every rule above is evaluated on the
///         price this transaction brought (never on whether a timer push happened to land). Each side's open interest is capped at the book's inventory cap, so
///         |pool net exposure| stays within it whatever the counterparties close. A retiring book's market
///         gets a close-out time after which anyone may close remaining positions at the oracle.
contract PoolEngine is IPoolEngine, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------------------------------------

    /// @notice Engine sanity bounds (the book's mandate enforces the tighter, normative limits).
    uint16 public constant MAX_SPREAD_BPS = 5000;
    int16 public constant MAX_QUOTE_SKEW_BPS = 2500;
    uint16 public constant MAX_FEE_BPS = 500;
    uint32 public constant MAX_FUNDING_VELOCITY_BPS = 10_000;
    /// @notice Bound on |position size| and |aggregate side size| (keeps all products far from overflow).
    uint256 public constant MAX_SIZE = uint256(uint128(type(int128).max));
    /// @notice Bound on accepted oracle prices (WAD).
    uint256 public constant MAX_PRICE_WAD = 1e36;
    /// @notice NEW risk (open / increase / flip, margin withdrawal with a position) needs an oracle price at
    ///         most this old (and never older than config.maxPriceAge()): bounds the window in which the
    ///         stored price can lag the market, e.g. while the oracle's pushes are failing. A trade adding
    ///         risk is further bounded by config.maxTradePriceAge() (LOW_GAS.md §1, default 15 s).
    uint256 public constant NEW_RISK_MAX_PRICE_AGE = 60;
    /// @notice Off-hours (oracle `held`) maintenance requirement as a multiple of the market's initial margin
    ///         (capped at 100 % of notional): a position must carry this much equity to be held through a
    ///         closed session, else it is liquidatable at the held price. Bounds the gap loss a reopen can turn
    ///         into bad debt (audit A2-02: a market-neutral pair at max leverage across a gap).
    uint256 public constant OFF_HOURS_MARGIN_MULTIPLE = 2;
    uint256 internal constant FUNDING_PERIOD = 1 days;

    // ------------------------------------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------------------------------------

    struct Market {
        MarketConfig cfg;
        address adapter;
        uint16 spreadBps;
        int16 skewBps;
        bool reduceOnly;
        uint64 lastFundingTime;
        int256 longSize; // >= 0
        int256 shortSize; // <= 0
        uint256 poolCashUsd;
        uint256 insuranceUsd;
        uint256 feesAccruedUsd;
        uint256 totalMarginUsd; // sum of trader margins in this market
        int256 fundingIndex; // cumulative funding per 1e18 size, wadUsd (positive = longs pay)
        int256 sumEntryWad; // sum(size * entryPrice / 1e18) over open positions
        int256 sumFundingWad; // sum(size * fundingIndexAtEntry / 1e18) over open positions
        uint128 inventoryCapUsd; // mandate maxInventoryUsd: per-side OI cap + funding normaliser
        uint64 closeOutAfter; // wind-down: positions may be force-closed at the oracle from then (0 = none)
    }

    /// @notice Protocol registry (oracle, factory, maxPriceAge are read live).
    IBookrunnerConfig public immutable protocolConfig;
    /// @notice Settlement asset (USDC, 6 decimals), fixed at deployment.
    IERC20 public immutable usdc;

    /// @notice Number of markets created; market ids are 1..marketCount.
    uint256 public marketCount;
    /// @notice Market owned by an adapter (0 = none). One market per adapter.
    mapping(address adapter => uint256 marketId) public marketOf;

    mapping(uint256 marketId => Market) internal _markets;
    mapping(uint256 marketId => mapping(address trader => Position)) internal _positions;

    // ------------------------------------------------------------------------------------------------
    // Errors / events (beyond IPoolEngine)
    // ------------------------------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error ZeroSize();
    error UnknownMarket(uint256 marketId);
    error NotFactoryComponent(address caller);
    error AdapterHasMarket(address adapter, uint256 marketId);
    error NotAdapter(address caller);
    error InvalidMarketConfig();
    error InvalidQuote(uint16 spreadBps, int16 skewBps);
    error NoPrice(bytes32 underlying);
    error PriceOutOfRange(uint256 priceWad);
    error SizeTooLarge();
    error MarketReduceOnly(uint256 marketId);
    error OffHours(uint256 marketId);
    error StalePrice(bytes32 underlying, uint64 publishedAt);
    error PriceNotAcceptable(uint256 fillPriceWad, uint256 acceptablePriceWad);
    error ExposureCap(uint256 exposureUsd, uint256 maxNetExposureUsd);
    error InsufficientMargin(uint256 requiredUsd, int256 availableUsd);
    error PoolUndercollateralized(int256 poolEquityUsd, uint256 requiredUsd);
    error WouldBeLiquidatable();
    error NotLiquidatable(address trader);
    error NoPosition(address trader);
    error InsufficientLiquidity(uint256 requestedUsd, uint256 availableUsd);
    error InsufficientInsurance(uint256 requestedUsd, uint256 availableUsd);
    error OpenInterest(uint256 marketId);
    error CloseOutActive(uint256 marketId);
    error CloseOutNotOpen(uint256 marketId, uint64 closeOutAfter);

    event ReduceOnlySet(uint256 indexed marketId, bool reduceOnly);
    event FundingAccrued(uint256 indexed marketId, int256 fundingIndex, int256 indexDelta);
    event FundingSettled(uint256 indexed marketId, address indexed trader, int256 owedUsd);
    event InsuranceDrawn(uint256 indexed marketId, uint256 amountUsd);
    event InventoryCapSet(uint256 indexed marketId, uint128 inventoryCapUsd);
    event CloseOutScheduled(uint256 indexed marketId, uint64 closeOutAfter);
    event ClosedOut(
        uint256 indexed marketId,
        address indexed trader,
        address indexed by,
        int256 size,
        uint256 priceWad,
        uint256 badDebtUsd
    );

    // ------------------------------------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------------------------------------

    /// @param config_ BookrunnerConfig. `usdc()` must already be set (cached immutably here).
    constructor(address config_) {
        if (config_ == address(0)) revert ZeroAddress();
        protocolConfig = IBookrunnerConfig(config_);
        address usdc_ = IBookrunnerConfig(config_).usdc();
        if (usdc_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
    }

    modifier onlyAdapter(uint256 marketId) {
        if (msg.sender != _markets[marketId].adapter) revert NotAdapter(msg.sender);
        _;
    }

    // ------------------------------------------------------------------------------------------------
    // Market admin (only the market's adapter)
    // ------------------------------------------------------------------------------------------------

    /// @inheritdoc IPoolEngine
    /// @dev Caller must be registered by the BookFactory (`isComponent`) and own no market yet. The market
    ///      starts with spread 0 / skew 0 and an empty pool; the adapter sets the quote and funds it.
    function createMarket(MarketConfig calldata cfg) external returns (uint256 marketId) {
        if (!IBookFactory(protocolConfig.factory()).isComponent(msg.sender)) {
            revert NotFactoryComponent(msg.sender);
        }
        uint256 existing = marketOf[msg.sender];
        if (existing != 0) revert AdapterHasMarket(msg.sender, existing);
        if (
            cfg.underlying == bytes32(0) || cfg.maintenanceMarginBps == 0
                || cfg.initialMarginBps <= cfg.maintenanceMarginBps
                || cfg.initialMarginBps > PoolEngineMath.BPS
                || cfg.liquidationFeeBps > cfg.maintenanceMarginBps || cfg.takerFeeBps > MAX_FEE_BPS
                || cfg.makerFeeBps > MAX_FEE_BPS || cfg.fundingVelocityBps > MAX_FUNDING_VELOCITY_BPS
        ) revert InvalidMarketConfig();

        marketId = ++marketCount;
        Market storage m = _markets[marketId];
        m.cfg = cfg;
        m.adapter = msg.sender;
        m.lastFundingTime = uint64(block.timestamp);
        m.inventoryCapUsd = cfg.maxNetExposureUsd;
        marketOf[msg.sender] = marketId;
        emit MarketCreated(marketId, msg.sender, cfg.underlying, cfg.symbol);
        emit QuoteSet(marketId, 0, 0, cfg.maxNetExposureUsd);
    }

    /// @inheritdoc IPoolEngine
    /// @dev Mandate checks (min width, max skew, maxNet <= maxInventory) are done by the desk/adapter; the
    ///      engine only enforces sanity bounds that keep fill prices positive. The funding rate is
    ///      normalised by the market's inventory cap, not by this (agent-driven) quote cap.
    function setQuote(uint256 marketId, uint16 spreadBps, int16 skewBps, uint128 maxNetExposureUsd)
        external
        onlyAdapter(marketId)
    {
        if (spreadBps > MAX_SPREAD_BPS || skewBps > MAX_QUOTE_SKEW_BPS || skewBps < -MAX_QUOTE_SKEW_BPS) {
            revert InvalidQuote(spreadBps, skewBps);
        }
        Market storage m = _markets[marketId];
        _accrue(marketId, m, _netSize(m) == 0 ? 0 : _latestPrice(m));
        m.spreadBps = spreadBps;
        m.skewBps = skewBps;
        m.cfg.maxNetExposureUsd = maxNetExposureUsd;
        emit QuoteSet(marketId, spreadBps, skewBps, maxNetExposureUsd);
    }

    /// @inheritdoc IPoolEngine
    /// @dev Cannot be lifted once a wind-down close-out is scheduled.
    function setReduceOnly(uint256 marketId, bool reduceOnly) external onlyAdapter(marketId) {
        Market storage m = _markets[marketId];
        if (!reduceOnly && m.closeOutAfter != 0) revert CloseOutActive(marketId);
        m.reduceOnly = reduceOnly;
        emit ReduceOnlySet(marketId, reduceOnly);
    }

    /// @notice Only the market's adapter (re-mandate): the book's maxInventoryUsd. Caps each side's open
    ///         interest for new risk (so counterparty closes can never leave |pool net| above it) and
    ///         normalises funding. The live quote cap is clamped to it. Funding is accrued first.
    function setInventoryCap(uint256 marketId, uint128 capUsd) external onlyAdapter(marketId) {
        Market storage m = _markets[marketId];
        _accrue(marketId, m, _netSize(m) == 0 ? 0 : _latestPrice(m));
        m.inventoryCapUsd = capUsd;
        if (m.cfg.maxNetExposureUsd > capUsd) {
            m.cfg.maxNetExposureUsd = capUsd;
            emit QuoteSet(marketId, m.spreadBps, m.skewBps, capUsd);
        }
        emit InventoryCapSet(marketId, capUsd);
    }

    /// @notice Only the market's adapter (book winding down): reduce-only for good, and after `notice`
    ///         seconds anyone may close any remaining position at the oracle ({forceClose}). Idempotent:
    ///         the first schedule sticks.
    function startCloseOut(uint256 marketId, uint64 notice) external onlyAdapter(marketId) {
        Market storage m = _markets[marketId];
        if (!m.reduceOnly) {
            m.reduceOnly = true;
            emit ReduceOnlySet(marketId, true);
        }
        if (m.closeOutAfter != 0) return;
        uint64 at = uint64(block.timestamp) + notice;
        m.closeOutAfter = at;
        emit CloseOutScheduled(marketId, at);
    }

    /// @inheritdoc IPoolEngine
    /// @dev Pulls `amount` USDC from the adapter (approved).
    function depositInsurance(uint256 marketId, uint256 amount) external nonReentrant onlyAdapter(marketId) {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        _markets[marketId].insuranceUsd += amount;
        emit LiquidityChanged(marketId, 0, int256(amount));
    }

    /// @inheritdoc IPoolEngine
    /// @dev Pulls `amount` USDC from the adapter (approved).
    function depositLiquidity(uint256 marketId, uint256 amount) external nonReentrant onlyAdapter(marketId) {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        _markets[marketId].poolCashUsd += amount;
        emit LiquidityChanged(marketId, int256(amount), 0);
    }

    /// @inheritdoc IPoolEngine
    /// @dev Requires `amount <= poolCash` and, after the withdrawal, poolEquity >= the gross pool margin
    ///      (= max(long OI, short OI) * price * initialMarginBps): winners are paid from pool cash before the
    ///      losing side pays in, so a net-flat book with large two-sided open interest keeps cash as well.
    ///      With any open interest the price must be fresh or held.
    function withdrawLiquidity(uint256 marketId, uint256 amount, address to)
        external
        nonReentrant
        onlyAdapter(marketId)
    {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        Market storage m = _markets[marketId];
        uint256 price;
        if (_hasOpenInterest(m)) {
            uint64 publishedAt;
            (price,, publishedAt) = _oracle(m);
            if (_stale(publishedAt, protocolConfig.maxPriceAge())) {
                revert StalePrice(m.cfg.underlying, publishedAt);
            }
        }
        _accrue(marketId, m, price);
        uint256 cash = m.poolCashUsd;
        if (amount > cash) revert InsufficientLiquidity(amount, cash);
        m.poolCashUsd = cash - amount;
        int256 equity = _poolEquity(m, price, m.fundingIndex);
        uint256 required = _requiredGrossMargin(m, price);
        if (equity < int256(required)) revert PoolUndercollateralized(equity, required);
        emit LiquidityChanged(marketId, -int256(amount), 0);
        usdc.safeTransfer(to, amount);
    }

    /// @inheritdoc IPoolEngine
    /// @dev Only with no open interest: the IF backs open positions (bad debt, then winners the pool cannot
    ///      pay) until every position is closed (a wind-down closes them via {forceClose}).
    function withdrawInsurance(uint256 marketId, uint256 amount, address to)
        external
        nonReentrant
        onlyAdapter(marketId)
    {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        Market storage m = _markets[marketId];
        if (_hasOpenInterest(m)) revert OpenInterest(marketId);
        uint256 ins = m.insuranceUsd;
        if (amount > ins) revert InsufficientInsurance(amount, ins);
        m.insuranceUsd = ins - amount;
        emit LiquidityChanged(marketId, 0, -int256(amount));
        usdc.safeTransfer(to, amount);
    }

    /// @inheritdoc IPoolEngine
    function claimFees(uint256 marketId, address to)
        external
        nonReentrant
        onlyAdapter(marketId)
        returns (uint256 amount)
    {
        if (to == address(0)) revert ZeroAddress();
        Market storage m = _markets[marketId];
        amount = m.feesAccruedUsd;
        if (amount == 0) return 0;
        m.feesAccruedUsd = 0;
        emit FeesClaimed(marketId, to, amount);
        usdc.safeTransfer(to, amount);
    }

    // ------------------------------------------------------------------------------------------------
    // Traders
    // ------------------------------------------------------------------------------------------------

    /// @inheritdoc IPoolEngine
    /// @dev Always allowed (adding margin never adds risk), including off-hours and reduce-only.
    function depositMargin(uint256 marketId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Market storage m = _market(marketId);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        _positions[marketId][msg.sender].marginUsd += amount;
        m.totalMarginUsd += amount;
        emit MarginChanged(marketId, msg.sender, int256(amount));
    }

    /// @inheritdoc IPoolEngine
    /// @dev Flat traders withdraw freely. With an open position the withdrawal is new risk: blocked
    ///      off-hours / stale, settles funding first, then requires equity >= initial margin.
    function withdrawMargin(uint256 marketId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Market storage m = _market(marketId);
        Position storage p = _positions[marketId][msg.sender];
        uint256 price;
        if (p.size != 0) {
            bool held;
            uint64 publishedAt;
            (price, held, publishedAt) = _oracle(m);
            if (held) revert OffHours(marketId);
            if (_newRiskStale(publishedAt)) revert StalePrice(m.cfg.underlying, publishedAt);
            _accrue(marketId, m, price);
            _settleFunding(marketId, m, p);
        }
        uint256 margin = p.marginUsd;
        if (amount > margin) revert InsufficientMargin(amount, int256(margin));
        p.marginUsd = margin - amount;
        m.totalMarginUsd -= amount;
        if (p.size != 0) {
            uint256 required = PoolEngineMath.requirementUsd(p.size, price, m.cfg.initialMarginBps);
            int256 equity = int256(p.marginUsd) + PoolEngineMath.pnlUsd(p.size, p.entryPriceWad, price);
            if (equity < int256(required)) revert InsufficientMargin(required, equity);
        }
        emit MarginChanged(marketId, msg.sender, -int256(amount));
        usdc.safeTransfer(msg.sender, amount);
    }

    struct TradeCtx {
        uint256 price;
        uint256 fill;
        int256 oldSize;
        int256 newSize;
        int256 pnlUsd;
        int256 fundingUsd;
        uint256 feeUsd;
        bool newRisk;
    }

    /// @inheritdoc IPoolEngine
    /// @dev Buy (sizeDelta > 0) fills at oracle*(1e4 + spread/2 + skew)/1e4 (rounded up), sell at
    ///      oracle*(1e4 - spread/2 + skew)/1e4 (rounded down). Every trade is blocked when the price is held
    ///      or stale (older than min(maxPriceAge, NEW_RISK_MAX_PRICE_AGE, maxTradePriceAge)); new risk
    ///      (open/increase/flip) is also blocked when reduce-only, must keep |pool net exposure| <=
    ///      maxNetExposureUsd and the trader's
    ///      side OI <= inventoryCapUsd, must pass the trader's initial margin and keep the pool
    ///      collateralised. Reductions must not leave the
    ///      position liquidatable (a full close only needs margin to cover losses + funding + fee).
    ///      Uses the stored price, which must therefore be fresh (otherwise use the `priceData` overload).
    function trade(uint256 marketId, int256 sizeDelta, uint256 acceptablePriceWad)
        external
        nonReentrant
        returns (uint256 fillPriceWad, uint256 feeUsd)
    {
        return _trade(marketId, sizeDelta, acceptablePriceWad);
    }

    /// @inheritdoc IPoolEngine
    /// @dev Pull oracle: `AttestedOracle.update(priceData)` first when non-empty (not-newer entries are
    ///      skipped, a bad signature reverts), then exactly {trade}. Any trade (reductions and closes too)
    ///      still needs the resulting stored price to be live (not held) and to satisfy
    ///      `publishedAt >= block.timestamp - maxTradePriceAge`, so a trader cannot replay an old print.
    function trade(uint256 marketId, int256 sizeDelta, uint256 acceptablePriceWad, bytes calldata priceData)
        external
        nonReentrant
        returns (uint256 fillPriceWad, uint256 feeUsd)
    {
        _pull(priceData);
        return _trade(marketId, sizeDelta, acceptablePriceWad);
    }

    function _trade(uint256 marketId, int256 sizeDelta, uint256 acceptablePriceWad)
        internal
        returns (uint256, uint256)
    {
        if (sizeDelta == 0) revert ZeroSize();
        Market storage m = _market(marketId);
        Position storage p = _positions[marketId][msg.sender];
        TradeCtx memory c;
        {
            bool held;
            uint64 publishedAt;
            (c.price, held, publishedAt) = _oracle(m);
            c.oldSize = p.size;
            c.newSize = c.oldSize + sizeDelta;
            if (PoolEngineMath.abs(c.newSize) > MAX_SIZE) revert SizeTooLarge();
            c.newRisk = PoolEngineMath.isNewRisk(c.oldSize, c.newSize);
            if (c.newRisk && m.reduceOnly) revert MarketReduceOnly(marketId);
            // Every voluntary trade (reductions and closes included) needs a live, fresh price: a held print
            // or a stored price older than the trade bound would let a trader pick the stale price for one
            // leg and the real one for another (audit A2-01 / A2-03).
            if (held) revert OffHours(marketId);
            if (_tradeStale(publishedAt)) revert StalePrice(m.cfg.underlying, publishedAt);
        }
        _accrue(marketId, m, c.price);

        c.fill = _fillPrice(m, c.price, sizeDelta);
        if (sizeDelta > 0 ? c.fill > acceptablePriceWad : c.fill < acceptablePriceWad) {
            revert PriceNotAcceptable(c.fill, acceptablePriceWad);
        }

        c.fundingUsd = PoolEngineMath.fundingOwedUsd(c.oldSize, m.fundingIndex, p.fundingIndexAtEntry);
        c.pnlUsd =
            PoolEngineMath.pnlUsd(PoolEngineMath.closedSize(c.oldSize, sizeDelta), p.entryPriceWad, c.fill);
        c.feeUsd =
            Math.mulDiv(PoolEngineMath.notionalUsd(sizeDelta, c.fill), m.cfg.takerFeeBps, PoolEngineMath.BPS);

        // Remove the old position from the aggregates, settle funding + realised PnL against the pool,
        // charge the taker fee, then write the new position back into the aggregates.
        _removeAggregates(m, p);
        uint256 newEntryPrice = PoolEngineMath.newEntry(c.oldSize, c.newSize, p.entryPriceWad, c.fill);
        _settle(marketId, m, p, c.fundingUsd - c.pnlUsd, false);
        if (p.marginUsd < c.feeUsd) revert InsufficientMargin(c.feeUsd, int256(p.marginUsd));
        p.marginUsd -= c.feeUsd;
        m.totalMarginUsd -= c.feeUsd;
        m.feesAccruedUsd += c.feeUsd;
        p.size = c.newSize;
        p.entryPriceWad = newEntryPrice;
        p.fundingIndexAtEntry = m.fundingIndex;
        _addAggregates(m, p);
        if (PoolEngineMath.abs(m.longSize) > MAX_SIZE || PoolEngineMath.abs(m.shortSize) > MAX_SIZE) {
            revert SizeTooLarge();
        }

        if (c.fundingUsd != 0) emit FundingSettled(marketId, msg.sender, c.fundingUsd);
        _postTradeChecks(m, p, c);

        emit Trade(marketId, msg.sender, sizeDelta, c.fill, c.feeUsd, c.pnlUsd, c.newSize);
        return (c.fill, c.feeUsd);
    }

    /// @inheritdoc IPoolEngine
    /// @dev Anyone. Works off-hours, stale and reduce-only (at the latest / held price): involuntary, only
    ///      below maintenance (while held: below OFF_HOURS_MARGIN_MULTIPLE x initial margin), and it forfeits
    ///      the liquidation fee, so a stored price is not a free option for the trader. Closes the whole
    ///      position at the oracle price; losses + funding settle against the pool; any shortfall is bad
    ///      debt paid by this market's IF, the remainder absorbed by this market's pool (ADL). The
    ///      liquidation fee (liquidationFeeBps of notional, capped by remaining margin) is split 50% to
    ///      the liquidator, 50% to the IF. Leftover margin stays withdrawable by the trader.
    function liquidate(uint256 marketId, address trader) external nonReentrant returns (uint256 rewardUsd) {
        return _liquidate(marketId, trader);
    }

    /// @inheritdoc IPoolEngine
    /// @dev Pull oracle: `AttestedOracle.update(priceData)` first when non-empty, then exactly {liquidate}
    ///      (no maxTradePriceAge bound: liquidations keep working at the latest / held price).
    function liquidate(uint256 marketId, address trader, bytes calldata priceData)
        external
        nonReentrant
        returns (uint256 rewardUsd)
    {
        _pull(priceData);
        return _liquidate(marketId, trader);
    }

    function _liquidate(uint256 marketId, address trader) internal returns (uint256 rewardUsd) {
        Market storage m = _market(marketId);
        Position storage p = _positions[marketId][trader];
        if (p.size == 0) revert NoPosition(trader);
        (uint256 price, bool held,) = _oracle(m);
        _accrue(marketId, m, price);
        if (!_isLiquidatable(m, p, price, m.fundingIndex, held)) revert NotLiquidatable(trader);

        (int256 size,, uint256 badDebt) = _closeAtOracle(marketId, m, p, trader, price);

        uint256 margin = p.marginUsd;
        uint256 feeUsd = Math.min(
            margin,
            Math.mulDiv(PoolEngineMath.notionalUsd(size, price), m.cfg.liquidationFeeBps, PoolEngineMath.BPS)
        );
        rewardUsd = feeUsd / 2;
        p.marginUsd = margin - feeUsd;
        m.totalMarginUsd -= feeUsd;
        m.insuranceUsd += feeUsd - rewardUsd;

        emit Liquidation(marketId, trader, msg.sender, size, price, feeUsd, badDebt);
        if (rewardUsd != 0) usdc.safeTransfer(msg.sender, rewardUsd);
    }

    /// @notice Anyone, once a wind-down close-out is open (book Retiring, notice elapsed): closes `trader`'s
    ///         whole position at the oracle price with no fee, like a liquidation without the maintenance
    ///         check (a loss beyond margin is bad debt: IF, then ADL in this market). The price must not be
    ///         stale. Leftover margin stays withdrawable by the trader. O(1) per position.
    function forceClose(uint256 marketId, address trader) external nonReentrant {
        Market storage m = _market(marketId);
        uint64 at = m.closeOutAfter;
        if (at == 0 || block.timestamp < at) revert CloseOutNotOpen(marketId, at);
        Position storage p = _positions[marketId][trader];
        if (p.size == 0) revert NoPosition(trader);
        (uint256 price,, uint64 publishedAt) = _oracle(m);
        if (_stale(publishedAt, protocolConfig.maxPriceAge())) revert StalePrice(m.cfg.underlying, publishedAt);
        _accrue(marketId, m, price);
        (int256 size, int256 pnl, uint256 badDebt) = _closeAtOracle(marketId, m, p, trader, price);
        emit Trade(marketId, trader, -size, price, 0, pnl, 0);
        emit ClosedOut(marketId, trader, msg.sender, size, price, badDebt);
    }

    // ------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------

    /// @inheritdoc IPoolEngine
    function adapterOf(uint256 marketId) external view returns (address) {
        return _markets[marketId].adapter;
    }

    /// @inheritdoc IPoolEngine
    function config(uint256 marketId) external view returns (MarketConfig memory) {
        return _market(marketId).cfg;
    }

    /// @inheritdoc IPoolEngine
    /// @dev `fundingIndex` includes funding accrued since the last interaction (at the latest price).
    function state(uint256 marketId) external view returns (MarketState memory s) {
        Market storage m = _market(marketId);
        s = MarketState({
            spreadBps: m.spreadBps,
            skewBps: m.skewBps,
            reduceOnly: m.reduceOnly,
            longSize: m.longSize,
            shortSize: m.shortSize,
            poolCashUsd: m.poolCashUsd,
            insuranceUsd: m.insuranceUsd,
            feesAccruedUsd: m.feesAccruedUsd,
            fundingIndex: _pendingIndex(m, _viewPrice(m))
        });
    }

    /// @inheritdoc IPoolEngine
    function positionOf(uint256 marketId, address trader) external view returns (Position memory) {
        return _positions[marketId][trader];
    }

    /// @inheritdoc IPoolEngine
    /// @dev At the latest stored oracle price (does not check staleness; `trade` does).
    function quotePrice(uint256 marketId, int256 sizeDelta) external view returns (uint256) {
        if (sizeDelta == 0) revert ZeroSize();
        Market storage m = _market(marketId);
        return _fillPrice(m, _latestPrice(m), sizeDelta);
    }

    /// @inheritdoc IPoolEngine
    function poolEquityUsd(uint256 marketId) external view returns (int256) {
        Market storage m = _market(marketId);
        uint256 price = _viewPrice(m);
        return _poolEquity(m, price, _pendingIndex(m, price));
    }

    /// @inheritdoc IPoolEngine
    function netExposureUsd(uint256 marketId) external view returns (int256) {
        Market storage m = _market(marketId);
        int256 net = _netSize(m);
        if (net == 0) return 0;
        return -(net * int256(_latestPrice(m))) / int256(PoolEngineMath.SIZE_PRICE_TO_USD);
    }

    /// @inheritdoc IPoolEngine
    /// @dev equity / notional in bps at the latest price; type(uint256).max when flat; 0 when equity <= 0.
    function marginRatioBps(uint256 marketId, address trader) external view returns (uint256) {
        Market storage m = _market(marketId);
        Position storage p = _positions[marketId][trader];
        if (p.size == 0) return type(uint256).max;
        uint256 price = _latestPrice(m);
        int256 equity = _traderEquity(p, price, _pendingIndex(m, price));
        uint256 notional = PoolEngineMath.notionalUsd(p.size, price);
        if (notional == 0) return type(uint256).max;
        if (equity <= 0) return 0;
        return Math.mulDiv(uint256(equity), PoolEngineMath.BPS, notional);
    }

    /// @inheritdoc IPoolEngine
    function isLiquidatable(uint256 marketId, address trader) external view returns (bool) {
        Market storage m = _market(marketId);
        Position storage p = _positions[marketId][trader];
        if (p.size == 0) return false;
        (uint256 price, bool held,) = _oracle(m);
        return _isLiquidatable(m, p, price, _pendingIndex(m, price), held);
    }

    /// @notice Trader equity (margin + unrealised PnL - unsettled funding) at the latest price, USD 6dp.
    function traderEquityUsd(uint256 marketId, address trader) external view returns (int256) {
        Market storage m = _market(marketId);
        Position storage p = _positions[marketId][trader];
        if (p.size == 0) return int256(p.marginUsd);
        uint256 price = _latestPrice(m);
        return _traderEquity(p, price, _pendingIndex(m, price));
    }

    /// @notice Pool margin the pool must keep against its net exposure (|exposure| * initialMarginBps).
    function requiredPoolMarginUsd(uint256 marketId) external view returns (uint256) {
        Market storage m = _market(marketId);
        return _requiredPoolMargin(m, _viewPrice(m));
    }

    /// @notice MM liquidity {withdrawLiquidity} would release now: min(poolCash, poolEquity - gross pool
    ///         margin) at the latest price (the call itself also needs a non-stale price with open interest).
    function withdrawableLiquidityUsd(uint256 marketId) external view returns (uint256) {
        Market storage m = _market(marketId);
        uint256 price = _hasOpenInterest(m) ? _latestPrice(m) : 0;
        int256 free = _poolEquity(m, price, _pendingIndex(m, price)) - int256(_requiredGrossMargin(m, price));
        if (free <= 0) return 0;
        return Math.min(uint256(free), m.poolCashUsd);
    }

    /// @notice The market's inventory cap (mandate maxInventoryUsd): per-side OI cap + funding normaliser.
    function inventoryCapUsd(uint256 marketId) external view returns (uint128) {
        return _market(marketId).inventoryCapUsd;
    }

    /// @notice Wind-down close-out time (0 = none scheduled); {forceClose} is open from then on.
    function closeOutAfter(uint256 marketId) external view returns (uint64) {
        return _market(marketId).closeOutAfter;
    }

    /// @notice Sum of trader margins held for this market (USD 6dp).
    function totalMarginUsd(uint256 marketId) external view returns (uint256) {
        return _market(marketId).totalMarginUsd;
    }

    /// @notice Current funding rate per day as a signed WAD fraction of notional (positive = longs pay).
    function fundingRatePerDayWad(uint256 marketId) external view returns (int256) {
        Market storage m = _market(marketId);
        int256 net = _netSize(m);
        if (net == 0) return 0;
        uint256 r = _fundingRateWad(m, PoolEngineMath.abs(net), _latestPrice(m));
        return net > 0 ? int256(r) : -int256(r);
    }

    /// @notice Timestamp of the last funding accrual for the market.
    function lastFundingTime(uint256 marketId) external view returns (uint64) {
        return _market(marketId).lastFundingTime;
    }

    // ------------------------------------------------------------------------------------------------
    // Internals — oracle
    // ------------------------------------------------------------------------------------------------

    function _market(uint256 marketId) internal view returns (Market storage m) {
        m = _markets[marketId];
        if (m.adapter == address(0)) revert UnknownMarket(marketId);
    }

    /// @dev Latest attested price, held flag and publication time. Reverts when the underlying was never priced.
    function _oracle(Market storage m) internal view returns (uint256 price, bool held, uint64 publishedAt) {
        IAttestedOracle.PriceData memory d = IAttestedOracle(protocolConfig.oracle()).latest(m.cfg.underlying);
        price = d.priceWad;
        if (price == 0 || d.publishedAt == 0) revert NoPrice(m.cfg.underlying);
        if (price > MAX_PRICE_WAD) revert PriceOutOfRange(price);
        held = d.held;
        publishedAt = d.publishedAt;
    }

    function _stale(uint64 publishedAt, uint256 maxAge) internal view returns (bool) {
        return uint256(publishedAt) + maxAge < block.timestamp;
    }

    /// @dev Staleness bound for new risk: min(config.maxPriceAge(), NEW_RISK_MAX_PRICE_AGE).
    function _newRiskStale(uint64 publishedAt) internal view returns (bool) {
        return _stale(publishedAt, Math.min(protocolConfig.maxPriceAge(), NEW_RISK_MAX_PRICE_AGE));
    }

    /// @dev Staleness bound for every trade (LOW_GAS.md §1 latency-arbitrage bound): the new-risk
    ///      bound tightened by config.maxTradePriceAge(), i.e. allowed iff
    ///      publishedAt >= block.timestamp - min(maxPriceAge, NEW_RISK_MAX_PRICE_AGE, maxTradePriceAge).
    function _tradeStale(uint64 publishedAt) internal view returns (bool) {
        uint256 maxAge = Math.min(protocolConfig.maxPriceAge(), NEW_RISK_MAX_PRICE_AGE);
        maxAge = Math.min(maxAge, IBookrunnerConfigTradeAge(address(protocolConfig)).maxTradePriceAge());
        return _stale(publishedAt, maxAge);
    }

    /// @dev Pull oracle: relays the transaction's signed price bundle to the oracle (no-op when empty).
    function _pull(bytes calldata priceData) internal {
        if (priceData.length != 0) IAttestedOracle(protocolConfig.oracle()).update(priceData);
    }

    function _latestPrice(Market storage m) internal view returns (uint256 price) {
        (price,,) = _oracle(m);
    }

    /// @dev Price for views: not needed (0) when the market is net-flat (aggregates are price-independent).
    function _viewPrice(Market storage m) internal view returns (uint256) {
        return _netSize(m) == 0 ? 0 : _latestPrice(m);
    }

    // ------------------------------------------------------------------------------------------------
    // Internals — funding
    // ------------------------------------------------------------------------------------------------

    function _netSize(Market storage m) internal view returns (int256) {
        return m.longSize + m.shortSize;
    }

    /// @dev Funding rate per day (unsigned WAD fraction of notional) for a net trader skew of `absNet`:
    ///      fundingVelocityBps * min(|skewUsd| / inventoryCapUsd, 1). Full velocity when the cap is 0. The
    ///      normaliser is the mandate's maxInventoryUsd, never the agent's dynamic quote cap.
    function _fundingRateWad(Market storage m, uint256 absNet, uint256 price)
        internal
        view
        returns (uint256)
    {
        uint256 maxNet = m.inventoryCapUsd;
        uint256 fracWad = maxNet == 0
            ? PoolEngineMath.WAD
            : Math.min(PoolEngineMath.WAD, Math.mulDiv(absNet, price, maxNet * 1e12));
        return fracWad * m.cfg.fundingVelocityBps / PoolEngineMath.BPS;
    }

    function _fundingDelta(Market storage m, uint256 price, uint256 dt) internal view returns (int256) {
        int256 net = _netSize(m);
        if (net == 0 || dt == 0 || price == 0) return 0;
        uint256 rate = _fundingRateWad(m, PoolEngineMath.abs(net), price);
        uint256 d = Math.mulDiv(price, rate * dt, FUNDING_PERIOD * PoolEngineMath.WAD);
        return net > 0 ? int256(d) : -int256(d);
    }

    function _pendingIndex(Market storage m, uint256 price) internal view returns (int256) {
        // eth_call may execute in a block older than the last accrual: never underflow in a view.
        uint256 last = m.lastFundingTime;
        uint256 dt = block.timestamp > last ? block.timestamp - last : 0;
        return m.fundingIndex + _fundingDelta(m, price, dt);
    }

    /// @dev Accrues funding at `price` for the time since the last accrual (rate from the skew that
    ///      prevailed over that interval). `price` may be 0 only when the market is net-flat.
    function _accrue(uint256 marketId, Market storage m, uint256 price) internal {
        uint256 last = m.lastFundingTime;
        if (block.timestamp <= last) return;
        int256 d = _fundingDelta(m, price, block.timestamp - last);
        m.lastFundingTime = uint64(block.timestamp);
        if (d != 0) {
            int256 idx = m.fundingIndex + d;
            m.fundingIndex = idx;
            emit FundingAccrued(marketId, idx, d);
        }
    }

    /// @dev Settles a position's unsettled funding into its margin (reverts if it cannot be paid).
    function _settleFunding(uint256 marketId, Market storage m, Position storage p) internal {
        int256 owed = PoolEngineMath.fundingOwedUsd(p.size, m.fundingIndex, p.fundingIndexAtEntry);
        m.sumFundingWad -= PoolEngineMath.contribSigned(p.size, p.fundingIndexAtEntry);
        p.fundingIndexAtEntry = m.fundingIndex;
        m.sumFundingWad += PoolEngineMath.contribSigned(p.size, m.fundingIndex);
        if (owed != 0) {
            _settle(marketId, m, p, owed, false);
            emit FundingSettled(marketId, msg.sender, owed);
        }
    }

    // ------------------------------------------------------------------------------------------------
    // Internals — accounting
    // ------------------------------------------------------------------------------------------------

    function _removeAggregates(Market storage m, Position storage p) internal {
        int256 size = p.size;
        if (size == 0) return;
        if (size > 0) m.longSize -= size;
        else m.shortSize -= size;
        m.sumEntryWad -= PoolEngineMath.contrib(size, p.entryPriceWad);
        m.sumFundingWad -= PoolEngineMath.contribSigned(size, p.fundingIndexAtEntry);
    }

    function _addAggregates(Market storage m, Position storage p) internal {
        int256 size = p.size;
        if (size == 0) return;
        if (size > 0) m.longSize += size;
        else m.shortSize += size;
        m.sumEntryWad += PoolEngineMath.contrib(size, p.entryPriceWad);
        m.sumFundingWad += PoolEngineMath.contribSigned(size, p.fundingIndexAtEntry);
    }

    /// @dev Moves `owedUsd` from the trader's margin to the pool (owedUsd > 0) or from the pool to the
    ///      trader (owedUsd < 0). Trader shortfall: reverts unless `allowBadDebt` (liquidation), in which
    ///      case the bad debt is covered by this market's IF and any remainder is absorbed by this
    ///      market's pool (ADL). Pool shortfall on a payout: IF covers, any remainder is haircut (ADL).
    ///      Only this market's balances are touched.
    function _settle(
        uint256 marketId,
        Market storage m,
        Position storage p,
        int256 owedUsd,
        bool allowBadDebt
    ) internal returns (uint256 badDebt) {
        if (owedUsd > 0) {
            uint256 owed = uint256(owedUsd);
            uint256 margin = p.marginUsd;
            if (margin >= owed) {
                p.marginUsd = margin - owed;
                m.totalMarginUsd -= owed;
                m.poolCashUsd += owed;
                return 0;
            }
            if (!allowBadDebt) revert InsufficientMargin(owed, int256(margin));
            p.marginUsd = 0;
            m.totalMarginUsd -= margin;
            badDebt = owed - margin;
            uint256 cover = Math.min(badDebt, m.insuranceUsd);
            m.poolCashUsd += margin + cover;
            if (cover != 0) {
                m.insuranceUsd -= cover;
                emit InsuranceDrawn(marketId, cover);
            }
            if (badDebt > cover) emit ADL(marketId, badDebt - cover);
        } else if (owedUsd < 0) {
            uint256 due = uint256(-owedUsd);
            uint256 fromPool = Math.min(due, m.poolCashUsd);
            m.poolCashUsd -= fromPool;
            uint256 rem = due - fromPool;
            uint256 fromIf = Math.min(rem, m.insuranceUsd);
            if (fromIf != 0) {
                m.insuranceUsd -= fromIf;
                emit InsuranceDrawn(marketId, fromIf);
            }
            rem -= fromIf;
            uint256 paid = due - rem;
            p.marginUsd += paid;
            m.totalMarginUsd += paid;
            if (rem != 0) emit ADL(marketId, rem);
        }
    }

    /// @dev Closes the whole position at the oracle `price` (liquidation / wind-down close-out): funding and
    ///      PnL settle against the pool; a trader shortfall is bad debt (IF, then ADL in this market).
    function _closeAtOracle(uint256 marketId, Market storage m, Position storage p, address trader, uint256 price)
        internal
        returns (int256 size, int256 pnl, uint256 badDebt)
    {
        size = p.size;
        int256 fundingUsd = PoolEngineMath.fundingOwedUsd(size, m.fundingIndex, p.fundingIndexAtEntry);
        pnl = PoolEngineMath.pnlUsd(size, p.entryPriceWad, price);
        _removeAggregates(m, p);
        badDebt = _settle(marketId, m, p, fundingUsd - pnl, true);
        p.size = 0;
        p.entryPriceWad = 0;
        p.fundingIndexAtEntry = m.fundingIndex;
        if (fundingUsd != 0) emit FundingSettled(marketId, trader, fundingUsd);
    }

    /// @dev New risk: post-trade |pool net| <= the quote cap AND the side the trader added to stays within
    ///      the inventory cap. Either side may close at will, so |pool net| can reach the larger side's OI:
    ///      the side cap keeps |pool net exposure| <= maxInventoryUsd under any sequence of reductions.
    function _postTradeChecks(Market storage m, Position storage p, TradeCtx memory c) internal view {
        if (c.newRisk) {
            uint256 exposure =
                Math.mulDiv(PoolEngineMath.abs(_netSize(m)), c.price, PoolEngineMath.SIZE_PRICE_TO_USD);
            if (exposure > m.cfg.maxNetExposureUsd) revert ExposureCap(exposure, m.cfg.maxNetExposureUsd);
            uint256 sideOi = Math.mulDiv(
                uint256(c.newSize > 0 ? m.longSize : -m.shortSize), c.price, PoolEngineMath.SIZE_PRICE_TO_USD
            );
            if (sideOi > m.inventoryCapUsd) revert ExposureCap(sideOi, m.inventoryCapUsd);
            uint256 required = PoolEngineMath.requirementUsd(c.newSize, c.price, m.cfg.initialMarginBps);
            int256 equity = int256(p.marginUsd) + PoolEngineMath.pnlUsd(c.newSize, p.entryPriceWad, c.price);
            if (equity < int256(required)) revert InsufficientMargin(required, equity);
            int256 poolEq = _poolEquity(m, c.price, m.fundingIndex);
            uint256 poolReq = _requiredPoolMargin(m, c.price);
            if (poolEq < int256(poolReq)) revert PoolUndercollateralized(poolEq, poolReq);
        } else if (c.newSize != 0 && _isLiquidatable(m, p, c.price, m.fundingIndex, false)) {
            revert WouldBeLiquidatable();
        }
    }

    /// @dev margin + unrealised PnL (floored) - unsettled funding (ceiled), USD 6dp.
    function _traderEquity(Position storage p, uint256 price, int256 index) internal view returns (int256) {
        return int256(p.marginUsd) + PoolEngineMath.pnlUsd(p.size, p.entryPriceWad, price)
            - PoolEngineMath.fundingOwedUsd(p.size, index, p.fundingIndexAtEntry);
    }

    /// @dev Below maintenance margin; while the oracle is `held` (session closed) below the off-hours
    ///      requirement min(OFF_HOURS_MARGIN_MULTIPLE * initialMarginBps, 100 %) instead.
    function _isLiquidatable(Market storage m, Position storage p, uint256 price, int256 index, bool held)
        internal
        view
        returns (bool)
    {
        if (p.size == 0) return false;
        uint256 bps = held
            ? Math.min(OFF_HOURS_MARGIN_MULTIPLE * m.cfg.initialMarginBps, PoolEngineMath.BPS)
            : m.cfg.maintenanceMarginBps;
        uint256 required = PoolEngineMath.requirementUsd(p.size, price, bps);
        return _traderEquity(p, price, index) < int256(required);
    }

    /// @dev poolCash - aggregate trader unrealised PnL + aggregate funding owed by traders, floored.
    ///      Aggregate PnL = net*price/1e18 - sum(size*entry/1e18); aggregate funding owed =
    ///      net*index/1e18 - sum(size*indexAtEntry/1e18). Both are price-independent when net == 0.
    function _poolEquity(Market storage m, uint256 price, int256 index) internal view returns (int256) {
        int256 net = _netSize(m);
        int256 traderPnlWad = PoolEngineMath.contrib(net, price) - m.sumEntryWad;
        int256 traderFundingOwedWad = PoolEngineMath.contribSigned(net, index) - m.sumFundingWad;
        return int256(m.poolCashUsd) + PoolEngineMath.wadToUsdFloor(traderFundingOwedWad - traderPnlWad);
    }

    function _requiredPoolMargin(Market storage m, uint256 price) internal view returns (uint256) {
        int256 net = _netSize(m);
        if (net == 0) return 0;
        return PoolEngineMath.requirementUsd(net, price, m.cfg.initialMarginBps);
    }

    function _hasOpenInterest(Market storage m) internal view returns (bool) {
        return m.longSize != 0 || m.shortSize != 0;
    }

    /// @dev max(long OI, short OI) * price * initialMarginBps (ceil): pool margin kept against withdrawals.
    function _requiredGrossMargin(Market storage m, uint256 price) internal view returns (uint256) {
        int256 side = m.longSize > -m.shortSize ? m.longSize : -m.shortSize;
        if (side == 0) return 0;
        return PoolEngineMath.requirementUsd(side, price, m.cfg.initialMarginBps);
    }

    function _fillPrice(Market storage m, uint256 price, int256 sizeDelta) internal view returns (uint256) {
        int256 skew2 = int256(m.skewBps) * 2;
        uint256 spread = m.spreadBps;
        if (sizeDelta > 0) {
            uint256 f = uint256(int256(2 * PoolEngineMath.BPS + spread) + skew2);
            return Math.mulDiv(price, f, 2 * PoolEngineMath.BPS, Math.Rounding.Ceil);
        }
        uint256 g = uint256(int256(2 * PoolEngineMath.BPS) - int256(spread) + skew2);
        return Math.mulDiv(price, g, 2 * PoolEngineMath.BPS);
    }
}
