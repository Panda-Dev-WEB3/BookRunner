// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {IBook} from "../../../src/interfaces/IBook.sol";
import {IBookFactory} from "../../../src/interfaces/IBookFactory.sol";
import {ITranche} from "../../../src/interfaces/ITranche.sol";
import {IUnderwritingVault} from "../../../src/interfaces/IUnderwritingVault.sol";
import {IVenueAdapter} from "../../../src/interfaces/IVenueAdapter.sol";
import {IBookrunnerDesk} from "../../../src/interfaces/IBookrunnerDesk.sol";
import {BookrunnerConfig} from "../../../src/BookrunnerConfig.sol";
import {MarkRegistry} from "../../../src/MarkRegistry.sol";
import {BookProxy} from "../../../src/BookFactory.sol";
import {Book} from "../../../src/Book.sol";
import {Tranche} from "../../../src/Tranche.sol";
import {UnderwritingVault} from "../../../src/UnderwritingVault.sol";
import {OrderlyAdapter} from "../../../src/OrderlyAdapter.sol";
import {MMMandate} from "../../../src/MMMandate.sol";
import {BookrunnerDesk} from "../../../src/BookrunnerDesk.sol";
import {MockOrderlyVault} from "../../../src/mocks/MockOrderlyVault.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {MockBackstop, MockCharter} from "../../book/utils/BookMocks.sol";
import {OrderlyMockRouter} from "../../orderly/utils/OrderlyTestMocks.sol";
import {LowGasMarkBase, LowGasOracleStub} from "../../integration/LowGasMark.t.sol";
import {MandateMockStaking} from "../../mandate/utils/MandateMocks.sol";

/// @dev LowGasFactory with the REAL MMMandate + BookrunnerDesk clones instead of a mock mandate / EOA desk.
contract Area3Factory is IBookFactory {
    struct Impls {
        address book;
        address tranche;
        address vault;
        address adapter;
        address mandate;
        address desk;
    }

    mapping(uint256 => BRTypes.BookComponents) internal _components;
    mapping(address => uint256) public bookIdOf;
    mapping(address => bool) public isComponent;
    uint256[] internal _ids;

    function deploy(address cfg, uint256 bookId, BRTypes.Charter calldata charter, Impls calldata impls, address router)
        external
        returns (BRTypes.BookComponents memory c)
    {
        c.book = address(new BookProxy(impls.book));
        c.senior = Clones.clone(impls.tranche);
        c.junior = Clones.clone(impls.tranche);
        c.vault = Clones.clone(impls.vault);
        c.mandate = Clones.clone(impls.mandate);
        c.router = router;
        c.desk = Clones.clone(impls.desk);
        c.adapter = address(new BookProxy(impls.adapter));

        _components[bookId] = c;
        bookIdOf[c.book] = bookId;
        _ids.push(bookId);
        address[8] memory all = [c.book, c.senior, c.junior, c.vault, c.mandate, c.router, c.desk, c.adapter];
        for (uint256 i; i < 8; i++) {
            isComponent[all[i]] = true;
        }

        IBook(c.book).initialize(cfg, bookId, charter, c);
        ITranche(c.senior).initialize(cfg, bookId, c.book, BRTypes.SENIOR);
        ITranche(c.junior).initialize(cfg, bookId, c.book, BRTypes.JUNIOR);
        IUnderwritingVault(c.vault).initialize(cfg, bookId, c.book);
        IVenueAdapter(c.adapter).initialize(cfg, bookId, c.book);
        MMMandate(c.mandate).initialize(cfg, bookId, c.book);
        BookrunnerDesk(payable(c.desk)).initialize(cfg, bookId, c.book);
    }

    function create(uint256, BRTypes.Charter calldata) external pure returns (BRTypes.BookComponents memory) {
        revert("Area3Factory: use deploy");
    }

    function componentsOf(uint256 bookId) external view returns (BRTypes.BookComponents memory) {
        return _components[bookId];
    }

    function bookOf(uint256 bookId) external view returns (address) {
        return _components[bookId].book;
    }

    function isBook(address b) external view returns (bool) {
        return bookIdOf[b] != 0;
    }

    function bookIds() external view returns (uint256[] memory) {
        return _ids;
    }
}

