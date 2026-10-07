// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoreFixture} from "../../core/utils/CoreFixture.sol";
import {CAMockBook, CAMockAdapter, CAMockOracle} from "../../core/MarkRegistryCommitAndApply.t.sol";
import {BRTypes} from "../../../src/interfaces/BRTypes.sol";

/// @notice Security audit, area 2 (marks). Asserts the SECURE behaviour; fails on the audited code.
contract Area2MarkAuditTest is CoreFixture {
    uint32 internal constant INTERVAL = 300;
    uint32 internal constant MAX_AGE = 3600;
    uint256 internal constant OBOOK = 5;
    uint64 internal constant NONCE = 4;

    CAMockBook internal obook;
    CAMockAdapter internal oadapter;
    CAMockOracle internal oracleStub;

    function setUp() public override {
        super.setUp();
        vm.startPrank(admin);
        config.setParam("markInterval", INTERVAL);
        config.setParam("maxMarkAge", MAX_AGE);
        vm.stopPrank();
        obook = new CAMockBook(address(registry), OBOOK);
        oadapter = new CAMockAdapter(address(registry));
        oracleStub = new CAMockOracle(address(registry));
        obook.setFlowNonce(NONCE);
        BRTypes.BookComponents memory c;
        c.book = address(obook);
        c.adapter = address(oadapter);
        c.vault = makeAddr("ovault");
        c.router = makeAddr("orouter");
        factory.register(OBOOK, c);
        vm.prank(admin);
        config.setAddress("oracle", address(oracleStub));
    }

    function _mark() internal view returns (BRTypes.MarkInput memory m) {
        m = BRTypes.MarkInput({
            bookId: OBOOK,
            periodEnd: uint64((block.timestamp / INTERVAL) * INTERVAL),
            navUsd: 100_000e6,
            deployedValueUsd: 99_000e6,
            flowNonce: NONCE,
            inventoryRoot: keccak256("inv"),
            pnlJsonHash: keccak256("pnl"),
            receiptsRoot: keccak256("receipts")
        });
    }

    // =========================================================================================
    // A2-04  Front-running commitAndApply with a bare commit() of the same signed mark reverts the
    //        keeper's atomic mark (and drops its price bundle + venue report)
    // =========================================================================================

    /// @dev The keeper broadcasts commitAndApply(m, sig, prices, report). Anyone copies (m, sig) from the
    ///      mempool and front-runs with the permissionless `commit(m, sig)`: the mark is now the latest,
    ///      applicable mark of the period, so the keeper's call reverts PeriodNotAfterLast — the mark is left
    ///      committed-but-unapplied and the period's prices / venue report never land. The registry already
    ///      neutralises the same front-run on the venue report (VenueReportSkipped); the mark step should be
    ///      idempotent the same way (apply the identical already-committed mark instead of reverting).
    function test_audit_commitFrontRunRevertsAtomicMark() public {
        BRTypes.MarkInput memory m = _mark();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(markSignerPk, registry.hashMark(m));
        bytes memory sig = abi.encodePacked(r, s, v);
        bytes memory priceData = abi.encode(uint256(1), bytes32("NVDA"), uint256(180e18));
        bytes memory report =
            abi.encode(uint256(25_000e6), int256(74_000e6), -int256(1500e6), uint64(block.timestamp - 3), hex"c0ffee");

        vm.prank(carol); // griefer copies the keeper's (m, sig) from the mempool
        registry.commit(m, sig);

        vm.prank(keeper);
        (bool ok,) = address(registry).call(
            abi.encodeWithSignature(
                "commitAndApply((uint256,uint64,uint256,uint256,uint64,bytes32,bytes32,bytes32),bytes,bytes,bytes)",
                m,
                sig,
                priceData,
                report
            )
        );
        assertTrue(ok, "keeper's atomic mark reverted after a bare commit() front-run");
        assertEq(obook.applyCalls(), 1, "mark applied in the keeper's transaction");
        assertEq(oracleStub.updateCalls(), 1, "period prices landed");
        assertEq(oadapter.reportCalls(), 1, "venue report landed");
    }
}
