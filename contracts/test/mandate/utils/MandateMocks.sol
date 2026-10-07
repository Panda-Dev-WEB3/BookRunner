// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {IAttestedOracle} from "../../../src/interfaces/IAttestedOracle.sol";
import {IPoolEngine} from "../../../src/interfaces/IPoolEngine.sol";
import {ISwapRouter02} from "../../../src/interfaces/external/ISwapRouter02.sol";
import {IMMMandate} from "../../../src/interfaces/IMMMandate.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/IERC4337.sol";

/// @dev Minimal BookrunnerConfig: the subset A-mandate reads.
contract MandateMockConfig {
    bytes32 public constant MARK_SIGNER_ROLE = keccak256("MARK_SIGNER");
    bytes32 public constant RISK_ROLE = keccak256("RISK");
    bytes32 public constant OPS_VENUE_ROLE = keccak256("OPS_VENUE");
    bytes32 public constant JURY_ROLE = keccak256("JURY");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN");

    mapping(bytes32 => mapping(address => bool)) internal _roles;
    address public usdc;
    address public staking;
    address public oracle;
    address public stockRegistry;
    address public committee;
    address public factory;
    address public poolEngine;
    address public hedgeExecutor;
    address public entryPoint;
    address public timelock;
    uint32 public maxPriceAge = 300;
    uint32 public markInterval = 86_400;

    uint256[] internal _tierThresholds;

    function setMarkInterval(uint32 v) external {
        markInterval = v;
    }
    uint256[] internal _tierBonds;

    function grant(bytes32 role, address a) external {
        _roles[role][a] = true;
    }

    function revoke(bytes32 role, address a) external {
        _roles[role][a] = false;
    }

    function hasRole(bytes32 role, address a) external view returns (bool) {
        return _roles[role][a];
    }

    function setUsdc(address a) external {
        usdc = a;
    }

    function setStaking(address a) external {
        staking = a;
    }

    function setOracle(address a) external {
        oracle = a;
    }

    function setStockRegistry(address a) external {
        stockRegistry = a;
    }

    function setCommittee(address a) external {
        committee = a;
    }

    function setFactory(address a) external {
        factory = a;
    }

    function setPoolEngine(address a) external {
        poolEngine = a;
    }

    function setHedgeExecutor(address a) external {
        hedgeExecutor = a;
    }

    function setEntryPoint(address a) external {
        entryPoint = a;
    }

    function setTimelock(address a) external {
        timelock = a;
    }

    function setMaxPriceAge(uint32 v) external {
        maxPriceAge = v;
    }

    /// @dev Sorted step tiers [(threshold, bond)].
    function setTiers(uint256[] calldata thresholds, uint256[] calldata bonds) external {
        _tierThresholds = thresholds;
        _tierBonds = bonds;
    }

    function agentTierBond(uint256 inventoryUsd) external view returns (uint256 bond) {
        for (uint256 i; i < _tierThresholds.length; ++i) {
            if (inventoryUsd >= _tierThresholds[i]) bond = _tierBonds[i];
        }
    }
}

/// @dev AttestedOracle subset: latest / priceOf (StalePrice beyond config.maxPriceAge()).
contract MandateMockOracle {
    MandateMockConfig public immutable config;
    mapping(bytes32 => IAttestedOracle.PriceData) internal _data;

    constructor(MandateMockConfig c) {
        config = c;
    }

    function set(bytes32 id, uint256 priceWad, uint64 publishedAt, bool held) external {
        _data[id] = IAttestedOracle.PriceData({
            priceWad: priceWad, publishedAt: publishedAt, held: held, sourceCount: 3
        });
    }

    function setHeld(bytes32 id, bool held) external {
        _data[id].held = held;
    }

    function latest(bytes32 id) external view returns (IAttestedOracle.PriceData memory) {
        return _data[id];
    }

    function priceOf(bytes32 id) external view returns (uint256, bool) {
        IAttestedOracle.PriceData memory d = _data[id];
        if (d.publishedAt == 0 || block.timestamp > uint256(d.publishedAt) + config.maxPriceAge()) {
            revert IAttestedOracle.StalePrice(id, d.publishedAt);
        }
        return (d.priceWad, d.held);
    }
}

