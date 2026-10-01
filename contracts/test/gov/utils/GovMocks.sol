// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {IBookrunnerConfig} from "../../../src/interfaces/IBookrunnerConfig.sol";
import {IBkrnStaking} from "../../../src/interfaces/IBkrnStaking.sol";
import {IMarketCharter} from "../../../src/interfaces/IMarketCharter.sol";

// =============================================================================================
// Config
// =============================================================================================

/// @notice Minimal settable IBookrunnerConfig for gov tests.
contract GovMockConfig is IBookrunnerConfig {
    bytes32 public constant MARK_SIGNER_ROLE = keccak256("MARK_SIGNER");
    bytes32 public constant RISK_ROLE = keccak256("RISK");
    bytes32 public constant OPS_VENUE_ROLE = keccak256("OPS_VENUE");
    bytes32 public constant JURY_ROLE = keccak256("JURY");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN");

    mapping(bytes32 => mapping(address => bool)) public hasRole;

    address public usdc;
    address public bkrn;
    address public staking;
    address public feeRouter;
    address public backstop;
    address public markRegistry;
    address public oracle;
    address public stockRegistry;
    address public charter;
    address public committee;
    address public factory;
    address public poolEngine;
    address public orderlyVault;
    address public hedgeExecutor;
    address public entryPoint;
    address public timelock;
    address public expenseRecipient;
    address public slashRecipient;

    uint16 public carryBps = 1000;
    uint16 public expenseCapBps = 2000;
    uint256 public charterFeeUsd;
    uint256 public sponsorBondBkrn;
    uint256 public committeeBondBkrn;
    uint32 public markInterval = 300;
    uint32 public maxMarkAge = 3600;
    uint32 public maxPriceAge = 300;
    uint32 public committeeWindow;
    mapping(uint8 => uint256) public venueMinIfUsd;
    bool public newBooksPaused;

    function agentTierBond(uint256) external pure returns (uint256) {
        return 0;
    }

    function grantRole(bytes32 role, address account) external {
        hasRole[role][account] = true;
    }

    function revokeRole(bytes32 role, address account) external {
        hasRole[role][account] = false;
    }

    function setAddresses(
        address usdc_,
        address bkrn_,
        address staking_,
        address stockRegistry_,
        address charter_,
        address committee_,
        address factory_,
        address timelock_,
        address expenseRecipient_,
        address slashRecipient_
    ) external {
        usdc = usdc_;
        bkrn = bkrn_;
        staking = staking_;
        stockRegistry = stockRegistry_;
        charter = charter_;
        committee = committee_;
        factory = factory_;
        timelock = timelock_;
        expenseRecipient = expenseRecipient_;
        slashRecipient = slashRecipient_;
    }

    function setCharter(address a) external {
        charter = a;
    }

    function setCommittee(address a) external {
        committee = a;
    }

    function setFactory(address a) external {
        factory = a;
    }

    function setStockRegistry(address a) external {
        stockRegistry = a;
    }

    function setStaking(address a) external {
        staking = a;
    }

    function setUsdc(address a) external {
        usdc = a;
    }

    function setExpenseRecipient(address a) external {
        expenseRecipient = a;
    }

    function setParams(uint256 fee, uint256 sponsorBond, uint256 committeeBond, uint32 window) external {
        charterFeeUsd = fee;
        sponsorBondBkrn = sponsorBond;
        committeeBondBkrn = committeeBond;
        committeeWindow = window;
    }

    function setCharterFee(uint256 v) external {
        charterFeeUsd = v;
    }

    function setSponsorBond(uint256 v) external {
        sponsorBondBkrn = v;
    }

    function setCommitteeBond(uint256 v) external {
        committeeBondBkrn = v;
    }

    function setCommitteeWindow(uint32 v) external {
        committeeWindow = v;
    }

    function setVenueMinIf(uint8 venue, uint256 v) external {
        venueMinIfUsd[venue] = v;
    }

    function setNewBooksPaused(bool p) external {
        newBooksPaused = p;
    }
}

