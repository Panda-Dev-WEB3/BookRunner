// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {TransientSlot} from "@openzeppelin/contracts/utils/TransientSlot.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/IERC4337.sol";

import {BRTypes} from "./interfaces/BRTypes.sol";
import {IBookrunnerDesk} from "./interfaces/IBookrunnerDesk.sol";
import {IMMMandate} from "./interfaces/IMMMandate.sol";
import {IBook} from "./interfaces/IBook.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {IStockTokenRegistry} from "./interfaces/IStockTokenRegistry.sol";
import {IHedgeExecutor} from "./interfaces/IHedgeExecutor.sol";
import {IUnderwritingVault} from "./interfaces/IUnderwritingVault.sol";
import {IPoolEngineAdapter} from "./interfaces/IVenueAdapter.sol";
import {IAttestedOracle} from "./interfaces/IAttestedOracle.sol";
import {IMMMandateDesk, IDeskKeySync} from "./MMMandate.sol";

/// @title IDeskReturnVault — UnderwritingVault extension the desk calls on ReturnToVault.
/// @notice Requested from A-book: `UnderwritingVault.notifyDeskReturn(uint256 amount)`, callable only by
///         the book's desk after it transferred `amount` USDC to the vault; the vault accounts the
///         inflow and calls `book.onCapitalFlow()` (flowNonce++), exactly like deploy/recall/fundDesk.
interface IDeskReturnVault {
    function notifyDeskReturn(uint256 amount) external;
}

