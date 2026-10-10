// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {IBookrunnerDesk} from "../../../src/interfaces/IBookrunnerDesk.sol";
import {IStockTokenRegistry} from "../../../src/interfaces/IStockTokenRegistry.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {MMMandate} from "../../../src/MMMandate.sol";
import {BookrunnerDesk} from "../../../src/BookrunnerDesk.sol";
import {HedgeExecutor} from "../../../src/HedgeExecutor.sol";
import {StockTokenRegistry} from "../../../src/StockTokenRegistry.sol";

import {
    MandateMockConfig,
    MandateMockOracle,
    MandateMockStaking,
    MandateMockBook,
    MandateMockVault,
    MandateMockPoolEngine,
    MandateMockAdapter,
    MandateMockFactory,
    MandateMockSwapRouter
} from "./MandateMocks.sol";
import {StandardMerkle} from "./StandardMerkle.sol";

/// @dev Shared fixture for the A-mandate cluster: real MMMandate / BookrunnerDesk clones, real
///      HedgeExecutor + StockTokenRegistry, mocked siblings (config, book, vault, adapter, oracle,
///      staking, factory, swap router, engine).
abstract contract MandateBase is Test {
    uint256 internal constant BOOK_ID = 7;
    bytes32 internal constant NVDA_ID = "NVDA";
    bytes32 internal constant TSLA_ID = "TSLA";
    bytes32 internal constant UNIV3 = "UNIV3";
    bytes32 internal constant UNIV4 = "UNIV4";
    bytes32 internal constant V_ORDERLY = "ORDERLY";
    bytes32 internal constant V_ENGINE = "ENGINE";
    uint256 internal constant NVDA_PX = 190e18;
    uint256 internal constant TSLA_PX = 440e18;
    uint128 internal constant MAX_INV = 50_000e6;
    uint128 internal constant IF_TARGET = 25_000e6;
    uint128 internal constant MM_INV = 100_000e6;
    uint256 internal constant T0 = 1_700_000_000;

    bytes32 internal constant RISK_ROLE = keccak256("RISK");
    bytes32 internal constant KEEPER_ROLE = keccak256("KEEPER");

    MandateMockConfig internal cfg;
    MandateMockOracle internal oracle;
    MandateMockStaking internal staking;
    MandateMockFactory internal factory;
    MandateMockPoolEngine internal engine;
    MandateMockSwapRouter internal router;
    StockTokenRegistry internal registry;
    HedgeExecutor internal exec;
    MMMandate internal mandateImpl;
    BookrunnerDesk internal deskImpl;

    MockERC20 internal usdc;
    MockERC20 internal nvda; // 18 decimals
    MockERC20 internal tsla; // 6 decimals

    MandateMockBook internal book;
    MMMandate internal mandate;
    BookrunnerDesk internal desk;
    MandateMockVault internal vault;
    MandateMockAdapter internal adapter;

    address internal timelock = makeAddr("timelock");
    address internal risk = makeAddr("risk");
    address internal keeper = makeAddr("keeper");
    address internal committee = makeAddr("committee");
    address internal sponsor = makeAddr("sponsor");
    address internal operator = makeAddr("operator");
    address internal stranger = makeAddr("stranger");
    address internal entryPoint = makeAddr("entryPoint");
    address internal key;
    uint256 internal keyPk;

    bytes32[] internal allowLeaves;
    bytes32[] internal allowTree;

    function setUp() public virtual {
        vm.warp(T0);
        (key, keyPk) = makeAddrAndKey("deskKey");
        _deployInfra();
        _deployBook(BRTypes.VENUE_POOL_ENGINE);
        _registerDefaultKey();
    }

    // ------------------------------------------------------------------ deployment

    function _deployInfra() internal {
        cfg = new MandateMockConfig();
        oracle = new MandateMockOracle(cfg);
        staking = new MandateMockStaking();
        factory = new MandateMockFactory();
        engine = new MandateMockPoolEngine();
        usdc = new MockERC20("USD Coin", "USDC", 6);
        nvda = new MockERC20("NVIDIA Stock Token", "NVDA", 18);
        tsla = new MockERC20("Tesla Stock Token", "TSLA", 6);
        router = new MandateMockSwapRouter(address(usdc));

        cfg.setUsdc(address(usdc));
        cfg.setStaking(address(staking));
        cfg.setOracle(address(oracle));
        cfg.setCommittee(committee);
        cfg.setFactory(address(factory));
        cfg.setPoolEngine(address(engine));
        cfg.setEntryPoint(entryPoint);
        cfg.setTimelock(timelock);
        cfg.grant(RISK_ROLE, risk);
        cfg.grant(KEEPER_ROLE, keeper);
        uint256[] memory th = new uint256[](3);
        uint256[] memory bd = new uint256[](3);
        (th[0], bd[0]) = (50_000e6, 25_000e18);
        (th[1], bd[1]) = (250_000e6, 100_000e18);
        (th[2], bd[2]) = (1_000_000e6, 400_000e18);
        cfg.setTiers(th, bd);

        registry = new StockTokenRegistry(address(cfg), address(0));
        cfg.setStockRegistry(address(registry));
        vm.startPrank(timelock);
        registry.register(address(nvda), NVDA_ID, 1e18, 1000e18);
        registry.register(address(tsla), TSLA_ID, 1e18, 1000e6);
        vm.stopPrank();
        oracle.set(NVDA_ID, NVDA_PX, uint64(block.timestamp), false);
        oracle.set(TSLA_ID, TSLA_PX, uint64(block.timestamp), false);
        router.setPrice(address(nvda), NVDA_PX);
        router.setPrice(address(tsla), TSLA_PX);

        exec = new HedgeExecutor(address(cfg), address(router));
        cfg.setHedgeExecutor(address(exec));
        // governance routes (direct pools, 0.3% tier) for every hedge asset on both spot venues
        vm.startPrank(timelock);
        exec.setRoute(UNIV3, address(nvda), 3000, address(0), 0);
        exec.setRoute(UNIV3, address(tsla), 3000, address(0), 0);
        exec.setRoute(UNIV4, address(nvda), 3000, address(0), 0);
        exec.setRoute(UNIV4, address(tsla), 3000, address(0), 0);
        vm.stopPrank();

        mandateImpl = new MMMandate();
        deskImpl = new BookrunnerDesk();

        allowLeaves.push(StandardMerkle.leaf(_asset(address(nvda)), UNIV3));
        allowLeaves.push(StandardMerkle.leaf(_asset(address(tsla)), UNIV3));
        allowLeaves.push(StandardMerkle.leaf(_asset(address(nvda)), V_ORDERLY));
        allowLeaves.push(StandardMerkle.leaf(_asset(address(nvda)), V_ENGINE));
        allowLeaves.push(StandardMerkle.leaf(_asset(address(nvda)), UNIV4));
        allowTree = StandardMerkle.build(allowLeaves);
    }

    function _defaultMandate() internal view returns (BRTypes.Mandate memory) {
        return BRTypes.Mandate({
            maxInventoryUsd: MAX_INV,
            maxSkewBps: 25,
            minQuoteWidthBps: 8,
            maxHedgeLeverage: 300,
            hedgeRatioMinBps: 5000,
            hedgeRatioMaxBps: 12_000,
            noNewRiskOffHours: true,
            killAtDrawdownBps: -800,
            hedgeAllowRoot: allowTree[0]
        });
    }

    function _charter(uint8 venue_) internal view returns (BRTypes.Charter memory c) {
        c.underlying = _asset(address(nvda));
        c.venue = venue_;
        c.oracle = BRTypes.ORACLE_ATTESTED;
        c.ifTargetUsd = IF_TARGET;
        c.mmInventoryUsd = MM_INV;
        c.mandate = _defaultMandate();
        c.seniorHurdleBps = 6000;
        c.seniorCapBps = 7000;
        c.subscriptionWindow = 600;
        c.juniorNoticeSeconds = 900;
        c.sponsor = sponsor;
        c.symbol = "NVDA-PERP";
        c.takerFeeBps = 5;
    }

    function _deployBook(uint8 venue_) internal {
        (book, mandate, desk, vault, adapter) = _newBook(BOOK_ID, venue_);
    }

    function _newBook(uint256 id, uint8 venue_)
        internal
        returns (MandateMockBook b, MMMandate m, BookrunnerDesk d, MandateMockVault v, MandateMockAdapter a)
    {
        b = new MandateMockBook();
        m = MMMandate(Clones.clone(address(mandateImpl)));
        d = BookrunnerDesk(payable(Clones.clone(address(deskImpl))));
        v = new MandateMockVault(usdc, b);
        a = new MandateMockAdapter(venue_, engine);
        BRTypes.BookComponents memory comps = BRTypes.BookComponents({
            book: address(b),
            senior: makeAddr(string.concat("senior", vm.toString(id))),
            junior: makeAddr(string.concat("junior", vm.toString(id))),
            vault: address(v),
            mandate: address(m),
            router: makeAddr(string.concat("revRouter", vm.toString(id))),
            desk: address(d),
            adapter: address(a)
        });
        b.setUp(id, _charter(venue_), comps);
        v.wire(address(d), address(a));
        a.wire(address(d), address(m));
        factory.register(id, comps);
        m.initialize(address(cfg), id, address(b));
        d.initialize(address(cfg), id, address(b));
        staking.setLocker(address(m), true);
        usdc.mint(address(v), 1_000_000e6);
    }

    function _registerDefaultKey() internal {
        _registerKey(key, operator, uint64(block.timestamp + 30 days), MAX_INV);
    }

    function _registerKey(address k, address op, uint64 validUntil, uint128 tier) internal {
        staking.setAvailable(op, staking.availableOf(op) + 1_000_000e18);
        if (op != sponsor) {
            vm.prank(op);
            mandate.consentKey(k, true);
        }
        vm.prank(sponsor);
        mandate.registerKey(k, op, validUntil, tier);
    }

    // ------------------------------------------------------------------ helpers

    function _asset(address token) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(token)));
    }

    function _proof(address token, bytes32 venue_) internal view returns (bytes32[] memory) {
        return StandardMerkle.proof(allowTree, StandardMerkle.leaf(_asset(token), venue_));
    }

    function _action(IBookrunnerDesk.ActionKind kind, bytes memory data)
        internal
        pure
        returns (IBookrunnerDesk.Action memory a)
    {
        a.kind = kind;
        a.data = data;
    }

    function _hedgeAction(address token, bool buy, uint256 amountIn, uint256 minOut)
        internal
        view
        returns (IBookrunnerDesk.Action memory a)
    {
        a.kind = IBookrunnerDesk.ActionKind.Hedge;
        a.data = abi.encode(token, buy, amountIn, minOut, uint24(3000), UNIV3);
        a.proof = _proof(token, UNIV3);
    }

    function _flattenAction(address token, uint256 amountIn, uint256 minOut)
        internal
        pure
        returns (IBookrunnerDesk.Action memory a)
    {
        a.kind = IBookrunnerDesk.ActionKind.Flatten;
        a.data = abi.encode(token, amountIn, minOut, uint24(3000), UNIV3);
    }

    function _exec(address caller, IBookrunnerDesk.Action memory a) internal returns (bytes memory) {
        vm.prank(caller);
        return desk.execute(a);
    }

    function _fundDesk(uint256 amount) internal {
        _exec(key, _action(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(amount)));
    }

    /// @dev Buy `usdAmount` of NVDA through the desk as the default key.
    function _buyNvda(uint256 usdAmount) internal returns (uint256 out) {
        out = abi.decode(_exec(key, _hedgeAction(address(nvda), true, usdAmount, 0)), (uint256));
    }

    function _refreshPrices() internal {
        oracle.set(NVDA_ID, NVDA_PX, uint64(block.timestamp), false);
        oracle.set(TSLA_ID, TSLA_PX, uint64(block.timestamp), false);
    }

    function _tokenInfo(address token) internal view returns (IStockTokenRegistry.StockToken memory) {
        return registry.getToken(token);
    }
}
