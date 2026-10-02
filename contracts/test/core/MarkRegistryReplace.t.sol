// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoreFixture} from "./utils/CoreFixture.sol";
import {MarkRegistry} from "../../src/MarkRegistry.sol";
import {IMarkRegistry} from "../../src/interfaces/IMarkRegistry.sol";
import {BRTypes} from "../../src/interfaces/BRTypes.sol";

/// @dev View added by the fix, called through an interface so the file also compiles pre-fix.
interface IMarkRegistryReplaceView {
    function latestMarkReplaceable(uint256 bookId) external view returns (bool);
}

/// @notice Regression tests (findings flownonce-grief-voids-marks / flownonce-grief-burns-marks /
///         permissionless-flownonce-bump-mark-dos): a mark committed but not applied whose flowNonce no
///         longer matches `book.flowNonce()` can be replaced for the same periodEnd, so one capital flow
///         between commit and apply can never burn a period. An applicable or applied mark can never be
///         replaced, and older periods stay closed.
contract MarkRegistryReplaceTest is CoreFixture {
    uint32 internal constant INTERVAL = 300;
    uint32 internal constant MAX_AGE = 3600;

    event MarkSuperseded(
        uint256 indexed bookId, uint256 indexed oldMarkId, uint256 indexed newMarkId, uint64 periodEnd
    );

    function setUp() public override {
        super.setUp();
        vm.startPrank(admin);
        config.setParam("markInterval", INTERVAL);
        config.setParam("maxMarkAge", MAX_AGE);
        vm.stopPrank();
        book.setFlowNonce(7);
    }

    function _period() internal view returns (uint64) {
        return uint64((block.timestamp / INTERVAL) * INTERVAL);
    }

    function _mark(uint64 periodEnd, uint64 nonce, uint256 nav)
        internal
        pure
        returns (BRTypes.MarkInput memory m)
    {
        m = BRTypes.MarkInput({
            bookId: BOOK_ID,
            periodEnd: periodEnd,
            navUsd: nav,
            deployedValueUsd: 900_000e6,
            flowNonce: nonce,
            inventoryRoot: keccak256("inv"),
            pnlJsonHash: keccak256("pnl"),
            receiptsRoot: keccak256("receipts")
        });
    }

    function _sig(uint256 pk, BRTypes.MarkInput memory m) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, registry.hashMark(m));
        return abi.encodePacked(r, s, v);
    }

    function _commit(BRTypes.MarkInput memory m) internal returns (uint256) {
        return registry.commit(m, _sig(markSignerPk, m));
    }

    function _replaceable() internal view returns (bool) {
        return IMarkRegistryReplaceView(address(registry)).latestMarkReplaceable(BOOK_ID);
    }

    function test_staleUnappliedMark_isReplacedForSamePeriod() public {
        uint64 p = _period();
        uint256 first = _commit(_mark(p, 7, 1_000_000e6));
        assertFalse(_replaceable(), "an applicable mark is not replaceable");

        // a capital flow lands between commit and apply: the committed mark can never be applied
        book.setFlowNonce(8);
        assertTrue(_replaceable());

        BRTypes.MarkInput memory m2 = _mark(p, 8, 1_000_100e6);
        bytes memory sig = _sig(markSignerPk, m2);
        vm.expectEmit(true, true, true, true, address(registry));
        emit MarkSuperseded(BOOK_ID, first, first + 1, p);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IMarkRegistry.MarkCommitted(
            first + 1,
            BOOK_ID,
            p,
            m2.navUsd,
            m2.deployedValueUsd,
            m2.inventoryRoot,
            m2.pnlJsonHash,
            m2.receiptsRoot,
            markSigner
        );
        vm.prank(bob); // anyone may relay
        uint256 second = registry.commit(m2, sig);

        assertEq(second, first + 1);
        assertEq(registry.latestMarkId(BOOK_ID), second);
        assertEq(registry.lastPeriodEnd(BOOK_ID), p);
        assertEq(registry.getMark(second).input.flowNonce, 8);
        assertFalse(registry.getMark(first).applied);
        assertFalse(_replaceable(), "the replacement is applicable");

        // the replacement is applied normally by the book
        book.applyMark(address(registry), second);
        assertTrue(registry.getMark(second).applied);
    }

    function test_replacement_canRepeatWhileTheNonceKeepsMoving() public {
        uint64 p = _period();
        uint256 id = _commit(_mark(p, 7, 1));
        for (uint64 n = 8; n < 12; n++) {
            book.setFlowNonce(n);
            id = _commit(_mark(p, n, n));
            assertEq(registry.latestMarkId(BOOK_ID), id);
        }
        assertEq(registry.markCount(), 5);
        book.applyMark(address(registry), id);
    }

    function test_samePeriod_rejectedWhileLatestMarkIsApplicable() public {
        uint64 p = _period();
        _commit(_mark(p, 7, 1_000_000e6));
        // a different mark (equivocation) for the same period at the same nonce is still rejected
        BRTypes.MarkInput memory other = _mark(p, 7, 2_000_000e6);
        bytes memory sig = _sig(markSignerPk, other);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.PeriodNotAfterLast.selector, p, p));
        registry.commit(other, sig);
    }

    function test_samePeriod_rejectedOnceLatestMarkApplied() public {
        uint64 p = _period();
        uint256 id = _commit(_mark(p, 7, 1_000_000e6));
        book.applyMark(address(registry), id);
        book.setFlowNonce(8);
        assertFalse(_replaceable());
        BRTypes.MarkInput memory m2 = _mark(p, 8, 1_000_000e6);
        bytes memory sig = _sig(markSignerPk, m2);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.PeriodNotAfterLast.selector, p, p));
        registry.commit(m2, sig);
    }

    function test_olderPeriod_neverReplaceable() public {
        uint64 p = _period();
        _commit(_mark(p, 7, 1));
        vm.warp(block.timestamp + INTERVAL);
        uint64 p2 = _period();
        _commit(_mark(p2, 7, 2));
        book.setFlowNonce(8);
        BRTypes.MarkInput memory old = _mark(p, 8, 3);
        bytes memory sig = _sig(markSignerPk, old);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.PeriodNotAfterLast.selector, p, p2));
        registry.commit(old, sig);
        // the latest period is replaceable instead
        _commit(_mark(p2, 8, 4));
    }

    function test_replacement_stillRequiresSignerAndAge() public {
        uint64 p = _period();
        _commit(_mark(p, 7, 1));
        book.setFlowNonce(8);

        BRTypes.MarkInput memory m2 = _mark(p, 8, 2);
        bytes memory bad = _sig(0xBAD, m2);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.NotMarkSigner.selector, vm.addr(0xBAD)));
        registry.commit(m2, bad);

        vm.warp(uint256(p) + MAX_AGE + 1);
        bytes memory sig = _sig(markSignerPk, m2);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.MarkTooOld.selector, p, block.timestamp, MAX_AGE));
        registry.commit(m2, sig);
    }

    function test_noMarkYet_zeroPeriodStillRejected() public {
        BRTypes.MarkInput memory m = _mark(0, 0, 1);
        book.setFlowNonce(1);
        bytes memory sig = _sig(markSignerPk, m);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.PeriodNotAfterLast.selector, 0, 0));
        registry.commit(m, sig);
        assertFalse(_replaceable());
    }
}