// =============================================================================================
// Staking
// =============================================================================================

/// @notice BkrnStaking stand-in implementing the lock semantics of ARCHITECTURE.md §2.2:
///         locks keyed (account, lockId); only the creating locker may unlock / slash; a lock id may
///         not be re-locked while it exists (stricter than needed, catches double locking);
///         `setLocker` callable by the timelock or the factory.
contract GovMockStaking is IBkrnStaking {
    struct LockInfo {
        address locker;
        uint256 amount;
    }

    IBookrunnerConfig public immutable config;
    IERC20 public immutable token;

    mapping(address => uint256) public stakedOf;
    mapping(address => uint256) public lockedOf;
    mapping(address => uint256) public pendingOf;
    mapping(address => bool) public isLocker;
    mapping(address => mapping(bytes32 => LockInfo)) internal _locks;

    error NotLocker();
    error NotLockOwner();
    error LockExists();
    error Insufficient();
    error NotAdmin();
    error NoLock();

    event LockerSet(address indexed locker, bool allowed);

    constructor(address config_, address token_) {
        config = IBookrunnerConfig(config_);
        token = IERC20(token_);
    }

    function setLocker(address locker, bool allowed) external {
        if (msg.sender != config.timelock() && msg.sender != config.factory()) revert NotAdmin();
        isLocker[locker] = allowed;
        emit LockerSet(locker, allowed);
    }

    function stake(uint256 amount) external {
        token.transferFrom(msg.sender, address(this), amount);
        stakedOf[msg.sender] += amount;
        emit Staked(msg.sender, amount);
    }

    function requestUnstake(uint256 amount) external {
        if (availableOf(msg.sender) < amount) revert Insufficient();
        pendingOf[msg.sender] += amount;
        emit UnstakeRequested(msg.sender, amount, uint64(block.timestamp));
    }

    function unstake() external returns (uint256 amount) {
        amount = pendingOf[msg.sender];
        pendingOf[msg.sender] = 0;
        stakedOf[msg.sender] -= amount;
        token.transfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function availableOf(address account) public view returns (uint256) {
        return stakedOf[account] - lockedOf[account] - pendingOf[account];
    }

    function lockOf(address account, bytes32 lockId) external view returns (uint256) {
        return _locks[account][lockId].amount;
    }

    function lockerOf(address account, bytes32 lockId) external view returns (address) {
        return _locks[account][lockId].locker;
    }

    function lock(address account, bytes32 lockId, uint256 amount) external {
        if (!isLocker[msg.sender]) revert NotLocker();
        LockInfo storage l = _locks[account][lockId];
        if (l.amount != 0) revert LockExists();
        if (amount == 0 || availableOf(account) < amount) revert Insufficient();
        l.locker = msg.sender;
        l.amount = amount;
        lockedOf[account] += amount;
        emit Locked(account, lockId, msg.sender, amount);
    }

    function unlock(address account, bytes32 lockId) external returns (uint256 released) {
        LockInfo storage l = _locks[account][lockId];
        if (l.amount == 0) revert NoLock();
        if (l.locker != msg.sender) revert NotLockOwner();
        released = l.amount;
        lockedOf[account] -= released;
        delete _locks[account][lockId];
        emit Unlocked(account, lockId, released);
    }

    function slash(address account, bytes32 lockId, uint256 amount) external returns (uint256 slashed) {
        LockInfo storage l = _locks[account][lockId];
        if (l.amount == 0) revert NoLock();
        if (l.locker != msg.sender) revert NotLockOwner();
        slashed = amount < l.amount ? amount : l.amount;
        l.amount -= slashed;
        lockedOf[account] -= slashed;
        stakedOf[account] -= slashed;
        if (l.amount == 0) delete _locks[account][lockId];
        address to = config.slashRecipient();
        token.transfer(to, slashed);
        emit Slashed(account, lockId, slashed, to);
    }

    function notifyReward(uint256) external pure {
        revert NotAdmin();
    }

    function earned(address) external pure returns (uint256) {
        return 0;
    }

    function claimReward() external pure returns (uint256) {
        return 0;
    }
}

// =============================================================================================
// Stock Token registry
// =============================================================================================

/// @notice Only the IStockTokenRegistry views MarketCharter.validate uses.
contract GovMockRegistry {
    mapping(address => bool) public isCanonical;
    mapping(bytes32 => bool) public isIndex;

    function setCanonical(address token, bool ok) external {
        isCanonical[token] = ok;
    }

    function setIndex(bytes32 id, bool ok) external {
        isIndex[id] = ok;
    }
}

// =============================================================================================
// Book components
// =============================================================================================

interface IGovInitFlag {
    function isInitialized() external view returns (bool);
}

/// @notice Book stand-in (behind the factory's ERC1967 proxy) without the `sponsorAbandoned()` getter.
contract GovMockBookNoFlag is Initializable {
    address public config;
    uint256 public bookId;
    BRTypes.Charter internal _charter;
    BRTypes.BookComponents internal _components;
    BRTypes.BookState public state;
    uint256 public initCount;
    uint256 public retireCalls;
    /// @notice Global init sequence number; components record their position (ordering checks).
    uint256 public initSeq;

    error NotCharter();
    error NotLive();
    error BadComponents();

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address config_,
        uint256 bookId_,
        BRTypes.Charter calldata charter_,
        BRTypes.BookComponents calldata components_
    ) external initializer {
        if (components_.book != address(this)) revert BadComponents();
        config = config_;
        bookId = bookId_;
        _charter = charter_;
        _components = components_;
        initCount++;
        initSeq = 1;
    }

    /// @dev Components call this when they initialize; returns their position in the sequence.
    function nextSeq() external returns (uint256) {
        return ++initSeq;
    }

    function isInitialized() external view returns (bool) {
        return _getInitializedVersion() == 1;
    }

    function getCharter() external view returns (BRTypes.Charter memory) {
        return _charter;
    }

    function components() external view returns (BRTypes.BookComponents memory) {
        return _components;
    }

    function sponsor() external view returns (address) {
        return _charter.sponsor;
    }

    /// @notice When set, retire() finalizes synchronously (calls back charter.onRetired in the same call).
    bool public finalizeOnRetire;

    function retire() external {
        if (msg.sender != IBookrunnerConfig(config).charter()) revert NotCharter();
        if (state != BRTypes.BookState.Live) revert NotLive();
        state = BRTypes.BookState.Retiring;
        retireCalls++;
        if (finalizeOnRetire) {
            state = BRTypes.BookState.Retired;
            IMarketCharter(msg.sender).onRetired(bookId);
        }
    }

    // ---- test hooks ----
    function setState(BRTypes.BookState s) external {
        state = s;
    }

    function finalize() external {
        state = BRTypes.BookState.Retired;
        IMarketCharter(IBookrunnerConfig(config).charter()).onRetired(bookId);
    }

    function setFinalizeOnRetire(bool v) external {
        finalizeOnRetire = v;
    }
}