/// @notice AREA 3 — a desk key can void every mark at ~zero cost. `ReturnToVault` has no mandate check and no
///         minimum; 1 wei of USDC returned by an active key calls `vault.notifyDeskReturn` -> `book.onCapitalFlow`
///         (flowNonce++), so the keeper's mark signed against the previous nonce reverts `FlowNonceMismatch`
///         (commitAndApply rolls back). Repeating it after every re-sign (or simply every block) keeps the book
///         unmarked: redemption buckets never settle, the drawdown kill check in applyMark never runs, and a
///         Retiring book can never `finalizeRetirement` (it requires lastMark.flowNonce == flowNonce; keys stay
///         active while Retiring). Also allowed off-hours and while Retiring. `InventoryToVault(1)` does the same
///         and additionally blocks venue reports (WithdrawalPending) until ops-venue cancels.
contract Area3KeyMarkGriefTest is LowGasMarkBase {
    Area3Factory internal f3;
    MMMandate internal mandateC;
    BookrunnerDesk internal deskC;
    address internal deskKey = makeAddr("compromisedDeskKey");

    function setUp() public override {
        vm.warp(1_760_000_123);
        markSigner = vm.addr(MARK_PK);
        opsSigner = vm.addr(OPS_PK);

        usdc = new MockERC20("USD Coin", "USDC", 6);
        config = new BookrunnerConfig(timelock);
        registry = new MarkRegistry(address(config));
        f3 = new Area3Factory();
        ov = new MockOrderlyVault(address(this), address(usdc), TOKEN_HASH, BROKER_HASH);
        ov.setStrictAccountIds(true); // real Orderly accountId check (VERIFY O6)
        ov.setOperator(orderlyOperator, true);
        oracle = new LowGasOracleStub(vm.addr(ORACLE_PK));
        backstop = new MockBackstop(IERC20(address(usdc)));
        charterC = new MockCharter();
        router = new OrderlyMockRouter(address(usdc));
        MandateMockStaking staking = new MandateMockStaking();

        vm.startPrank(timelock);
        config.setAddress("staking", address(staking));
        config.setAddress("usdc", address(usdc));
        config.setAddress("orderlyVault", address(ov));
        config.setAddress("factory", address(f3));
        config.setAddress("markRegistry", address(registry));
        config.setAddress("backstop", address(backstop));
        config.setAddress("oracle", address(oracle));
        config.setAddress("charter", address(charterC));
        config.setParam("markInterval", INTERVAL);
        config.grantRole(config.MARK_SIGNER_ROLE(), markSigner);
        config.grantRole(config.OPS_VENUE_ROLE(), opsSigner);
        config.grantRole(config.KEEPER_ROLE(), keeper);
        vm.stopPrank();

        BRTypes.BookComponents memory c = f3.deploy(
            address(config),
            BOOK_ID,
            _charter(),
            Area3Factory.Impls({
                book: address(new Book()),
                tranche: address(new Tranche()),
                vault: address(new UnderwritingVault()),
                adapter: address(new OrderlyAdapter(BROKER_HASH, TOKEN_HASH)),
                mandate: address(new MMMandate()),
                desk: address(new BookrunnerDesk())
            }),
            address(router)
        );
        book = Book(c.book);
        senior = Tranche(c.senior);
        junior = Tranche(c.junior);
        vault = UnderwritingVault(c.vault);
        adapter = OrderlyAdapter(payable(c.adapter));
        mandateC = MMMandate(c.mandate);
        deskC = BookrunnerDesk(payable(c.desk));
        desk = c.desk;
        backstop.setVault(c.vault);
        charterC.setBook(BOOK_ID, c.book);

        _deposit(senior, alice, 40_000e6);
        _deposit(senior, bob, 30_000e6);
        _deposit(junior, sponsor, 10_000e6);
        _deposit(junior, carol, 20_000e6);
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        closedAt = uint64(block.timestamp);
        senior.claimAllocation(alice);
        senior.claimAllocation(bob);
        junior.claimAllocation(sponsor);
        junior.claimAllocation(carol);
        p1 = uint64((block.timestamp / INTERVAL + 1) * INTERVAL);

        // sponsor registers an agent key (tier bond locked from the sponsor's stake)
        staking.setLocker(address(mandateC), true);
        staking.setAvailable(sponsor, 1_000_000e18);
        vm.prank(sponsor);
        mandateC.registerKey(deskKey, sponsor, uint64(block.timestamp + 30 days), 50_000e6);
        assertTrue(mandateC.isActiveKey(deskKey));
        assertEq(book.flowNonce(), 2);
    }

    function test_audit_keyDustReturnVoidsMark() public {
        vm.prank(alice);
        senior.requestRedeem(10_000e6, alice, alice); // settles at the period's mark
        _toMarkTime();
        (BRTypes.MarkInput memory m, bytes memory sig,,) = _keeperInputs(); // signed at flowNonce 2

        // the key returns 1 wei of USDC (any time, no mandate check, no minimum)
        usdc.mint(desk, 1);
        IBookrunnerDesk.Action memory a;
        a.kind = IBookrunnerDesk.ActionKind.ReturnToVault;
        a.data = abi.encode(uint256(1));
        vm.prank(deskKey);
        try deskC.execute(a) {} catch {}

        (bool ok,) = address(registry).call(abi.encodeCall(registry.commitAndApply, (m, sig, "", "")));
        // SECURE: a key's dust flow during the mark window must not void the period's mark
        assertTrue(ok, "1 wei ReturnToVault by the desk key voided the mark (FlowNonceMismatch)");
        assertEq(book.lastMarkPeriodEnd(), p1);
    }
}
