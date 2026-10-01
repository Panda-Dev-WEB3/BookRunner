// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {BRTypes} from "./interfaces/BRTypes.sol";
import {IMarketCharter} from "./interfaces/IMarketCharter.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {IBkrnStaking} from "./interfaces/IBkrnStaking.sol";
import {IStockTokenRegistry} from "./interfaces/IStockTokenRegistry.sol";
import {IBookFactory} from "./interfaces/IBookFactory.sol";
import {IBook} from "./interfaces/IBook.sol";

/// @title CharterRules — charter / mandate validation rules (ARCHITECTURE.md §2.6).
/// @notice Shared by MarketCharter.validate and RiskCommittee REMANDATE proposals so a re-mandate can
///         never install terms a new charter could not be filed with.
library CharterRules {
    // ---- reason codes (bytes32 short strings, exactly as listed in ARCHITECTURE.md §2.6) ----
    bytes32 internal constant IF_BELOW_VENUE_MIN = "IF_BELOW_VENUE_MIN";
    bytes32 internal constant BAD_VENUE = "BAD_VENUE";
    bytes32 internal constant BAD_ORACLE = "BAD_ORACLE";
    bytes32 internal constant BAD_BPS = "BAD_BPS";
    bytes32 internal constant BAD_WINDOW = "BAD_WINDOW";
    bytes32 internal constant BAD_NOTICE = "BAD_NOTICE";
    bytes32 internal constant BAD_MANDATE = "BAD_MANDATE";
    bytes32 internal constant BAD_UNDERLYING = "BAD_UNDERLYING";
    bytes32 internal constant BAD_SYMBOL = "BAD_SYMBOL";
    bytes32 internal constant BAD_FEES = "BAD_FEES";

    // ---- bounds ----
    uint256 internal constant BPS = 1e4;
    uint256 internal constant MIN_SUBSCRIPTION_WINDOW = 60; // seconds
    uint256 internal constant MAX_SUBSCRIPTION_WINDOW = 30 days;
    uint256 internal constant MAX_JUNIOR_NOTICE = 30 days;
    int16 internal constant MIN_KILL_DRAWDOWN_BPS = -5000; // kill must trigger at or above -50%
    uint256 internal constant MAX_ENGINE_TAKER_FEE_BPS = 100; // in-house venue taker fee cap (1%)

    /// @notice BAD_MANDATE when: maxInventoryUsd == 0, minQuoteWidthBps == 0, hedge band min > max,
    ///         killAtDrawdownBps >= 0 or < -5000, maxSkewBps <= 0. Returns 0 when the mandate is valid.
    function mandateReason(BRTypes.Mandate memory m) internal pure returns (bytes32) {
        if (
            m.maxInventoryUsd == 0 || m.minQuoteWidthBps == 0 || m.hedgeRatioMinBps > m.hedgeRatioMaxBps
                || m.killAtDrawdownBps >= 0 || m.killAtDrawdownBps < MIN_KILL_DRAWDOWN_BPS
                || m.maxSkewBps <= 0
        ) {
            return BAD_MANDATE;
        }
        return bytes32(0);
    }

    /// @notice True when `underlying` encodes an address (upper 12 bytes zero), i.e. a Stock Token.
    function isTokenUnderlying(bytes32 underlying) internal pure returns (bool) {
        return uint256(underlying) >> 160 == 0;
    }
}

