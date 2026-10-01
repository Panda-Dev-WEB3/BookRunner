// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IBookFactory} from "../../src/interfaces/IBookFactory.sol";
import {BookFactory} from "../../src/BookFactory.sol";

import {GovBase} from "./utils/GovBase.sol";
import {
    GovMockStaking,
    GovMockBook,
    GovMockTranche,
    GovMockVault,
    GovMockRouter,
    GovMockDesk,
    GovMockMandate,
    GovMockAdapter,
    GovMockComponentBase,
    GovRevertingComponent
} from "./utils/GovMocks.sol";

contract BookFactoryTest is GovBase {
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    // ------------------------------------------------------------------------------------------
    // constructor / implementations
    // ------------------------------------------------------------------------------------------

    function test_constructor_zeroConfigReverts() public {
        vm.expectRevert(BookFactory.ZeroAddress.selector);
        new BookFactory(address(0));
    }

    function test_implementations_setForEveryKind() public view {
        assertEq(factory.implementation(factory.BOOK()), address(bookImpl));
        assertEq(factory.implementation(factory.TRANCHE()), address(trancheImpl));
        assertEq(factory.implementation(factory.VAULT()), address(vaultImpl));
        assertEq(factory.implementation(factory.MANDATE()), address(mandateImpl));
        assertEq(factory.implementation(factory.ROUTER()), address(routerImpl));
        assertEq(factory.implementation(factory.DESK()), address(deskImpl));
        assertEq(factory.implementation(factory.ORDERLY_ADAPTER()), address(orderlyImpl));
        assertEq(factory.implementation(factory.ENGINE_ADAPTER()), address(engineImpl));
    }

    function test_setImplementation_onlyTimelock() public {
        bytes32 kind = factory.BOOK();
        vm.prank(outsider);
        vm.expectRevert(BookFactory.NotTimelock.selector);
        factory.setImplementation(kind, address(bookImpl));

        bytes32[] memory kinds = new bytes32[](1);
        address[] memory impls = new address[](1);
        kinds[0] = kind;
        impls[0] = address(bookImpl);
        vm.prank(address(charter));
        vm.expectRevert(BookFactory.NotTimelock.selector);
        factory.setImplementations(kinds, impls);
    }

    function test_setImplementation_validation() public {
        vm.startPrank(timelock);
        vm.expectRevert(abi.encodeWithSelector(BookFactory.UnknownKind.selector, bytes32("ORACLE")));
        factory.setImplementation("ORACLE", address(bookImpl));
        vm.expectRevert(abi.encodeWithSelector(BookFactory.NotAContract.selector, outsider));
        factory.setImplementation("BOOK", outsider);
        vm.expectRevert(abi.encodeWithSelector(BookFactory.NotAContract.selector, address(0)));
        factory.setImplementation("BOOK", address(0));

        bytes32[] memory kinds = new bytes32[](2);
        address[] memory impls = new address[](1);
        vm.expectRevert(BookFactory.LengthMismatch.selector);
        factory.setImplementations(kinds, impls);
        vm.stopPrank();
    }

    function test_setImplementation_emits() public {
        GovMockBook impl2 = new GovMockBook();
        vm.expectEmit(true, false, false, true, address(factory));
        emit IBookFactory.ImplementationSet("BOOK", address(impl2));
        vm.prank(timelock);
        factory.setImplementation("BOOK", address(impl2));
        assertEq(factory.implementation("BOOK"), address(impl2));
    }

    function test_implementationsAreLocked() public {
        BRTypes.Charter memory c = _charter();
        BRTypes.BookComponents memory none;
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        bookImpl.initialize(address(cfg), 1, c, none);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        trancheImpl.initialize(address(cfg), 1, address(1), 0);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vaultImpl.initialize(address(cfg), 1, address(1));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        mandateImpl.initialize(address(cfg), 1, address(1));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        routerImpl.initialize(address(cfg), 1, address(1));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        deskImpl.initialize(address(cfg), 1, address(1));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        orderlyImpl.initialize(address(cfg), 1, address(1));
    }

    // ------------------------------------------------------------------------------------------
    // create — access / guards
    // ------------------------------------------------------------------------------------------

    function test_create_onlyCharter() public {
        BRTypes.Charter memory c = _charter();
        vm.prank(outsider);
        vm.expectRevert(BookFactory.NotCharter.selector);
        factory.create(1, c);
        vm.prank(address(committee));
        vm.expectRevert(BookFactory.NotCharter.selector);
        factory.create(1, c);
    }

    function test_create_pausedNewBooksReverts() public {
        cfg.setNewBooksPaused(true);
        BRTypes.Charter memory c = _charter();
        vm.prank(address(charter));
        vm.expectRevert(BookFactory.NewBooksPaused.selector);
        factory.create(1, c);
    }

    function test_create_zeroIdReverts() public {
        BRTypes.Charter memory c = _charter();
        vm.prank(address(charter));
        vm.expectRevert(BookFactory.BadBookId.selector);
        factory.create(0, c);
    }

    function test_create_duplicateIdReverts() public {
        BRTypes.Charter memory c = _charter();
        vm.prank(address(charter));
        factory.create(5, c);
        vm.prank(address(charter));
        vm.expectRevert(abi.encodeWithSelector(BookFactory.BookExists.selector, 5));
        factory.create(5, c);
    }

    function test_create_badVenueReverts() public {
        BRTypes.Charter memory c = _charter();
        c.venue = 7;
        vm.prank(address(charter));
        vm.expectRevert(abi.encodeWithSelector(BookFactory.BadVenue.selector, uint8(7)));
        factory.create(1, c);
        vm.expectRevert(abi.encodeWithSelector(BookFactory.BadVenue.selector, uint8(7)));
        factory.predictComponents(1, 7);
    }

    function test_create_unsetImplementationReverts() public {
        BookFactory fresh = new BookFactory(address(cfg));
        BRTypes.Charter memory c = _engineCharter();
        vm.prank(address(charter));
        vm.expectRevert(abi.encodeWithSelector(BookFactory.ImplementationNotSet.selector, bytes32("BOOK")));
        fresh.create(1, c);

        vm.startPrank(timelock);
        fresh.setImplementation("BOOK", address(bookImpl));
        fresh.setImplementation("TRANCHE", address(trancheImpl));
        fresh.setImplementation("VAULT", address(vaultImpl));
        fresh.setImplementation("MANDATE", address(mandateImpl));
        fresh.setImplementation("ROUTER", address(routerImpl));
        fresh.setImplementation("DESK", address(deskImpl));
        fresh.setImplementation("ORDERLY_ADAPTER", address(orderlyImpl));
        vm.stopPrank();
        vm.prank(address(charter));
        vm.expectRevert(
            abi.encodeWithSelector(BookFactory.ImplementationNotSet.selector, bytes32("ENGINE_ADAPTER"))
        );
        fresh.create(1, c);
    }

    function test_create_requiresLockerAdminRights() public {
        // a factory that is not config.factory() cannot register mandate lockers -> whole create reverts
        BookFactory rogue = new BookFactory(address(cfg));
        (bytes32[] memory kinds, address[] memory impls) = _allImpls();
        vm.prank(timelock);
        rogue.setImplementations(kinds, impls);
        BRTypes.Charter memory c = _charter();
        vm.prank(address(charter));
        vm.expectRevert(GovMockStaking.NotAdmin.selector);
        rogue.create(1, c);
        assertEq(rogue.bookCount(), 0);
    }

    function test_create_atomicWhenAComponentInitializerReverts() public {
        GovRevertingComponent bad = new GovRevertingComponent();
        vm.prank(timelock);
        factory.setImplementation("VAULT", address(bad));

        _bondAll();
        uint256 id = _file();
        _postJury(id, true);
        _vote(m1, id, true);
        vm.prank(m2);
        vm.expectRevert(GovRevertingComponent.Boom.selector);
        committee.vote(id, true);

        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Filed));
        assertEq(factory.bookCount(), 0);
        assertEq(factory.bookOf(id), address(0));
        assertEq(usdc.balanceOf(address(charter)), FEE, "fee still escrowed");

        vm.prank(timelock);
        factory.setImplementation("VAULT", address(vaultImpl));
        _vote(m2, id, true);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Approved));
    }

    // ------------------------------------------------------------------------------------------
    // create — wiring
    // ------------------------------------------------------------------------------------------

    function test_create_wiresAndInitializesEveryComponent_orderly() public {
        _bondAll();
        BRTypes.Charter memory c = _charter();
        BRTypes.BookComponents memory predicted = factory.predictComponents(1, BRTypes.VENUE_ORDERLY);

        uint256 id = _file(c);
        assertEq(id, 1);
        _postJury(id, true);
        _vote(m1, id, true);
        vm.expectEmit(true, true, false, true, address(factory));
        emit IBookFactory.BookCreated(1, predicted.book, predicted);
        _vote(m2, id, true);

        BRTypes.BookComponents memory comps = factory.componentsOf(id);
        assertEq(keccak256(abi.encode(comps)), keccak256(abi.encode(predicted)), "predicted addresses");
        _assertWired(id, c, comps, address(orderlyImpl));
    }

    function test_create_engineVenueUsesEngineAdapter() public {
        _bondAll();
        BRTypes.Charter memory c = _engineCharter();
        uint256 id = _fileAndApprove(c);
        BRTypes.BookComponents memory comps = factory.componentsOf(id);
        _assertWired(id, c, comps, address(engineImpl));
        assertEq(GovMockAdapter(comps.adapter).venueKind(), BRTypes.VENUE_POOL_ENGINE);
        assertEq(GovMockAdapter(comps.adapter).symbol(), bytes32("RHX5-PERP"));
    }

    function test_create_multipleBooksEnumerable() public {
        _bondAll();
        uint256 a = _fileAndApprove(_charter());
        uint256 b = _fileAndApprove(_engineCharter());
        uint256[] memory ids = factory.bookIds();
        assertEq(ids.length, 2);
        assertEq(ids[0], a);
        assertEq(ids[1], b);
        assertEq(factory.bookCount(), 2);
        assertEq(factory.bookIdAt(1), b);
        assertTrue(factory.bookOf(a) != factory.bookOf(b));
        assertTrue(factory.componentsOf(a).mandate != factory.componentsOf(b).mandate);
        assertEq(factory.bookIdOf(factory.bookOf(b)), b);
    }

    function test_views_unknownAddresses() public view {
        assertFalse(factory.isBook(outsider));
        assertFalse(factory.isComponent(outsider));
        assertEq(factory.bookIdOf(outsider), 0);
        assertEq(factory.componentBookId(outsider), 0);
        assertEq(factory.bookOf(1), address(0));
        assertEq(factory.bookIds().length, 0);
    }

    function test_implementationChangeAffectsOnlyFutureBooks() public {
        _bondAll();
        uint256 a = _fileAndApprove(_charter());
        GovMockBook impl2 = new GovMockBook();
        vm.prank(timelock);
        factory.setImplementation("BOOK", address(impl2));
        uint256 b = _fileAndApprove(_charter());
        assertEq(address(uint160(uint256(vm.load(factory.bookOf(a), IMPL_SLOT)))), address(bookImpl));
        assertEq(address(uint160(uint256(vm.load(factory.bookOf(b), IMPL_SLOT)))), address(impl2));
    }

    // ------------------------------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------------------------------

    function _allImpls() internal view returns (bytes32[] memory kinds, address[] memory impls) {
        kinds = new bytes32[](8);
        impls = new address[](8);
        kinds[0] = "BOOK";
        impls[0] = address(bookImpl);
        kinds[1] = "TRANCHE";
        impls[1] = address(trancheImpl);
        kinds[2] = "VAULT";
        impls[2] = address(vaultImpl);
        kinds[3] = "MANDATE";
        impls[3] = address(mandateImpl);
        kinds[4] = "ROUTER";
        impls[4] = address(routerImpl);
        kinds[5] = "DESK";
        impls[5] = address(deskImpl);
        kinds[6] = "ORDERLY_ADAPTER";
        impls[6] = address(orderlyImpl);
        kinds[7] = "ENGINE_ADAPTER";
        impls[7] = address(engineImpl);
    }

    function _cloneCode(address impl) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"363d3d373d3d3d363d73", impl, hex"5af43d82803e903d91602b57fd5bf3");
    }

    function _assertWired(
        uint256 id,
        BRTypes.Charter memory c,
        BRTypes.BookComponents memory comps,
        address adapterImpl
    ) internal {
        address[8] memory all = [
            comps.book,
            comps.senior,
            comps.junior,
            comps.vault,
            comps.mandate,
            comps.router,
            comps.desk,
            comps.adapter
        ];
        for (uint256 i; i < 8; ++i) {
            assertTrue(all[i] != address(0), "component deployed");
            assertTrue(all[i].code.length > 0, "component has code");
            assertTrue(factory.isComponent(all[i]), "isComponent");
            assertEq(factory.componentBookId(all[i]), id);
            for (uint256 j; j < i; ++j) {
                assertTrue(all[i] != all[j], "distinct components");
            }
        }

        // registry views
        assertEq(factory.bookOf(id), comps.book);
        assertTrue(factory.isBook(comps.book));
        assertFalse(factory.isBook(comps.vault));
        assertEq(factory.bookIdOf(comps.book), id);
        assertEq(charter.get(id).book, comps.book);

        // proxies -> UUPS impls; clones -> EIP-1167 to their impls
        assertEq(address(uint160(uint256(vm.load(comps.book, IMPL_SLOT)))), address(bookImpl));
        assertEq(address(uint160(uint256(vm.load(comps.adapter, IMPL_SLOT)))), adapterImpl);
        assertEq(comps.senior.code, _cloneCode(address(trancheImpl)));
        assertEq(comps.junior.code, _cloneCode(address(trancheImpl)));
        assertEq(comps.vault.code, _cloneCode(address(vaultImpl)));
        assertEq(comps.mandate.code, _cloneCode(address(mandateImpl)));
        assertEq(comps.router.code, _cloneCode(address(routerImpl)));
        assertEq(comps.desk.code, _cloneCode(address(deskImpl)));

        // book initialized first, once, with the charter + components
        GovMockBook book = GovMockBook(comps.book);
        assertEq(book.initCount(), 1);
        assertEq(book.config(), address(cfg));
        assertEq(book.bookId(), id);
        assertEq(keccak256(abi.encode(book.getCharter())), keccak256(abi.encode(c)));
        assertEq(keccak256(abi.encode(book.components())), keccak256(abi.encode(comps)));

        // components initialized once, in order: senior, junior, vault, mandate, router, desk, adapter
        address[7] memory ordered =
            [comps.senior, comps.junior, comps.vault, comps.mandate, comps.router, comps.desk, comps.adapter];
        for (uint256 i; i < 7; ++i) {
            GovMockComponentBase comp = GovMockComponentBase(ordered[i]);
            assertEq(comp.initCount(), 1, "initialized once");
            assertEq(comp.initSeq(), i + 2, "init order");
            assertEq(comp.config(), address(cfg));
            assertEq(comp.bookId(), id);
            assertEq(comp.book(), comps.book);
        }
        assertEq(book.initSeq(), 8, "adapter was last");
        assertEq(GovMockTranche(comps.senior).kind(), BRTypes.SENIOR);
        assertEq(GovMockTranche(comps.junior).kind(), BRTypes.JUNIOR);
        assertEq(
            keccak256(abi.encode(GovMockMandate(comps.mandate).getMandate())),
            keccak256(abi.encode(c.mandate))
        );

        // mandate registered as a staking locker
        assertTrue(staking.isLocker(comps.mandate));
        assertFalse(staking.isLocker(comps.desk));

        // nothing can be re-initialized
        BRTypes.BookComponents memory none;
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        book.initialize(address(cfg), id, c, none);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        GovMockTranche(comps.senior).initialize(address(cfg), id, comps.book, BRTypes.JUNIOR);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        GovMockTranche(comps.junior).initialize(address(cfg), id, comps.book, BRTypes.SENIOR);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        GovMockVault(comps.vault).initialize(address(cfg), id, outsider);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        GovMockMandate(comps.mandate).initialize(address(cfg), id, outsider);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        GovMockRouter(comps.router).initialize(address(cfg), id, outsider);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        GovMockDesk(comps.desk).initialize(address(cfg), id, outsider);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        GovMockAdapter(comps.adapter).initialize(address(cfg), id, outsider);
    }
}
