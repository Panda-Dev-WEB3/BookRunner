// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {IVenueAdapter} from "../../../src/interfaces/IVenueAdapter.sol";

/// @notice ERC1967 proxy that may be deployed without init data (OZ >= 5.6 refuses empty data by default):
///         mirrors the factory flow "deploy all -> book.initialize -> adapter.initialize".
contract EngineLazyProxy is ERC1967Proxy {
    constructor(address implementation) ERC1967Proxy(implementation, "") {}

    function _unsafeAllowUninitialized() internal pure override returns (bool) {
        return true;
    }
}

/// @notice Minimal BookrunnerConfig stand-in: only what the engine cluster reads.
contract EngineMockConfig {
    bytes32 public constant RISK_ROLE = keccak256("RISK");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER");

    address public usdc;
    address public oracle;
    address public factory;
    address public stockRegistry;
    address public poolEngine;
    address public timelock;
    uint32 public maxPriceAge = 300;
    uint32 public markInterval = 300;

    mapping(bytes32 => mapping(address => bool)) internal _roles;

    function setMarkInterval(uint32 v) external {
        markInterval = v;
    }

    constructor(address timelock_) {
        timelock = timelock_;
    }

    function setUsdc(address a) external {
        usdc = a;
    }

    function setOracle(address a) external {
        oracle = a;
    }

    function setFactory(address a) external {
        factory = a;
    }

    function setStockRegistry(address a) external {
        stockRegistry = a;
    }

    function setPoolEngine(address a) external {
        poolEngine = a;
    }

    function setTimelock(address a) external {
        timelock = a;
    }

    function setMaxPriceAge(uint32 v) external {
        maxPriceAge = v;
    }

    function grantRole(bytes32 role, address a) external {
        _roles[role][a] = true;
    }

    function hasRole(bytes32 role, address a) external view returns (bool) {
        return _roles[role][a];
    }
}

/// @notice BookFactory stand-in: component registry.
contract EngineMockFactory {
    mapping(address => bool) public isComponent;

    function setComponent(address a, bool v) external {
        isComponent[a] = v;
    }

    /// @dev CREATE2-deploys `code` (e.g. an ERC1967Proxy with init data) so that msg.sender of the
    ///      constructor-time initialize is this factory.
    function deploy2(bytes32 salt, bytes memory code) external returns (address a) {
        assembly {
            a := create2(0, add(code, 32), mload(code), salt)
        }
        if (a == address(0)) {
            assembly {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }
    }
}

/// @notice StockTokenRegistry stand-in: charter underlying -> oracle price id.
contract EngineMockRegistry {
    mapping(bytes32 => bytes32) public priceIdOf;

    function setPriceId(bytes32 underlying, bytes32 pid) external {
        priceIdOf[underlying] = pid;
    }
}

/// @notice Book stand-in: charter, components, state.
contract EngineMockBook {
    uint256 public bookId;
    BRTypes.Charter internal _charter;
    BRTypes.BookComponents internal _components;
    BRTypes.BookState public state;

    constructor(uint256 bookId_) {
        bookId = bookId_;
        state = BRTypes.BookState.Live;
    }

    function setBookId(uint256 id) external {
        bookId = id;
    }

    function setCharter(BRTypes.Charter calldata c) external {
        _charter = c;
    }

    function setComponents(BRTypes.BookComponents calldata c) external {
        _components = c;
    }

    function setState(BRTypes.BookState s) external {
        state = s;
    }

    function getCharter() external view returns (BRTypes.Charter memory) {
        return _charter;
    }

    function components() external view returns (BRTypes.BookComponents memory) {
        return _components;
    }
}

/// @notice MMMandate stand-in: mandate terms + kill flag.
contract EngineMockMandate {
    BRTypes.Mandate internal _m;
    bool public killed;

    function setMandate(BRTypes.Mandate calldata m) external {
        _m = m;
    }

    function setKilled(bool k) external {
        killed = k;
    }

    function getMandate() external view returns (BRTypes.Mandate memory) {
        return _m;
    }

    /// @dev Simulates mandate.kill() -> adapter.setReduceOnly(true).
    function forceReduceOnly(address adapter, bool v) external {
        (bool ok, bytes memory ret) = adapter.call(abi.encodeWithSignature("setReduceOnly(bool)", v));
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    /// @dev Simulates mandate.remandate() -> adapter.applyMandate().
    function callAdapter(address adapter, bytes calldata data) external {
        (bool ok, bytes memory ret) = adapter.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

/// @notice RevenueRouter stand-in: push-style accounting identical to the spec (balance must have grown).
contract EngineMockRevenueRouter {
    IERC20 public immutable usdc;
    uint256 public accounted;
    uint256 public pendingGross;
    uint256 public calls;
    uint8 public lastSource;
    uint256 public lastAmount;

    error NotFunded(uint256 grown, uint256 amount);

    constructor(address usdc_) {
        usdc = IERC20(usdc_);
    }

    function notifySettlement(uint8 source, uint256 amount) external {
        uint256 bal = usdc.balanceOf(address(this));
        uint256 grown = bal - accounted;
        if (grown < amount) revert NotFunded(grown, amount);
        accounted += amount;
        pendingGross += amount;
        calls++;
        lastSource = source;
        lastAmount = amount;
    }
}

/// @notice UnderwritingVault stand-in: approves the adapter and calls depositToVenue / requestWithdraw.
contract EngineMockVault {
    IERC20 public immutable usdc;
    address public adapter;

    constructor(address usdc_) {
        usdc = IERC20(usdc_);
    }

    function setAdapter(address a) external {
        adapter = a;
    }

    function deployToVenue(uint8 account, uint256 amount) external {
        usdc.approve(adapter, amount);
        IVenueAdapter(adapter).depositToVenue(account, amount);
    }

    function recall(uint8 account, uint256 amount) external {
        IVenueAdapter(adapter).requestWithdraw(account, amount);
    }
}
