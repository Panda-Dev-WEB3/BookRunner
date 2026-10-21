// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {Book} from "../../../src/Book.sol";
import {Tranche} from "../../../src/Tranche.sol";
import {UnderwritingVault} from "../../../src/UnderwritingVault.sol";
import {RevenueRouter} from "../../../src/RevenueRouter.sol";
import {InsurancePool} from "../../../src/InsurancePool.sol";
import {BookFixture} from "../../book/utils/BookFixture.sol";
import {MockMandate} from "../../book/utils/BookMocks.sol";
import {CoreMockFactory} from "../../core/utils/CoreMocks.sol";
import {MockPoolAdapter, MockCarrySink} from "./PoolMocks.sol";

/// @notice One book on the real Book / Tranche / UnderwritingVault / RevenueRouter with the real InsurancePool (proxy)
///         and a two-account venue mock (MockPoolAdapter). The pool is seeded: depositor 1,000,000 + first-loss
///         slice 100,000. Siblings (registry, backstop, charter, mandate) are the book-cluster mocks.
abstract contract PoolBookFixture is BookFixture {
    CoreMockFactory internal factory;
    InsurancePool internal pool;
    MockPoolAdapter internal venue;
    RevenueRouter internal rrouter;
    MockCarrySink internal carrySink;
    address internal expenseSink = makeAddr("expenseSink");
    address internal poolDepositor = makeAddr("poolDepositor");
    address internal treasury = makeAddr("treasury");

    uint256 internal constant POOL_DEPOSIT = 1_000_000e6;
    uint256 internal constant POOL_FIRST_LOSS = 100_000e6;

    function _poolCharter() internal view returns (BRTypes.Charter memory c) {
        c = _defaultCharter();
        c.ifFromPool = true;
    }

    function _deployPoolInfra() internal {
        _deployInfra();
        factory = new CoreMockFactory();
        cfg.setFactory(address(factory));
        carrySink = new MockCarrySink();
        cfg.setFeeRouter(address(carrySink));
        cfg.setExpenseRecipient(expenseSink);
        InsurancePool impl = new InsurancePool();
        pool = InsurancePool(
            address(new ERC1967Proxy(address(impl), abi.encodeCall(InsurancePool.initialize, (address(cfg)))))
        );
        cfg.setInsurancePool(address(pool));
        _seedPool(POOL_DEPOSIT, POOL_FIRST_LOSS);
    }

    function _seedPool(uint256 deposit, uint256 firstLoss) internal {
        if (deposit > 0) {
            usdc.mint(poolDepositor, deposit);
            vm.startPrank(poolDepositor);
            usdc.approve(address(pool), deposit);
            pool.deposit(deposit, poolDepositor);
            vm.stopPrank();
        }
        if (firstLoss > 0) {
            usdc.mint(treasury, firstLoss);
            vm.startPrank(treasury);
            usdc.approve(address(pool), firstLoss);
            pool.depositFirstLoss(firstLoss);
            vm.stopPrank();
        }
    }

    /// @dev BookFixture._deployBook with a real RevenueRouter and the two-account venue; registered in the factory.
    function _deployPoolBook(BRTypes.Charter memory c) internal {
        senior = Tranche(Clones.clone(address(trancheImpl)));
        junior = Tranche(Clones.clone(address(trancheImpl)));
        vault = UnderwritingVault(Clones.clone(address(vaultImpl)));
        rrouter = RevenueRouter(Clones.clone(address(new RevenueRouter())));
        mandate = new MockMandate(address(0));
        venue = new MockPoolAdapter(usdc);
        BRTypes.BookComponents memory comps = BRTypes.BookComponents({
            book: address(0),
            senior: address(senior),
            junior: address(junior),
            vault: address(vault),
            mandate: address(mandate),
            router: address(rrouter),
            desk: desk,
            adapter: address(venue)
        });
        bytes memory init = abi.encodeCall(Book.initialize, (address(cfg), BOOK_ID, c, comps));
        book = Book(address(new ERC1967Proxy(address(bookImpl), init)));
        comps.book = address(book);
        mandate.setBook(address(book));
        senior.initialize(address(cfg), BOOK_ID, address(book), BRTypes.SENIOR);
        junior.initialize(address(cfg), BOOK_ID, address(book), BRTypes.JUNIOR);
        vault.initialize(address(cfg), BOOK_ID, address(book));
        rrouter.initialize(address(cfg), BOOK_ID, address(book));
        venue.initialize(address(cfg), BOOK_ID, address(book));
        venue.setVault(address(vault));
        registry.setBook(BOOK_ID, address(book));
        backstop.setVault(address(vault));
        charterC.setBook(BOOK_ID, address(book));
        factory.register(BOOK_ID, comps);
    }

    function _setUpPoolBook() internal {
        _deployPoolInfra();
        _deployPoolBook(_poolCharter());
    }

    /// @dev Window S 70k (alice 40k, bob 30k), J 30k (sponsor 10k, carol 20k): a pool-funded book raises 75k (the
    ///      MM inventory) -> S 52.5k, J 22.5k; the pool funds the 25k IF.
    function _goLivePool() internal {
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        senior.claimAllocation(alice);
        senior.claimAllocation(bob);
        junior.claimAllocation(sponsor);
        junior.claimAllocation(carol);
    }

    /// @dev Warps to the next period boundary and commits a mark valued at the venue's current IF + MM.
    function _poolMark() internal returns (uint256 id) {
        vm.warp(((block.timestamp / INTERVAL) + 1) * INTERVAL);
        id = _commitMark(_nextPeriodEnd(), venue.deployedValueUsd(), book.flowNonce());
    }

    function _applyPoolMark() internal returns (uint256 id) {
        id = _poolMark();
        book.applyMark(id);
    }

    function _distribute(uint256 gross, uint256 expenses) internal returns (uint64 period) {
        usdc.mint(address(rrouter), gross);
        rrouter.notifySettlement(BRTypes.SRC_ENGINE_FEES, gross);
        period = uint64(block.timestamp);
        vm.prank(keeper);
        rrouter.distribute(period, expenses);
    }

    function _claim() internal view returns (uint256 claim, bool due) {
        (,, claim, due) = book.insuranceClaim();
    }
}
