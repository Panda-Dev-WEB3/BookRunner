// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {BRTypes} from "./interfaces/BRTypes.sol";
import {IBook} from "./interfaces/IBook.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {IUnderwritingVault} from "./interfaces/IUnderwritingVault.sol";
import {IVenueAdapter} from "./interfaces/IVenueAdapter.sol";
import {IBackstop} from "./interfaces/IBkrnFeeRouter.sol";

/// @title UnderwritingVault — holds one book's undeployed USDC (EIP-1167 clone).
/// @notice Capital leaves only to the book's venue adapter (IF / MM accounts), the book's desk (hedge
///         budget), the book's tranche escrows (claims / window settlement) or, book-initiated, the
///         protocol backstop (repaying cover it advanced). Recalls always land back here. Every deploy / recall / desk funding / desk return / venue return bumps the book's
///         flowNonce (book.onCapitalFlow), invalidating marks valued against the previous state.
///         Cash backing settled-but-unfunded redemption claims (book.unfundedClaims()) is reserved:
///         it cannot be deployed to the venue or the desk, and capital only goes out while the book is
///         Live (never during wind-down or after retirement).
contract UnderwritingVault is IUnderwritingVault, Initializable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error ZeroAmount();
    error BookMismatch();
    error BadAccount(uint8 account);
    error NotBook();
    error NotDesk();
    error NotAuthorized();
    error NotTranche(address to);
    error InsufficientIdle(uint256 requested, uint256 available);
    error BookNotLive(BRTypes.BookState state);

    event ReturnedFromDesk(uint256 amount);
    event CapitalFlowNotified(address indexed by);

    address public config;
    uint256 public bookId;
    address public book;
    address public adapter;
    address public desk;
    address public senior;
    address public junior;
    IERC20 internal _usdc;

    constructor() {
        _disableInitializers();
    }

    /// @notice Clone initializer. The book must already be initialized (factory order: book first) and
    ///         list this clone as its vault; component addresses are cached (immutable per book).
    function initialize(address config_, uint256 bookId_, address book_) external initializer {
        if (config_ == address(0) || book_ == address(0)) revert ZeroAddress();
        if (IBook(book_).bookId() != bookId_) revert BookMismatch();
        BRTypes.BookComponents memory c = IBook(book_).components();
        if (c.vault != address(this)) revert BookMismatch();
        address usdc = IBookrunnerConfig(config_).usdc();
        if (usdc == address(0) || c.adapter == address(0) || c.senior == address(0) || c.junior == address(0))
        {
            revert ZeroAddress();
        }
        config = config_;
        bookId = bookId_;
        book = book_;
        adapter = c.adapter;
        desk = c.desk;
        senior = c.senior;
        junior = c.junior;
        _usdc = IERC20(usdc);
    }

    // ---- views ----

    function asset() external view returns (address) {
        return address(_usdc);
    }

    /// @notice USDC held by the vault (includes cash reserved for unfunded claims).
    function idle() public view returns (uint256) {
        return _usdc.balanceOf(address(this));
    }

    /// @notice Idle USDC not reserved for settled-but-unfunded redemption claims.
    function deployable() public view returns (uint256) {
        uint256 bal = idle();
        uint256 reserved = IBook(book).unfundedClaims();
        return bal > reserved ? bal - reserved : 0;
    }

    // ---- capital movements ----

    /// @notice Book (at closeWindow) or the desk (mandate-checked inventory move): approves the adapter
    ///         for exactly `amount` and calls adapter.depositToVenue(account, amount).
    function deployToVenue(uint8 account, uint256 amount) external nonReentrant {
        if (msg.sender != book && msg.sender != desk) revert NotAuthorized();
        _checkAccount(account);
        if (amount == 0) revert ZeroAmount();
        _checkLive();
        uint256 available = deployable();
        if (amount > available) revert InsufficientIdle(amount, available);
        emit Deployed(account, amount);
        address a = adapter;
        _usdc.forceApprove(a, amount);
        IVenueAdapter(a).depositToVenue(account, amount);
        _usdc.forceApprove(a, 0);
        IBook(book).onCapitalFlow();
    }

    /// @notice Book, desk, KEEPER or RISK: asks the adapter to withdraw `amount` from a venue account.
    ///         Funds can only return to this vault (sync venues in the same call; async venues via
    ///         adapter.sweepToVault()).
    function recall(uint8 account, uint256 amount) external nonReentrant {
        if (msg.sender != book && msg.sender != desk) {
            IBookrunnerConfig cfg = IBookrunnerConfig(config);
            if (!cfg.hasRole(cfg.KEEPER_ROLE(), msg.sender) && !cfg.hasRole(cfg.RISK_ROLE(), msg.sender)) {
                revert NotAuthorized();
            }
        }
        _checkAccount(account);
        if (amount == 0) revert ZeroAmount();
        emit RecallRequested(account, amount, msg.sender);
        IVenueAdapter(adapter).requestWithdraw(account, amount);
        IBook(book).onCapitalFlow();
    }

    /// @notice Desk only (mandate-checked by the desk): moves USDC hedge budget vault -> desk.
    function fundDesk(uint256 amount) external nonReentrant {
        if (msg.sender != desk) revert NotDesk();
        if (amount == 0) revert ZeroAmount();
        _checkLive();
        uint256 available = deployable();
        if (amount > available) revert InsufficientIdle(amount, available);
        emit DeskFunded(amount);
        _usdc.safeTransfer(desk, amount);
        IBook(book).onCapitalFlow();
    }

    /// @notice Only book: pays tranche escrows (redemption claim funding). Targets: this book's
    ///         Senior and Junior tranches only.
    function payTo(address to, uint256 amount) external nonReentrant {
        if (msg.sender != book) revert NotBook();
        if (to != senior && to != junior) revert NotTranche(to);
        if (amount == 0) return;
        emit Paid(to, amount);
        _usdc.safeTransfer(to, amount);
    }

    /// @notice Only book: repays the protocol backstop (config.backstop()) `amount` of the cover it
    ///         advanced to this book, then acknowledges the deposit (Backstop.notifyDeposit). The book
    ///         reserves the amount out of NAV first (Book.backstopDebt).
    function repayBackstop(uint256 amount) external nonReentrant {
        if (msg.sender != book) revert NotBook();
        address backstop = IBookrunnerConfig(config).backstop();
        if (backstop == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        emit Paid(backstop, amount);
        _usdc.safeTransfer(backstop, amount);
        // the cash is in the backstop's balance() either way; only its accounting needs the notice
        try IBackstop(backstop).notifyDeposit(amount) {} catch {}
    }

    /// @notice Desk only (ReturnToVault): pulls `amount` USDC from the desk (desk approves first) and
    ///         bumps the book's flowNonce.
    function returnFromDesk(uint256 amount) external nonReentrant {
        if (msg.sender != desk) revert NotDesk();
        if (amount == 0) revert ZeroAmount();
        emit ReturnedFromDesk(amount);
        _usdc.safeTransferFrom(desk, address(this), amount);
        IBook(book).onCapitalFlow();
    }

    /// @notice Desk only: the desk already transferred `amount` USDC to this vault (ReturnToVault action);
    ///         bumps the book's flowNonce like every other vault<->desk capital movement.
    function notifyDeskReturn(uint256 amount) external nonReentrant {
        if (msg.sender != desk) revert NotDesk();
        if (amount == 0) revert ZeroAmount();
        emit ReturnedFromDesk(amount);
        IBook(book).onCapitalFlow();
    }

    /// @notice Adapter or desk: reports that USDC was pushed to this vault (e.g. adapter.sweepToVault of
    ///         an async withdrawal, or a desk transfer), bumping the book's flowNonce so a mark that still
    ///         counts those funds as deployed / in transit cannot be applied.
    function notifyCapitalFlow() external nonReentrant {
        if (msg.sender != adapter && msg.sender != desk) revert NotAuthorized();
        emit CapitalFlowNotified(msg.sender);
        IBook(book).onCapitalFlow();
    }

    function _checkLive() internal view {
        BRTypes.BookState st = IBook(book).state();
        if (st != BRTypes.BookState.Live) revert BookNotLive(st);
    }

    function _checkAccount(uint8 account) internal pure {
        if (account != BRTypes.ACCOUNT_IF && account != BRTypes.ACCOUNT_MM) revert BadAccount(account);
    }
}
