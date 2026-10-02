// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {EngineBase} from "./utils/EngineBase.sol";
import {
    EngineMockConfig,
    EngineMockFactory,
    EngineMockBook,
    EngineMockRegistry,
    EngineMockRevenueRouter,
    EngineMockVault,
    EngineLazyProxy
} from "./utils/EngineMocks.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {AttestedOracle} from "../../src/AttestedOracle.sol";
import {PoolEngine} from "../../src/PoolEngine.sol";
import {PoolEngineAdapter} from "../../src/PoolEngineAdapter.sol";
import {MMMandate} from "../../src/MMMandate.sol";
import {BookrunnerDesk} from "../../src/BookrunnerDesk.sol";
import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IBookrunnerDesk} from "../../src/interfaces/IBookrunnerDesk.sol";
import {IPoolEngine} from "../../src/interfaces/IPoolEngine.sol";

/// @dev EngineMockConfig + what MMMandate / BookrunnerDesk read (committee, tier bonds = 0, EntryPoint).
contract EngineIntegrationConfig is EngineMockConfig {
    address public committee;
    address public staking;
    address public entryPoint;
    address public hedgeExecutor;

    constructor(address timelock_) EngineMockConfig(timelock_) {}

    function setCommittee(address a) external {
        committee = a;
    }

    function agentTierBond(uint256) external pure returns (uint256) {
        return 0;
    }
}

