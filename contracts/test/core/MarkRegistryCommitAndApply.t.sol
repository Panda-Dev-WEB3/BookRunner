// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoreFixture} from "./utils/CoreFixture.sol";
import {MarkRegistry} from "../../src/MarkRegistry.sol";
import {IMarkRegistry, IMarkRegistryAtomic} from "../../src/interfaces/IMarkRegistry.sol";
import {BRTypes} from "../../src/interfaces/BRTypes.sol";

/// @notice IBook-shaped book: `applyMark(uint256)` with the real book's nonce / order / applied checks.
contract CAMockBook {
    IMarkRegistry public immutable registry;
    uint256 public immutable bookId;
    uint64 public flowNonce;
    uint64 public lastMarkPeriodEnd;
    uint256 public lastMarkId;
    uint256 public applyCalls;
    address public lastApplyCaller;

    error FlowNonceMismatch(uint64 expected, uint64 got);
    error MarkOutOfOrder(uint64 periodEnd, uint64 last);
    error MarkForOtherBook(uint256 markId, uint256 bookId);

    constructor(address registry_, uint256 bookId_) {
        registry = IMarkRegistry(registry_);
        bookId = bookId_;
    }

    function setFlowNonce(uint64 n) external {
        flowNonce = n;
    }

    function applyMark(uint256 markId) external {
        BRTypes.Mark memory m = registry.getMark(markId);
        if (m.input.bookId != bookId) revert MarkForOtherBook(markId, m.input.bookId);
        if (m.input.periodEnd <= lastMarkPeriodEnd) {
            revert MarkOutOfOrder(m.input.periodEnd, lastMarkPeriodEnd);
        }
        if (m.input.flowNonce != flowNonce) revert FlowNonceMismatch(flowNonce, m.input.flowNonce);
        lastMarkPeriodEnd = m.input.periodEnd;
        lastMarkId = markId;
        applyCalls++;
        lastApplyCaller = msg.sender;
        registry.markApplied(markId);
    }
}

/// @notice Venue adapter surface MarkRegistry.commitAndApply uses: `valuationAt` + `reportSigned`.
contract CAMockAdapter {
    IMarkRegistry public immutable registry;
    uint64 public valuationAt;
    bool public revertReport;
    uint256 public reportCalls;
    bytes32 public lastArgsHash;
    uint256 public markCountAtReport;

    error AdapterRejected();

    constructor(address registry_) {
        registry = IMarkRegistry(registry_);
    }

    function setValuationAt(uint64 t) external {
        valuationAt = t;
    }

    function setRevertReport(bool r) external {
        revertReport = r;
    }

    function reportSigned(uint256 ins, int256 margin, int256 exposure, uint64 asOf, bytes calldata sig)
        external
    {
        if (revertReport) revert AdapterRejected();
        reportCalls++;
        lastArgsHash = keccak256(abi.encode(ins, margin, exposure, asOf, sig));
        markCountAtReport = registry.markCount();
        valuationAt = asOf;
    }
}

/// @notice Oracle stub implementing the LOW_GAS §1 `update(bytes)` entry point.
contract CAMockOracle {
    IMarkRegistry public immutable registry;
    bool public revertUpdate;
    uint256 public updateCalls;
    bytes32 public lastDataHash;
    uint256 public markCountAtUpdate;

    error BadPriceSignature();

    constructor(address registry_) {
        registry = IMarkRegistry(registry_);
    }

    function setRevertUpdate(bool r) external {
        revertUpdate = r;
    }

    function update(bytes calldata priceData) external {
        if (revertUpdate) revert BadPriceSignature();
        updateCalls++;
        lastDataHash = keccak256(priceData);
        markCountAtUpdate = registry.markCount();
    }
}