/// @title MarketCharter — charter intake, sponsor bonds, charter fees, committee decisions, retirement.
/// @notice Lifecycle: `file` (Filed: fee escrowed here, sponsor bond locked in BkrnStaking) ->
///         `decide` by the RiskCommittee within `config.committeeWindow()` (Approved: fee forwarded to
///         `config.expenseRecipient()`, book deployed through BookFactory | Rejected: fee refunded, bond
///         unlocked) or `expire` after the window (Expired: fee refunded, bond unlocked). An Approved
///         charter's bond stays locked until the book reports Retired (`onRetired`) or the window failed
///         and the book is Cancelled (`closeCancelled`). Committee may slash an abandoning sponsor.
///         Charter ids start at 1; bookId == charterId. Non-upgradeable.
contract MarketCharter is IMarketCharter, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice Domain separator of sponsor-bond lock ids in BkrnStaking.
    bytes32 public constant SPONSOR_BOND_DOMAIN = keccak256("BKRN.SPONSOR_BOND");

    /// @notice Protocol registry (addresses, params, roles).
    IBookrunnerConfig public immutable config;

    /// @notice Where a charter's fee and bond live. Pinned at filing so refunds, forwards, unlocks and
    ///         slashes always target the token / staking contract that actually holds them, even if the
    ///         timelock later repoints `config.usdc()` or `config.staking()`.
    struct Escrow {
        address feeToken; // config.usdc() at filing
        address staking; // config.staking() at filing (the contract holding the bond lock)
        uint256 bondOutstanding; // still locked: reduced by slashing, zeroed on release
    }

    uint256 private _count;
    mapping(uint256 id => CharterRecord) private _records;
    mapping(uint256 id => Escrow) private _escrow;

    error ZeroAddress();
    error NotCommittee();
    error NotSponsorOrCommittee();
    error NotBook();
    error MissingJuryCid();
    error DecisionWindowClosed(uint256 id, uint256 deadline);
    error DecisionWindowOpen(uint256 id, uint256 deadline);
    error SponsorNotAbandoned(uint256 bookId);
    error NothingToSlash(uint256 bookId);
    error BookNotCancelled(uint256 bookId);
    error BookNotCreated(uint256 id);

    /// @notice Sponsor or committee asked the book to wind down.
    event RetireRequested(uint256 indexed bookId, address indexed by);
    /// @notice Charter fee forwarded on approval (committee review + oracle setup).
    event FeeForwarded(uint256 indexed id, address indexed to, uint256 amount);
    /// @notice Charter fee returned to the sponsor (reject / expire).
    event FeeRefunded(uint256 indexed id, address indexed sponsor, uint256 amount);
    /// @notice Sponsor bond unlocked in BkrnStaking.
    event SponsorBondReleased(uint256 indexed id, address indexed sponsor, uint256 amount);

    /// @param config_ BookrunnerConfig address. MarketCharter must be registered as `config.charter()`
    ///        and as a BkrnStaking locker by the timelock.
    constructor(address config_) {
        if (config_ == address(0)) revert ZeroAddress();
        config = IBookrunnerConfig(config_);
    }

    // ------------------------------------------------------------------------------------------
    // Intake
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IMarketCharter
    /// @dev Reverts NewBooksPaused while the guardian switch is on, NotSponsor unless
    ///      msg.sender == c.sponsor, InvalidCharter(reason) when validate(c) != 0. Requires a USDC
    ///      allowance of `config.charterFeeUsd()` and `config.sponsorBondBkrn()` of available stake.
    function file(BRTypes.Charter calldata c) external nonReentrant returns (uint256 id) {
        IBookrunnerConfig cfg = config;
        if (cfg.newBooksPaused()) revert NewBooksPaused();
        if (msg.sender != c.sponsor) revert NotSponsor();
        bytes32 reason = _validate(c);
        if (reason != bytes32(0)) revert InvalidCharter(reason);

        uint256 fee = cfg.charterFeeUsd();
        uint256 bond = cfg.sponsorBondBkrn();

        id = ++_count;
        CharterRecord storage r = _records[id];
        r.charter = c;
        r.status = BRTypes.CharterStatus.Filed;
        r.filedAt = uint64(block.timestamp);
        r.feePaidUsd = fee;
        r.bondBkrn = bond;
        Escrow storage e = _escrow[id];
        e.feeToken = cfg.usdc();
        e.staking = cfg.staking();
        e.bondOutstanding = bond;

        emit CharterFiled(id, msg.sender, c.underlying, c.venue, c.symbol, fee, bond);

        if (fee > 0) IERC20(e.feeToken).safeTransferFrom(msg.sender, address(this), fee);
        if (bond > 0) IBkrnStaking(e.staking).lock(msg.sender, bondLockId(id), bond);
    }

    /// @inheritdoc IMarketCharter
    /// @dev Reasons are checked in this order (first failure wins): BAD_VENUE, IF_BELOW_VENUE_MIN,
    ///      BAD_ORACLE, BAD_BPS, BAD_WINDOW, BAD_NOTICE, BAD_MANDATE, BAD_UNDERLYING, BAD_SYMBOL,
    ///      BAD_FEES. BAD_VENUE precedes the IF minimum because the minimum is looked up per venue.
    ///      BAD_UNDERLYING: token underlyings (upper 12 bytes zero) must be canonical in
    ///      `config.stockRegistry()`; anything else must be a registered index id.
    function validate(BRTypes.Charter calldata c) external view returns (bytes32 reason) {
        return _validate(c);
    }

    // ------------------------------------------------------------------------------------------
    // Decisions
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IMarketCharter
    /// @dev Only `config.committee()`, only while Filed and strictly before filedAt + committeeWindow.
    ///      Approval requires a non-zero jury CID and `!newBooksPaused`; it forwards the escrowed fee to
    ///      `config.expenseRecipient()` and calls `BookFactory.create(id, charter)`. Rejection refunds
    ///      the fee and unlocks the bond.
    function decide(uint256 id, bool ok, bytes32 juryCid) external nonReentrant {
        IBookrunnerConfig cfg = config;
        if (msg.sender != cfg.committee()) revert NotCommittee();
        CharterRecord storage r = _filedRecord(id);
        uint256 deadline = uint256(r.filedAt) + cfg.committeeWindow();
        if (block.timestamp >= deadline) revert DecisionWindowClosed(id, deadline);

        r.decidedAt = uint64(block.timestamp);
        r.juryCid = juryCid;

        if (!ok) {
            r.status = BRTypes.CharterStatus.Rejected;
            emit CharterDecided(id, false, juryCid, address(0));
            _refundAndRelease(id, r);
            return;
        }

        if (juryCid == bytes32(0)) revert MissingJuryCid();
        if (cfg.newBooksPaused()) revert NewBooksPaused();
        address recipient = cfg.expenseRecipient();
        if (recipient == address(0)) revert ZeroAddress();
        r.status = BRTypes.CharterStatus.Approved;

        uint256 fee = r.feePaidUsd;
        if (fee > 0) {
            emit FeeForwarded(id, recipient, fee);
            IERC20(_escrow[id].feeToken).safeTransfer(recipient, fee);
        }

        // Trusted call (factory set by the timelock); state written after it is guarded by nonReentrant.
        BRTypes.BookComponents memory comps = IBookFactory(cfg.factory()).create(id, r.charter);
        if (comps.book == address(0)) revert BookNotCreated(id);
        r.book = comps.book;
        emit CharterDecided(id, true, juryCid, comps.book);
    }

    /// @inheritdoc IMarketCharter
    /// @dev Anyone, once block.timestamp >= filedAt + config.committeeWindow() and still Filed.
    function expire(uint256 id) external nonReentrant {
        IBookrunnerConfig cfg = config;
        CharterRecord storage r = _filedRecord(id);
        uint256 deadline = uint256(r.filedAt) + cfg.committeeWindow();
        if (block.timestamp < deadline) revert DecisionWindowOpen(id, deadline);

        r.status = BRTypes.CharterStatus.Expired;
        r.decidedAt = uint64(block.timestamp);
        emit CharterExpired(id);
        _refundAndRelease(id, r);
    }

    // ------------------------------------------------------------------------------------------
    // Live books
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IMarketCharter
    /// @dev Approved charters only. The book enforces its own state machine (Live -> Retiring).
    ///      Not nonReentrant on purpose: a book may legitimately call back `onRetired` synchronously.
    function retire(uint256 bookId) external {
        CharterRecord storage r = _records[bookId];
        if (r.status != BRTypes.CharterStatus.Approved) revert WrongStatus(r.status);
        if (msg.sender != r.charter.sponsor && msg.sender != config.committee()) {
            revert NotSponsorOrCommittee();
        }
        emit RetireRequested(bookId, msg.sender);
        IBook(r.book).retire();
    }

    /// @inheritdoc IMarketCharter
    /// @dev Only the book created for `bookId`, while the charter is Approved. Status -> Retired.
    function onRetired(uint256 bookId) external nonReentrant {
        CharterRecord storage r = _records[bookId];
        if (r.status != BRTypes.CharterStatus.Approved) revert WrongStatus(r.status);
        if (msg.sender != r.book) revert NotBook();
        r.status = BRTypes.CharterStatus.Retired;
        emit CharterRetired(bookId);
        _releaseBond(bookId, r.charter.sponsor);
    }

    /// @notice Anyone: closes an Approved charter whose book's subscription window failed (book state
    ///         Cancelled — no capital was ever deployed). Status -> Retired and the sponsor bond is
    ///         released, since a cancelled book can never reach `onRetired`. [ext]
    /// @param bookId The charter / book id.
    function closeCancelled(uint256 bookId) external nonReentrant {
        CharterRecord storage r = _records[bookId];
        if (r.status != BRTypes.CharterStatus.Approved) revert WrongStatus(r.status);
        if (IBook(r.book).state() != BRTypes.BookState.Cancelled) revert BookNotCancelled(bookId);
        r.status = BRTypes.CharterStatus.Retired;
        emit CharterRetired(bookId);
        _releaseBond(bookId, r.charter.sponsor);
    }

    /// @inheritdoc IMarketCharter
    /// @dev Only `config.committee()` (2-of-3 SLASH_SPONSOR action). Requires the charter Approved and
    ///      the book's `sponsorAbandoned()` flag (Book extension, read via staticcall because IBook does
    ///      not expose it; a book without the getter counts as not abandoned). Slashes the full
    ///      outstanding bond; staking sends it to `config.slashRecipient()`.
    function slashSponsor(uint256 bookId, bytes32 reason) external nonReentrant {
        IBookrunnerConfig cfg = config;
        if (msg.sender != cfg.committee()) revert NotCommittee();
        CharterRecord storage r = _records[bookId];
        if (r.status != BRTypes.CharterStatus.Approved) revert WrongStatus(r.status);
        if (!_sponsorAbandoned(r.book)) revert SponsorNotAbandoned(bookId);
        Escrow storage e = _escrow[bookId];
        uint256 amount = e.bondOutstanding;
        if (amount == 0) revert NothingToSlash(bookId);

        e.bondOutstanding = 0;
        address sponsor = r.charter.sponsor;
        uint256 slashed = IBkrnStaking(e.staking).slash(sponsor, bondLockId(bookId), amount);
        if (slashed < amount) e.bondOutstanding = amount - slashed;
        emit SponsorSlashed(bookId, sponsor, slashed, reason);
    }

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IMarketCharter
    /// @dev Unknown ids return an empty record (status None).
    function get(uint256 id) external view returns (CharterRecord memory) {
        return _records[id];
    }

    /// @inheritdoc IMarketCharter
    function count() external view returns (uint256) {
        return _count;
    }

    /// @inheritdoc IMarketCharter
    function bondLockId(uint256 id) public pure returns (bytes32) {
        return keccak256(abi.encode(SPONSOR_BOND_DOMAIN, id));
    }

    /// @notice Sponsor bond still locked for `id` (0 after release or full slash).
    function bondOutstanding(uint256 id) external view returns (uint256) {
        return _escrow[id].bondOutstanding;
    }

    /// @notice Fee token, staking contract and outstanding bond pinned for `id` at filing.
    function escrowOf(uint256 id) external view returns (Escrow memory) {
        return _escrow[id];
    }

    /// @notice Timestamp from which `decide` is closed and `expire` is open (0 for unknown ids).
    function decisionDeadline(uint256 id) external view returns (uint256) {
        CharterRecord storage r = _records[id];
        if (r.status == BRTypes.CharterStatus.None) return 0;
        return uint256(r.filedAt) + config.committeeWindow();
    }

    /// @notice True while the charter is Filed and the committee window is still open.
    function isOpen(uint256 id) external view returns (bool) {
        CharterRecord storage r = _records[id];
        return r.status == BRTypes.CharterStatus.Filed
            && block.timestamp < uint256(r.filedAt) + config.committeeWindow();
    }

    // ------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------

    function _filedRecord(uint256 id) private view returns (CharterRecord storage r) {
        r = _records[id];
        if (r.status != BRTypes.CharterStatus.Filed) revert WrongStatus(r.status);
    }

    function _refundAndRelease(uint256 id, CharterRecord storage r) private {
        address sponsor = r.charter.sponsor;
        uint256 fee = r.feePaidUsd;
        if (fee > 0) {
            emit FeeRefunded(id, sponsor, fee);
            IERC20(_escrow[id].feeToken).safeTransfer(sponsor, fee);
        }
        _releaseBond(id, sponsor);
    }

    function _releaseBond(uint256 id, address sponsor) private {
        Escrow storage e = _escrow[id];
        if (e.bondOutstanding == 0) return;
        e.bondOutstanding = 0;
        uint256 released = IBkrnStaking(e.staking).unlock(sponsor, bondLockId(id));
        emit SponsorBondReleased(id, sponsor, released);
    }

    function _validate(BRTypes.Charter calldata c) private view returns (bytes32) {
        if (c.venue > BRTypes.VENUE_POOL_ENGINE) return CharterRules.BAD_VENUE;
        if (c.ifTargetUsd < config.venueMinIfUsd(c.venue)) return CharterRules.IF_BELOW_VENUE_MIN;
        if (c.oracle > BRTypes.ORACLE_ATTESTED) return CharterRules.BAD_ORACLE;
        if (c.seniorHurdleBps > CharterRules.BPS || c.seniorCapBps > CharterRules.BPS || c.seniorCapBps == 0)
        {
            return CharterRules.BAD_BPS;
        }
        if (
            c.subscriptionWindow < CharterRules.MIN_SUBSCRIPTION_WINDOW
                || c.subscriptionWindow > CharterRules.MAX_SUBSCRIPTION_WINDOW
        ) return CharterRules.BAD_WINDOW;
        if (c.juniorNoticeSeconds > CharterRules.MAX_JUNIOR_NOTICE) return CharterRules.BAD_NOTICE;
        bytes32 mandateReason = CharterRules.mandateReason(c.mandate);
        if (mandateReason != bytes32(0)) return mandateReason;
        if (!_underlyingOk(c.underlying)) return CharterRules.BAD_UNDERLYING;
        if (c.symbol == bytes32(0)) return CharterRules.BAD_SYMBOL;
        if (c.venue == BRTypes.VENUE_POOL_ENGINE && c.takerFeeBps > CharterRules.MAX_ENGINE_TAKER_FEE_BPS) {
            return CharterRules.BAD_FEES;
        }
        return bytes32(0);
    }

    function _underlyingOk(bytes32 underlying) private view returns (bool) {
        address registry = config.stockRegistry();
        if (registry.code.length == 0) return false;
        if (CharterRules.isTokenUnderlying(underlying)) {
            address token = address(uint160(uint256(underlying)));
            if (token == address(0)) return false;
            return IStockTokenRegistry(registry).isCanonical(token);
        }
        return IStockTokenRegistry(registry).isIndex(underlying);
    }

    /// @dev `sponsorAbandoned()` is a Book extension (ARCHITECTURE.md §2.5) not present on IBook.
    function _sponsorAbandoned(address book) private view returns (bool) {
        (bool ok, bytes memory ret) =
            book.staticcall(abi.encodeWithSelector(ISponsorAbandoned.sponsorAbandoned.selector));
        return ok && ret.length >= 32 && abi.decode(ret, (uint256)) == 1;
    }
}

/// @dev Book extension read by MarketCharter.slashSponsor (set when the sponsor redeems below 10% of
///      Junior supply while Live). Kept local because the frozen IBook does not declare it.
interface ISponsorAbandoned {
    function sponsorAbandoned() external view returns (bool);
}
