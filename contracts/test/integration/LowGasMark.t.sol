// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IBook} from "../../src/interfaces/IBook.sol";
import {IBookFactory} from "../../src/interfaces/IBookFactory.sol";
import {ITranche} from "../../src/interfaces/ITranche.sol";
import {IUnderwritingVault} from "../../src/interfaces/IUnderwritingVault.sol";
import {IVenueAdapter} from "../../src/interfaces/IVenueAdapter.sol";
import {IAttestedOracle} from "../../src/interfaces/IAttestedOracle.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {MarkRegistry} from "../../src/MarkRegistry.sol";
import {BookProxy} from "../../src/BookFactory.sol";
import {Book} from "../../src/Book.sol";
import {Tranche} from "../../src/Tranche.sol";
import {UnderwritingVault} from "../../src/UnderwritingVault.sol";
import {OrderlyAdapter} from "../../src/OrderlyAdapter.sol";
import {MockOrderlyVault} from "../../src/mocks/MockOrderlyVault.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockMandate, MockBackstop, MockCharter} from "../book/utils/BookMocks.sol";
import {OrderlyMockRouter} from "../orderly/utils/OrderlyTestMocks.sol";

/// @notice Stand-in for BookFactory that wires one Orderly book exactly like `BookFactory.create` (BookProxy for
///         book + adapter, EIP-1167 clones for tranches + vault, same initialization order) with mock mandate /
///         router / desk, and serves the IBookFactory reads MarkRegistry and OrderlyAdapter perform.
contract LowGasFactory is IBookFactory {
    struct Impls {
        address book;
        address tranche;
        address vault;
        address adapter;
    }

    mapping(uint256 => BRTypes.BookComponents) internal _components;
    mapping(address => uint256) public bookIdOf;
    mapping(address => bool) public isComponent;
    uint256[] internal _ids;

    function deployOrderlyBook(
        address cfg,
        uint256 bookId,
        BRTypes.Charter calldata charter,
        Impls calldata impls,
        address router,
        address desk
    ) external returns (BRTypes.BookComponents memory c) {
        c.book = address(new BookProxy(impls.book));
        c.senior = Clones.clone(impls.tranche);
        c.junior = Clones.clone(impls.tranche);
        c.vault = Clones.clone(impls.vault);
        c.mandate = address(new MockMandate(c.book));
        c.router = router;
        c.desk = desk;
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
    }

    function create(uint256, BRTypes.Charter calldata) external pure returns (BRTypes.BookComponents memory) {
        revert("LowGasFactory: use deployOrderlyBook");
    }

    function componentsOf(uint256 bookId) external view returns (BRTypes.BookComponents memory) {
        return _components[bookId];
    }

    function bookOf(uint256 bookId) external view returns (address) {
        return _components[bookId].book;
    }

    function isBook(address book) external view returns (bool) {
        return bookIdOf[book] != 0;
    }

    function bookIds() external view returns (uint256[] memory) {
        return _ids;
    }
}

/// @notice Oracle stub with the LOW_GAS §1 pull entry point `update(bytes)`: priceData =
///         abi.encode(PriceUpdate[], bytes[]), EIP-712 `Price` signatures as AttestedOracle, every newer
///         update stored, not-newer ones skipped, a bad signature reverts. `priceOf` reverts StalePrice
///         beyond `MAX_PRICE_AGE`.
contract LowGasOracleStub is EIP712 {
    bytes32 public constant PRICE_TYPEHASH = keccak256(
        "Price(bytes32 underlying,uint256 priceWad,uint64 publishedAt,bool held,uint32 sourceCount,bytes32 sourcesHash)"
    );
    uint256 public constant MAX_PRICE_AGE = 300;

    address public immutable signer;
    mapping(bytes32 => IAttestedOracle.PriceData) internal _prices;
    uint256 public updates;
    uint256 public skipped;

    error LengthMismatch();

    constructor(address signer_) EIP712("Bookrunner AttestedOracle", "1") {
        signer = signer_;
    }

    function hashPrice(IAttestedOracle.PriceUpdate memory u) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PRICE_TYPEHASH,
                    u.underlying,
                    u.priceWad,
                    u.publishedAt,
                    u.held,
                    u.sourceCount,
                    u.sourcesHash
                )
            )
        );
    }

    function update(bytes calldata priceData) external {
        (IAttestedOracle.PriceUpdate[] memory us, bytes[] memory sigs) =
            abi.decode(priceData, (IAttestedOracle.PriceUpdate[], bytes[]));
        if (us.length != sigs.length) revert LengthMismatch();
        for (uint256 i; i < us.length; i++) {
            (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(hashPrice(us[i]), sigs[i]);
            if (err != ECDSA.RecoverError.NoError || rec != signer) revert IAttestedOracle.BadSigner(rec);
            if (us[i].publishedAt <= _prices[us[i].underlying].publishedAt) {
                skipped++;
                continue;
            }
            _prices[us[i].underlying] = IAttestedOracle.PriceData({
                priceWad: us[i].priceWad,
                publishedAt: us[i].publishedAt,
                held: us[i].held,
                sourceCount: us[i].sourceCount
            });
            updates++;
        }
    }

    function latest(bytes32 underlying) external view returns (IAttestedOracle.PriceData memory) {
        return _prices[underlying];
    }

    function priceOf(bytes32 underlying) external view returns (uint256, bool) {
        IAttestedOracle.PriceData memory d = _prices[underlying];
        if (d.publishedAt == 0 || uint256(d.publishedAt) + MAX_PRICE_AGE < block.timestamp) {
            revert IAttestedOracle.StalePrice(underlying, d.publishedAt);
        }
        return (d.priceWad, d.held);
    }
}

