// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EngineBase} from "./utils/EngineBase.sol";
import {AttestedOracle} from "../../src/AttestedOracle.sol";
import {IAttestedOracle} from "../../src/interfaces/IAttestedOracle.sol";

/// @notice VERIFY E1: TEE signer registration. The quote itself is verified off-chain (platform-specific
///         collateral); the contract enforces the measurement allow-list, the timelock and records a digest
///         binding (chain, oracle, signer, platform, measurement, quoteHash). The type hashes and encodings
///         are mirrored by services/oracle/src/attestation.ts (test: attestation.test.ts).
contract AttestedOracleAttestationTest is EngineBase {
    uint256 internal constant TEE_PK = 0x7EE;
    bytes32 internal constant PLATFORM = bytes32("INTEL_TDX");
    bytes32 internal constant MEASUREMENT = keccak256("bookrunner-oracle-enclave v1.0.0");
    bytes32 internal constant QUOTE_HASH = keccak256("raw quote bytes");

    event SignerSet(address indexed signer, bool active, bytes32 attestation);
    event MeasurementSet(bytes32 indexed measurement, bool allowed);
    event AttestationRequiredSet();
    event SignerAttested(
        address indexed signer, bytes32 indexed platform, bytes32 indexed measurement, bytes32 quoteHash, bytes32 attestation
    );

    address internal tee;

    function setUp() public {
        _deployCore();
        tee = vm.addr(TEE_PK);
    }

    function test_typehashes_pinned() public view {
        // byte-identical to services/oracle/src/attestation.ts
        assertEq(
            oracle.REPORT_DATA_TYPEHASH(), keccak256("BookrunnerOracleSigner(uint256 chainId,address oracle,address signer)")
        );
        assertEq(
            oracle.ATTESTATION_TYPEHASH(),
            keccak256(
                "SignerAttestation(uint256 chainId,address oracle,address signer,bytes32 platform,bytes32 measurement,bytes32 quoteHash)"
            )
        );
    }

    function test_reportData_and_digest_encoding() public {
        vm.chainId(4663);
        assertEq(
            oracle.reportDataOf(tee), keccak256(abi.encode(oracle.REPORT_DATA_TYPEHASH(), uint256(4663), address(oracle), tee))
        );
        assertEq(
            oracle.attestationDigest(tee, PLATFORM, MEASUREMENT, QUOTE_HASH),
            keccak256(
                abi.encode(
                    oracle.ATTESTATION_TYPEHASH(), uint256(4663), address(oracle), tee, PLATFORM, MEASUREMENT, QUOTE_HASH
                )
            )
        );
        // bound to the chain: the same quote cannot be replayed on another deployment / chain
        bytes32 onMainnet = oracle.reportDataOf(tee);
        vm.chainId(46_630);
        assertTrue(oracle.reportDataOf(tee) != onMainnet);
    }

    function test_setAttestedSigner_flow() public {
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.MeasurementNotAllowed.selector, MEASUREMENT));
        oracle.setAttestedSigner(tee, PLATFORM, MEASUREMENT, QUOTE_HASH);

        vm.expectEmit(true, false, false, true, address(oracle));
        emit MeasurementSet(MEASUREMENT, true);
        vm.prank(timelock);
        oracle.setMeasurement(MEASUREMENT, true);

        bytes32 digest = oracle.attestationDigest(tee, PLATFORM, MEASUREMENT, QUOTE_HASH);
        vm.expectEmit(true, true, true, true, address(oracle));
        emit SignerAttested(tee, PLATFORM, MEASUREMENT, QUOTE_HASH, digest);
        vm.expectEmit(true, false, false, true, address(oracle));
        emit SignerSet(tee, true, digest);
        vm.prank(timelock);
        oracle.setAttestedSigner(tee, PLATFORM, MEASUREMENT, QUOTE_HASH);
        assertTrue(oracle.isSigner(tee));
        assertEq(oracle.attestationOf(tee), digest);
        assertEq(oracle.measurementOf(tee), MEASUREMENT);

        // the attested key signs prices like any registered signer
        vm.prank(tee);
        oracle.push(_update(PID_B, 190e18, uint64(block.timestamp), false, 3), _sign(TEE_PK, _update(PID_B, 190e18, uint64(block.timestamp), false, 3)));
        (uint256 px,) = oracle.priceOf(PID_B);
        assertEq(px, 190e18);

        // revoking the measurement blocks new registrations; existing signers are deactivated explicitly
        vm.startPrank(timelock);
        oracle.setMeasurement(MEASUREMENT, false);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.MeasurementNotAllowed.selector, MEASUREMENT));
        oracle.setAttestedSigner(makeAddr("tee2"), PLATFORM, MEASUREMENT, QUOTE_HASH);
        oracle.setSigner(tee, false, bytes32(0));
        vm.stopPrank();
        assertFalse(oracle.isSigner(tee));
        assertEq(oracle.measurementOf(tee), bytes32(0));
    }

    function test_requireAttestations_blocksPlainActivation() public {
        vm.startPrank(timelock);
        vm.expectEmit(false, false, false, true, address(oracle));
        emit AttestationRequiredSet();
        oracle.requireAttestations();
        assertTrue(oracle.attestationRequired());
        vm.expectRevert(AttestedOracle.AttestationRequired.selector);
        oracle.setSigner(tee, true, bytes32("plain"));
        // deactivation stays possible (the devnet bootstrap signer can be removed)
        oracle.setSigner(signer, false, bytes32(0));
        assertFalse(oracle.isSigner(signer));
        oracle.setMeasurement(MEASUREMENT, true);
        oracle.setAttestedSigner(tee, PLATFORM, MEASUREMENT, QUOTE_HASH);
        vm.stopPrank();
        assertTrue(oracle.isSigner(tee));
    }

    function test_guards() public {
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.NotTimelock.selector, stranger));
        oracle.setMeasurement(MEASUREMENT, true);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.NotTimelock.selector, stranger));
        oracle.setAttestedSigner(tee, PLATFORM, MEASUREMENT, QUOTE_HASH);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.NotTimelock.selector, stranger));
        oracle.requireAttestations();
        vm.stopPrank();

        vm.startPrank(timelock);
        vm.expectRevert(AttestedOracle.BadAttestation.selector);
        oracle.setMeasurement(bytes32(0), true);
        oracle.setMeasurement(MEASUREMENT, true);
        vm.expectRevert(AttestedOracle.ZeroAddress.selector);
        oracle.setAttestedSigner(address(0), PLATFORM, MEASUREMENT, QUOTE_HASH);
        vm.expectRevert(AttestedOracle.BadAttestation.selector);
        oracle.setAttestedSigner(tee, bytes32(0), MEASUREMENT, QUOTE_HASH);
        vm.expectRevert(AttestedOracle.BadAttestation.selector);
        oracle.setAttestedSigner(tee, PLATFORM, MEASUREMENT, bytes32(0));
        vm.stopPrank();
    }

    function test_unsetByDefault() public view {
        assertFalse(oracle.attestationRequired());
        assertFalse(oracle.measurementAllowed(MEASUREMENT));
        // keeps the IAttestedOracle surface (interface-typed callers unaffected)
        assertTrue(IAttestedOracle(address(oracle)).isSigner(signer));
    }
}
