// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {OrderlyAdapter} from "../../src/OrderlyAdapter.sol";
import {IOrderlyAdapter} from "../../src/interfaces/IVenueAdapter.sol";

import {OrderlyFixture} from "./utils/OrderlyFixture.sol";
import {OrderlyAdapterV2} from "./utils/OrderlyTestMocks.sol";

/// @notice LOW_GAS §2: `reportSigned` — EIP-712 venue reports signed off-chain by an OPS_VENUE key and relayed
///         by anyone, with exactly the acceptance rules of the role-gated `report`.
contract OrderlyReportSignedTest is OrderlyFixture {
    uint256 internal constant OPS_SIGNER_PK = 0x0B5;
    address internal opsSigner;

    bytes32 internal constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    event VenueReported(uint256 insuranceUsd, int256 marginUsd, int256 netExposureUsd, uint64 asOf);
    event VenueReportRelayed(address indexed signer, address indexed relayer, uint64 asOf);

    function setUp() public override {
        super.setUp();
        opsSigner = vm.addr(OPS_SIGNER_PK);
        cfg.grantRole(cfg.OPS_VENUE_ROLE(), opsSigner);
    }

    // ---------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------

    function _sign(uint256 pk, OrderlyAdapter a, uint256 ins, int256 margin, int256 exposure, uint64 asOf)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, a.hashReport(ins, margin, exposure, asOf));
        return abi.encodePacked(r, s, v);
    }

    function _relay(uint256 ins, int256 margin, int256 exposure, uint64 asOf) internal {
        bytes memory sig = _sign(OPS_SIGNER_PK, adapter, ins, margin, exposure, asOf);
        vm.prank(alice); // anyone relays
        adapter.reportSigned(ins, margin, exposure, asOf, sig);
    }

    function _now() internal view returns (uint64) {
        return uint64(block.timestamp);
    }

    // ---------------------------------------------------------------------------------------------
    // EIP-712
    // ---------------------------------------------------------------------------------------------

    function test_typehash_matchesLowGasSpec() public view {
        assertEq(
            adapter.REPORT_TYPEHASH(),
            keccak256("VenueReport(uint256 insuranceUsd,int256 marginUsd,int256 netExposureUsd,uint64 asOf)")
        );
        assertEq(IOrderlyAdapter(address(adapter)).REPORT_TYPEHASH(), adapter.REPORT_TYPEHASH());
    }

    function test_domainSeparator_isBoundToProxyAndChain() public {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("Bookrunner OrderlyAdapter"),
                keccak256("1"),
                block.chainid,
                address(adapter)
            )
        );
        assertEq(adapter.DOMAIN_SEPARATOR(), expected);
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifying,
            bytes32 salt,
            uint256[] memory ext
        ) = adapter.eip712Domain();
        assertEq(uint8(fields), 0x0f);
        assertEq(name, "Bookrunner OrderlyAdapter");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifying, address(adapter), "verifyingContract is the proxy, not the implementation");
        assertEq(salt, bytes32(0));
        assertEq(ext.length, 0);

        // fork-safe: the separator follows block.chainid
        vm.chainId(4663);
        assertTrue(adapter.DOMAIN_SEPARATOR() != expected);
    }

    function test_hashReport_manual() public view {
        bytes32 structHash = keccak256(
            abi.encode(
                adapter.REPORT_TYPEHASH(), uint256(25_000e6), int256(76_200e6), -int256(8000e6), _now()
            )
        );
        assertEq(
            adapter.hashReport(25_000e6, 76_200e6, -8000e6, _now()),
            keccak256(abi.encodePacked("\x19\x01", adapter.DOMAIN_SEPARATOR(), structHash))
        );
    }

    // ---------------------------------------------------------------------------------------------
    // happy path
    // ---------------------------------------------------------------------------------------------

    function test_reportSigned_storesAndEmits_anyoneRelays() public {
        _deploy(IF, IF_TARGET);
        _deploy(MM, MM_INVENTORY);
        vm.warp(block.timestamp + 60);
        uint64 asOf = _now() - 5;
        bytes memory sig = _sign(OPS_SIGNER_PK, adapter, 25_000e6, 76_200e6, -8000e6, asOf);

        vm.expectEmit(false, false, false, true, address(adapter));
        emit VenueReported(25_000e6, 76_200e6, -8000e6, asOf);
        vm.expectEmit(true, true, false, true, address(adapter));
        emit VenueReportRelayed(opsSigner, alice, asOf);
        vm.prank(alice);
        adapter.reportSigned(25_000e6, 76_200e6, -8000e6, asOf, sig);

        assertEq(adapter.insuranceEquityUsd(), 25_000e6);
        assertEq(adapter.marginEquityUsd(), int256(76_200e6));
        assertEq(adapter.netExposureUsd(), -int256(8000e6));
        assertEq(adapter.valuationAt(), asOf);
        assertEq(adapter.deployedValueUsd(), 101_200e6);
    }

    function test_reportSigned_roleGatedReportStillWorks_andInterleaves() public {
        _report(1, 1, 1);
        vm.warp(block.timestamp + 1);
        _relay(2, 2, 2, _now());
        assertEq(adapter.insuranceEquityUsd(), 2);
        vm.warp(block.timestamp + 1);
        _report(3, 3, 3);
        assertEq(adapter.insuranceEquityUsd(), 3);
        assertEq(adapter.valuationAt(), _now());
    }

    // ---------------------------------------------------------------------------------------------
    // signature / signer
    // ---------------------------------------------------------------------------------------------

    function test_reportSigned_rejectsMalformedSignature() public {
        vm.expectRevert(OrderlyAdapter.InvalidReportSignature.selector);
        adapter.reportSigned(1, 1, 1, _now(), hex"1234");
        vm.expectRevert(OrderlyAdapter.InvalidReportSignature.selector);
        adapter.reportSigned(1, 1, 1, _now(), "");
        // 64-byte (EIP-2098 compact) signatures are not accepted
        bytes memory sig = _sign(OPS_SIGNER_PK, adapter, 1, 1, 1, _now());
        bytes memory compact = new bytes(64);
        for (uint256 i; i < 64; i++) {
            compact[i] = sig[i];
        }
        vm.expectRevert(OrderlyAdapter.InvalidReportSignature.selector);
        adapter.reportSigned(1, 1, 1, _now(), compact);
    }

    function test_reportSigned_rejectsHighSMalleation() public {
        bytes memory sig = _sign(OPS_SIGNER_PK, adapter, 1, 1, 1, _now());
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        bytes memory malleated =
            abi.encodePacked(r, bytes32(uint256(SECP256K1_N) - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(OrderlyAdapter.InvalidReportSignature.selector);
        adapter.reportSigned(1, 1, 1, _now(), malleated);
    }

    function test_reportSigned_rejectsNonOpsVenueSigner() public {
        uint256 pk = 0xBAD;
        bytes memory sig = _sign(pk, adapter, 1, 1, 1, _now());
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.NotOpsVenueSigner.selector, vm.addr(pk)));
        adapter.reportSigned(1, 1, 1, _now(), sig);
    }

    function test_reportSigned_rejectsRevokedSigner() public {
        bytes memory sig = _sign(OPS_SIGNER_PK, adapter, 1, 1, 1, _now());
        cfg.revokeRole(cfg.OPS_VENUE_ROLE(), opsSigner);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.NotOpsVenueSigner.selector, opsSigner));
        adapter.reportSigned(1, 1, 1, _now(), sig);
    }

    function test_reportSigned_rejectsTamperedPayload() public {
        bytes memory sig = _sign(OPS_SIGNER_PK, adapter, 25_000e6, 75_000e6, 0, _now());
        vm.expectPartialRevert(OrderlyAdapter.NotOpsVenueSigner.selector);
        adapter.reportSigned(25_000e6, 95_000e6, 0, _now(), sig); // margin inflated
        vm.expectPartialRevert(OrderlyAdapter.NotOpsVenueSigner.selector);
        adapter.reportSigned(25_000e6, 75_000e6, 1, _now(), sig); // exposure changed
        vm.expectPartialRevert(OrderlyAdapter.NotOpsVenueSigner.selector);
        adapter.reportSigned(25_000e6, 75_000e6, 0, _now() - 1, sig); // asOf changed
    }

    function test_reportSigned_rejectsSignatureForAnotherAdapter() public {
        OrderlyAdapter other = _deployAdapter(BOOK_ID, true);
        bytes memory sigForOther = _sign(OPS_SIGNER_PK, other, 1, 1, 1, _now());
        vm.expectPartialRevert(OrderlyAdapter.NotOpsVenueSigner.selector);
        adapter.reportSigned(1, 1, 1, _now(), sigForOther);
        // ...while it verifies on the adapter it was signed for
        other.reportSigned(1, 1, 1, _now(), sigForOther);
        assertEq(other.insuranceEquityUsd(), 1);
        assertEq(adapter.insuranceEquityUsd(), 0);
    }

    function test_reportSigned_rejectsSignatureFromAnotherChain() public {
        bytes memory sig = _sign(OPS_SIGNER_PK, adapter, 1, 1, 1, _now());
        vm.chainId(4663);
        vm.expectPartialRevert(OrderlyAdapter.NotOpsVenueSigner.selector);
        adapter.reportSigned(1, 1, 1, _now(), sig);
    }

    function test_reportSigned_ownRoleDoesNotMatter_onlySigner() public {
        // the relayer may hold OPS_VENUE itself: what counts is the recovered signer
        bytes memory sig = _sign(0xBAD, adapter, 1, 1, 1, _now());
        vm.prank(ops);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.NotOpsVenueSigner.selector, vm.addr(0xBAD)));
        adapter.reportSigned(1, 1, 1, _now(), sig);
    }

    // ---------------------------------------------------------------------------------------------
    // report() rules
    // ---------------------------------------------------------------------------------------------

    function test_reportSigned_replayRejected() public {
        uint64 asOf = _now();
        bytes memory sig = _sign(OPS_SIGNER_PK, adapter, 7, 7, 7, asOf);
        adapter.reportSigned(7, 7, 7, asOf, sig);
        vm.warp(block.timestamp + 600);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.StaleReport.selector, asOf, asOf));
        adapter.reportSigned(7, 7, 7, asOf, sig);
    }

    function test_reportSigned_olderReportAfterNewerRejected() public {
        vm.warp(block.timestamp + 100);
        uint64 older = _now() - 50;
        bytes memory oldSig = _sign(OPS_SIGNER_PK, adapter, 1, 1, 1, older);
        _relay(2, 2, 2, _now());
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.StaleReport.selector, older, _now()));
        adapter.reportSigned(1, 1, 1, older, oldSig);
        // an unsigned report with asOf 0 can never land either
        bytes memory zeroSig = _sign(OPS_SIGNER_PK, adapter, 1, 1, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.StaleReport.selector, uint64(0), _now()));
        adapter.reportSigned(1, 1, 1, 0, zeroSig);
    }

    function test_reportSigned_rejectsFuture() public {
        uint64 asOf = _now() + 1;
        bytes memory sig = _sign(OPS_SIGNER_PK, adapter, 1, 1, 1, asOf);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.ReportInFuture.selector, asOf, _now()));
        adapter.reportSigned(1, 1, 1, asOf, sig);
        // valid once its time has come
        vm.warp(asOf);
        adapter.reportSigned(1, 1, 1, asOf, sig);
    }

    function test_reportSigned_cannotPredateLastFlow() public {
        vm.warp(block.timestamp + 100);
        uint64 snapshot = _now() - 1;
        bytes memory sig = _sign(OPS_SIGNER_PK, adapter, 0, 0, 0, snapshot);
        _deploy(MM, 1000e6);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.ReportPredatesFlow.selector, snapshot, _now()));
        adapter.reportSigned(0, 0, 0, snapshot, sig);
        _relay(0, 1000e6, 0, _now()); // same-timestamp snapshot is accepted
    }

    function test_reportSigned_rejectedWhileWithdrawalPending() public {
        _deploy(MM, 10_000e6);
        vm.warp(block.timestamp + 10);
        uint256 nonce = _recall(MM, 4000e6);
        uint64 asOf = _now();
        bytes memory sig = _sign(OPS_SIGNER_PK, adapter, 0, 6000e6, 0, asOf);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.WithdrawalPending.selector, 4000e6));
        adapter.reportSigned(0, 6000e6, 0, asOf, sig);
        // after confirmation the venue-side debit is booked; a snapshot from the confirmation second lands
        _confirm(nonce);
        adapter.reportSigned(0, 6000e6, 0, asOf, sig);
        assertEq(adapter.marginEquityUsd(), int256(6000e6));
        assertEq(adapter.deployedValueUsd(), 10_000e6, "6k venue-side + 4k in transit");
    }

    function test_reportSigned_boundsValues() public {
        uint64 t = _now();
        uint256 bigIns = uint256(type(uint128).max) + 1;
        bytes memory sig = _sign(OPS_SIGNER_PK, adapter, bigIns, 0, 0, t);
        vm.expectRevert(OrderlyAdapter.ReportOutOfRange.selector);
        adapter.reportSigned(bigIns, 0, 0, t, sig);
        int256 big = int256(type(int128).max) + 1;
        sig = _sign(OPS_SIGNER_PK, adapter, 0, big, 0, t);
        vm.expectRevert(OrderlyAdapter.ReportOutOfRange.selector);
        adapter.reportSigned(0, big, 0, t, sig);
        int256 small = int256(type(int128).min) - 1;
        sig = _sign(OPS_SIGNER_PK, adapter, 0, 0, small, t);
        vm.expectRevert(OrderlyAdapter.ReportOutOfRange.selector);
        adapter.reportSigned(0, 0, small, t, sig);
        _relay(type(uint128).max, type(int128).max, type(int128).min, t);
        assertEq(adapter.netExposureUsd(), int256(type(int128).min));
    }

    function test_reportSigned_survivesUpgrade() public {
        OrderlyAdapterV2 v2 = new OrderlyAdapterV2(BROKER_HASH, TOKEN_HASH);
        bytes32 domainBefore = adapter.DOMAIN_SEPARATOR();
        bytes memory sig = _sign(OPS_SIGNER_PK, adapter, 5, 5, 5, _now());
        vm.prank(timelock);
        adapter.upgradeToAndCall(address(v2), "");
        assertEq(adapter.DOMAIN_SEPARATOR(), domainBefore, "domain bound to the proxy");
        adapter.reportSigned(5, 5, 5, _now(), sig);
        assertEq(adapter.insuranceEquityUsd(), 5);
    }

    /// @dev Signed and role-gated reports accept/reject identically and leave identical state.
    function testFuzz_reportSigned_parityWithReport(
        uint256 ins,
        int256 margin,
        int256 exposure,
        uint32 dtSnapshot,
        uint32 dtNow,
        bool pending
    ) public {
        ins = bound(ins, 0, uint256(type(uint128).max) + 2);
        margin = bound(margin, int256(type(int128).min) - 2, int256(type(int128).max) + 2);
        exposure = bound(exposure, int256(type(int128).min) - 2, int256(type(int128).max) + 2);
        _deploy(MM, 1000e6);
        _report(0, 1000e6, 0);
        if (pending) _recall(MM, 1);
        vm.warp(block.timestamp + bound(dtNow, 0, 1 days));
        uint64 asOf = uint64(bound(dtSnapshot, 0, block.timestamp + 10));

        uint256 snap = vm.snapshotState();
        vm.prank(ops);
        (bool okA, bytes memory errA) =
            address(adapter).call(abi.encodeCall(OrderlyAdapter.report, (ins, margin, exposure, asOf)));
        bytes32 stateA = _stateHash();
        vm.revertToState(snap);

        bytes memory sig = _sign(OPS_SIGNER_PK, adapter, ins, margin, exposure, asOf);
        (bool okB, bytes memory errB) = address(adapter)
            .call(abi.encodeCall(OrderlyAdapter.reportSigned, (ins, margin, exposure, asOf, sig)));
        assertEq(okA, okB, "same acceptance");
        assertEq(keccak256(errA), keccak256(errB), "same revert reason");
        assertEq(_stateHash(), stateA, "same resulting state");
    }

    function _stateHash() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                adapter.insuranceEquityUsd(),
                adapter.marginEquityUsd(),
                adapter.netExposureUsd(),
                adapter.valuationAt(),
                adapter.deployedValueUsd()
            )
        );
    }
}