/// @notice One live Orderly book on the real Book / Tranche / UnderwritingVault / MarkRegistry / OrderlyAdapter /
///         MockOrderlyVault stack (real BookrunnerConfig; mandate, backstop, charter and router are the existing
///         test mocks; the oracle is a pull-update stub), just after its subscription window closed.
abstract contract LowGasMarkBase is Test {
    uint256 internal constant BOOK_ID = 1;
    uint32 internal constant INTERVAL = 86_400; // daily marks (LOW_GAS §3)
    uint256 internal constant WAD = 1e18;
    bytes32 internal constant BROKER_HASH = keccak256("bookrunner");
    bytes32 internal constant TOKEN_HASH = keccak256("USDC");
    bytes32 internal constant NVDA = bytes32("NVDA");
    uint128 internal constant IF_TARGET = 25_000e6;
    uint128 internal constant MM_INVENTORY = 75_000e6;
    uint8 internal constant IF = 0;
    uint8 internal constant MM = 1;

    uint256 internal constant MARK_PK = 0xA11CE;
    uint256 internal constant OPS_PK = 0x0B5;
    uint256 internal constant ORACLE_PK = 0x0AC1E;

    address internal timelock = makeAddr("timelock");
    address internal keeper = makeAddr("keeper");
    address internal relayer = makeAddr("relayer");
    address internal griefer = makeAddr("griefer");
    address internal orderlyOperator = makeAddr("orderlyOperator");
    address internal desk = makeAddr("desk");
    address internal sponsor = makeAddr("sponsor");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal markSigner;
    address internal opsSigner;

    MockERC20 internal usdc;
    BookrunnerConfig internal config;
    MarkRegistry internal registry;
    LowGasFactory internal factory;
    MockOrderlyVault internal ov;
    LowGasOracleStub internal oracle;
    MockBackstop internal backstop;
    MockCharter internal charterC;
    OrderlyMockRouter internal router;

    Book internal book;
    Tranche internal senior;
    Tranche internal junior;
    UnderwritingVault internal vault;
    OrderlyAdapter internal adapter;

    uint64 internal p1; // first mark period end after the window closed
    uint64 internal closedAt;

    event MarkSuperseded(
        uint256 indexed bookId, uint256 indexed oldMarkId, uint256 indexed newMarkId, uint64 periodEnd
    );
    event VenueReportSkipped(
        uint256 indexed bookId, address indexed adapter, uint64 asOf, uint64 valuationAt
    );
    event VenueReportRelayed(address indexed signer, address indexed relayer, uint64 asOf);

    function setUp() public virtual {
        vm.warp(1_760_000_123);
        markSigner = vm.addr(MARK_PK);
        opsSigner = vm.addr(OPS_PK);

        usdc = new MockERC20("USD Coin", "USDC", 6);
        config = new BookrunnerConfig(timelock);
        registry = new MarkRegistry(address(config));
        factory = new LowGasFactory();
        ov = new MockOrderlyVault(address(this), address(usdc), TOKEN_HASH, BROKER_HASH);
        ov.setOperator(orderlyOperator, true);
        oracle = new LowGasOracleStub(vm.addr(ORACLE_PK));
        backstop = new MockBackstop(IERC20(address(usdc)));
        charterC = new MockCharter();
        router = new OrderlyMockRouter(address(usdc));

        vm.startPrank(timelock);
        config.setAddress("usdc", address(usdc));
        config.setAddress("orderlyVault", address(ov));
        config.setAddress("factory", address(factory));
        config.setAddress("markRegistry", address(registry));
        config.setAddress("backstop", address(backstop));
        config.setAddress("oracle", address(oracle));
        config.setAddress("charter", address(charterC));
        config.setParam("markInterval", INTERVAL);
        config.grantRole(config.MARK_SIGNER_ROLE(), markSigner);
        config.grantRole(config.OPS_VENUE_ROLE(), opsSigner);
        config.grantRole(config.KEEPER_ROLE(), keeper);
        vm.stopPrank();

        BRTypes.BookComponents memory c = factory.deployOrderlyBook(
            address(config),
            BOOK_ID,
            _charter(),
            LowGasFactory.Impls({
                book: address(new Book()),
                tranche: address(new Tranche()),
                vault: address(new UnderwritingVault()),
                adapter: address(new OrderlyAdapter(BROKER_HASH, TOKEN_HASH))
            }),
            address(router),
            desk
        );
        book = Book(c.book);
        senior = Tranche(c.senior);
        junior = Tranche(c.junior);
        vault = UnderwritingVault(c.vault);
        adapter = OrderlyAdapter(payable(c.adapter));
        backstop.setVault(c.vault);
        charterC.setBook(BOOK_ID, c.book);

        // subscription window -> Live: S 70k / J 30k, IF 25k + MM 75k deployed to Orderly
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

        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live));
        assertEq(adapter.deployedValueUsd(), 100_000e6);
        assertEq(vault.idle(), 0);
        assertEq(book.flowNonce(), 2);
        assertEq(ov.balanceOf(adapter.accountId(MM)), MM_INVENTORY);
    }

    // ---------------------------------------------------------------------------------------------
    // builders
    // ---------------------------------------------------------------------------------------------

    function _charter() internal view returns (BRTypes.Charter memory c) {
        c.underlying = NVDA;
        c.venue = BRTypes.VENUE_ORDERLY;
        c.oracle = BRTypes.ORACLE_ATTESTED;
        c.ifTargetUsd = IF_TARGET;
        c.mmInventoryUsd = MM_INVENTORY;
        c.mandate = BRTypes.Mandate({
            maxInventoryUsd: 50_000e6,
            maxSkewBps: 25,
            minQuoteWidthBps: 8,
            maxHedgeLeverage: 100,
            hedgeRatioMinBps: 5000,
            hedgeRatioMaxBps: 12_000,
            noNewRiskOffHours: true,
            killAtDrawdownBps: -800,
            hedgeAllowRoot: bytes32(uint256(1))
        });
        c.seniorHurdleBps = 6000;
        c.seniorCapBps = 7000;
        c.subscriptionWindow = 600;
        c.juniorNoticeSeconds = 900;
        c.sponsor = sponsor;
        c.perWalletCapUsd = 250_000e6;
        c.symbol = bytes32("PERP_NVDA_USDC");
    }

    function _deposit(Tranche t, address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(t), amount);
        t.deposit(amount, who);
        vm.stopPrank();
    }

    function _mark(uint64 periodEnd, uint256 deployed, uint64 nonce)
        internal
        view
        returns (BRTypes.MarkInput memory)
    {
        return BRTypes.MarkInput({
            bookId: BOOK_ID,
            periodEnd: periodEnd,
            navUsd: vault.idle() + deployed,
            deployedValueUsd: deployed,
            flowNonce: nonce,
            inventoryRoot: keccak256("inventory"),
            pnlJsonHash: keccak256("pnl.json"),
            receiptsRoot: keccak256("receipts")
        });
    }

    function _signMark(BRTypes.MarkInput memory m) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MARK_PK, registry.hashMark(m));
        return abi.encodePacked(r, s, v);
    }

    function _signReport(uint256 pk, uint256 ins, int256 margin, int256 exposure, uint64 asOf)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, adapter.hashReport(ins, margin, exposure, asOf));
        return abi.encodePacked(r, s, v);
    }

    /// @dev LOW_GAS §3 encoding: abi.encode(insuranceUsd, marginUsd, netExposureUsd, asOf, sig).
    function _venueReport(uint256 pk, uint256 ins, int256 margin, int256 exposure, uint64 asOf)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(ins, margin, exposure, asOf, _signReport(pk, ins, margin, exposure, asOf));
    }

    /// @dev LOW_GAS §1 encoding: abi.encode(PriceUpdate[], bytes[]).
    function _priceData(uint256 pk, uint256 priceWad, uint64 publishedAt)
        internal
        view
        returns (bytes memory)
    {
        IAttestedOracle.PriceUpdate[] memory us = new IAttestedOracle.PriceUpdate[](1);
        us[0] = IAttestedOracle.PriceUpdate({
            underlying: NVDA,
            priceWad: priceWad,
            publishedAt: publishedAt,
            held: false,
            sourceCount: 3,
            sourcesHash: keccak256("sources")
        });
        bytes[] memory sigs = new bytes[](1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, oracle.hashPrice(us[0]));
        sigs[0] = abi.encodePacked(r, s, v);
        return abi.encode(us, sigs);
    }

    /// @dev Keeper pass for the period that just ended: MM made +1,200 USDC and holds an 8k short.
    function _keeperInputs()
        internal
        view
        returns (
            BRTypes.MarkInput memory m,
            bytes memory sig,
            bytes memory priceData,
            bytes memory venueReport
        )
    {
        m = _mark(p1, 101_200e6, book.flowNonce());
        sig = _signMark(m);
        priceData = _priceData(ORACLE_PK, 181e18, uint64(block.timestamp) - 2);
        venueReport = _venueReport(OPS_PK, 25_000e6, 76_200e6, -8000e6, p1 + 60);
    }

    function _toMarkTime() internal {
        vm.warp(uint256(p1) + 120);
    }

    function _bookState() internal view returns (bytes32) {
        (uint256 s, uint256 j) = book.trancheNav();
        return keccak256(
            abi.encode(
                s,
                j,
                book.unfundedClaims(),
                book.sharePrice(BRTypes.SENIOR),
                book.sharePrice(BRTypes.JUNIOR),
                book.lastMarkPeriodEnd(),
                book.flowNonce(),
                adapter.deployedValueUsd(),
                adapter.netExposureUsd(),
                adapter.valuationAt(),
                senior.totalSupply(),
                junior.totalSupply()
            )
        );
    }
}

