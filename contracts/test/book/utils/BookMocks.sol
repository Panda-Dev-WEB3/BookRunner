// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {IBook} from "../../../src/interfaces/IBook.sol";
import {IBookrunnerConfig} from "../../../src/interfaces/IBookrunnerConfig.sol";
import {IMarkRegistry} from "../../../src/interfaces/IMarkRegistry.sol";
import {IVenueAdapter} from "../../../src/interfaces/IVenueAdapter.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";

/// @notice Minimal IBookrunnerConfig for book-cluster tests: settable addresses, params and roles.
contract MockBookConfig is IBookrunnerConfig {
    bytes32 public constant MARK_SIGNER_ROLE = keccak256("MARK_SIGNER");
    bytes32 public constant RISK_ROLE = keccak256("RISK");
    bytes32 public constant OPS_VENUE_ROLE = keccak256("OPS_VENUE");
    bytes32 public constant JURY_ROLE = keccak256("JURY");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN");

    mapping(bytes32 => mapping(address => bool)) internal _roles;

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
    uint256 public charterFeeUsd = 5000e6;
    uint256 public sponsorBondBkrn = 100_000e18;
    uint256 public committeeBondBkrn = 250_000e18;
    uint32 public markInterval = 300;
    uint32 public maxMarkAge = 3600;
    uint32 public maxPriceAge = 300;
    uint32 public committeeWindow = 172_800;
    bool public newBooksPaused;

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return _roles[role][account];
    }

    function grantRole(bytes32 role, address account) external {
        _roles[role][account] = true;
    }

    function revokeRole(bytes32 role, address account) external {
        _roles[role][account] = false;
    }

    function setUsdc(address a) external {
        usdc = a;
    }

    function setBackstop(address a) external {
        backstop = a;
    }

    function setMarkRegistry(address a) external {
        markRegistry = a;
    }

    function setCharter(address a) external {
        charter = a;
    }

    function setFactory(address a) external {
        factory = a;
    }

    function setTimelock(address a) external {
        timelock = a;
    }

    function setMarkInterval(uint32 v) external {
        markInterval = v;
    }

    function setNewBooksPaused(bool p) external {
        newBooksPaused = p;
        emit NewBooksPaused(p);
    }

    function venueMinIfUsd(uint8) external pure returns (uint256) {
        return 0;
    }

    function agentTierBond(uint256) external pure returns (uint256) {
        return 0;
    }
}

/// @notice IMarkRegistry without signatures (tests commit marks directly).
contract MockMarkRegistry is IMarkRegistry {
    mapping(uint256 => BRTypes.Mark) internal _marks;
    mapping(uint256 => uint256) public latestMarkId;
    mapping(uint256 => address) public bookOf;
    uint256 public markCount;

    function setBook(uint256 bookId, address book) external {
        bookOf[bookId] = book;
    }

    function MARK_TYPEHASH() external pure returns (bytes32) {
        return keccak256(
            "Mark(uint256 bookId,uint64 periodEnd,uint256 navUsd,uint256 deployedValueUsd,uint64 flowNonce,bytes32 inventoryRoot,bytes32 pnlJsonHash,bytes32 receiptsRoot)"
        );
    }

    function hashMark(BRTypes.MarkInput calldata m) external pure returns (bytes32) {
        return keccak256(abi.encode(m));
    }

    function commit(BRTypes.MarkInput calldata m, bytes calldata) external returns (uint256 id) {
        id = ++markCount;
        _marks[id] = BRTypes.Mark({
            input: m, signer: msg.sender, committedAt: uint64(block.timestamp), applied: false
        });
        latestMarkId[m.bookId] = id;
        emit MarkCommitted(
            id,
            m.bookId,
            m.periodEnd,
            m.navUsd,
            m.deployedValueUsd,
            m.inventoryRoot,
            m.pnlJsonHash,
            m.receiptsRoot,
            msg.sender
        );
    }

    function getMark(uint256 markId) external view returns (BRTypes.Mark memory) {
        return _marks[markId];
    }

    function markApplied(uint256 markId) external {
        uint256 bookId = _marks[markId].input.bookId;
        require(msg.sender == bookOf[bookId], "MockMarkRegistry: not book");
        _marks[markId].applied = true;
        emit MarkApplied(markId, bookId);
    }
}

