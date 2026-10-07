// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {EngineBase} from "./utils/EngineBase.sol";
import {
    EngineMockBook,
    EngineMockRegistry,
    EngineMockRevenueRouter,
    EngineMockVault,
    EngineMockFactory,
    EngineLazyProxy
} from "./utils/EngineMocks.sol";
import {EngineIntegrationConfig} from "./EngineMandateIntegration.t.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {AttestedOracle} from "../../src/AttestedOracle.sol";
import {PoolEngine} from "../../src/PoolEngine.sol";
import {PoolEngineAdapter} from "../../src/PoolEngineAdapter.sol";
import {MMMandate} from "../../src/MMMandate.sol";
import {BookrunnerDesk} from "../../src/BookrunnerDesk.sol";
import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IBookrunnerDesk} from "../../src/interfaces/IBookrunnerDesk.sol";
import {IMMMandate} from "../../src/interfaces/IMMMandate.sol";

/// @notice LOW_GAS.md §1 end to end on the real in-house stack (MMMandate, BookrunnerDesk, PoolEngineAdapter,
///         PoolEngine, AttestedOracle) with no oracle pushes at all after setUp: every transaction that needs a
///         price carries it (desk executeWithPrices, engine trade / liquidate overloads), and the stored-price
///         readers (vault recall -> withdrawLiquidity) work after a separate permissionless oracle.update.
contract EnginePullIntegrationTest is EngineBase {
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

    address internal sponsor = makeAddr("sponsor");
    address internal key = makeAddr("key");
    address internal alice = makeAddr("alice");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.warp(T0);
        icfg = new EngineIntegrationConfig(timelock);
        cfg = icfg;
        usdc = new MockERC20("USD Coin", "USDC", 6);
        cfg.setUsdc(address(usdc));
        signer = vm.addr(SIGNER_PK);
        oracle = new AttestedOracle(address(cfg), signer, bytes32(0));
        cfg.setOracle(address(oracle));
        factory = new EngineMockFactory();
        cfg.setFactory(address(factory));
        engine = new PoolEngine(address(cfg));
        cfg.setPoolEngine(address(engine));
        registry = new EngineMockRegistry();
        registry.setPriceId(UNDERLYING, PID_A);
        cfg.setStockRegistry(address(registry));
        icfg.setCommittee(makeAddr("committee"));

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
        c.mandate = BRTypes.Mandate({
            maxInventoryUsd: MAX_INV,
            maxSkewBps: 25,
            minQuoteWidthBps: 10,
            maxHedgeLeverage: 100,
            hedgeRatioMinBps: 4000,
            hedgeRatioMaxBps: 12_000,
            noNewRiskOffHours: true,
            killAtDrawdownBps: -800,
            hedgeAllowRoot: bytes32(0)
        });
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
        // the only price ever stored before the tests: no heartbeat pushes from here on
        oracle.update(_priceData(PID_A, PX, uint64(block.timestamp), false));
        usdc.mint(address(vault), 125_000e6);
        vault.deployToVenue(BRTypes.ACCOUNT_IF, 25_000e6);
        vault.deployToVenue(BRTypes.ACCOUNT_MM, 100_000e6);
        vm.prank(sponsor);
        mandate.registerKey(key, sponsor, uint64(block.timestamp + 30 days), MAX_INV);
        _deposit(alice, mid, 20_000e6);
    }

    function _quote(uint16 spread, uint128 maxNet) internal pure returns (IBookrunnerDesk.Action memory a) {
        a.kind = IBookrunnerDesk.ActionKind.SetQuote;
        a.data = abi.encode(spread, int16(0), maxNet);
    }

    function _fresh() internal view returns (bytes memory) {
        return _priceData(PID_A, PX, uint64(block.timestamp), false);
    }

    /// @dev A day with no pushes: the agent re-quotes carrying a price, a trader opens carrying one, a
    ///      liquidator closes carrying the crash print — every rule evaluated on the in-tx price.
    function test_pullMode_quoteTradeLiquidate() public {
        vm.prank(key);
        desk.execute(_quote(20, MAX_INV));
        vm.warp(block.timestamp + 1 days);
        assertTrue(mandate.offHours(), "stored price is a day old");
        vm.prank(key);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        desk.execute(_quote(12, MAX_INV)); // tightening = new risk while the stored price is stale

        bytes memory pd = _fresh();
        vm.prank(key);
        desk.executeWithPrices(_quote(12, MAX_INV), pd);
        assertEq(engine.state(mid).spreadBps, 12);
        assertFalse(engine.state(mid).reduceOnly);

        vm.warp(block.timestamp + 20); // the agent's price is now 20 s old
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, uint64(block.timestamp - 20)));
        engine.trade(mid, 100e18, type(uint256).max);
        pd = _fresh();
        vm.prank(alice);
        engine.trade(mid, 500e18, type(uint256).max, pd); // 50k notional on 20k margin
        assertEq(engine.positionOf(mid, alice).size, 500e18);

        vm.warp(block.timestamp + 1 hours);
        assertFalse(engine.isLiquidatable(mid, alice)); // at the (old) stored price
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotLiquidatable.selector, alice));
        engine.liquidate(mid, alice);
        pd = _priceData(PID_A, 62e18, uint64(block.timestamp), false);
        vm.prank(keeper);
        engine.liquidate(mid, alice, pd);
        assertEq(engine.positionOf(mid, alice).size, 0);
    }

    /// @dev Off-hours via a carried held price: the desk may only widen and the engine refuses every trade,
    ///      closes included (audit A2-03: a held print is a free option); the trader closes at the reopen.
    function test_pullMode_heldBundle() public {
        bytes memory pd = _fresh();
        vm.prank(key);
        desk.executeWithPrices(_quote(12, MAX_INV), pd);
        vm.prank(alice);
        engine.trade(mid, 10e18, type(uint256).max, "");
        vm.warp(block.timestamp + 1 hours);
        bytes memory held = _priceData(PID_A, 99e18, uint64(block.timestamp), true);
        vm.prank(key);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        desk.executeWithPrices(_quote(10, MAX_INV), held);
        vm.prank(key);
        desk.executeWithPrices(_quote(20, MAX_INV), held);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mid));
        engine.trade(mid, 1e18, type(uint256).max, held);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mid));
        engine.trade(mid, -10e18, 0, held);
        vm.warp(block.timestamp + 1 hours);
        pd = _fresh();
        vm.prank(alice);
        engine.trade(mid, -10e18, 0, pd);
        assertEq(engine.positionOf(mid, alice).size, 0);
    }

    /// @dev Vault recall with open interest needs a non-stale stored price (withdrawLiquidity keeps its
    ///      signature): a permissionless oracle.update beforehand is enough.
    function test_pullMode_recallAfterSeparateUpdate() public {
        bytes memory pd = _fresh();
        vm.prank(key);
        desk.executeWithPrices(_quote(12, MAX_INV), pd);
        vm.prank(alice);
        engine.trade(mid, 10e18, type(uint256).max, "");
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, uint64(T0)));
        vault.recall(BRTypes.ACCOUNT_MM, 1000e6);
        pd = _fresh();
        vm.prank(stranger);
        oracle.update(pd);
        vault.recall(BRTypes.ACCOUNT_MM, 1000e6);
        assertEq(usdc.balanceOf(address(vault)), 1000e6);
    }
}