/// @notice LOW_GAS §2 + §3 end to end: one keeper transaction `MarkRegistry.commitAndApply` lands the signed
///         prices, the signed venue report, the mark and its application on the real book stack.
contract LowGasMarkTest is LowGasMarkBase {
    // ---------------------------------------------------------------------------------------------
    // the atomic mark
    // ---------------------------------------------------------------------------------------------

    function test_atomicMark_endToEnd() public {
        // alice queues a Senior redemption during the period; it settles at the period's mark
        vm.prank(alice);
        senior.requestRedeem(10_000e6, alice, alice);
        _toMarkTime();
        (BRTypes.MarkInput memory m, bytes memory sig, bytes memory priceData, bytes memory venueReport) =
            _keeperInputs();
        assertFalse(adapter.sweepOpen(), "sweep gate closed until the period's mark is applied");

        vm.expectEmit(true, true, false, true, address(adapter));
        emit VenueReportRelayed(opsSigner, address(registry), p1 + 60);
        vm.prank(relayer); // anyone may run the keeper pass
        uint256 id = registry.commitAndApply(m, sig, priceData, venueReport);

        // mark committed and applied in the same transaction
        assertEq(id, 1);
        BRTypes.Mark memory got = registry.getMark(id);
        assertTrue(got.applied);
        assertEq(got.signer, markSigner);
        assertEq(book.lastMarkId(), id);
        assertEq(book.lastMarkPeriodEnd(), p1);
        // the venue report landed on the adapter
        assertEq(adapter.insuranceEquityUsd(), 25_000e6);
        assertEq(adapter.marginEquityUsd(), int256(76_200e6));
        assertEq(adapter.netExposureUsd(), -int256(8000e6));
        assertEq(adapter.valuationAt(), p1 + 60);
        assertEq(adapter.deployedValueUsd(), 101_200e6);
        // the prices landed on the oracle
        assertEq(oracle.latest(NVDA).priceWad, 181e18);
        (uint256 px,) = oracle.priceOf(NVDA);
        assertEq(px, 181e18);
        // the book's waterfall ran on the mark: +1,200 to Junior, alice's bucket settled (unfunded: all deployed)
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s + j + book.unfundedClaims(), 101_200e6, "accounting identity");
        assertGt(book.sharePrice(BRTypes.JUNIOR), WAD);
        assertEq(senior.totalSupply(), 60_000e6, "alice's 10k Senior shares burned at the mark");
        assertEq(book.unfundedClaims(), 10_000e6 * book.sharePrice(BRTypes.SENIOR) / WAD);
        assertTrue(adapter.sweepOpen(), "the applied mark opens the sweep window");

        // next day: one transaction again
        vm.warp(uint256(p1) + INTERVAL + 300);
        uint64 p2 = p1 + INTERVAL;
        BRTypes.MarkInput memory m2 = _mark(p2, 100_700e6, book.flowNonce());
        bytes memory venue2 = _venueReport(OPS_PK, 25_000e6, 75_700e6, -2000e6, p2 + 30);
        vm.prank(keeper);
        uint256 id2 = registry.commitAndApply(m2, _signMark(m2), "", venue2);
        assertEq(id2, 2);
        assertEq(book.lastMarkPeriodEnd(), p2);
        assertEq(adapter.deployedValueUsd(), 100_700e6);
    }

    function test_atomicMark_matchesLegacyThreeTransactions() public {
        _toMarkTime();
        (BRTypes.MarkInput memory m, bytes memory sig,,) = _keeperInputs();

        uint256 snap = vm.snapshotState();
        // legacy: role-gated report, commit, applyMark (three transactions)
        vm.prank(opsSigner);
        adapter.report(25_000e6, 76_200e6, -8000e6, p1 + 60);
        uint256 legacyId = registry.commit(m, sig);
        book.applyMark(legacyId);
        bytes32 legacy = _bookState();
        vm.revertToState(snap);

        bytes memory venueReport = _venueReport(OPS_PK, 25_000e6, 76_200e6, -8000e6, p1 + 60);
        uint256 id = registry.commitAndApply(m, sig, "", venueReport);
        assertEq(id, legacyId);
        assertEq(_bookState(), legacy, "identical outcome");
    }

    // ---------------------------------------------------------------------------------------------
    // venue report: signatures, replay, rules
    // ---------------------------------------------------------------------------------------------

    function test_atomicMark_badVenueSignature_revertsEverything() public {
        _toMarkTime();
        (BRTypes.MarkInput memory m, bytes memory sig, bytes memory priceData,) = _keeperInputs();

        // signed by a key without OPS_VENUE
        bytes memory forged = _venueReport(0xBAD, 25_000e6, 999_000e6, 0, p1 + 60);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.NotOpsVenueSigner.selector, vm.addr(0xBAD)));
        registry.commitAndApply(m, sig, priceData, forged);

        // OPS_VENUE signature, inflated margin
        bytes memory good = _signReport(OPS_PK, 25_000e6, 76_200e6, -8000e6, p1 + 60);
        bytes memory tampered =
            abi.encode(uint256(25_000e6), int256(999_000e6), -int256(8000e6), p1 + 60, good);
        vm.expectPartialRevert(OrderlyAdapter.NotOpsVenueSigner.selector);
        registry.commitAndApply(m, sig, priceData, tampered);

        // garbage signature bytes
        bytes memory garbage =
            abi.encode(uint256(25_000e6), int256(76_200e6), -int256(8000e6), p1 + 60, hex"0102");
        vm.expectRevert(OrderlyAdapter.InvalidReportSignature.selector);
        registry.commitAndApply(m, sig, priceData, garbage);

        // nothing of the keeper pass landed
        assertEq(registry.markCount(), 0);
        assertEq(book.lastMarkId(), 0);
        assertEq(adapter.valuationAt(), 0);
        assertEq(adapter.deployedValueUsd(), 100_000e6);
        assertEq(oracle.latest(NVDA).publishedAt, 0, "price update rolled back");
    }

    function test_atomicMark_venueReportForAnotherChain_rejected() public {
        _toMarkTime();
        (BRTypes.MarkInput memory m, bytes memory sig,,) = _keeperInputs();
        uint256 chain = block.chainid;
        vm.chainId(4663);
        bytes memory otherChain = _venueReport(OPS_PK, 25_000e6, 76_200e6, -8000e6, p1 + 60);
        vm.chainId(chain);
        vm.expectPartialRevert(OrderlyAdapter.NotOpsVenueSigner.selector);
        registry.commitAndApply(m, sig, "", otherChain);
    }

    function test_atomicMark_replayRejected() public {
        _toMarkTime();
        (BRTypes.MarkInput memory m, bytes memory sig, bytes memory priceData, bytes memory venueReport) =
            _keeperInputs();
        registry.commitAndApply(m, sig, priceData, venueReport);

        vm.warp(block.timestamp + 600);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.PeriodNotAfterLast.selector, p1, p1));
        registry.commitAndApply(m, sig, priceData, venueReport);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.PeriodNotAfterLast.selector, p1, p1));
        registry.commit(m, sig);
        vm.expectRevert(abi.encodeWithSelector(Book.MarkAlreadyApplied.selector, 1));
        book.applyMark(1);
        // the signed venue report cannot be replayed directly either
        bytes memory rsig = _signReport(OPS_PK, 25_000e6, 76_200e6, -8000e6, p1 + 60);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.StaleReport.selector, p1 + 60, p1 + 60));
        adapter.reportSigned(25_000e6, 76_200e6, -8000e6, p1 + 60, rsig);
    }

    function test_atomicMark_frontRunVenueReport_markStillLands() public {
        _toMarkTime();
        (BRTypes.MarkInput memory m, bytes memory sig, bytes memory priceData, bytes memory venueReport) =
            _keeperInputs();
        // the signed report is public (Redis / HTTP): someone relays it first
        bytes memory rsig = _signReport(OPS_PK, 25_000e6, 76_200e6, -8000e6, p1 + 60);
        vm.prank(griefer);
        adapter.reportSigned(25_000e6, 76_200e6, -8000e6, p1 + 60, rsig);

        vm.expectEmit(true, true, false, true, address(registry));
        emit VenueReportSkipped(BOOK_ID, address(adapter), p1 + 60, p1 + 60);
        vm.prank(keeper);
        uint256 id = registry.commitAndApply(m, sig, priceData, venueReport);
        assertTrue(registry.getMark(id).applied, "front-running the report cannot block the mark");
        assertEq(adapter.deployedValueUsd(), 101_200e6);

        // a NEWER report relayed first also makes the keeper's older one a no-op
        vm.warp(uint256(p1) + INTERVAL + 300);
        uint64 p2 = p1 + INTERVAL;
        bytes memory newer = _signReport(OPS_PK, 25_000e6, 76_000e6, 0, p2 + 200);
        adapter.reportSigned(25_000e6, 76_000e6, 0, p2 + 200, newer);
        BRTypes.MarkInput memory m2 = _mark(p2, 101_000e6, book.flowNonce());
        bytes memory older = _venueReport(OPS_PK, 25_000e6, 75_000e6, 0, p2 + 100);
        registry.commitAndApply(m2, _signMark(m2), "", older);
        assertEq(adapter.marginEquityUsd(), int256(76_000e6), "the newer stored report wins");
    }

    function test_atomicMark_withdrawalPending_reportRejected_markWithoutReportLands() public {
        _toMarkTime();
        vm.prank(keeper);
        vault.recall(MM, 20_000e6); // flowNonce 3, withdrawal Requested (venue-side until confirmed)
        BRTypes.MarkInput memory m = _mark(p1, 100_000e6, book.flowNonce());
        bytes memory sig = _signMark(m);
        bytes memory venueReport = _venueReport(OPS_PK, 25_000e6, 55_000e6, 0, uint64(block.timestamp));

        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.WithdrawalPending.selector, 20_000e6));
        registry.commitAndApply(m, sig, "", venueReport);
        assertEq(registry.markCount(), 0);

        // keeper fallback: same mark without the venue report
        uint256 id = registry.commitAndApply(m, sig, "", "");
        assertTrue(registry.getMark(id).applied);
        assertEq(book.lastMarkPeriodEnd(), p1);
    }

    function test_atomicMark_reportPredatingFlow_reverts() public {
        _toMarkTime();
        vm.prank(keeper);
        vault.recall(MM, 20_000e6);
        uint64 snapshotAt = uint64(block.timestamp); // ops-venue snapshot taken before the confirmation
        vm.warp(block.timestamp + 30);
        vm.prank(opsSigner);
        adapter.confirmWithdraw(1); // lastFlowAt = now
        BRTypes.MarkInput memory m = _mark(p1, 100_000e6, book.flowNonce());
        bytes memory sig = _signMark(m);

        bytes memory early = _venueReport(OPS_PK, 25_000e6, 55_000e6, 0, snapshotAt);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderlyAdapter.ReportPredatesFlow.selector, snapshotAt, uint64(block.timestamp)
            )
        );
        registry.commitAndApply(m, sig, "", early);

        // a snapshot from the confirmation second may still predate the debit: refused too
        bytes memory sameSecond = _venueReport(OPS_PK, 25_000e6, 55_000e6, 0, uint64(block.timestamp));
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderlyAdapter.ReportPredatesFlow.selector, uint64(block.timestamp), uint64(block.timestamp)
            )
        );
        registry.commitAndApply(m, sig, "", sameSecond);

        vm.warp(block.timestamp + 1);
        bytes memory fresh = _venueReport(OPS_PK, 25_000e6, 55_000e6, 0, uint64(block.timestamp));
        registry.commitAndApply(m, sig, "", fresh);
        assertEq(adapter.deployedValueUsd(), 100_000e6, "25k IF + 55k MM + 20k in transit");
        assertEq(adapter.inTransitUsd(), 20_000e6);
    }

    function test_atomicMark_futureReport_reverts() public {
        _toMarkTime();
        (BRTypes.MarkInput memory m, bytes memory sig,,) = _keeperInputs();
        uint64 future = uint64(block.timestamp) + 1;
        bytes memory venueReport = _venueReport(OPS_PK, 25_000e6, 76_200e6, 0, future);
        vm.expectRevert(
            abi.encodeWithSelector(OrderlyAdapter.ReportInFuture.selector, future, uint64(block.timestamp))
        );
        registry.commitAndApply(m, sig, "", venueReport);
    }

    // ---------------------------------------------------------------------------------------------
    // mark: flow nonce / stale replacement
    // ---------------------------------------------------------------------------------------------

    function test_atomicMark_capitalFlowAfterSigning_revertsAndPeriodStaysOpen() public {
        _toMarkTime();
        (BRTypes.MarkInput memory m, bytes memory sig,,) = _keeperInputs(); // signed at flowNonce 2
        vm.prank(keeper);
        vault.recall(MM, 5000e6); // flowNonce 3
        vm.expectRevert(abi.encodeWithSelector(Book.FlowNonceMismatch.selector, uint64(3), uint64(2)));
        registry.commitAndApply(m, sig, "", "");
        assertEq(registry.markCount(), 0, "commit rolled back with the failed apply");
        assertEq(registry.lastPeriodEnd(BOOK_ID), 0, "period not burned");

        BRTypes.MarkInput memory m2 = _mark(p1, 101_200e6, book.flowNonce());
        uint256 id = registry.commitAndApply(m2, _signMark(m2), "", "");
        assertTrue(registry.getMark(id).applied);
    }

    function test_atomicMark_replacesStaleLegacyCommit() public {
        _toMarkTime();
        (BRTypes.MarkInput memory m, bytes memory sig,,) = _keeperInputs();
        uint256 stale = registry.commit(m, sig); // legacy commit, not applied
        vm.prank(keeper);
        vault.recall(MM, 5000e6);
        vm.prank(opsSigner);
        adapter.confirmWithdraw(1);
        assertTrue(registry.latestMarkReplaceable(BOOK_ID));
        vm.warp(block.timestamp + 1); // the venue snapshot must be strictly after the confirmation

        BRTypes.MarkInput memory m2 = _mark(p1, 101_200e6, book.flowNonce());
        bytes memory venueReport = _venueReport(OPS_PK, 25_000e6, 71_200e6, 0, uint64(block.timestamp));
        vm.expectEmit(true, true, true, true, address(registry));
        emit MarkSuperseded(BOOK_ID, stale, stale + 1, p1);
        uint256 id = registry.commitAndApply(m2, _signMark(m2), "", venueReport);
        assertEq(id, stale + 1);
        assertTrue(registry.getMark(id).applied);
        assertFalse(registry.getMark(stale).applied);
        assertEq(book.lastMarkId(), id);
        assertEq(adapter.deployedValueUsd(), 101_200e6, "25k + 71.2k venue-side + 5k in transit");
    }

    function test_atomicMark_wrongMarkSigner_reverts() public {
        _toMarkTime();
        (BRTypes.MarkInput memory m,, bytes memory priceData, bytes memory venueReport) = _keeperInputs();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPS_PK, registry.hashMark(m)); // OPS key is no MARK_SIGNER
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.NotMarkSigner.selector, opsSigner));
        registry.commitAndApply(m, abi.encodePacked(r, s, v), priceData, venueReport);
        assertEq(adapter.valuationAt(), 0, "venue report rolled back");
    }

    // ---------------------------------------------------------------------------------------------
    // prices
    // ---------------------------------------------------------------------------------------------

    function test_atomicMark_badPriceSignature_revertsEverything() public {
        _toMarkTime();
        (BRTypes.MarkInput memory m, bytes memory sig,, bytes memory venueReport) = _keeperInputs();
        bytes memory badPrices = _priceData(0xBAD, 181e18, uint64(block.timestamp));
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, vm.addr(0xBAD)));
        registry.commitAndApply(m, sig, badPrices, venueReport);
        assertEq(registry.markCount(), 0);
        assertEq(adapter.valuationAt(), 0);
    }

    function test_atomicMark_oldPriceSkipped_markLands() public {
        _toMarkTime();
        (BRTypes.MarkInput memory m, bytes memory sig, bytes memory priceData, bytes memory venueReport) =
            _keeperInputs();
        // a fresher price already landed (e.g. in a trader's tx): the keeper's older print is skipped
        oracle.update(_priceData(ORACLE_PK, 182e18, uint64(block.timestamp)));
        registry.commitAndApply(m, sig, priceData, venueReport);
        assertEq(oracle.skipped(), 1);
        assertEq(oracle.latest(NVDA).priceWad, 182e18, "older print never overwrites a newer one");
        assertTrue(registry.getMark(1).applied);
        // the stored price is stale for consumers once maxPriceAge passes (no timer pushes in pull mode)
        vm.warp(block.timestamp + 301);
        vm.expectPartialRevert(IAttestedOracle.StalePrice.selector);
        oracle.priceOf(NVDA);
    }
}