contract MarkRegistryCommitAndApplyTest is CoreFixture {
    uint32 internal constant INTERVAL = 300;
    uint32 internal constant MAX_AGE = 3600;
    uint256 internal constant ORDERLY_BOOK = 5;
    uint64 internal constant NONCE = 4;

    CAMockBook internal obook;
    CAMockAdapter internal oadapter;
    CAMockOracle internal oracle;

    event MarkSuperseded(
        uint256 indexed bookId, uint256 indexed oldMarkId, uint256 indexed newMarkId, uint64 periodEnd
    );
    event VenueReportSkipped(
        uint256 indexed bookId, address indexed adapter, uint64 asOf, uint64 valuationAt
    );

    function setUp() public override {
        super.setUp();
        vm.startPrank(admin);
        config.setParam("markInterval", INTERVAL);
        config.setParam("maxMarkAge", MAX_AGE);
        vm.stopPrank();

        obook = new CAMockBook(address(registry), ORDERLY_BOOK);
        oadapter = new CAMockAdapter(address(registry));
        oracle = new CAMockOracle(address(registry));
        obook.setFlowNonce(NONCE);
        BRTypes.BookComponents memory c;
        c.book = address(obook);
        c.adapter = address(oadapter);
        c.vault = makeAddr("ovault");
        c.router = makeAddr("orouter");
        factory.register(ORDERLY_BOOK, c);

        vm.prank(admin);
        config.setAddress("oracle", address(oracle));
    }

    // ---------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------

    function _period() internal view returns (uint64) {
        return uint64((block.timestamp / INTERVAL) * INTERVAL);
    }

    function _mark(uint64 periodEnd, uint64 nonce) internal pure returns (BRTypes.MarkInput memory m) {
        m = BRTypes.MarkInput({
            bookId: ORDERLY_BOOK,
            periodEnd: periodEnd,
            navUsd: 100_000e6,
            deployedValueUsd: 99_000e6,
            flowNonce: nonce,
            inventoryRoot: keccak256("inv"),
            pnlJsonHash: keccak256("pnl"),
            receiptsRoot: keccak256("receipts")
        });
    }

    function _sign(uint256 pk, BRTypes.MarkInput memory m) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, registry.hashMark(m));
        return abi.encodePacked(r, s, v);
    }

    function _venueReport(uint64 asOf) internal pure returns (bytes memory) {
        return abi.encode(uint256(25_000e6), int256(74_000e6), -int256(1500e6), asOf, hex"c0ffee");
    }

    function _priceData() internal pure returns (bytes memory) {
        return abi.encode(uint256(1), bytes32("NVDA"), uint256(180e18));
    }

    function _atomic(BRTypes.MarkInput memory m, bytes memory priceData, bytes memory venueReport)
        internal
        returns (uint256)
    {
        bytes memory sig = _sign(markSignerPk, m);
        vm.prank(bob); // anyone (keeper)
        return registry.commitAndApply(m, sig, priceData, venueReport);
    }

    // ---------------------------------------------------------------------------------------------
    // happy paths
    // ---------------------------------------------------------------------------------------------

    function test_commitAndApply_markOnly_commitsAndApplies() public {
        BRTypes.MarkInput memory m = _mark(_period(), NONCE);
        bytes memory sig = _sign(markSignerPk, m);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IMarkRegistry.MarkCommitted(
            1,
            ORDERLY_BOOK,
            m.periodEnd,
            m.navUsd,
            m.deployedValueUsd,
            m.inventoryRoot,
            m.pnlJsonHash,
            m.receiptsRoot,
            markSigner
        );
        vm.expectEmit(true, true, false, true, address(registry));
        emit IMarkRegistry.MarkApplied(1, ORDERLY_BOOK);
        vm.prank(bob);
        uint256 id = IMarkRegistryAtomic(address(registry)).commitAndApply(m, sig, "", "");

        assertEq(id, 1);
        assertEq(registry.markCount(), 1);
        assertEq(registry.latestMarkId(ORDERLY_BOOK), 1);
        assertEq(registry.lastPeriodEnd(ORDERLY_BOOK), m.periodEnd);
        BRTypes.Mark memory got = registry.getMark(1);
        assertTrue(got.applied);
        assertEq(got.signer, markSigner);
        assertEq(got.committedAt, block.timestamp);
        assertEq(obook.applyCalls(), 1);
        assertEq(obook.lastMarkId(), 1);
        assertEq(obook.lastApplyCaller(), address(registry), "the registry applies the mark");
        assertEq(oracle.updateCalls(), 0, "empty priceData: oracle untouched");
        assertEq(oadapter.reportCalls(), 0, "empty venueReport: adapter untouched");
    }

    function test_commitAndApply_fullPath_runsStepsInOrder() public {
        uint64 asOf = uint64(block.timestamp) - 3;
        bytes memory priceData = _priceData();
        bytes memory venueReport = _venueReport(asOf);
        uint256 id = _atomic(_mark(_period(), NONCE), priceData, venueReport);

        assertEq(id, 1);
        assertEq(oracle.updateCalls(), 1);
        assertEq(oracle.lastDataHash(), keccak256(priceData), "priceData forwarded verbatim");
        assertEq(oracle.markCountAtUpdate(), 0, "oracle updated before the commit");
        assertEq(oadapter.reportCalls(), 1);
        assertEq(
            oadapter.lastArgsHash(),
            keccak256(abi.encode(uint256(25_000e6), int256(74_000e6), -int256(1500e6), asOf, hex"c0ffee")),
            "venue report decoded and forwarded exactly"
        );
        assertEq(oadapter.markCountAtReport(), 0, "venue report relayed before the commit");
        assertTrue(registry.getMark(id).applied);
    }

    function test_commitAndApply_bookWithoutAdapter_markOnlyStillWorks() public {
        // a book whose components list no adapter: with an empty venueReport only the mark path runs
        CAMockBook b = new CAMockBook(address(registry), 6);
        BRTypes.BookComponents memory c;
        c.book = address(b);
        factory.register(6, c);
        BRTypes.MarkInput memory m = _mark(_period(), 0);
        m.bookId = 6;
        assertEq(_atomic(m, "", ""), 1);
        assertEq(b.applyCalls(), 1);

        // a venue report for a book with no adapter is rejected
        vm.warp(block.timestamp + INTERVAL);
        BRTypes.MarkInput memory m2 = _mark(_period(), 0);
        m2.bookId = 6;
        bytes memory sig = _sign(markSignerPk, m2);
        bytes memory venueReport = _venueReport(uint64(block.timestamp));
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.UnknownBook.selector, 6));
        registry.commitAndApply(m2, sig, "", venueReport);
    }

    function test_commitAndApply_returnsGlobalIds() public {
        BRTypes.MarkInput memory m1 = _mark(_period(), NONCE);
        registry.commit(m1, _sign(markSignerPk, m1)); // id 1 (applied separately below)
        obook.applyMark(1);
        vm.warp(block.timestamp + INTERVAL);
        assertEq(_atomic(_mark(_period(), NONCE), "", ""), 2);
        assertEq(registry.latestMarkId(ORDERLY_BOOK), 2);
    }

    // ---------------------------------------------------------------------------------------------
    // oracle step
    // ---------------------------------------------------------------------------------------------

    function test_commitAndApply_oracleRevert_revertsEverything() public {
        oracle.setRevertUpdate(true);
        BRTypes.MarkInput memory m = _mark(_period(), NONCE);
        bytes memory sig = _sign(markSignerPk, m);
        bytes memory priceData = _priceData();
        bytes memory venueReport = _venueReport(uint64(block.timestamp));
        vm.expectRevert(CAMockOracle.BadPriceSignature.selector);
        registry.commitAndApply(m, sig, priceData, venueReport);
        assertEq(registry.markCount(), 0);
        assertEq(oadapter.reportCalls(), 0);
        assertEq(obook.applyCalls(), 0);
        // the period is not burned: the keeper retries without (or with fresh) prices
        oracle.setRevertUpdate(false);
        assertEq(registry.commitAndApply(m, sig, priceData, venueReport), 1);
    }

    function test_commitAndApply_priceDataWithoutOracle_reverts() public {
        vm.prank(admin);
        config.setAddress("oracle", address(0xdead));
        // oracle with no code: the call reverts (no silent skip)
        BRTypes.MarkInput memory m = _mark(_period(), NONCE);
        bytes memory sig = _sign(markSignerPk, m);
        bytes memory priceData = _priceData();
        vm.expectRevert();
        registry.commitAndApply(m, sig, priceData, "");
    }

    function test_commitAndApply_oracleUnset() public {
        // BookrunnerConfig rejects a zero address, so "no oracle" is a minimal config without one
        uint256 bookId = ORDERLY_BOOK + 100;
        (MarkRegistry r3, CAMockBook b3) =
            new CoreFixtureNoOracle().deploy(address(factory), markSigner, bookId);
        BRTypes.MarkInput memory m = _mark(_period(), 0);
        m.bookId = bookId;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(markSignerPk, r3.hashMark(m));
        bytes memory sig = abi.encodePacked(r, s, v);
        bytes memory priceData = _priceData();
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.NotConfigured.selector, bytes32("oracle")));
        r3.commitAndApply(m, sig, priceData, "");
        assertEq(r3.commitAndApply(m, sig, "", ""), 1, "empty priceData needs no oracle");
        assertEq(b3.applyCalls(), 1);
    }

    // ---------------------------------------------------------------------------------------------
    // venue report step
    // ---------------------------------------------------------------------------------------------

    function test_commitAndApply_venueReportNotNewer_isSkipped() public {
        uint64 asOf = uint64(block.timestamp) - 10;
        oadapter.setValuationAt(asOf); // the same report was already relayed (e.g. front-run)
        BRTypes.MarkInput memory m = _mark(_period(), NONCE);
        bytes memory sig = _sign(markSignerPk, m);
        bytes memory venueReport = _venueReport(asOf);
        vm.expectEmit(true, true, false, true, address(registry));
        emit VenueReportSkipped(ORDERLY_BOOK, address(oadapter), asOf, asOf);
        assertEq(registry.commitAndApply(m, sig, "", venueReport), 1);
        assertEq(oadapter.reportCalls(), 0);
        assertTrue(registry.getMark(1).applied, "the mark is not griefed by the relayed report");

        // an older report than the stored one is skipped as well
        vm.warp(block.timestamp + INTERVAL);
        BRTypes.MarkInput memory m2 = _mark(_period(), NONCE);
        bytes memory sig2 = _sign(markSignerPk, m2);
        bytes memory older = _venueReport(asOf - 1);
        vm.expectEmit(true, true, false, true, address(registry));
        emit VenueReportSkipped(ORDERLY_BOOK, address(oadapter), asOf - 1, asOf);
        assertEq(registry.commitAndApply(m2, sig2, "", older), 2);
        assertEq(oadapter.reportCalls(), 0);
    }

    function test_commitAndApply_venueReportRejected_revertsEverything() public {
        oadapter.setRevertReport(true);
        BRTypes.MarkInput memory m = _mark(_period(), NONCE);
        bytes memory sig = _sign(markSignerPk, m);
        bytes memory priceData = _priceData();
        bytes memory venueReport = _venueReport(uint64(block.timestamp));
        vm.expectRevert(CAMockAdapter.AdapterRejected.selector);
        registry.commitAndApply(m, sig, priceData, venueReport);
        assertEq(registry.markCount(), 0, "nothing committed");
        assertEq(oracle.updateCalls(), 0, "oracle update rolled back");
        assertEq(obook.applyCalls(), 0);
        // the keeper's fallback: the same mark without the venue report
        assertEq(registry.commitAndApply(m, sig, priceData, ""), 1);
    }

    function test_commitAndApply_malformedVenueReport_reverts() public {
        BRTypes.MarkInput memory m = _mark(_period(), NONCE);
        bytes memory sig = _sign(markSignerPk, m);
        vm.expectRevert();
        registry.commitAndApply(m, sig, "", hex"deadbeef");
        assertEq(registry.markCount(), 0);
    }

    // ---------------------------------------------------------------------------------------------
    // commit checks are unchanged
    // ---------------------------------------------------------------------------------------------

    function test_commitAndApply_rejectsBadMarkSignature() public {
        BRTypes.MarkInput memory m = _mark(_period(), NONCE);
        vm.expectRevert(MarkRegistry.InvalidSignature.selector);
        registry.commitAndApply(m, hex"1234", "", "");

        bytes memory wrong = _sign(0xBAD, m);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.NotMarkSigner.selector, vm.addr(0xBAD)));
        registry.commitAndApply(m, wrong, "", "");

        bytes memory sig = _sign(markSignerPk, m);
        m.navUsd += 1; // tampered
        vm.expectPartialRevert(MarkRegistry.NotMarkSigner.selector);
        registry.commitAndApply(m, sig, "", "");
        assertEq(registry.markCount(), 0);
    }

    function test_commitAndApply_rejectsReplay() public {
        BRTypes.MarkInput memory m = _mark(_period(), NONCE);
        bytes memory sig = _sign(markSignerPk, m);
        registry.commitAndApply(m, sig, "", "");
        vm.expectRevert(
            abi.encodeWithSelector(MarkRegistry.PeriodNotAfterLast.selector, m.periodEnd, m.periodEnd)
        );
        registry.commitAndApply(m, sig, "", "");
        // replaying through the legacy entry point is rejected too
        vm.expectRevert(
            abi.encodeWithSelector(MarkRegistry.PeriodNotAfterLast.selector, m.periodEnd, m.periodEnd)
        );
        registry.commit(m, sig);
    }

    function test_commitAndApply_rejectsOldAndFutureAndMisaligned() public {
        uint64 p = _period();
        vm.warp(uint256(p) + MAX_AGE + 1);
        BRTypes.MarkInput memory old = _mark(p, NONCE);
        bytes memory sig = _sign(markSignerPk, old);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.MarkTooOld.selector, p, block.timestamp, MAX_AGE));
        registry.commitAndApply(old, sig, "", "");

        uint64 future = _period() + INTERVAL;
        BRTypes.MarkInput memory fut = _mark(future, NONCE);
        sig = _sign(markSignerPk, fut);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.PeriodInFuture.selector, future, block.timestamp));
        registry.commitAndApply(fut, sig, "", "");

        uint64 mis = _period() - 1;
        BRTypes.MarkInput memory bad = _mark(mis, NONCE);
        sig = _sign(markSignerPk, bad);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.PeriodNotAligned.selector, mis, INTERVAL));
        registry.commitAndApply(bad, sig, "", "");
    }

    function test_commitAndApply_rejectsUnknownBook() public {
        BRTypes.MarkInput memory m = _mark(_period(), NONCE);
        m.bookId = 42;
        bytes memory sig = _sign(markSignerPk, m);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.UnknownBook.selector, 42));
        registry.commitAndApply(m, sig, "", "");
    }

    // ---------------------------------------------------------------------------------------------
    // apply step
    // ---------------------------------------------------------------------------------------------

    function test_commitAndApply_unapplicableMark_isNotCommitted() public {
        // a capital flow landed after the mark was signed: Book.applyMark rejects it, so the commit rolls
        // back as well and the period stays open for the re-signed mark
        BRTypes.MarkInput memory m = _mark(_period(), NONCE);
        bytes memory sig = _sign(markSignerPk, m);
        obook.setFlowNonce(NONCE + 1);
        vm.expectRevert(abi.encodeWithSelector(CAMockBook.FlowNonceMismatch.selector, NONCE + 1, NONCE));
        registry.commitAndApply(m, sig, "", "");
        assertEq(registry.markCount(), 0);
        assertEq(registry.lastPeriodEnd(ORDERLY_BOOK), 0, "period not burned");

        assertEq(_atomic(_mark(_period(), NONCE + 1), "", ""), 1);
        assertTrue(registry.getMark(1).applied);
    }

    function test_commitAndApply_replacesStaleUnappliedMark() public {
        // legacy path: committed, then a capital flow made it unapplicable
        uint64 p = _period();
        BRTypes.MarkInput memory first = _mark(p, NONCE);
        uint256 firstId = registry.commit(first, _sign(markSignerPk, first));
        obook.setFlowNonce(NONCE + 1);
        assertTrue(registry.latestMarkReplaceable(ORDERLY_BOOK));

        BRTypes.MarkInput memory m2 = _mark(p, NONCE + 1);
        bytes memory sig = _sign(markSignerPk, m2);
        vm.expectEmit(true, true, true, true, address(registry));
        emit MarkSuperseded(ORDERLY_BOOK, firstId, firstId + 1, p);
        uint256 id = registry.commitAndApply(m2, sig, "", "");
        assertEq(id, firstId + 1);
        assertEq(registry.latestMarkId(ORDERLY_BOOK), id);
        assertTrue(registry.getMark(id).applied);
        assertFalse(registry.getMark(firstId).applied);
        assertFalse(registry.latestMarkReplaceable(ORDERLY_BOOK));
    }

    function test_legacyCommitThenApply_stillWorks() public {
        BRTypes.MarkInput memory m = _mark(_period(), NONCE);
        uint256 id = registry.commit(m, _sign(markSignerPk, m));
        assertFalse(registry.getMark(id).applied);
        vm.prank(carol);
        obook.applyMark(id);
        assertTrue(registry.getMark(id).applied);
        // an applied period cannot be re-run atomically
        bytes memory sig = _sign(markSignerPk, m);
        vm.expectRevert(
            abi.encodeWithSelector(MarkRegistry.PeriodNotAfterLast.selector, m.periodEnd, m.periodEnd)
        );
        registry.commitAndApply(m, sig, "", "");
    }

    /// @dev commitAndApply accepts exactly the marks commit accepts (and then applies them).
    function testFuzz_commitAndApply_sameAcceptanceAsCommit(uint64 periodEnd, uint32 dt) public {
        vm.warp(block.timestamp + bound(dt, 0, 30 days));
        periodEnd = uint64(bound(periodEnd, 1, block.timestamp + 1 days));
        BRTypes.MarkInput memory m = _mark(periodEnd, NONCE);
        bytes memory sig = _sign(markSignerPk, m);

        uint256 snap = vm.snapshotState();
        (bool okCommit, bytes memory errCommit) =
            address(registry).call(abi.encodeCall(MarkRegistry.commit, (m, sig)));
        vm.revertToState(snap);

        (bool okAtomic, bytes memory errAtomic) = address(registry)
            .call(abi.encodeCall(MarkRegistry.commitAndApply, (m, sig, bytes(""), bytes(""))));
        assertEq(okAtomic, okCommit);
        if (okAtomic) {
            assertTrue(registry.getMark(1).applied);
            assertEq(registry.lastPeriodEnd(ORDERLY_BOOK), periodEnd);
        } else {
            assertEq(keccak256(errAtomic), keccak256(errCommit), "same revert reason");
            assertEq(registry.markCount(), 0);
        }
    }
}

