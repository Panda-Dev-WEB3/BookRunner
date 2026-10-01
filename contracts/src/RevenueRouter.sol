// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {BRTypes} from "./interfaces/BRTypes.sol";
import {IRevenueRouter} from "./interfaces/IRevenueRouter.sol";
import {IBook} from "./interfaces/IBook.sol";
import {IBkrnFeeRouter} from "./interfaces/IBkrnFeeRouter.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";

/// @title RevenueRouter — per-book fee-flow waterfall (EIP-1167 clone, one per book).
/// @notice Fee flow (venue builder share, engine fees, funding, liquidation fees) is pushed here and
///         acknowledged with `notifySettlement`. Once per mark period a KEEPER calls `distribute`, which
///         splits the pending gross exactly as `splitDistribution` in packages/shared/src/waterfall.ts:
///         expenses (capped at `expenseCapBps` of gross) -> protocol carry (`carryBps` of net) ->
///         Senior share (`seniorHurdleBps` of the remainder) -> Junior residual. Expenses go to
///         `config.expenseRecipient()`, carry to `BkrnFeeRouter.notifyCarry`, Senior + Junior to the
///         book's UnderwritingVault, credited via `IBook.creditDistribution`.
/// @dev Accounting: `pendingGross` is exactly the USDC this router has acknowledged and not yet paid out
///      (a distribution pays out exactly `gross`: expenses + carry + senior + junior == gross). A
///      settlement of `amount` is accepted only if the actual balance covers `pendingGross + amount`;
///      USDC pushed without a notification stays unacknowledged until someone notifies it.
contract RevenueRouter is Initializable, ReentrancyGuardTransient, IRevenueRouter {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    bytes32 private constant KEEPER_ROLE = keccak256("KEEPER");

    /// @notice Protocol registry.
    IBookrunnerConfig public config;
    /// @inheritdoc IRevenueRouter
    uint256 public bookId;
    /// @inheritdoc IRevenueRouter
    address public book;
    /// @notice USDC (config.usdc() at initialization).
    IERC20 public usdc;

    /// @inheritdoc IRevenueRouter
    uint256 public pendingGross;
    /// @notice Whether a period label has been distributed (idempotency for the waterfall service).
    mapping(uint64 period => bool) public distributed;

    /// @notice Lifetime totals: [gross, expenses, carry, senior, junior].
    uint256[5] private _totals;

    error ZeroAddress();
    error InvalidSource(uint8 source);
    error SettlementNotReceived(uint256 required, uint256 balance);
    error NotKeeper(address caller);
    error AlreadyDistributed(uint64 period);
    error NotConfigured(bytes32 what);
    error BpsOutOfRange(uint256 bps);

    /// @dev Locks the implementation; clones are initialized by the BookFactory.
    constructor() {
        _disableInitializers();
    }

    /// @inheritdoc IRevenueRouter
    /// @dev Called once by the BookFactory right after cloning. Caches `config.usdc()`.
    function initialize(address config_, uint256 bookId_, address book_) external initializer {
        if (config_ == address(0) || book_ == address(0)) revert ZeroAddress();
        address usdc_ = IBookrunnerConfig(config_).usdc();
        if (usdc_ == address(0)) revert ZeroAddress();
        config = IBookrunnerConfig(config_);
        bookId = bookId_;
        book = book_;
        usdc = IERC20(usdc_);
    }

    // ---------------------------------------------------------------------------------------------
    // Settlement intake
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IRevenueRouter
    /// @dev Anyone may call (adapter, engine, donor), but only for USDC that has actually arrived and has
    ///      not been acknowledged yet. A zero amount is a no-op.
    function notifySettlement(uint8 source, uint256 amount) external nonReentrant {
        if (source > BRTypes.SRC_OTHER) revert InvalidSource(source);
        if (amount == 0) return;
        uint256 required = pendingGross + amount;
        uint256 bal = usdc.balanceOf(address(this));
        if (bal < required) revert SettlementNotReceived(required, bal);
        pendingGross = required;
        emit SettlementReceived(bookId, source, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Distribution
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IRevenueRouter
    /// @dev KEEPER only; each `period` once. Distributes the whole `pendingGross`. With `gross == 0` the
    ///      call is a no-op that still marks the period and emits `Distributed` with zeros.
    function distribute(uint64 period, uint256 expensesRequested)
        external
        nonReentrant
        returns (Amounts memory a)
    {
        if (!config.hasRole(KEEPER_ROLE, msg.sender)) revert NotKeeper(msg.sender);
        if (distributed[period]) revert AlreadyDistributed(period);
        distributed[period] = true;

        uint256 gross = pendingGross;
        if (gross == 0) {
            emit Distributed(bookId, period, [uint256(0), 0, 0, 0, 0]);
            return a;
        }

        BRTypes.BookComponents memory c = IBook(book).components();
        a = _preview(c, gross, expensesRequested);

        pendingGross = 0;
        _totals[0] += a.gross;
        _totals[1] += a.expenses;
        _totals[2] += a.carry;
        _totals[3] += a.senior;
        _totals[4] += a.junior;
        emit Distributed(bookId, period, [a.gross, a.expenses, a.carry, a.senior, a.junior]);

        if (a.expenses > 0) {
            address recipient = config.expenseRecipient();
            if (recipient == address(0)) revert NotConfigured("expenseRecipient");
            usdc.safeTransfer(recipient, a.expenses);
        }
        if (a.carry > 0) {
            address feeRouter = config.feeRouter();
            if (feeRouter == address(0)) revert NotConfigured("feeRouter");
            usdc.safeTransfer(feeRouter, a.carry);
            IBkrnFeeRouter(feeRouter).notifyCarry(bookId, a.carry);
        }
        uint256 toVault = a.senior + a.junior;
        if (toVault > 0) {
            if (c.vault == address(0)) revert NotConfigured("vault");
            usdc.safeTransfer(c.vault, toVault);
            IBook(book).creditDistribution(a.senior, a.junior);
        }
    }

    /// @inheritdoc IRevenueRouter
    function previewSplit(uint256 gross, uint256 expensesRequested) external view returns (Amounts memory) {
        return _preview(IBook(book).components(), gross, expensesRequested);
    }

    /// @notice Lifetime distributed totals: [gross, expenses, carry, senior, junior].
    function totals() external view returns (uint256[5] memory) {
        return _totals;
    }

    /// @notice Pure split, identical to `splitDistribution` in packages/shared/src/waterfall.ts.
    /// @dev All divisions floor. Reverts `BpsOutOfRange` for any bps input above 1e4.
    function computeSplit(
        uint256 gross,
        uint256 expensesRequested,
        uint256 expenseCapBps,
        uint256 carryBps,
        uint256 seniorHurdleBps,
        uint256 seniorSupply,
        uint256 juniorSupply
    ) public pure returns (Amounts memory a) {
        if (expenseCapBps > BPS) revert BpsOutOfRange(expenseCapBps);
        if (carryBps > BPS) revert BpsOutOfRange(carryBps);
        if (seniorHurdleBps > BPS) revert BpsOutOfRange(seniorHurdleBps);

        uint256 expenseCap = (gross * expenseCapBps) / BPS;
        a.gross = gross;
        a.expenses = expensesRequested < expenseCap ? expensesRequested : expenseCap;
        uint256 net = gross - a.expenses;
        a.carry = (net * carryBps) / BPS;
        uint256 rest = net - a.carry;
        if (seniorSupply == 0) {
            a.junior = rest;
        } else if (juniorSupply == 0) {
            a.senior = rest;
        } else {
            a.senior = (rest * seniorHurdleBps) / BPS;
            a.junior = rest - a.senior;
        }
    }

    function _preview(BRTypes.BookComponents memory c, uint256 gross, uint256 expensesRequested)
        private
        view
        returns (Amounts memory)
    {
        uint256 hurdle = IBook(book).getCharter().seniorHurdleBps;
        uint256 seniorSupply = IERC20(c.senior).totalSupply();
        uint256 juniorSupply = IERC20(c.junior).totalSupply();
        return computeSplit(
            gross,
            expensesRequested,
            config.expenseCapBps(),
            config.carryBps(),
            hurdle,
            seniorSupply,
            juniorSupply
        );
    }
}