/// @notice Book stand-in with the `sponsorAbandoned()` extension read by MarketCharter.slashSponsor.
contract GovMockBook is GovMockBookNoFlag {
    bool public sponsorAbandoned;

    function setSponsorAbandoned(bool v) external {
        sponsorAbandoned = v;
    }
}

/// @notice Base for per-book components: initialize(config, bookId, book) once, after the book.
abstract contract GovMockComponentBase is Initializable {
    address public config;
    uint256 public bookId;
    address public book;
    uint256 public initSeq;
    uint256 public initCount;

    error BookNotInitialized();

    constructor() {
        _disableInitializers();
    }

    function _init(address config_, uint256 bookId_, address book_) internal {
        if (!IGovInitFlag(book_).isInitialized()) revert BookNotInitialized();
        config = config_;
        bookId = bookId_;
        book = book_;
        initCount++;
        initSeq = GovMockBook(book_).nextSeq();
    }

    function isInitialized() external view returns (bool) {
        return _getInitializedVersion() == 1;
    }
}

contract GovMockTranche is GovMockComponentBase {
    uint8 public kind;

    function initialize(address config_, uint256 bookId_, address book_, uint8 kind_) external initializer {
        _init(config_, bookId_, book_);
        kind = kind_;
    }
}

contract GovMockVault is GovMockComponentBase {
    function initialize(address config_, uint256 bookId_, address book_) external initializer {
        _init(config_, bookId_, book_);
    }
}