/// @notice Builds a minimal config without an oracle + a registry and an IBook-shaped book on it, registered
///         on the shared mock factory.
contract CoreFixtureNoOracle {
    function deploy(address factory_, address markSigner_, uint256 bookId)
        external
        returns (MarkRegistry r, CAMockBook b)
    {
        NoOracleConfig c = new NoOracleConfig(factory_, markSigner_);
        r = new MarkRegistry(address(c));
        b = new CAMockBook(address(r), bookId);
        BRTypes.BookComponents memory comps;
        comps.book = address(b);
        CoreMockFactoryLike(factory_).register(bookId, comps);
    }
}

interface CoreMockFactoryLike {
    function register(uint256 bookId, BRTypes.BookComponents memory c) external;
}

/// @notice The IBookrunnerConfig reads MarkRegistry performs, with `oracle()` unset.
contract NoOracleConfig {
    address public immutable factory;
    address public immutable signer;

    constructor(address factory_, address signer_) {
        factory = factory_;
        signer = signer_;
    }

    function hasRole(bytes32 role, address a) external view returns (bool) {
        return role == keccak256("MARK_SIGNER") && a == signer;
    }

    function markInterval() external pure returns (uint32) {
        return 300;
    }

    function maxMarkAge() external pure returns (uint32) {
        return 3600;
    }

    function oracle() external pure returns (address) {
        return address(0);
    }
}