// =================================================================================================
// Gas: one atomic keeper transaction vs report + commit + applyMark.
// Each test function makes exactly ONE top-level call (inputs are prepared in setUp), so with
//   bash scripts/forge.sh test --isolate --gas-report --match-contract LowGasMarkGas
// every top-level row of the gas report is a full transaction (21000 intrinsic + calldata + execution,
// cold access lists). Proxied targets (Book, OrderlyAdapter) appear as `BookProxy.fallback`: run those
// tests one at a time (`--match-test`) to read their single row.
// =================================================================================================

/// @notice Keeper inputs for the period that just ended, prepared outside the measured call.
abstract contract LowGasMarkGasBase is LowGasMarkBase {
    BRTypes.MarkInput internal gm;
    bytes internal gsig;
    bytes internal gPriceData;
    bytes internal gVenueReport;
    bytes internal gReportSig;

    function setUp() public virtual override {
        super.setUp();
        _toMarkTime();
        (gm, gsig, gPriceData, gVenueReport) = _keeperInputs();
        gReportSig = _signReport(OPS_PK, 25_000e6, 76_200e6, -8000e6, p1 + 60);
    }
}

contract LowGasMarkGasTest is LowGasMarkGasBase {
    /// legacy tx 1/3: role-gated venue report (ops-venue's 30 s loop today)
    function test_gasTx_1_report() public {
        vm.prank(opsSigner);
        adapter.report(25_000e6, 76_200e6, -8000e6, p1 + 60);
    }

    /// signed venue report relayed on its own (desk hedge legs / ad-hoc refresh)
    function test_gasTx_1b_reportSigned() public {
        adapter.reportSigned(25_000e6, 76_200e6, -8000e6, p1 + 60, gReportSig);
    }

    /// legacy tx 2/3: commit
    function test_gasTx_2_commit() public {
        registry.commit(gm, gsig);
    }

    /// LOW_GAS §3: mark only (PoolEngine book, or no fresh venue report)
    function test_gasTx_atomic_markOnly() public {
        registry.commitAndApply(gm, gsig, "", "");
    }

    /// LOW_GAS §3: mark + venue report (Orderly book, the daily keeper transaction)
    function test_gasTx_atomic_withVenueReport() public {
        registry.commitAndApply(gm, gsig, "", gVenueReport);
    }

    /// LOW_GAS §3: mark + venue report + one signed price through the oracle stub
    function test_gasTx_atomic_withPricesAndVenueReport() public {
        registry.commitAndApply(gm, gsig, gPriceData, gVenueReport);
    }
}

/// @notice legacy tx 3/3: applyMark after a separate report + commit.
contract LowGasMarkGasApplyTest is LowGasMarkGasBase {
    uint256 internal gid;

    function setUp() public override {
        super.setUp();
        vm.prank(opsSigner);
        adapter.report(25_000e6, 76_200e6, -8000e6, p1 + 60);
        gid = registry.commit(gm, gsig);
    }

    function test_gasTx_3_applyMark() public {
        book.applyMark(gid);
    }
}