contract GovMockRouter is GovMockComponentBase {
    function initialize(address config_, uint256 bookId_, address book_) external initializer {
        _init(config_, bookId_, book_);
    }
}

contract GovMockDesk is GovMockComponentBase {
    function initialize(address config_, uint256 bookId_, address book_) external initializer {
        _init(config_, bookId_, book_);
    }
}

contract GovMockMandate is GovMockComponentBase {
    BRTypes.Mandate internal _mandate;
    uint256 public remandateCount;
    address public lastRevokedKey;
    bytes32 public lastRevokeReason;

    error NotCommittee();

    function initialize(address config_, uint256 bookId_, address book_) external initializer {
        _init(config_, bookId_, book_);
        _mandate = GovMockBook(book_).getCharter().mandate;
    }

    function getMandate() external view returns (BRTypes.Mandate memory) {
        return _mandate;
    }

    function remandate(BRTypes.Mandate calldata m) external {
        if (msg.sender != IBookrunnerConfig(config).committee()) revert NotCommittee();
        _mandate = m;
        remandateCount++;
    }

    function revokeKey(address key, bytes32 reason) external {
        if (msg.sender != IBookrunnerConfig(config).committee()) revert NotCommittee();
        lastRevokedKey = key;
        lastRevokeReason = reason;
    }
}

/// @notice Venue adapter stand-in (behind the factory's ERC1967 proxy). Must initialize LAST: it
///         checks every sibling is initialized and the mandate is already a staking locker.
contract GovMockAdapter is GovMockComponentBase {
    uint8 public immutable venueKind;
    bytes32 public symbol;

    error SiblingNotInitialized(address sibling);
    error MandateNotLocker();
    error WrongVenue();

    constructor(uint8 venueKind_) {
        venueKind = venueKind_;
    }

    function initialize(address config_, uint256 bookId_, address book_) external initializer {
        _init(config_, bookId_, book_);
        BRTypes.BookComponents memory c = GovMockBook(book_).components();
        address[6] memory siblings = [c.senior, c.junior, c.vault, c.mandate, c.router, c.desk];
        for (uint256 i; i < siblings.length; ++i) {
            if (!IGovInitFlag(siblings[i]).isInitialized()) revert SiblingNotInitialized(siblings[i]);
        }
        if (!IBkrnStaking(IBookrunnerConfig(config_).staking()).isLocker(c.mandate)) {
            revert MandateNotLocker();
        }
        BRTypes.Charter memory ch = GovMockBook(book_).getCharter();
        if (ch.venue != venueKind) revert WrongVenue();
        symbol = ch.symbol;
    }
}

/// @notice A component whose initializer always reverts (factory atomicity test).
contract GovRevertingComponent is Initializable {
    error Boom();

    constructor() {
        _disableInitializers();
    }

    function initialize(address, uint256, address) external pure {
        revert Boom();
    }
}

/// @notice Fake factory used to test MarketCharter's BookNotCreated guard.
contract GovNullFactory {
    function create(uint256, BRTypes.Charter calldata)
        external
        pure
        returns (BRTypes.BookComponents memory c)
    {
        return c;
    }
}
