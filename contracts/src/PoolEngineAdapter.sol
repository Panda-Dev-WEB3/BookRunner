// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {BRTypes} from "./interfaces/BRTypes.sol";
import {IVenueAdapter, IPoolEngineAdapter} from "./interfaces/IVenueAdapter.sol";
import {IPoolEngine} from "./interfaces/IPoolEngine.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {IBook} from "./interfaces/IBook.sol";
import {IMMMandate} from "./interfaces/IMMMandate.sol";
import {IRevenueRouter} from "./interfaces/IRevenueRouter.sol";
import {IStockTokenRegistry} from "./interfaces/IStockTokenRegistry.sol";

/// @title IPoolEngineControls — PoolEngine market controls beyond the frozen IPoolEngine (only the adapter).
interface IPoolEngineControls {
    function setInventoryCap(uint256 marketId, uint128 capUsd) external;
    function startCloseOut(uint256 marketId, uint64 notice) external;
}

/// @title PoolEngineAdapter — a book's venue adapter for its in-house PoolEngine market.
/// @notice UUPS proxy per book (upgrades only by `config.timelock()`). Owns exactly one engine market:
///         the book's IF is the market's insurance fund and the book's MM inventory is the pool.
///         Capital moves only between the book's UnderwritingVault and the engine (withdrawals are
///         synchronous: funds land in the vault in the same call); fee flow only to the book's RevenueRouter.
/// @dev    ERC-7201 namespaced storage; implementation initializers are disabled in the constructor.
contract PoolEngineAdapter is IPoolEngineAdapter, Initializable, UUPSUpgradeable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------------------------------------
    // §2.8 market defaults
    // ------------------------------------------------------------------------------------------------

    uint16 public constant DEFAULT_INITIAL_MARGIN_BPS = 1000;
    uint16 public constant DEFAULT_MAINTENANCE_MARGIN_BPS = 500;
    uint16 public constant DEFAULT_LIQUIDATION_FEE_BPS = 50;
    uint32 public constant DEFAULT_FUNDING_VELOCITY_BPS = 100;
    /// @dev Mirrors PoolEngine.MAX_SPREAD_BPS: the initial spread (mandate min width) is clamped to it.
    uint16 internal constant ENGINE_MAX_SPREAD_BPS = 5000;
    /// @notice Wind-down: open positions may be force-closed at the oracle this many mark intervals after
    ///         the book starts retiring (traders' notice).
    uint256 public constant CLOSE_OUT_NOTICE_MARKS = 2;

    // ------------------------------------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------------------------------------

    /// @custom:storage-location erc7201:bookrunner.storage.PoolEngineAdapter
    struct AdapterStorage {
        IBookrunnerConfig config;
        address book;
        uint256 bookId;
        IPoolEngine engine;
        IERC20 usdc;
        uint256 marketId;
        bytes32 priceId;
        address vault;
        address desk;
        address mandate;
        address router;
        uint256 withdrawNonce;
        /// @dev Set by a re-mandate (market held reduce-only); the next in-mandate SetQuote lifts it. Any
        ///      later reduce-only request (RISK, kill, retire) clears it, so a kill is never undone by a quote.
        bool liftOnQuote;
    }

    // keccak256(abi.encode(uint256(keccak256("bookrunner.storage.PoolEngineAdapter")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0x5b6be5c326a96061136e532e7179d97957bfd7cafd7388b9f0ade3cacebab400;

    function _s() private pure returns (AdapterStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    // ------------------------------------------------------------------------------------------------
    // Errors / events (beyond IVenueAdapter)
    // ------------------------------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error ConfigMismatch(address config);
    error NotFactory(address caller);
    error WrongVenue(uint8 venue);
    error BookIdMismatch(uint256 expected, uint256 actual);
    error NotBookAdapter(address registered);
    error NoPriceId(bytes32 underlying);
    error BadAccount(uint8 account);
    error NotVault(address caller);
    error NotDesk(address caller);
    error NotTimelock(address caller);
    error Unauthorized(address caller);
    error MandateKilled();
    error BookWindingDown();
    error BookNotWindingDown();
    error ExposureAboveMandate(uint128 maxNetExposureUsd, uint128 maxInventoryUsd);

    event AdapterInitialized(
        uint256 indexed bookId, address indexed book, address engine, uint256 marketId, bytes32 priceId
    );
    /// @notice Synchronous withdrawal settled: `amount` landed in the vault in the same call.
    event WithdrawSettled(uint8 indexed account, uint256 amount, uint256 indexed requestNonce);
    event ReduceOnlyRequested(address indexed by, bool reduceOnly);
    /// @notice Re-mandate applied to the live market (quote clamped to the new terms, held reduce-only).
    event MandateApplied(uint16 spreadBps, int16 skewBps, uint128 maxNetExposureUsd, uint128 inventoryCapUsd);
    /// @notice Wind-down close-out scheduled on the engine market (`notice` seconds from now).
    event CloseOutStarted(uint64 notice);

    // ------------------------------------------------------------------------------------------------
    // Construction / initialisation
    // ------------------------------------------------------------------------------------------------

    /// @notice Protocol config this implementation is bound to (immutable, so it is part of the code that
    ///         every proxy delegates to). Only proxies initialised with this config, by its factory, are valid.
    IBookrunnerConfig public immutable EXPECTED_CONFIG;

    /// @param config_ BookrunnerConfig the proxies must be initialised with.
    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address config_) {
        if (config_ == address(0)) revert ZeroAddress();
        EXPECTED_CONFIG = IBookrunnerConfig(config_);
        _disableInitializers();
    }

    /// @inheritdoc IVenueAdapter
    /// @dev Only `config.factory()` (closes the initialise-front-running window of a lazily deployed proxy),
    ///      with `config_ == EXPECTED_CONFIG`. Called after `book.initialize` (the book must already expose its
    ///      charter and components, with `components.adapter == address(this)`) and after this proxy is
    ///      registered as a factory component (PoolEngine.createMarket checks `factory.isComponent`). May also
    ///      run inside the proxy constructor (init data) when the factory pre-computes the proxy address.
    ///      Creates the market with the §2.8 defaults and sets the initial quote: spread =
    ///      mandate.minQuoteWidthBps (clamped to the engine bound), skew 0, maxNetExposure =
    ///      mandate.maxInventoryUsd.
    function initialize(address config_, uint256 bookId_, address book_) external initializer {
        if (config_ == address(0) || book_ == address(0)) revert ZeroAddress();
        if (config_ != address(EXPECTED_CONFIG)) revert ConfigMismatch(config_);
        if (msg.sender != EXPECTED_CONFIG.factory()) revert NotFactory(msg.sender);
        BRTypes.Charter memory ch = _wire(IBookrunnerConfig(config_), bookId_, book_);
        AdapterStorage storage $ = _s();
        IPoolEngine eng = $.engine;
        uint128 maxInv = ch.mandate.maxInventoryUsd;
        uint256 id = eng.createMarket(
            IPoolEngine.MarketConfig({
                underlying: $.priceId,
                symbol: ch.symbol,
                takerFeeBps: ch.takerFeeBps,
                makerFeeBps: ch.makerFeeBps,
                initialMarginBps: DEFAULT_INITIAL_MARGIN_BPS,
                maintenanceMarginBps: DEFAULT_MAINTENANCE_MARGIN_BPS,
                liquidationFeeBps: DEFAULT_LIQUIDATION_FEE_BPS,
                fundingVelocityBps: DEFAULT_FUNDING_VELOCITY_BPS,
                maxNetExposureUsd: maxInv
            })
        );
        $.marketId = id;
        uint16 spread = ch.mandate.minQuoteWidthBps;
        if (spread > ENGINE_MAX_SPREAD_BPS) spread = ENGINE_MAX_SPREAD_BPS;
        eng.setQuote(id, spread, 0, maxInv);
        emit AdapterInitialized(bookId_, book_, address(eng), id, $.priceId);
    }

    /// @dev Validates the book wiring and caches config, book, engine, USDC, price id and components.
    function _wire(IBookrunnerConfig cfg, uint256 bookId_, address book_)
        private
        returns (BRTypes.Charter memory ch)
    {
        IBook bk = IBook(book_);
        uint256 actualId = bk.bookId();
        if (actualId != bookId_) revert BookIdMismatch(bookId_, actualId);
        ch = bk.getCharter();
        if (ch.venue != BRTypes.VENUE_POOL_ENGINE) revert WrongVenue(ch.venue);
        BRTypes.BookComponents memory comps = bk.components();
        if (comps.adapter != address(this)) revert NotBookAdapter(comps.adapter);
        if (
            comps.vault == address(0) || comps.desk == address(0) || comps.mandate == address(0)
                || comps.router == address(0)
        ) revert ZeroAddress();
        bytes32 pid = IStockTokenRegistry(cfg.stockRegistry()).priceIdOf(ch.underlying);
        if (pid == bytes32(0)) revert NoPriceId(ch.underlying);
        address engineAddr = cfg.poolEngine();
        address usdcAddr = cfg.usdc();
        if (engineAddr == address(0) || usdcAddr == address(0)) revert ZeroAddress();

        AdapterStorage storage $ = _s();
        $.config = cfg;
        $.book = book_;
        $.bookId = bookId_;
        $.engine = IPoolEngine(engineAddr);
        $.usdc = IERC20(usdcAddr);
        $.priceId = pid;
        $.vault = comps.vault;
        $.desk = comps.desk;
        $.mandate = comps.mandate;
        $.router = comps.router;
    }

    // ------------------------------------------------------------------------------------------------
    // Capital movements (vault only)
    // ------------------------------------------------------------------------------------------------

    /// @inheritdoc IVenueAdapter
    /// @dev IF -> engine insurance fund; MM -> engine pool liquidity. Pulls from the vault (approved).
    function depositToVenue(uint8 account, uint256 amount) external nonReentrant {
        AdapterStorage storage $ = _s();
        if (msg.sender != $.vault) revert NotVault(msg.sender);
        if (amount == 0) revert ZeroAmount();
        if (account > BRTypes.ACCOUNT_MM) revert BadAccount(account);
        IPoolEngine eng = $.engine;
        $.usdc.safeTransferFrom(msg.sender, address(this), amount);
        $.usdc.forceApprove(address(eng), amount);
        if (account == BRTypes.ACCOUNT_IF) eng.depositInsurance($.marketId, amount);
        else eng.depositLiquidity($.marketId, amount);
        emit VenueDeposit(account, amount);
    }

    /// @inheritdoc IVenueAdapter
    /// @dev Synchronous: the engine pays the vault directly. MM withdrawals are subject to the engine's
    ///      pool solvency check (reverts if the pool would not cover trader PnL + pool margin).
    function requestWithdraw(uint8 account, uint256 amount) external nonReentrant {
        AdapterStorage storage $ = _s();
        address vault_ = $.vault;
        if (msg.sender != vault_) revert NotVault(msg.sender);
        if (amount == 0) revert ZeroAmount();
        if (account > BRTypes.ACCOUNT_MM) revert BadAccount(account);
        uint256 nonce = ++$.withdrawNonce;
        emit WithdrawRequested(account, amount, nonce);
        if (account == BRTypes.ACCOUNT_IF) $.engine.withdrawInsurance($.marketId, amount, vault_);
        else $.engine.withdrawLiquidity($.marketId, amount, vault_);
        emit WithdrawSettled(account, amount, nonce);
    }

    /// @inheritdoc IVenueAdapter
    /// @dev The adapter never holds funds in normal operation; this returns any stray USDC to the vault.
    function sweepToVault() external nonReentrant returns (uint256 amount) {
        AdapterStorage storage $ = _s();
        amount = $.usdc.balanceOf(address(this));
        if (amount != 0) {
            emit SweptToVault(amount);
            $.usdc.safeTransfer($.vault, amount);
        }
    }

    /// @inheritdoc IVenueAdapter
    /// @dev Anyone. Claims all engine-accrued fees straight to the book's RevenueRouter and notifies it
    ///      (SRC_ENGINE_FEES). `amount` is ignored: engine fees are accrued on-chain, so there is nothing
    ///      to cap. `period` is a label for the waterfall service.
    function sweepFees(
        uint64 period,
        uint256 /* amount */
    )
        external
        nonReentrant
        returns (uint256 swept)
    {
        AdapterStorage storage $ = _s();
        address router_ = $.router;
        swept = $.engine.claimFees($.marketId, router_);
        if (swept != 0) IRevenueRouter(router_).notifySettlement(BRTypes.SRC_ENGINE_FEES, swept);
        emit FeesSwept(period, swept);
    }

    // ------------------------------------------------------------------------------------------------
    // Quote / risk controls
    // ------------------------------------------------------------------------------------------------

    /// @inheritdoc IPoolEngineAdapter
    /// @dev Only the book's desk (which runs mandate.checkQuote). Defence in depth: rejects a killed
    ///      mandate and any maxNetExposureUsd above the mandate's maxInventoryUsd. After a re-mandate the
    ///      market is held reduce-only until this first in-mandate quote from a fresh key, which lifts it
    ///      (Live book only); a reduce-only request made since (RISK / kill / retire) is never lifted here.
    function setQuote(uint16 spreadBps, int16 skewBps, uint128 maxNetExposureUsd) external {
        AdapterStorage storage $ = _s();
        if (msg.sender != $.desk) revert NotDesk(msg.sender);
        IMMMandate mandate_ = IMMMandate($.mandate);
        if (mandate_.killed()) revert MandateKilled();
        uint128 maxInv = mandate_.getMandate().maxInventoryUsd;
        if (maxNetExposureUsd > maxInv) revert ExposureAboveMandate(maxNetExposureUsd, maxInv);
        $.engine.setQuote($.marketId, spreadBps, skewBps, maxNetExposureUsd);
        if ($.liftOnQuote) {
            $.liftOnQuote = false;
            if (IBook($.book).state() == BRTypes.BookState.Live) {
                emit ReduceOnlyRequested(msg.sender, false);
                $.engine.setReduceOnly($.marketId, false);
            }
        }
    }

    /// @inheritdoc IPoolEngineAdapter
    /// @dev Enable: desk, the book's mandate (kill), the book (retire) or the RISK role; on a Retiring /
    ///      Retired book it also schedules the wind-down close-out. Disable: desk, mandate or book only
    ///      (never RISK), and never while the mandate is killed or the book is Retiring/Retired.
    function setReduceOnly(bool reduceOnly) external {
        AdapterStorage storage $ = _s();
        address sender = msg.sender;
        bool component = sender == $.desk || sender == $.mandate || sender == $.book;
        BRTypes.BookState st = IBook($.book).state();
        bool windingDown = st == BRTypes.BookState.Retiring || st == BRTypes.BookState.Retired;
        if (reduceOnly) {
            if (!component && !$.config.hasRole($.config.RISK_ROLE(), sender)) revert Unauthorized(sender);
        } else {
            if (!component) revert Unauthorized(sender);
            if (IMMMandate($.mandate).killed()) revert MandateKilled();
            if (windingDown) revert BookWindingDown();
        }
        $.liftOnQuote = false;
        emit ReduceOnlyRequested(sender, reduceOnly);
        $.engine.setReduceOnly($.marketId, reduceOnly);
        if (reduceOnly && windingDown) _startCloseOut($);
    }

    /// @notice Anyone, once the book is Retiring or Retired: reduce-only for good and schedules the
    ///         close-out (CLOSE_OUT_NOTICE_MARKS mark intervals from the first call), after which anyone may
    ///         close remaining positions at the oracle (PoolEngine.forceClose) so the book can finalize.
    ///         Idempotent. Also runs automatically when the retire kill sets reduce-only.
    function startCloseOut() external {
        AdapterStorage storage $ = _s();
        BRTypes.BookState st = IBook($.book).state();
        if (st != BRTypes.BookState.Retiring && st != BRTypes.BookState.Retired) revert BookNotWindingDown();
        _startCloseOut($);
    }

    /// @notice Only the book's mandate, on a re-mandate: brings the live engine quote within the new terms
    ///         (inventory cap = maxInventoryUsd, quote cap <= it, spread >= minQuoteWidthBps, |skew| <=
    ///         maxSkewBps) and holds the market reduce-only until a fresh key quotes under the new terms.
    function applyMandate() external {
        AdapterStorage storage $ = _s();
        if (msg.sender != $.mandate) revert Unauthorized(msg.sender);
        BRTypes.Mandate memory md = IMMMandate($.mandate).getMandate();
        IPoolEngine eng = $.engine;
        uint256 id = $.marketId;
        IPoolEngine.MarketState memory st = eng.state(id);
        uint128 maxNet = eng.config(id).maxNetExposureUsd;
        if (maxNet > md.maxInventoryUsd) maxNet = md.maxInventoryUsd;
        uint16 spread = st.spreadBps > md.minQuoteWidthBps ? st.spreadBps : md.minQuoteWidthBps;
        if (spread > ENGINE_MAX_SPREAD_BPS) spread = ENGINE_MAX_SPREAD_BPS;
        int16 skew = st.skewBps;
        if (skew > md.maxSkewBps) skew = md.maxSkewBps;
        else if (skew < -md.maxSkewBps) skew = -md.maxSkewBps;
        IPoolEngineControls(address(eng)).setInventoryCap(id, md.maxInventoryUsd);
        eng.setQuote(id, spread, skew, maxNet);
        eng.setReduceOnly(id, true);
        $.liftOnQuote = IBook($.book).state() == BRTypes.BookState.Live;
        emit MandateApplied(spread, skew, maxNet, md.maxInventoryUsd);
    }

    function _startCloseOut(AdapterStorage storage $) private {
        $.liftOnQuote = false;
        uint64 notice = uint64(CLOSE_OUT_NOTICE_MARKS * $.config.markInterval());
        emit CloseOutStarted(notice);
        IPoolEngineControls(address($.engine)).startCloseOut($.marketId, notice);
    }

    // ------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------

    /// @inheritdoc IVenueAdapter
    function book() external view returns (address) {
        return _s().book;
    }

    /// @inheritdoc IVenueAdapter
    function venueKind() external pure returns (uint8) {
        return BRTypes.VENUE_POOL_ENGINE;
    }

    /// @inheritdoc IPoolEngineAdapter
    function marketId() external view returns (uint256) {
        return _s().marketId;
    }

    /// @notice Protocol registry.
    function config() external view returns (address) {
        return address(_s().config);
    }

    /// @notice Book id (== charter id).
    function bookId() external view returns (uint256) {
        return _s().bookId;
    }

    /// @notice The shared PoolEngine.
    function engine() external view returns (address) {
        return address(_s().engine);
    }

    /// @notice Oracle price id of the market (registry `priceIdOf(charter.underlying)`).
    function priceId() external view returns (bytes32) {
        return _s().priceId;
    }

    /// @notice The book's components cached at initialisation: vault, desk, mandate, router.
    function wiring()
        external
        view
        returns (address vault_, address desk_, address mandate_, address router_)
    {
        AdapterStorage storage $ = _s();
        return ($.vault, $.desk, $.mandate, $.router);
    }

    /// @notice Number of synchronous withdrawals executed.
    function withdrawNonce() external view returns (uint256) {
        return _s().withdrawNonce;
    }

    /// @inheritdoc IVenueAdapter
    function insuranceEquityUsd() public view returns (uint256) {
        AdapterStorage storage $ = _s();
        return $.engine.state($.marketId).insuranceUsd;
    }

    /// @inheritdoc IVenueAdapter
    /// @dev Pool equity = poolCash - aggregate trader unrealised PnL - net funding owed to traders.
    function marginEquityUsd() public view returns (int256) {
        AdapterStorage storage $ = _s();
        return $.engine.poolEquityUsd($.marketId);
    }

    /// @inheritdoc IVenueAdapter
    /// @dev The pool's signed exposure (the pool is the book's MM inventory; positive = book long).
    function netExposureUsd() external view returns (int256) {
        AdapterStorage storage $ = _s();
        return $.engine.netExposureUsd($.marketId);
    }

    /// @inheritdoc IVenueAdapter
    /// @dev Withdrawals are synchronous: nothing is ever in transit.
    function inTransitUsd() external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IVenueAdapter
    /// @dev max(insurance + poolEquity, 0): a negative pool equity (traders' unrealised gains the pool cash
    ///      cannot pay) is a claim on the IF (`_settle` pays winners pool -> IF -> ADL), so it is netted.
    function deployedValueUsd() external view returns (uint256) {
        int256 v = int256(insuranceEquityUsd()) + marginEquityUsd();
        return v > 0 ? uint256(v) : 0;
    }

    /// @inheritdoc IVenueAdapter
    function valuationAt() external view returns (uint64) {
        return uint64(block.timestamp);
    }

    // ------------------------------------------------------------------------------------------------
    // Upgrades
    // ------------------------------------------------------------------------------------------------

    /// @dev Only the protocol timelock may upgrade.
    function _authorizeUpgrade(address) internal view override {
        address tl = _s().config.timelock();
        if (msg.sender != tl) revert NotTimelock(msg.sender);
    }
}
