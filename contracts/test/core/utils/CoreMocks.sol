// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {IBookFactory} from "../../../src/interfaces/IBookFactory.sol";
import {IAttestedOracle} from "../../../src/interfaces/IAttestedOracle.sol";
import {IBackstop} from "../../../src/interfaces/IBkrnFeeRouter.sol";
import {IMarkRegistry} from "../../../src/interfaces/IMarkRegistry.sol";
import {IBkrnFeeRouter} from "../../../src/interfaces/IBkrnFeeRouter.sol";
import {ISwapRouter02} from "../../../src/interfaces/external/ISwapRouter02.sol";

/// @notice Minimal IBookFactory: books, components and registrations are set directly by tests.
contract CoreMockFactory is IBookFactory {
    mapping(uint256 bookId => address) public bookOf;
    mapping(address => bool) public isBook;
    mapping(address => uint256) public bookIdOf;
    mapping(address => bool) public isComponent;
    mapping(uint256 => BRTypes.BookComponents) private _components;
    uint256[] private _ids;

    function register(uint256 bookId, BRTypes.BookComponents memory c) external {
        bookOf[bookId] = c.book;
        isBook[c.book] = true;
        bookIdOf[c.book] = bookId;
        _components[bookId] = c;
        _ids.push(bookId);
        _mark(c.book);
        _mark(c.senior);
        _mark(c.junior);
        _mark(c.vault);
        _mark(c.mandate);
        _mark(c.router);
        _mark(c.desk);
        _mark(c.adapter);
    }

    function setComponent(address a, bool v) external {
        isComponent[a] = v;
    }

    function setBookOf(uint256 bookId, address book) external {
        bookOf[bookId] = book;
    }

    function create(uint256, BRTypes.Charter calldata) external pure returns (BRTypes.BookComponents memory) {
        revert("mock");
    }

    function componentsOf(uint256 bookId) external view returns (BRTypes.BookComponents memory) {
        return _components[bookId];
    }

    function bookIds() external view returns (uint256[] memory) {
        return _ids;
    }

    function _mark(address a) private {
        if (a != address(0)) isComponent[a] = true;
    }
}

/// @notice Minimal Book surface used by RevenueRouter, Backstop and MarkRegistry.
contract CoreMockBook {
    BRTypes.BookComponents private _c;
    BRTypes.Charter private _charter;

    uint256 public creditedSenior;
    uint256 public creditedJunior;
    uint256 public creditCalls;
    /// @notice Book capital-flow nonce (MarkRegistry reads it to decide whether a mark is stale).
    uint64 public flowNonce;

    error NotRouter();

    function setComponents(BRTypes.BookComponents memory c) external {
        _c = c;
    }

    function setFlowNonce(uint64 n) external {
        flowNonce = n;
    }

    function setVault(address vault) external {
        _c.vault = vault;
    }

    function setHurdle(uint16 bps) external {
        _charter.seniorHurdleBps = bps;
    }

    function components() external view returns (BRTypes.BookComponents memory) {
        return _c;
    }

    function getCharter() external view returns (BRTypes.Charter memory) {
        return _charter;
    }

    function creditDistribution(uint256 seniorAmount, uint256 juniorAmount) external {
        if (msg.sender != _c.router) revert NotRouter();
        creditedSenior += seniorAmount;
        creditedJunior += juniorAmount;
        ++creditCalls;
    }

    function coverFrom(address backstop, uint256 bookId, uint256 shortfall) external returns (uint256) {
        return IBackstop(backstop).cover(bookId, shortfall);
    }

    function applyMark(address registry, uint256 markId) external {
        IMarkRegistry(registry).markApplied(markId);
    }
}

/// @notice Settable IAttestedOracle price surface (only the reads used by MockSwapRouter).
contract CoreMockOracle {
    struct P {
        uint256 price;
        bool held;
        bool stale;
    }

    mapping(bytes32 => P) public prices;

    function set(bytes32 id, uint256 priceWad, bool held, bool stale) external {
        prices[id] = P(priceWad, held, stale);
    }

    function priceOf(bytes32 id) external view returns (uint256, bool) {
        P memory p = prices[id];
        if (p.stale) revert IAttestedOracle.StalePrice(id, 0);
        return (p.price, p.held);
    }
}

/// @notice Swap router that pulls only `pullBps` of the input and pays `payOut` (ignores min-out).
contract CoreMisbehavingRouter {
    uint256 public pullBps = 10_000;
    uint256 public payOut;
    uint256 public reportOut;

    function configure(uint256 pullBps_, uint256 payOut_, uint256 reportOut_) external {
        (pullBps, payOut, reportOut) = (pullBps_, payOut_, reportOut_);
    }

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p)
        external
        payable
        returns (uint256)
    {
        uint256 pull = (p.amountIn * pullBps) / 10_000;
        if (pull > 0) IERC20(p.tokenIn).transferFrom(msg.sender, address(this), pull);
        if (payOut > 0) IERC20(p.tokenOut).transfer(p.recipient, payOut);
        return reportOut;
    }
}

/// @notice Swap router that re-enters BkrnFeeRouter.executeBuyback.
contract CoreReentrantRouter {
    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p)
        external
        payable
        returns (uint256)
    {
        IBkrnFeeRouter(msg.sender).executeBuyback(p.amountIn, 1, p.fee);
        return 0;
    }
}