/// @title BookrunnerDesk — per-book ERC-4337 v0.7 account operated by mandate session keys.
/// @notice There is NO generic call: `execute` only runs the typed actions of IBookrunnerDesk.ActionKind,
///         each validated by the book's MMMandate. Holds the book's long-spot hedge inventory (canonical
///         Stock Tokens) and its USDC hedge budget.
///
///         Pull oracle (LOW_GAS.md §1): `executeWithPrices(action, priceData)` relays the signed price
///         bundle to `AttestedOracle.update` and then runs exactly the `execute` path, so the mandate's
///         off-hours / staleness rules and the registry valuations see the price this transaction brought.
///
///         Callers of `execute` / `executeWithPrices`:
///           - the EntryPoint, for a userOp validated by {validateUserOp}; the signer recorded at
///             validation is re-checked with `mandate.isActiveKey` at execution (revocation race closed);
///           - an active desk key directly (EOA tx; devnet / no bundler);
///           - the RISK role, for reduce-only kinds only (Flatten, InventoryToVault, ReturnToVault).
///
///         ERC-7562: validation reads only desk storage (a key mirror the mandate maintains through
///         {syncKey}, and the cached EntryPoint) and returns the key's `validUntil` in validationData
///         instead of reading the clock; everything else is re-validated at execution.
///
///         Swaps (Hedge / Flatten) go through config.hedgeExecutor() with an exact approval. Hedges are
///         validated post-trade on the measured inventory (`mandate.checkHedgeExecuted`), so the bound
///         is the executed leg, not an estimate; a key's Flatten meets the same off-hours / band rules
///         (`mandate.checkFlatten`). Key-initiated swaps must also execute within `maxSlippageBps` of the
///         attested oracle value (no self-sandwiching the book), and their cumulative loss vs the oracle
///         per mark period is capped at `periodSlippageBudgetBps` of maxInventoryUsd (no bleeding the book
///         by churning in-band). RISK Flatten is bounded by `riskMaxSlippageBps` whenever the price is
///         fresh, and is never blocked by a stale price.
contract BookrunnerDesk is IBookrunnerDesk, IDeskKeySync, Initializable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;
    using TransientSlot for *;

    // ------------------------------------------------------------------ constants

    bytes32 internal constant RISK_ROLE = keccak256("RISK");
    uint256 internal constant BPS = 10_000;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;
    /// @dev Transient slot seed: signer of a validated userOp, keyed by keccak256(callData).
    bytes32 internal constant USEROP_SIGNER_SEED = keccak256("bookrunner.desk.userop.signer");

    /// @notice Spot legs are 1.00x (0.01x units).
    uint16 public constant SPOT_LEVERAGE = 100;
    /// @notice Max distinct Stock Tokens the desk tracks (bounds valuation loops).
    uint256 public constant MAX_HELD_TOKENS = 16;
    uint16 public constant DEFAULT_MAX_SLIPPAGE_BPS = 300;
    uint16 public constant MAX_SLIPPAGE_LIMIT_BPS = 2000;
    /// @notice RISK Flatten with a fresh price: max loss vs the oracle value (bps).
    uint16 public constant DEFAULT_RISK_MAX_SLIPPAGE_BPS = 1000;
    /// @notice Key swaps: cumulative loss vs the oracle per mark period, bps of maxInventoryUsd.
    uint16 public constant DEFAULT_PERIOD_SLIPPAGE_BUDGET_BPS = 200;
    bytes32 public constant VENUE_UNIV3 = "UNIV3";
    bytes32 public constant VENUE_UNIV4 = "UNIV4";

    // ------------------------------------------------------------------ storage

    IBookrunnerConfig public config;
    uint256 public bookId;
    /// @inheritdoc IBookrunnerDesk
    address public book;
    address public mandate;
    address public vault;
    address public adapter;
    address public usdc;
    uint8 public venue;
    /// @notice EntryPoint cached from config (ERC-7562: no foreign storage reads in validation).
    address public entryPoint;
    /// @notice Max loss vs the oracle value tolerated on key-initiated swaps (bps).
    uint16 public maxSlippageBps;
    /// @notice Mandate-maintained mirror of active keys: validUntil, 0 = inactive.
    mapping(address key => uint64) public sessionKeyValidUntil;
    EnumerableSet.AddressSet internal _held;
    /// @notice Max loss vs the oracle value tolerated on a RISK Flatten priced at a fresh price (bps).
    uint16 public riskMaxSlippageBps;
    /// @notice Budget for key swaps' cumulative loss vs the oracle per mark period (bps of maxInventoryUsd).
    uint16 public periodSlippageBudgetBps;
    /// @notice Key swaps' cumulative loss vs the oracle value (USD 6dp) per period (timestamp / markInterval).
    mapping(uint256 period => uint256 lossUsd) public slippageUsedUsd;

    struct HedgeOrder {
        address token;
        bool buy;
        uint256 amountIn;
        uint256 minAmountOut;
        uint24 poolFee;
        bytes32 venue;
    }

    // ------------------------------------------------------------------ errors / events

    error ZeroAddress();
    error ZeroAmount();
    error ComponentMismatch();
    error NotAuthorized(address caller);
    error NotEntryPoint(address caller);
    error NotMandate(address caller);
    error Unauthorized(address caller);
    error BadVenue(bytes32 venue);
    error NotCanonical(address token);
    error NotHeld(address token);
    error TooManyHeldTokens();
    error NotEngineBook();
    error InsufficientOutput(uint256 amountOut, uint256 minAmountOut);
    error InsufficientBalance(uint256 requested, uint256 available);
    error FundingShortfall(uint256 expected, uint256 received);
    error SlippageTooHigh(uint256 valueGivenUsd, uint256 valueReceivedUsd);
    error SlippageBudgetExceeded(uint256 usedUsd, uint256 budgetUsd);
    error BadSlippage(uint16 bps);
    error NativeTransferFailed();

    event SessionKeySynced(address indexed key, uint64 validUntil);
    event EntryPointSynced(address indexed entryPoint);
    event MaxSlippageSet(uint16 bps);
    event RiskSlippageParamsSet(uint16 riskMaxSlippageBps, uint16 periodSlippageBudgetBps);
    event HeldTokenAdded(address indexed token);
    event HeldTokenRemoved(address indexed token);
    event NativeWithdrawn(address indexed to, uint256 amount);

    // ------------------------------------------------------------------ init

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @inheritdoc IBookrunnerDesk
    /// @dev Called by the factory after `book.initialize`. Caches components, USDC and the EntryPoint.
    function initialize(address config_, uint256 bookId_, address book_) external override initializer {
        if (config_ == address(0) || book_ == address(0)) revert ZeroAddress();
        IBook b = IBook(book_);
        BRTypes.BookComponents memory c = b.components();
        if (c.desk != address(this) || b.bookId() != bookId_) revert ComponentMismatch();
        if (c.mandate == address(0) || c.vault == address(0) || c.adapter == address(0)) {
            revert ComponentMismatch();
        }
        IBookrunnerConfig cfg = IBookrunnerConfig(config_);
        address usdc_ = cfg.usdc();
        if (usdc_ == address(0)) revert ZeroAddress();

        config = cfg;
        bookId = bookId_;
        book = book_;
        mandate = c.mandate;
        vault = c.vault;
        adapter = c.adapter;
        usdc = usdc_;
        venue = b.getCharter().venue;
        maxSlippageBps = DEFAULT_MAX_SLIPPAGE_BPS;
        riskMaxSlippageBps = DEFAULT_RISK_MAX_SLIPPAGE_BPS;
        periodSlippageBudgetBps = DEFAULT_PERIOD_SLIPPAGE_BUDGET_BPS;
        address ep = cfg.entryPoint();
        entryPoint = ep;
        emit EntryPointSynced(ep);
        emit MaxSlippageSet(DEFAULT_MAX_SLIPPAGE_BPS);
        emit RiskSlippageParamsSet(DEFAULT_RISK_MAX_SLIPPAGE_BPS, DEFAULT_PERIOD_SLIPPAGE_BUDGET_BPS);
    }

    receive() external payable {}

    // ------------------------------------------------------------------ ERC-4337

    /// @inheritdoc IBookrunnerDesk
    /// @dev Only the cached EntryPoint. Returns SIG_VALIDATION_FAILED (1) when callData is neither
    ///      `execute(Action)` nor `executeWithPrices(Action,bytes)` or the signature (ECDSA over
    ///      toEthSignedMessageHash(userOpHash)) is not by a key the mandate mirrored as active; on success
    ///      returns the key's validUntil packed per ERC-4337 (sigFailed = 0). Pays `missingAccountFunds` to
    ///      the EntryPoint.
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external override returns (uint256 validationData) {
        address ep = entryPoint;
        if (msg.sender != ep || ep == address(0)) revert NotEntryPoint(msg.sender);
        validationData = _validateSignature(userOp, userOpHash);
        if (missingAccountFunds != 0) {
            // Failure is the EntryPoint's to detect (it checks the prefund); standard account behaviour.
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}("");
            ok;
        }
    }

    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        returns (uint256)
    {
        bytes calldata cd = userOp.callData;
        if (cd.length < 4) return SIG_VALIDATION_FAILED;
        bytes4 sel = bytes4(cd[:4]);
        if (sel != this.execute.selector && sel != this.executeWithPrices.selector) return SIG_VALIDATION_FAILED;
        (address signer, ECDSA.RecoverError err,) =
            ECDSA.tryRecoverCalldata(MessageHashUtils.toEthSignedMessageHash(userOpHash), userOp.signature);
        if (err != ECDSA.RecoverError.NoError || signer == address(0)) return SIG_VALIDATION_FAILED;
        uint64 validUntil = sessionKeyValidUntil[signer];
        if (validUntil == 0) return SIG_VALIDATION_FAILED;
        _signerSlot(keccak256(cd)).tstore(signer);
        uint48 until = validUntil > type(uint48).max ? type(uint48).max : uint48(validUntil);
        return uint256(until) << 160;
    }

    /// @notice Only the mandate: mirror a key's validity for validation (0 = inactive).
    function syncKey(address key, uint64 validUntil) external override {
        if (msg.sender != mandate) revert NotMandate(msg.sender);
        sessionKeyValidUntil[key] = validUntil;
        emit SessionKeySynced(key, validUntil);
    }

    /// @notice Anyone: re-read the EntryPoint from config (after a config change).
    function syncEntryPoint() external {
        address ep = config.entryPoint();
        entryPoint = ep;
        emit EntryPointSynced(ep);
    }

    // ------------------------------------------------------------------ execute

    /// @inheritdoc IBookrunnerDesk
    function execute(Action calldata action) external override nonReentrant returns (bytes memory result) {
        (address key, bool viaRisk) = _authorize(action.kind);
        result = _execute(key, viaRisk, action);
    }

    /// @inheritdoc IBookrunnerDesk
    /// @dev Same callers and checks as {execute}; after authorisation `AttestedOracle.update(priceData)`
    ///      runs first when `priceData` is non-empty (not-newer entries skipped, a bad signature reverts the
    ///      whole action).
    function executeWithPrices(Action calldata action, bytes calldata priceData)
        external
        override
        nonReentrant
        returns (bytes memory result)
    {
        (address key, bool viaRisk) = _authorize(action.kind);
        if (priceData.length != 0) IAttestedOracle(config.oracle()).update(priceData);
        result = _execute(key, viaRisk, action);
    }

    function _execute(address key, bool viaRisk, Action calldata action) internal returns (bytes memory result) {
        ActionKind kind = action.kind;
        if (kind == ActionKind.Hedge) {
            result = _hedge(key, action.data, action.proof);
        } else if (kind == ActionKind.InventoryToVenue) {
            _inventoryMove(key, true, action.data);
        } else if (kind == ActionKind.InventoryToVault) {
            _inventoryMove(key, false, action.data);
        } else if (kind == ActionKind.FundDesk) {
            _fundDesk(key, action.data);
        } else if (kind == ActionKind.ReturnToVault) {
            _returnToVault(action.data);
        } else if (kind == ActionKind.SetQuote) {
            _setQuote(key, action.data);
        } else {
            result = _flatten(key, viaRisk, action.data);
        }
        emit ActionExecuted(key, kind, action.data);
    }

    function _authorize(ActionKind kind) internal view returns (address key, bool viaRisk) {
        IMMMandate m = IMMMandate(mandate);
        address ep = entryPoint;
        if (msg.sender == ep && ep != address(0)) {
            key = _signerSlot(keccak256(msg.data)).tload();
            if (key == address(0) || !m.isActiveKey(key)) revert NotAuthorized(key);
            return (key, false);
        }
        if (m.isActiveKey(msg.sender)) return (msg.sender, false);
        if (
            (kind == ActionKind.Flatten
                    || kind == ActionKind.InventoryToVault
                    || kind == ActionKind.ReturnToVault) && config.hasRole(RISK_ROLE, msg.sender)
        ) return (msg.sender, true);
        revert NotAuthorized(msg.sender);
    }

    function _hedge(address key, bytes calldata data, bytes32[] calldata proof)
        internal
        returns (bytes memory)
    {
        HedgeOrder memory o;
        (o.token, o.buy, o.amountIn, o.minAmountOut, o.poolFee, o.venue) =
            abi.decode(data, (address, bool, uint256, uint256, uint24, bytes32));
        if (o.amountIn == 0) revert ZeroAmount();
        _requireSpotVenue(o.venue);
        IStockTokenRegistry reg = _registry();
        if (!reg.isCanonical(o.token)) revert NotCanonical(o.token);
        if (!o.buy && o.amountIn > IERC20(o.token).balanceOf(address(this))) {
            revert IMMMandate.SpotShortNotAllowed();
        }

        int256 before = SafeCast.toInt256(_hedgeValue(reg));
        (uint256 spent, uint256 received) = o.buy
            ? _swap(o.venue, usdc, o.token, o.poolFee, o.amountIn, o.minAmountOut)
            : _swap(o.venue, o.token, usdc, o.poolFee, o.amountIn, o.minAmountOut);
        _syncHeld(o.token);
        int256 after_ = SafeCast.toInt256(_hedgeValue(reg));

        uint256 tokenQty = o.buy ? received : spent;
        uint256 tokenValue = reg.valueUsd(o.token, tokenQty);
        if (o.buy) _chargeSlippage(spent, tokenValue);
        else _chargeSlippage(tokenValue, received);

        IMMMandateDesk(mandate)
            .checkHedgeExecuted(
                key,
                IMMMandate.HedgeParams({
                    asset: bytes32(uint256(uint160(o.token))),
                    venue: o.venue,
                    buy: o.buy,
                    qtyRaw: tokenQty,
                    notionalUsd: tokenValue,
                    leverage: SPOT_LEVERAGE
                }),
                proof,
                before,
                after_,
                IERC20(o.token).balanceOf(address(this))
            );
        emit HedgeExecuted(
            o.token,
            o.buy,
            spent,
            received,
            before > after_ ? uint256(before - after_) : uint256(after_ - before)
        );
        return abi.encode(received);
    }

    function _flatten(address key, bool viaRisk, bytes calldata data) internal returns (bytes memory) {
        HedgeOrder memory o;
        (o.token, o.amountIn, o.minAmountOut, o.poolFee, o.venue) =
            abi.decode(data, (address, uint256, uint256, uint24, bytes32));
        if (o.amountIn == 0) revert ZeroAmount();
        _requireSpotVenue(o.venue);
        if (!_held.contains(o.token)) revert NotHeld(o.token);
        if (o.amountIn > IERC20(o.token).balanceOf(address(this))) revert IMMMandate.SpotShortNotAllowed();

        IStockTokenRegistry reg = _registry();
        int256 before = viaRisk ? int256(0) : SafeCast.toInt256(_hedgeValue(reg));
        (uint256 spent, uint256 received) = _swap(o.venue, o.token, usdc, o.poolFee, o.amountIn, o.minAmountOut);
        _syncHeld(o.token);

        uint256 notional;
        if (viaRisk) {
            // Emergency path (trusted role): never blocked by a stale price, but bounded when it is fresh.
            try reg.valueUsd(o.token, spent) returns (uint256 v) {
                notional = v;
            } catch {}
            _checkSlippageBps(notional, received, riskMaxSlippageBps);
        } else {
            notional = reg.valueUsd(o.token, spent);
            _chargeSlippage(notional, received);
            IMMMandateDesk(mandate).checkFlatten(key, before, SafeCast.toInt256(_hedgeValue(reg)));
        }
        emit HedgeExecuted(o.token, false, spent, received, notional);
        return abi.encode(received);
    }

    function _inventoryMove(address key, bool toVenue, bytes calldata data) internal {
        (uint8 account, uint256 amount) = abi.decode(data, (uint8, uint256));
        if (amount == 0) revert ZeroAmount();
        IMMMandate(mandate).checkInventoryMove(key, toVenue, account, amount);
        if (toVenue) IUnderwritingVault(vault).deployToVenue(account, amount);
        else IUnderwritingVault(vault).recall(account, amount);
    }

    function _fundDesk(address key, bytes calldata data) internal {
        uint256 amount = abi.decode(data, (uint256));
        if (amount == 0) revert ZeroAmount();
        IMMMandateDesk(mandate).checkFundDesk(key, amount);
        IERC20 u = IERC20(usdc);
        uint256 before = u.balanceOf(address(this));
        IUnderwritingVault(vault).fundDesk(amount);
        uint256 got = u.balanceOf(address(this)) - before;
        if (got < amount) revert FundingShortfall(amount, got);
    }

    function _returnToVault(bytes calldata data) internal {
        uint256 amount = abi.decode(data, (uint256));
        if (amount == 0) revert ZeroAmount();
        IERC20 u = IERC20(usdc);
        uint256 bal = u.balanceOf(address(this));
        if (amount > bal) revert InsufficientBalance(amount, bal);
        u.safeTransfer(vault, amount);
        IDeskReturnVault(vault).notifyDeskReturn(amount);
    }

    function _setQuote(address key, bytes calldata data) internal {
        (uint16 spreadBps, int16 skewBps, uint128 maxNetExposureUsd) =
            abi.decode(data, (uint16, int16, uint128));
        if (venue != BRTypes.VENUE_POOL_ENGINE) revert NotEngineBook();
        IMMMandate(mandate).checkQuote(key, spreadBps, skewBps, maxNetExposureUsd);
        IPoolEngineAdapter(adapter).setQuote(spreadBps, skewBps, maxNetExposureUsd);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Timelock: slippage tolerance for key-initiated swaps (<= MAX_SLIPPAGE_LIMIT_BPS).
    function setMaxSlippageBps(uint16 bps) external {
        if (msg.sender != config.timelock()) revert Unauthorized(msg.sender);
        if (bps > MAX_SLIPPAGE_LIMIT_BPS) revert BadSlippage(bps);
        maxSlippageBps = bps;
        emit MaxSlippageSet(bps);
    }

    /// @notice Timelock: RISK Flatten slippage bound (fresh price, <= MAX_SLIPPAGE_LIMIT_BPS) and the key
    ///         swaps' per-period loss budget (bps of maxInventoryUsd, <= 1e4).
    function setRiskSlippageParams(uint16 riskBps, uint16 periodBudgetBps) external {
        if (msg.sender != config.timelock()) revert Unauthorized(msg.sender);
        if (riskBps > MAX_SLIPPAGE_LIMIT_BPS) revert BadSlippage(riskBps);
        if (periodBudgetBps > BPS) revert BadSlippage(periodBudgetBps);
        riskMaxSlippageBps = riskBps;
        periodSlippageBudgetBps = periodBudgetBps;
        emit RiskSlippageParamsSet(riskBps, periodBudgetBps);
    }

    /// @notice Timelock: recover native gas balance held by the account.
    function withdrawNative(address payable to, uint256 amount) external nonReentrant {
        if (msg.sender != config.timelock()) revert Unauthorized(msg.sender);
        if (to == address(0)) revert ZeroAddress();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit NativeWithdrawn(to, amount);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IBookrunnerDesk
    /// @dev Sum over held canonical tokens of registry.valueUsd(token, balance); reverts on a stale price.
    function hedgeNotionalUsd() external view override returns (int256) {
        return SafeCast.toInt256(_hedgeValue(_registry()));
    }

    /// @inheritdoc IBookrunnerDesk
    function valueUsd() external view override returns (uint256) {
        return IERC20(usdc).balanceOf(address(this)) + _hedgeValue(_registry());
    }

    /// @inheritdoc IBookrunnerDesk
    function heldTokens() external view override returns (address[] memory) {
        return _held.values();
    }

    // ------------------------------------------------------------------ internals

    function _swap(
        bytes32 hedgeVenue,
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 minAmountOut
    ) internal returns (uint256 spent, uint256 received) {
        address exec = config.hedgeExecutor();
        if (exec == address(0)) revert ZeroAddress();
        IERC20 tin = IERC20(tokenIn);
        IERC20 tout = IERC20(tokenOut);
        uint256 inBefore = tin.balanceOf(address(this));
        uint256 outBefore = tout.balanceOf(address(this));
        tin.forceApprove(exec, amountIn);
        IHedgeExecutor(exec)
            .swapExactIn(hedgeVenue, tokenIn, tokenOut, poolFee, amountIn, minAmountOut, address(this));
        if (tin.allowance(address(this), exec) != 0) tin.forceApprove(exec, 0);
        spent = inBefore - tin.balanceOf(address(this));
        received = tout.balanceOf(address(this)) - outBefore;
        if (received < minAmountOut) revert InsufficientOutput(received, minAmountOut);
    }

    function _syncHeld(address token) internal {
        if (IERC20(token).balanceOf(address(this)) != 0) {
            if (!_held.contains(token)) {
                if (_held.length() >= MAX_HELD_TOKENS) revert TooManyHeldTokens();
                _held.add(token);
                emit HeldTokenAdded(token);
            }
        } else if (_held.remove(token)) {
            emit HeldTokenRemoved(token);
        }
    }

    function _hedgeValue(IStockTokenRegistry reg) internal view returns (uint256 total) {
        uint256 n = _held.length();
        for (uint256 i; i < n; ++i) {
            address token = _held.at(i);
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal != 0) total += reg.valueUsd(token, bal);
        }
    }

    /// @dev Reverts unless valueReceived >= valueGiven * (1 - bps).
    function _checkSlippageBps(uint256 valueGivenUsd, uint256 valueReceivedUsd, uint16 bps) internal pure {
        if (valueReceivedUsd * BPS < valueGivenUsd * (BPS - bps)) {
            revert SlippageTooHigh(valueGivenUsd, valueReceivedUsd);
        }
    }

    /// @dev Key-initiated swap: per-swap bound (maxSlippageBps) plus the per-mark-period budget on the
    ///      cumulative loss vs the oracle value (periodSlippageBudgetBps of maxInventoryUsd).
    function _chargeSlippage(uint256 valueGivenUsd, uint256 valueReceivedUsd) internal {
        _checkSlippageBps(valueGivenUsd, valueReceivedUsd, maxSlippageBps);
        if (valueReceivedUsd >= valueGivenUsd) return;
        uint256 interval = config.markInterval();
        uint256 period = interval == 0 ? 0 : block.timestamp / interval;
        uint256 used = slippageUsedUsd[period] + (valueGivenUsd - valueReceivedUsd);
        uint256 budget =
            uint256(IMMMandate(mandate).getMandate().maxInventoryUsd) * periodSlippageBudgetBps / BPS;
        if (used > budget) revert SlippageBudgetExceeded(used, budget);
        slippageUsedUsd[period] = used;
    }

    function _requireSpotVenue(bytes32 v) internal pure {
        if (v != VENUE_UNIV3 && v != VENUE_UNIV4) revert BadVenue(v);
    }

    function _registry() internal view returns (IStockTokenRegistry) {
        return IStockTokenRegistry(config.stockRegistry());
    }

    function _signerSlot(bytes32 callDataHash) internal pure returns (TransientSlot.AddressSlot) {
        return keccak256(abi.encode(USEROP_SIGNER_SEED, callDataHash)).asAddress();
    }
}