/// @dev BkrnStaking lock subset with failure switches.
contract MandateMockStaking {
    mapping(address => bool) public isLocker;
    mapping(address => uint256) public availableOf;
    mapping(address => mapping(bytes32 => uint256)) public lockOf;
    bool public failUnlock;
    bool public shortLock;

    function setLocker(address l, bool ok) external {
        isLocker[l] = ok;
    }

    function setAvailable(address a, uint256 v) external {
        availableOf[a] = v;
    }

    function setFailUnlock(bool v) external {
        failUnlock = v;
    }

    function setShortLock(bool v) external {
        shortLock = v;
    }

    function lock(address account, bytes32 lockId, uint256 amount) external {
        require(isLocker[msg.sender], "not locker");
        require(availableOf[account] >= amount, "insufficient stake");
        availableOf[account] -= amount;
        lockOf[account][lockId] += shortLock ? amount / 2 : amount;
    }

    function unlock(address account, bytes32 lockId) external returns (uint256 released) {
        require(isLocker[msg.sender], "not locker");
        require(!failUnlock, "unlock disabled");
        released = lockOf[account][lockId];
        lockOf[account][lockId] = 0;
        availableOf[account] += released;
    }
}

/// @dev IBook subset used by the mandate cluster.
contract MandateMockBook {
    uint256 public bookId;
    BRTypes.Charter internal _charter;
    BRTypes.BookComponents internal _components;
    uint64 public flowNonce;
    bytes32 public lastKill;
    uint256 public killCount;
    bool public revertOnKill;
    /// @dev Desk mark-window gate inputs. Default Subscription: the gate is open (no mark cycle).
    BRTypes.BookState public state;
    uint64 public lastMarkPeriodEnd;
    uint64 public subscriptionEnds;

    function setUp(uint256 id, BRTypes.Charter memory c, BRTypes.BookComponents memory comps) external {
        bookId = id;
        _charter = c;
        _components = comps;
    }

    function setMarkState(BRTypes.BookState st, uint64 lastMarkPeriodEnd_, uint64 subscriptionEnds_) external {
        state = st;
        lastMarkPeriodEnd = lastMarkPeriodEnd_;
        subscriptionEnds = subscriptionEnds_;
    }

    function setRevertOnKill(bool v) external {
        revertOnKill = v;
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

    function onKill(bytes32 reason) external {
        require(msg.sender == _components.mandate, "only mandate");
        require(!revertOnKill, "book onKill reverts");
        lastKill = reason;
        killCount++;
    }

    function onCapitalFlow() external {
        require(msg.sender == _components.vault, "only vault");
        flowNonce++;
    }

    function callKill(bytes32 reason) external {
        IMMMandate(_components.mandate).kill(reason);
    }

    function callSetRetiring() external {
        MandateRetiringLike(_components.mandate).setRetiring();
    }
}

interface MandateRetiringLike {
    function setRetiring() external;
}

/// @dev UnderwritingVault subset (+ the requested notifyDeskReturn extension).
contract MandateMockVault {
    IERC20 public immutable usdc;
    MandateMockBook public immutable book;
    address public desk;
    address public adapter;
    mapping(uint8 => uint256) public deployed;
    mapping(uint8 => uint256) public recalled;
    uint256 public funded;
    uint256 public returnedNotified;
    uint256 public fundShortBy;

    constructor(IERC20 usdc_, MandateMockBook book_) {
        usdc = usdc_;
        book = book_;
    }

    function wire(address desk_, address adapter_) external {
        desk = desk_;
        adapter = adapter_;
    }

    function setFundShortBy(uint256 v) external {
        fundShortBy = v;
    }

    function deployToVenue(uint8 account, uint256 amount) external {
        require(msg.sender == desk || msg.sender == address(book), "only book/desk");
        deployed[account] += amount;
        require(usdc.transfer(adapter, amount), "transfer");
        book.onCapitalFlow();
    }

    function recall(uint8 account, uint256 amount) external {
        require(msg.sender == desk || msg.sender == address(book), "only book/desk");
        recalled[account] += amount;
        book.onCapitalFlow();
    }

    function fundDesk(uint256 amount) external {
        require(msg.sender == desk, "only desk");
        funded += amount;
        require(usdc.transfer(desk, amount - fundShortBy), "transfer");
        book.onCapitalFlow();
    }

    function notifyDeskReturn(uint256 amount) external {
        require(msg.sender == desk, "only desk");
        returnedNotified += amount;
        book.onCapitalFlow();
    }
}

/// @dev PoolEngine subset read by MMMandate.checkQuote (live spread + max net exposure).
contract MandateMockPoolEngine {
    uint16 public spreadBps;
    int16 public skewBps;
    uint128 public maxNetExposureUsd;
    bool public broken;

    function setQuote(uint256, uint16 s, int16 k, uint128 m) external {
        spreadBps = s;
        skewBps = k;
        maxNetExposureUsd = m;
    }

    function setBroken(bool v) external {
        broken = v;
    }

    function state(uint256) external view returns (IPoolEngine.MarketState memory s) {
        require(!broken, "engine broken");
        s.spreadBps = spreadBps;
        s.skewBps = skewBps;
    }

    function config(uint256) external view returns (IPoolEngine.MarketConfig memory c) {
        require(!broken, "engine broken");
        c.maxNetExposureUsd = maxNetExposureUsd;
    }
}

/// @dev Venue adapter (engine or Orderly flavour) with settable valuation inputs.
contract MandateMockAdapter {
    uint8 public venueKind;
    MandateMockPoolEngine public engine;
    address public desk;
    address public mandate;
    int256 public netExposureUsd;
    uint256 public insuranceEquityUsd;
    int256 public marginEquityUsd;
    uint64 public reportAsOf; // Orderly: last report; engine: 0 => block.timestamp
    bool public reduceOnly;
    uint256 public reduceOnlyCalls;
    bool public revertReduceOnly;
    uint16 public lastSpread;
    int16 public lastSkew;
    uint128 public lastMaxNet;
    uint256 public quoteCalls;

    constructor(uint8 kind, MandateMockPoolEngine engine_) {
        venueKind = kind;
        engine = engine_;
    }

    function wire(address desk_, address mandate_) external {
        desk = desk_;
        mandate = mandate_;
    }

    function setExposure(int256 v) external {
        netExposureUsd = v;
    }

    function setEquity(uint256 insurance, int256 margin) external {
        insuranceEquityUsd = insurance;
        marginEquityUsd = margin;
    }

    function report(uint64 asOf) external {
        reportAsOf = asOf;
    }

    function setRevertReduceOnly(bool v) external {
        revertReduceOnly = v;
    }

    function marketId() external pure returns (uint256) {
        return 1;
    }

    function valuationAt() external view returns (uint64) {
        if (venueKind == BRTypes.VENUE_POOL_ENGINE && reportAsOf == 0) return uint64(block.timestamp);
        return reportAsOf;
    }

    function setQuote(uint16 s, int16 k, uint128 m) external {
        require(msg.sender == desk, "only desk");
        lastSpread = s;
        lastSkew = k;
        lastMaxNet = m;
        quoteCalls++;
        engine.setQuote(1, s, k, m);
    }

    function setReduceOnly(bool v) external {
        require(msg.sender == desk || msg.sender == mandate, "not authorised");
        require(!revertReduceOnly, "reduce-only reverts");
        reduceOnly = v;
        reduceOnlyCalls++;
    }

    uint256 public applyMandateCalls;
    bool public revertApplyMandate;

    function setRevertApplyMandate(bool v) external {
        revertApplyMandate = v;
    }

    /// @dev PoolEngineAdapter.applyMandate stand-in (mandate-only re-mandate hook).
    function applyMandate() external {
        require(msg.sender == mandate, "only mandate");
        require(!revertApplyMandate, "applyMandate reverts");
        applyMandateCalls++;
        reduceOnly = true;
    }
}

/// @dev IBookFactory subset used by HedgeExecutor auth.
contract MandateMockFactory {
    mapping(address => bool) public isComponent;
    mapping(address => bool) public isBook;
    mapping(address => uint256) public bookIdOf;
    mapping(uint256 => BRTypes.BookComponents) internal _components;

    function register(uint256 id, BRTypes.BookComponents memory c) external {
        _components[id] = c;
        isBook[c.book] = true;
        bookIdOf[c.book] = id;
        isComponent[c.book] = true;
        isComponent[c.vault] = true;
        isComponent[c.mandate] = true;
        isComponent[c.desk] = true;
        isComponent[c.adapter] = true;
        isComponent[c.router] = true;
        isComponent[c.senior] = true;
        isComponent[c.junior] = true;
    }

    function setComponent(address a, bool v) external {
        isComponent[a] = v;
    }

    function componentsOf(uint256 id) external view returns (BRTypes.BookComponents memory) {
        return _components[id];
    }

    function bookOf(uint256 id) external view returns (address) {
        return _components[id].book;
    }
}

/// @dev Uniswap v3 SwapRouter02 stand-in. Prices are USD WAD per whole token (multiplier included).
contract MandateMockSwapRouter is ISwapRouter02 {
    address public immutable usdc;
    mapping(address => uint256) public priceWad;
    uint256 public haircutBps; // output haircut (slippage)
    uint256 public bonusBps; // output bonus (better than oracle)
    uint256 public consumeBps = 10_000; // share of amountIn actually pulled
    bool public ignoreMin; // do not enforce amountOutMinimum (to exercise caller-side checks)
    bool public underDeliver; // report full amountOut but deliver half
    uint24 public lastFee;
    uint256 public calls;

    constructor(address usdc_) {
        usdc = usdc_;
    }

    function setPrice(address token, uint256 p) external {
        priceWad[token] = p;
    }

    function setHaircutBps(uint256 v) external {
        haircutBps = v;
    }

    function setBonusBps(uint256 v) external {
        bonusBps = v;
    }

    function setConsumeBps(uint256 v) external {
        consumeBps = v;
    }

    function setIgnoreMin(bool v) external {
        ignoreMin = v;
    }

    function setUnderDeliver(bool v) external {
        underDeliver = v;
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256 out) {
        if (tokenIn == usdc) {
            uint8 dec = IERC20Metadata(tokenOut).decimals();
            out = amountIn * 1e12 * (10 ** dec) / priceWad[tokenOut];
        } else {
            uint8 dec = IERC20Metadata(tokenIn).decimals();
            out = amountIn * priceWad[tokenIn] / (10 ** dec) / 1e12;
        }
        out = out * (10_000 - haircutBps) / 10_000;
        out = out * (10_000 + bonusBps) / 10_000;
    }

    function exactInputSingle(ExactInputSingleParams calldata p)
        external
        payable
        returns (uint256 amountOut)
    {
        calls++;
        lastFee = p.fee;
        uint256 pulled = p.amountIn * consumeBps / 10_000;
        require(IERC20(p.tokenIn).transferFrom(msg.sender, address(this), pulled), "pull");
        amountOut = quote(p.tokenIn, p.tokenOut, pulled);
        if (!ignoreMin) require(amountOut >= p.amountOutMinimum, "Too little received");
        MockERC20(p.tokenOut).mint(p.recipient, underDeliver ? amountOut / 2 : amountOut);
    }
}

/// @dev ERC20 reporting absurd decimals (registry bound test).
contract MandateWeirdDecimalsToken {
    function decimals() external pure returns (uint8) {
        return 31;
    }
}

interface MandateIAccount {
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData);
}