/// @notice Venue adapter mock: synchronous deposits/withdrawals; P&L simulated by minting/burning the
///         USDC it holds so the deployed value is always fully backed.
contract MockVenueAdapter is IVenueAdapter {
    MockERC20 public immutable usdcToken;
    address public vault;
    address public book;
    uint256 public value;
    uint256 public ifEquity;
    bool public revertWithdraw;

    constructor(MockERC20 usdc_) {
        usdcToken = usdc_;
    }

    function initialize(address, uint256, address book_) external {
        book = book_;
    }

    function setVault(address v) external {
        vault = v;
    }

    function setRevertWithdraw(bool r) external {
        revertWithdraw = r;
    }

    function venueKind() external pure returns (uint8) {
        return BRTypes.VENUE_POOL_ENGINE;
    }

    function depositToVenue(uint8 account, uint256 amount) external {
        require(msg.sender == vault, "MockVenueAdapter: not vault");
        IERC20(address(usdcToken)).transferFrom(vault, address(this), amount);
        value += amount;
        if (account == BRTypes.ACCOUNT_IF) ifEquity += amount;
        emit VenueDeposit(account, amount);
    }

    function requestWithdraw(uint8 account, uint256 amount) external {
        require(msg.sender == vault, "MockVenueAdapter: not vault");
        require(!revertWithdraw, "MockVenueAdapter: withdraw disabled");
        if (amount > value) amount = value;
        value -= amount;
        if (account == BRTypes.ACCOUNT_IF) ifEquity = ifEquity > amount ? ifEquity - amount : 0;
        IERC20(address(usdcToken)).transfer(vault, amount);
        emit WithdrawRequested(account, amount, 0);
    }

    /// @notice Test hook: move the venue value to `v` (gain mints USDC, loss burns it).
    function setValue(uint256 v) external {
        if (v > value) usdcToken.mint(address(this), v - value);
        else if (v < value) usdcToken.burn(address(this), value - v);
        value = v;
    }

    function sweepToVault() external pure returns (uint256) {
        return 0;
    }

    function sweepFees(uint64, uint256) external pure returns (uint256) {
        return 0;
    }

    function insuranceEquityUsd() external view returns (uint256) {
        return ifEquity;
    }

    function marginEquityUsd() external view returns (int256) {
        return int256(value - ifEquity);
    }

    function netExposureUsd() external pure returns (int256) {
        return 0;
    }

    function inTransitUsd() external pure returns (uint256) {
        return 0;
    }

    function deployedValueUsd() external view returns (uint256) {
        return value;
    }

    function valuationAt() external view returns (uint64) {
        return uint64(block.timestamp);
    }
}

/// @notice MMMandate mock: kill bookkeeping + live killAtDrawdownBps (only the surface the Book uses).
contract MockMandate {
    address public book;
    bool public killed;
    bytes32 public killReason;
    uint256 public killCount;
    int16 public killAt = -800;
    bool public revertGetMandate;
    bool public revertKill;

    constructor(address book_) {
        book = book_;
    }

    function setBook(address b) external {
        book = b;
    }

    function setKillAt(int16 v) external {
        killAt = v;
    }

    function setRevertGetMandate(bool r) external {
        revertGetMandate = r;
    }

    function setRevertKill(bool r) external {
        revertKill = r;
    }

    function getMandate() external view returns (BRTypes.Mandate memory m) {
        require(!revertGetMandate, "MockMandate: getMandate");
        m.maxInventoryUsd = 50_000e6;
        m.maxSkewBps = 25;
        m.minQuoteWidthBps = 8;
        m.maxHedgeLeverage = 100;
        m.hedgeRatioMinBps = 5000;
        m.hedgeRatioMaxBps = 12_000;
        m.killAtDrawdownBps = killAt;
    }

    /// @dev Test mock: anyone may kill (the real mandate restricts to RISK or the book).
    function kill(bytes32 reason) external {
        require(!revertKill, "MockMandate: kill");
        require(!killed, "MockMandate: already killed");
        killed = true;
        killReason = reason;
        killCount++;
        IBook(book).onKill(reason);
    }

    function remandate() external {
        killed = false;
        killReason = 0;
    }
}

/// @notice IBackstop mock with failure modes.
contract MockBackstop {
    enum Mode {
        Normal,
        Revert,
        PayHalf,
        OverReport
    }

    IERC20 public immutable usdc;
    address public vault;
    Mode public mode;
    uint256 public covers;
    bool public revertBalance;

    constructor(IERC20 usdc_) {
        usdc = usdc_;
    }

    function setVault(address v) external {
        vault = v;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setRevertBalance(bool r) external {
        revertBalance = r;
    }

    function balance() external view returns (uint256) {
        require(!revertBalance, "MockBackstop: balance");
        return usdc.balanceOf(address(this));
    }

    function cover(uint256, uint256 shortfall) external returns (uint256 covered) {
        require(mode != Mode.Revert, "MockBackstop: cover");
        uint256 bal = usdc.balanceOf(address(this));
        covered = shortfall < bal ? shortfall : bal;
        uint256 paid = mode == Mode.PayHalf ? covered / 2 : covered;
        if (mode == Mode.PayHalf) covered = paid;
        usdc.transfer(vault, paid);
        covers++;
        if (mode == Mode.OverReport) return covered * 2 + 1;
    }

    function notifyDeposit(uint256) external {}
}

/// @notice MarketCharter mock: retire routing + onRetired bookkeeping.
contract MockCharter {
    mapping(uint256 => bool) public retired;
    mapping(uint256 => address) public bookOf;

    function setBook(uint256 bookId, address book) external {
        bookOf[bookId] = book;
    }

    function retire(uint256 bookId) external {
        IBook(bookOf[bookId]).retire();
    }

    function onRetired(uint256 bookId) external {
        require(msg.sender == bookOf[bookId], "MockCharter: not book");
        retired[bookId] = true;
    }
}

/// @notice Attempts reentrancy into the tranche / book during a USDC transfer is not possible with
///         MockERC20; this helper simulates a malicious caller for access-control tests.
contract CallProxy {
    function call(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}