/// @notice End to end on the real in-house stack (MMMandate clone, BookrunnerDesk clone, PoolEngineAdapter
///         proxy, PoolEngine, AttestedOracle): kill -> REMANDATE -> fresh key -> SetQuote re-opens the market
///         under the new terms; a re-mandate clamps the live quote at once. Regressions for
///         engine-reduce-only-sticky, engine-reduceonly-irreversible and remandate-stale-engine-quote
///         (pre-fix ABI only, so they compile against and FAIL on the old code).
contract EngineMandateIntegrationTest is EngineBase {
    uint256 internal constant BOOK_ID = 9;
    bytes32 internal constant UNDERLYING = bytes32("RHX5-INDEX");
    uint128 internal constant MAX_INV = 75_000e6;

    EngineIntegrationConfig internal icfg;
    EngineMockRegistry internal registry;
    EngineMockBook internal book;
    EngineMockVault internal vault;
    EngineMockRevenueRouter internal router;
    MMMandate internal mandate;
    BookrunnerDesk internal desk;
    PoolEngineAdapter internal adapter;
    uint256 internal mid;

    address internal committee = makeAddr("committee");
    address internal risk = makeAddr("risk");
    address internal sponsor = makeAddr("sponsor");
    address internal key = makeAddr("key");
    address internal key2 = makeAddr("key2");
    address internal alice = makeAddr("alice");

    function setUp() public {
        vm.warp(T0);
        icfg = new EngineIntegrationConfig(timelock);
        cfg = icfg;
        usdc = new MockERC20("USD Coin", "USDC", 6);
        cfg.setUsdc(address(usdc));
        signer = vm.addr(SIGNER_PK);
        oracle = new AttestedOracle(address(cfg), signer, bytes32(0));
        cfg.setOracle(address(oracle));
        cfg.grantRole(cfg.KEEPER_ROLE(), address(this));
        factory = new EngineMockFactory();
        cfg.setFactory(address(factory));
        engine = new PoolEngine(address(cfg));
        cfg.setPoolEngine(address(engine));
        registry = new EngineMockRegistry();
        registry.setPriceId(UNDERLYING, PID_A);
        cfg.setStockRegistry(address(registry));
        cfg.grantRole(cfg.RISK_ROLE(), risk);
        icfg.setCommittee(committee);

        mandate = MMMandate(Clones.clone(address(new MMMandate())));
        desk = BookrunnerDesk(payable(Clones.clone(address(new BookrunnerDesk()))));
        adapter = PoolEngineAdapter(address(new EngineLazyProxy(address(new PoolEngineAdapter(address(cfg))))));
        book = new EngineMockBook(BOOK_ID);
        vault = new EngineMockVault(address(usdc));
        router = new EngineMockRevenueRouter(address(usdc));
        BRTypes.Charter memory c;
        c.underlying = UNDERLYING;
        c.venue = BRTypes.VENUE_POOL_ENGINE;
        c.oracle = BRTypes.ORACLE_ATTESTED;
        c.ifTargetUsd = 25_000e6;
        c.mmInventoryUsd = 100_000e6;
        c.mandate = _terms(MAX_INV, 10, 25);
        c.sponsor = sponsor;
        c.symbol = bytes32("RHX5-PERP");
        c.takerFeeBps = 6;
        book.setCharter(c);
        book.setComponents(
            BRTypes.BookComponents({
                book: address(book),
                senior: makeAddr("senior"),
                junior: makeAddr("junior"),
                vault: address(vault),
                mandate: address(mandate),
                router: address(router),
                desk: address(desk),
                adapter: address(adapter)
            })
        );
        factory.setComponent(address(adapter), true);
        vault.setAdapter(address(adapter));
        mandate.initialize(address(cfg), BOOK_ID, address(book));
        desk.initialize(address(cfg), BOOK_ID, address(book));
        vm.prank(address(factory));
        adapter.initialize(address(cfg), BOOK_ID, address(book));
        mid = adapter.marketId();
        _price(PID_A, PX);
        usdc.mint(address(vault), 125_000e6);
        vault.deployToVenue(BRTypes.ACCOUNT_IF, 25_000e6);
        vault.deployToVenue(BRTypes.ACCOUNT_MM, 100_000e6);
        _register(key, MAX_INV);
        _deposit(alice, mid, 20_000e6);
    }

    function _terms(uint128 maxInv, uint16 minWidth, int16 maxSkew) internal pure returns (BRTypes.Mandate memory) {
        return BRTypes.Mandate({
            maxInventoryUsd: maxInv,
            maxSkewBps: maxSkew,
            minQuoteWidthBps: minWidth,
            maxHedgeLeverage: 100,
            hedgeRatioMinBps: 4000,
            hedgeRatioMaxBps: 12_000,
            noNewRiskOffHours: true,
            killAtDrawdownBps: -800,
            hedgeAllowRoot: bytes32(0)
        });
    }

    function _register(address k, uint128 tier) internal {
        vm.prank(sponsor);
        mandate.registerKey(k, sponsor, uint64(block.timestamp + 30 days), tier);
    }

    function _quote(address k, uint16 spread, int16 skew, uint128 maxNet) internal {
        IBookrunnerDesk.Action memory a;
        a.kind = IBookrunnerDesk.ActionKind.SetQuote;
        a.data = abi.encode(spread, skew, maxNet);
        vm.prank(k);
        desk.execute(a);
    }

    // ------------------------------------------------------------------ engine-reduce-only-sticky / irreversible

    function test_regression_killThenRemandateReopensEngineOnFreshQuote() public {
        _trade(alice, mid, 10e18);
        vm.prank(risk);
        mandate.kill("BREACH");
        assertTrue(engine.state(mid).reduceOnly);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.MarketReduceOnly.selector, mid));
        engine.trade(mid, 1e18, type(uint256).max);

        vm.prank(committee);
        mandate.remandate(_terms(MAX_INV, 10, 25));
        assertFalse(mandate.killed());
        // still no new risk until a freshly registered key quotes under the new terms
        assertTrue(engine.state(mid).reduceOnly);
        _register(key2, MAX_INV);
        _quote(key2, 10, 0, MAX_INV);
        assertFalse(engine.state(mid).reduceOnly, "REMANDATE + fresh quote must re-open the market");
        _trade(alice, mid, 10e18);
        assertEq(engine.positionOf(mid, alice).size, 20e18);
    }

    /// @dev Kill is not weakened: the RISK kill sequence sets reduce-only (step 2) before mandate.kill (step 4);
    ///      a quote landing in between never re-opens the market, and the kill then revokes the key.
    function test_killNotWeakened_riskReduceOnlyNeverLiftedByQuote() public {
        vm.prank(committee);
        mandate.remandate(_terms(MAX_INV, 10, 25));
        _register(key2, MAX_INV);
        vm.prank(risk);
        adapter.setReduceOnly(true);
        _quote(key2, 10, 0, MAX_INV);
        assertTrue(engine.state(mid).reduceOnly);
        vm.prank(risk);
        mandate.kill("BREACH");
        IBookrunnerDesk.Action memory a;
        a.kind = IBookrunnerDesk.ActionKind.SetQuote;
        a.data = abi.encode(uint16(10), int16(0), MAX_INV);
        vm.prank(key2);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotAuthorized.selector, key2));
        desk.execute(a);
        assertTrue(engine.state(mid).reduceOnly);
    }

    // ------------------------------------------------------------------ remandate-stale-engine-quote

    function test_regression_remandateClampsLiveEngineQuote() public {
        _quote(key, 12, 20, MAX_INV);
        // tightening re-mandate without a kill: maxInventory 30k, width >= 15, |skew| <= 10
        vm.prank(committee);
        mandate.remandate(_terms(30_000e6, 15, 10));
        IPoolEngine.MarketState memory s = engine.state(mid);
        assertLe(engine.config(mid).maxNetExposureUsd, 30_000e6, "cap within the new maxInventoryUsd");
        assertGe(s.spreadBps, 15, "spread within the new min width");
        assertLe(s.skewBps, 10, "skew within the new max skew");
        assertGe(s.skewBps, -10, "skew within the new max skew");
        // until a fresh key quotes, no trader can add risk at the old terms (keys were revoked)
        vm.prank(alice);
        vm.expectPartialRevert(PoolEngine.MarketReduceOnly.selector);
        engine.trade(mid, 400e18, type(uint256).max);
        _register(key2, 30_000e6);
        _quote(key2, 15, 0, 30_000e6);
        _trade(alice, mid, 250e18); // 25k
        vm.prank(alice);
        vm.expectPartialRevert(PoolEngine.ExposureCap.selector);
        engine.trade(mid, 60e18, type(uint256).max); // 31k > 30k
        assertLe(_abs(engine.netExposureUsd(mid)), 30_000e6);
    }

    // ------------------------------------------------------------------ wind-down end to end

    function test_retireKill_schedulesCloseOut_thenFlatAndRecallable() public {
        _trade(alice, mid, 10e18);
        book.setState(BRTypes.BookState.Retiring);
        vm.prank(address(book));
        mandate.kill("RETIRE"); // Book.retire -> _killMandate
        assertTrue(engine.state(mid).reduceOnly);
        vm.warp(block.timestamp + 2 * cfg.markInterval());
        _price(PID_A, 99e18);
        (bool ok,) = address(engine).call(abi.encodeWithSignature("forceClose(uint256,address)", mid, alice));
        assertTrue(ok);
        vault.recall(BRTypes.ACCOUNT_MM, uint256(adapter.marginEquityUsd()));
        vault.recall(BRTypes.ACCOUNT_IF, adapter.insuranceEquityUsd());
        assertEq(adapter.deployedValueUsd(), 0);
        // a re-mandate during the wind-down never re-opens the market
        vm.prank(committee);
        mandate.remandate(_terms(MAX_INV, 10, 25));
        _register(key2, MAX_INV);
        _quote(key2, 10, 0, MAX_INV);
        assertTrue(engine.state(mid).reduceOnly);
    }
}