/// @dev EntryPoint v0.7 stand-in: validation and execution in ONE call frame (transient storage
///      persists exactly as within a real handleOps transaction). Optionally runs another call between
///      the validation and execution phases (another sender's op in the same bundle).
contract MandateMockEntryPoint {
    receive() external payable {}

    function handleOp(address account, PackedUserOperation calldata op, bytes32 opHash)
        external
        returns (uint256 validationData, bool ok, bytes memory ret)
    {
        validationData = MandateIAccount(account).validateUserOp(op, opHash, 0);
        if (uint160(validationData) != 0) return (validationData, false, "");
        (ok, ret) = account.call(op.callData);
    }

    /// @dev Validate `op`, run `target.call(data)` (another op of the bundle), then execute `op`.
    function handleOpWithInterleave(
        address account,
        PackedUserOperation calldata op,
        bytes32 opHash,
        address target,
        bytes calldata data
    ) external returns (uint256 validationData, bool ok, bytes memory ret) {
        validationData = MandateIAccount(account).validateUserOp(op, opHash, 0);
        if (uint160(validationData) != 0) return (validationData, false, "");
        (bool ok2,) = target.call(data);
        require(ok2, "interleaved call failed");
        (ok, ret) = account.call(op.callData);
    }

    /// @dev Two ops of the same sender: validate both, then execute both (handleOps ordering).
    function handleTwo(
        address account,
        PackedUserOperation calldata op1,
        bytes32 h1,
        PackedUserOperation calldata op2,
        bytes32 h2
    ) external returns (bool ok1, bool ok2) {
        require(uint160(MandateIAccount(account).validateUserOp(op1, h1, 0)) == 0, "v1");
        require(uint160(MandateIAccount(account).validateUserOp(op2, h2, 0)) == 0, "v2");
        (ok1,) = account.call(op1.callData);
        (ok2,) = account.call(op2.callData);
    }
}

/// @dev An authorised revoker contract (granted RISK in tests): "another op in the bundle".
contract MandateRevoker {
    function revoke(IMMMandate m, address key, bytes32 reason) external {
        m.revokeKey(key, reason);
    }

    function kill(IMMMandate m, bytes32 reason) external {
        m.kill(reason);
    }
}
