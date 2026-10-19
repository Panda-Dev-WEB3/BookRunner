// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {EngineBase} from "../../../engine/utils/EngineBase.sol";
import {
    EngineMockFactory,
    EngineMockBook,
    EngineMockRegistry,
    EngineMockRevenueRouter,
    EngineMockVault,
    EngineLazyProxy
} from "../../../engine/utils/EngineMocks.sol";
import {EngineIntegrationConfig} from "../../../engine/EngineMandateIntegration.t.sol";
import {MockERC20} from "../../../../src/mocks/MockERC20.sol";
import {AttestedOracle} from "../../../../src/AttestedOracle.sol";
import {PoolEngine} from "../../../../src/PoolEngine.sol";
import {PoolEngineAdapter} from "../../../../src/PoolEngineAdapter.sol";
import {MMMandate} from "../../../../src/MMMandate.sol";
import {BookrunnerDesk} from "../../../../src/BookrunnerDesk.sol";
import {BRTypes} from "../../../../src/interfaces/BRTypes.sol";
import {IBookrunnerDesk} from "../../../../src/interfaces/IBookrunnerDesk.sol";

/// @notice Audit M-3 fixture: the real in-house stack (MMMandate clone, BookrunnerDesk clone, PoolEngineAdapter
///         proxy, PoolEngine, AttestedOracle) on the devnet RHX5 terms the auditor used: min width 10 bps, max
///         skew 25 bps, maxInventory $75k, pool (MM) $100k, IF $30k, taker fee 6 bps, kill at -800 bps.
///         The charter's mandate is cached by MMMandate.initialize without validation, so a book filed before
///         the fix (10/25 is no longer a valid charter) is modelled exactly.
abstract contract M3Stack is EngineBase {
    uint256 internal constant BOOK_ID = 5;
    bytes32 internal constant UNDERLYING = bytes32("RHX5-INDEX");
    uint128 internal constant MAX_INV = 75_000e6;
    uint256 internal constant POOL = 100_000e6;
    uint256 internal constant IF_USD = 30_000e6;
    uint16 internal constant MIN_WIDTH = 10;
    int16 internal constant MAX_SKEW = 25;
    uint16 internal constant TAKER_FEE = 6;

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
    address internal key = makeAddr("deskKey");

    function _deployStack() internal {
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
        c.ifTargetUsd = uint128(IF_USD);
        c.mmInventoryUsd = uint128(POOL);
        c.mandate = _terms(MAX_INV, MIN_WIDTH, MAX_SKEW);
        c.sponsor = sponsor;
        c.symbol = bytes32("RHX5-PERP");
        c.takerFeeBps = TAKER_FEE;
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
        usdc.mint(address(vault), POOL + IF_USD);
        vault.deployToVenue(BRTypes.ACCOUNT_IF, IF_USD);
        vault.deployToVenue(BRTypes.ACCOUNT_MM, POOL);
        vm.prank(sponsor);
        mandate.registerKey(key, sponsor, uint64(block.timestamp + 365 days), MAX_INV);
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

    function _quoteAction(uint16 spread, int16 skew, uint128 maxNet)
        internal
        pure
        returns (IBookrunnerDesk.Action memory a)
    {
        a.kind = IBookrunnerDesk.ActionKind.SetQuote;
        a.data = abi.encode(spread, skew, maxNet);
    }

    /// @dev The desk key's SetQuote through desk.execute (mandate.checkQuote, then adapter -> engine).
    function _quote(uint16 spread, int16 skew, uint128 maxNet) internal {
        vm.prank(key);
        desk.execute(_quoteAction(spread, skew, maxNet));
    }

    /// @dev Same, returning false instead of reverting.
    function _tryQuote(uint16 spread, int16 skew, uint128 maxNet) internal returns (bool ok) {
        vm.prank(key);
        try desk.execute(_quoteAction(spread, skew, maxNet)) {
            ok = true;
        } catch {}
    }

    function _tryTrade(address trader, int256 size) internal returns (bool ok) {
        vm.prank(trader);
        try engine.trade(mid, size, size > 0 ? type(uint256).max : 0) {
            ok = true;
        } catch {}
    }
}
