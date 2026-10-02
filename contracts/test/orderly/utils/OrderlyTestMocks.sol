// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {IOrderlyVault} from "../../../src/interfaces/external/IOrderlyVault.sol";
import {IVenueAdapter} from "../../../src/interfaces/IVenueAdapter.sol";
import {OrderlyAdapter} from "../../../src/OrderlyAdapter.sol";

/// @notice Minimal BookrunnerConfig: the subset of IBookrunnerConfig the OrderlyAdapter reads.
contract OrderlyMockConfig {
    bytes32 public constant OPS_VENUE_ROLE = keccak256("OPS_VENUE");
    bytes32 public constant RISK_ROLE = keccak256("RISK");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER");

    address public usdc;
    address public orderlyVault;
    address public timelock;
    address public factory;
    uint32 public markInterval;

    mapping(bytes32 => mapping(address => bool)) public hasRole;

    constructor(
        address usdc_,
        address orderlyVault_,
        address timelock_,
        address factory_,
        uint32 markInterval_
    ) {
        usdc = usdc_;
        orderlyVault = orderlyVault_;
        timelock = timelock_;
        factory = factory_;
        markInterval = markInterval_;
    }

    function grantRole(bytes32 role, address account) external {
        hasRole[role][account] = true;
    }

    function revokeRole(bytes32 role, address account) external {
        hasRole[role][account] = false;
    }

    function setUsdc(address a) external {
        usdc = a;
    }

    function setOrderlyVault(address a) external {
        orderlyVault = a;
    }

    function setTimelock(address a) external {
        timelock = a;
    }

    function setMarkInterval(uint32 v) external {
        markInterval = v;
    }
}

/// @notice Minimal Book: charter, components, lifecycle state, last applied mark period.
contract OrderlyMockBook {
    uint256 public bookId;
    BRTypes.BookState public state;
    uint64 public lastMarkPeriodEnd;
    uint256 public lastMarkId;
    uint64 public flowNonce;

    BRTypes.Charter internal _charter;
    BRTypes.BookComponents internal _components;

    constructor(uint256 bookId_) {
        bookId = bookId_;
    }

    function getCharter() external view returns (BRTypes.Charter memory) {
        return _charter;
    }

    function components() external view returns (BRTypes.BookComponents memory) {
        return _components;
    }

    function setCharter(BRTypes.Charter memory c) external {
        _charter = c;
    }

    function setComponents(BRTypes.BookComponents memory c) external {
        _components = c;
    }

    function setBookId(uint256 id) external {
        bookId = id;
    }

    function setState(BRTypes.BookState s) external {
        state = s;
    }

    /// @dev Simulates Book.applyMark having applied the mark for `periodEnd`.
    function setLastMarkPeriodEnd(uint64 periodEnd) external {
        lastMarkPeriodEnd = periodEnd;
        lastMarkId++;
    }

    function onCapitalFlow() external {
        require(msg.sender == _components.vault, "only vault");
        flowNonce++;
    }
}

/// @notice Minimal UnderwritingVault: holds USDC, approves + calls the adapter like the real vault does.
contract OrderlyMockUWVault {
    IERC20 public immutable asset;
    OrderlyMockBook public immutable bookRef;
    IVenueAdapter public adapter;

    constructor(address usdc_, address book_) {
        asset = IERC20(usdc_);
        bookRef = OrderlyMockBook(book_);
    }

    function setAdapter(address a) external {
        adapter = IVenueAdapter(a);
    }

    function idle() external view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function deployToVenue(uint8 account, uint256 amount) external {
        asset.approve(address(adapter), amount);
        adapter.depositToVenue(account, amount);
        bookRef.onCapitalFlow();
    }

    function recall(uint8 account, uint256 amount) external {
        adapter.requestWithdraw(account, amount);
        bookRef.onCapitalFlow();
    }

    /// @dev As UnderwritingVault.notifyCapitalFlow: the adapter reports USDC pushed here -> flowNonce++.
    function notifyCapitalFlow() external {
        require(msg.sender == address(adapter), "only adapter");
        bookRef.onCapitalFlow();
    }
}

