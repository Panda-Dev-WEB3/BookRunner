// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoreFixture} from "./utils/CoreFixture.sol";
import {CoreMockBook} from "./utils/CoreMocks.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {MarkRegistry} from "../../src/MarkRegistry.sol";
import {IMarkRegistry} from "../../src/interfaces/IMarkRegistry.sol";
import {BRTypes} from "../../src/interfaces/BRTypes.sol";

contract MarkRegistryTest is CoreFixture {
    uint32 internal constant INTERVAL = 300;
    uint32 internal constant MAX_AGE = 3600;

    function setUp() public override {
        super.setUp();
        vm.startPrank(admin);
        config.setParam("markInterval", INTERVAL);
        config.setParam("maxMarkAge", MAX_AGE);
        vm.stopPrank();
        // marks built by `_mark` carry flowNonce 3: keep them applicable (a stale latest mark is replaceable)
        book.setFlowNonce(3);
    }

    function _period() internal view returns (uint64) {
        return uint64((block.timestamp / INTERVAL) * INTERVAL);
    }

    function _mark(uint256 bookId, uint64 periodEnd) internal pure returns (BRTypes.MarkInput memory m) {
        m = BRTypes.MarkInput({
            bookId: bookId,
            periodEnd: periodEnd,
            navUsd: 1_000_000e6,
            deployedValueUsd: 900_000e6,
            flowNonce: 3,
            inventoryRoot: keccak256("inv"),
            pnlJsonHash: keccak256("pnl"),
            receiptsRoot: keccak256("receipts")
        });
    }

    function _sign(uint256 pk, BRTypes.MarkInput memory m) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, registry.hashMark(m));
        return abi.encodePacked(r, s, v);
    }

    function _commit(BRTypes.MarkInput memory m) internal returns (uint256) {
        return registry.commit(m, _sign(markSignerPk, m));
    }

    // ---------------------------------------------------------------- EIP-712

    function test_typehash_matchesSharedEip712() public view {
        assertEq(
            registry.MARK_TYPEHASH(),
            keccak256(
                "Mark(uint256 bookId,uint64 periodEnd,uint256 navUsd,uint256 deployedValueUsd,uint64 flowNonce,bytes32 inventoryRoot,bytes32 pnlJsonHash,bytes32 receiptsRoot)"
            )
        );
    }

    function test_domainSeparator() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("Bookrunner MarkRegistry"),
                keccak256("1"),
                block.chainid,
                address(registry)
            )
        );
        assertEq(registry.DOMAIN_SEPARATOR(), expected);
        (, string memory name, string memory version,, address verifying,,) = registry.eip712Domain();
        assertEq(name, "Bookrunner MarkRegistry");
        assertEq(version, "1");
        assertEq(verifying, address(registry));
    }

    function test_hashMark_manual() public view {
        BRTypes.MarkInput memory m = _mark(BOOK_ID, 600);
        bytes32 structHash = keccak256(
            abi.encode(
                registry.MARK_TYPEHASH(),
                m.bookId,
                m.periodEnd,
                m.navUsd,
                m.deployedValueUsd,
                m.flowNonce,
                m.inventoryRoot,
                m.pnlJsonHash,
                m.receiptsRoot
            )
        );
        assertEq(
            registry.hashMark(m),
            keccak256(abi.encodePacked("\x19\x01", registry.DOMAIN_SEPARATOR(), structHash))
        );
    }

    function test_constructor_revertsZeroConfig() public {
        vm.expectRevert(MarkRegistry.ZeroAddress.selector);
        new MarkRegistry(address(0));
    }

    // ---------------------------------------------------------------- commit

    function test_commit() public {
        BRTypes.MarkInput memory m = _mark(BOOK_ID, _period());
        bytes memory sig = _sign(markSignerPk, m);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IMarkRegistry.MarkCommitted(
            1,
            BOOK_ID,
            m.periodEnd,
            m.navUsd,
            m.deployedValueUsd,
            m.inventoryRoot,
            m.pnlJsonHash,
            m.receiptsRoot,
            markSigner
        );
        vm.prank(bob); // anyone may relay
        uint256 id = registry.commit(m, sig);
        assertEq(id, 1);
        assertEq(registry.markCount(), 1);
        assertEq(registry.latestMarkId(BOOK_ID), 1);
        assertEq(registry.lastPeriodEnd(BOOK_ID), m.periodEnd);
        BRTypes.Mark memory got = registry.getMark(1);
        assertEq(got.input.bookId, BOOK_ID);
        assertEq(got.input.periodEnd, m.periodEnd);
        assertEq(got.input.navUsd, m.navUsd);
        assertEq(got.input.deployedValueUsd, m.deployedValueUsd);
        assertEq(got.input.flowNonce, m.flowNonce);
        assertEq(got.input.inventoryRoot, m.inventoryRoot);
        assertEq(got.input.pnlJsonHash, m.pnlJsonHash);
        assertEq(got.input.receiptsRoot, m.receiptsRoot);
        assertEq(got.signer, markSigner);
        assertEq(got.committedAt, block.timestamp);
        assertFalse(got.applied);
    }

    function test_commit_globalIdsAcrossBooks() public {
        _deployBook(2, 6000, makeAddr("vault2"));
        uint64 p = _period();
        assertEq(_commit(_mark(BOOK_ID, p)), 1);
        assertEq(_commit(_mark(2, p)), 2);
        vm.warp(block.timestamp + INTERVAL);
        assertEq(_commit(_mark(BOOK_ID, _period())), 3);
        assertEq(registry.latestMarkId(BOOK_ID), 3);
        assertEq(registry.latestMarkId(2), 2);
        assertEq(registry.latestMarkId(99), 0);
    }

    function test_commit_ageBoundary() public {
        uint64 p = _period();
        vm.warp(uint256(p) + MAX_AGE); // exactly maxMarkAge old: accepted
        assertEq(_commit(_mark(BOOK_ID, p)), 1);
        vm.warp(uint256(p) + MAX_AGE + INTERVAL + 1);
        uint64 p2 = p + INTERVAL;
        BRTypes.MarkInput memory m2 = _mark(BOOK_ID, p2);
        bytes memory sig = _sign(markSignerPk, m2);
        vm.expectRevert(
            abi.encodeWithSelector(MarkRegistry.MarkTooOld.selector, p2, block.timestamp, MAX_AGE)
        );
        registry.commit(m2, sig);
    }

    function test_commit_periodAtNowAccepted() public {
        vm.warp(uint256(_period()) + INTERVAL);
        assertEq(uint256(_period()), block.timestamp);
        _commit(_mark(BOOK_ID, _period()));
    }

    function test_commit_revertsBadSignature() public {
        BRTypes.MarkInput memory m = _mark(BOOK_ID, _period());
        vm.expectRevert(MarkRegistry.InvalidSignature.selector);
        registry.commit(m, hex"1234");

        bytes memory sig = _sign(markSignerPk, m);
        // high-s malleated signature is rejected
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        bytes32 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory malleated =
            abi.encodePacked(r, bytes32(uint256(n) - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(MarkRegistry.InvalidSignature.selector);
        registry.commit(m, malleated);
    }

    function test_commit_revertsNonSigner() public {
        BRTypes.MarkInput memory m = _mark(BOOK_ID, _period());
        uint256 pk = 0xBAD;
        bytes memory sig = _sign(pk, m);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.NotMarkSigner.selector, vm.addr(pk)));
        registry.commit(m, sig);
    }

    function test_commit_revertsRevokedSigner() public {
        BRTypes.MarkInput memory m = _mark(BOOK_ID, _period());
        bytes memory sig = _sign(markSignerPk, m);
        bytes32 role = config.MARK_SIGNER_ROLE();
        vm.prank(admin);
        config.revokeRole(role, markSigner);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.NotMarkSigner.selector, markSigner));
        registry.commit(m, sig);
    }

    function test_commit_revertsTamperedPayload() public {
        BRTypes.MarkInput memory m = _mark(BOOK_ID, _period());
        bytes memory sig = _sign(markSignerPk, m);
        m.deployedValueUsd += 1;
        vm.expectRevert(); // recovers to an unrelated address
        registry.commit(m, sig);
    }

    function test_commit_revertsNotAligned() public {
        uint64 p = _period() - 1;
        BRTypes.MarkInput memory m = _mark(BOOK_ID, p);
        bytes memory sig = _sign(markSignerPk, m);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.PeriodNotAligned.selector, p, INTERVAL));
        registry.commit(m, sig);
    }

    function test_commit_revertsNotAfterLast() public {
        uint64 p = _period();
        _commit(_mark(BOOK_ID, p));
        // same period (replay of the same signed mark)
        BRTypes.MarkInput memory same = _mark(BOOK_ID, p);
        bytes memory sig = _sign(markSignerPk, same);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.PeriodNotAfterLast.selector, p, p));
        registry.commit(same, sig);
        // older period
        BRTypes.MarkInput memory older = _mark(BOOK_ID, p - INTERVAL);
        sig = _sign(markSignerPk, older);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.PeriodNotAfterLast.selector, p - INTERVAL, p));
        registry.commit(older, sig);
    }

    function test_commit_revertsZeroPeriod() public {
        BRTypes.MarkInput memory m = _mark(BOOK_ID, 0);
        bytes memory sig = _sign(markSignerPk, m);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.PeriodNotAfterLast.selector, 0, 0));
        registry.commit(m, sig);
    }

    function test_commit_revertsFuture() public {
        uint64 p = _period() + INTERVAL;
        BRTypes.MarkInput memory m = _mark(BOOK_ID, p);
        bytes memory sig = _sign(markSignerPk, m);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.PeriodInFuture.selector, p, block.timestamp));
        registry.commit(m, sig);
    }

    function test_commit_revertsUnknownBook() public {
        BRTypes.MarkInput memory m = _mark(42, _period());
        bytes memory sig = _sign(markSignerPk, m);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.UnknownBook.selector, 42));
        registry.commit(m, sig);
    }

    function test_commit_revertsFactoryUnset() public {
        BookrunnerConfig c2 = new BookrunnerConfig(admin);
        vm.startPrank(admin);
        c2.grantRole(c2.MARK_SIGNER_ROLE(), markSigner);
        c2.setParam("markInterval", INTERVAL);
        vm.stopPrank();
        MarkRegistry r2 = new MarkRegistry(address(c2));
        BRTypes.MarkInput memory m = _mark(BOOK_ID, _period());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(markSignerPk, r2.hashMark(m));
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.NotConfigured.selector, bytes32("factory")));
        r2.commit(m, abi.encodePacked(r, s, v));
    }

    function test_commit_crossRegistryReplayRejected() public {
        // a signature for this registry's domain does not verify on another registry (different domain)
        MarkRegistry r2 = new MarkRegistry(address(config));
        BRTypes.MarkInput memory m = _mark(BOOK_ID, _period());
        bytes memory sig = _sign(markSignerPk, m);
        vm.expectRevert();
        r2.commit(m, sig);
    }

    // ---------------------------------------------------------------- getMark / markApplied

    function test_getMark_revertsUnknown() public {
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.UnknownMark.selector, 0));
        registry.getMark(0);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.UnknownMark.selector, 1));
        registry.getMark(1);
    }

    function test_markApplied() public {
        uint256 id = _commit(_mark(BOOK_ID, _period()));
        vm.expectEmit(true, true, false, true, address(registry));
        emit IMarkRegistry.MarkApplied(id, BOOK_ID);
        book.applyMark(address(registry), id);
        assertTrue(registry.getMark(id).applied);

        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.AlreadyApplied.selector, id));
        book.applyMark(address(registry), id);
    }

    function test_markApplied_reverts() public {
        uint256 id = _commit(_mark(BOOK_ID, _period()));
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.NotBook.selector, id, alice));
        vm.prank(alice);
        registry.markApplied(id);

        (CoreMockBook book2,,,) = _deployBook(2, 6000, makeAddr("vault2"));
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.NotBook.selector, id, address(book2)));
        book2.applyMark(address(registry), id);

        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.UnknownMark.selector, 0));
        book.applyMark(address(registry), 0);
        vm.expectRevert(abi.encodeWithSelector(MarkRegistry.UnknownMark.selector, 2));
        book.applyMark(address(registry), 2);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_commit_onlyValidPeriods(uint64 periodEnd, uint32 dt) public {
        vm.warp(block.timestamp + bound(dt, 0, 30 days));
        periodEnd = uint64(bound(periodEnd, 1, block.timestamp + 1 days));
        BRTypes.MarkInput memory m = _mark(BOOK_ID, periodEnd);
        bytes memory sig = _sign(markSignerPk, m);
        bool valid = periodEnd % INTERVAL == 0 && periodEnd <= block.timestamp
            && block.timestamp - periodEnd <= MAX_AGE;
        if (valid) {
            assertEq(registry.commit(m, sig), 1);
            assertEq(registry.lastPeriodEnd(BOOK_ID), periodEnd);
        } else {
            vm.expectRevert();
            registry.commit(m, sig);
        }
    }
}