/// @notice Minimal RevenueRouter: push-style notifySettlement (balance must have grown by >= amount).
contract OrderlyMockRouter {
    error NotFunded(uint256 grown, uint256 amount);

    IERC20 public immutable usdc;
    uint256 public accountedBalance;
    uint256 public pendingGross;
    uint256 public notifications;
    uint8 public lastSource;
    address public lastNotifier;

    constructor(address usdc_) {
        usdc = IERC20(usdc_);
    }

    function notifySettlement(uint8 source, uint256 amount) external {
        uint256 bal = usdc.balanceOf(address(this));
        uint256 grown = bal - accountedBalance;
        if (grown < amount) revert NotFunded(grown, amount);
        accountedBalance = bal;
        pendingGross += amount;
        notifications++;
        lastSource = source;
        lastNotifier = msg.sender;
    }
}

/// @notice USDC that records every transfer leaving the closed set {adapter, vault, router, orderlyVault}.
/// @dev Any transfer whose `from` is one of the watched holders and whose `to` is outside the allowed set is
///      a violation of "USDC only ever moves to the book's vault or RevenueRouter (or into the venue)".
contract TrackingUSDC is MockERC20 {
    address public adapter;
    address public vault;
    address public router;
    address public orderlyVault;
    bool public watching;

    uint256 public violations;
    address public lastViolationFrom;
    address public lastViolationTo;
    uint256 public lastViolationAmount;

    /// @notice Every USDC amount received per destination from the adapter.
    mapping(address => uint256) public receivedFromAdapter;

    constructor() MockERC20("USD Coin", "USDC", 6) {}

    function watch(address adapter_, address vault_, address router_, address orderlyVault_) external {
        adapter = adapter_;
        vault = vault_;
        router = router_;
        orderlyVault = orderlyVault_;
        watching = true;
    }

    function _isAllowed(address a) internal view returns (bool) {
        return a == adapter || a == vault || a == router || a == orderlyVault;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (!watching || value == 0) return;
        if (from == adapter) receivedFromAdapter[to] += value;
        if (_isAllowed(from) && !_isAllowed(to)) {
            violations++;
            lastViolationFrom = from;
            lastViolationTo = to;
            lastViolationAmount = value;
        }
        // From the adapter the only legitimate destinations are the vault, the router and the venue.
        if (from == adapter && to != vault && to != router && to != orderlyVault) {
            violations++;
            lastViolationFrom = from;
            lastViolationTo = to;
            lastViolationAmount = value;
        }
    }
}

/// @notice Orderly vault that accepts deposits without pulling the token (adversarial venue).
contract NonPullingOrderlyVault is IOrderlyVault {
    address public immutable token;
    bytes32 public immutable tokenHash;

    constructor(address token_, bytes32 tokenHash_) {
        token = token_;
        tokenHash = tokenHash_;
    }

    function deposit(VaultDepositFE calldata) external payable {}

    function depositTo(address, VaultDepositFE calldata) external payable {}

    function getDepositFee(address, VaultDepositFE calldata) external pure returns (uint256) {
        return 0;
    }

    function delegateSigner(VaultDelegate calldata) external {}

    function getAllowedToken(bytes32 h) external view returns (address) {
        return h == tokenHash ? token : address(0);
    }
}

/// @notice Stand-in for BookFactory's adapter deployment: CREATE2 proxy with `initialize` calldata (OZ 5.7
///         ERC1967Proxy rejects empty init data), so the address can be predicted and listed in the book's
///         components before the proxy (and its initializer) runs.
contract OrderlyMockFactory {
    function initData(address config, uint256 bookId, address book) public pure returns (bytes memory) {
        return abi.encodeCall(OrderlyAdapter.initialize, (config, bookId, book));
    }

    function deployAdapter(address impl, address config, uint256 bookId, address book, bytes32 salt)
        external
        returns (address)
    {
        return address(new ERC1967Proxy{salt: salt}(impl, initData(config, bookId, book)));
    }

    function predictAdapter(address impl, address config, uint256 bookId, address book, bytes32 salt)
        external
        view
        returns (address)
    {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(ERC1967Proxy).creationCode, abi.encode(impl, initData(config, bookId, book))
            )
        );
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))))
        );
    }
}

/// @notice Upgrade target used by the UUPS tests.
contract OrderlyAdapterV2 is OrderlyAdapter {
    constructor(bytes32 b, bytes32 t) OrderlyAdapter(b, t) {}

    function version() external pure returns (uint256) {
        return 2;
    }
}

/// @notice Contract that rejects ETH (for rescueNative failure path).
contract EthRejecter {
    receive() external payable {
        revert("no eth");
    }
}
