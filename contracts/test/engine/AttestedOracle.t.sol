// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EngineBase} from "./utils/EngineBase.sol";
import {AttestedOracle} from "../../src/AttestedOracle.sol";
import {IAttestedOracle} from "../../src/interfaces/IAttestedOracle.sol";

contract AttestedOracleTest is EngineBase {
    event PricePushed(
        bytes32 indexed underlying,
        uint256 priceWad,
        uint64 publishedAt,
        bool held,
        uint32 sourceCount,
        address signer
    );
    event SignerSet(address indexed signer, bool active, bytes32 attestation);
    event PriceSkipped(bytes32 indexed underlying, uint64 storedPublishedAt, uint64 incomingPublishedAt);
    event MinSourcesSet(uint32 minSources);

    uint256 internal constant OTHER_PK = 0xB0B;

    function setUp() public {
        _deployCore();
    }

    // ------------------------------------------------------------------ construction / EIP-712

    function test_constructor_state() public view {
        assertEq(address(oracle.config()), address(cfg));
        assertEq(oracle.minSources(), 3);
        assertTrue(oracle.isSigner(signer));
        assertEq(oracle.attestationOf(signer), bytes32("devnet-attestation"));
        assertFalse(oracle.isSigner(vm.addr(OTHER_PK)));
    }

    function test_constructor_noInitialSigner() public {
        AttestedOracle o = new AttestedOracle(address(cfg), address(0), bytes32(0));
        assertFalse(o.isSigner(address(0)));
        assertEq(o.minSources(), 3);
    }

    function test_constructor_zeroConfigReverts() public {
        vm.expectRevert(AttestedOracle.ZeroAddress.selector);
        new AttestedOracle(address(0), signer, bytes32(0));
    }

    function test_typehash_matchesSharedEip712() public view {
        assertEq(
            oracle.PRICE_TYPEHASH(),
            keccak256(
                "Price(bytes32 underlying,uint256 priceWad,uint64 publishedAt,bool held,uint32 sourceCount,bytes32 sourcesHash)"
            )
        );
    }

    function test_hashPrice_matchesManualDigest() public view {
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 123e18, uint64(block.timestamp), true, 2);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("Bookrunner AttestedOracle"),
                keccak256("1"),
                block.chainid,
                address(oracle)
            )
        );
        assertEq(oracle.domainSeparator(), domain);
        bytes32 structHash = keccak256(
            abi.encode(
                oracle.PRICE_TYPEHASH(),
                u.underlying,
                u.priceWad,
                u.publishedAt,
                u.held,
                u.sourceCount,
                u.sourcesHash
            )
        );
        assertEq(oracle.hashPrice(u), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }

    // ------------------------------------------------------------------ push

    /// @dev Relayers: an active signer, the KEEPER role or the timelock. Anyone else (a trader holding a
    ///      leaked signature) is refused, for push and pushMany alike.
    function test_push_onlyRelayers() public {
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 190e18, uint64(block.timestamp), false, 3);
        bytes memory sig = _sign(SIGNER_PK, u);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("NotRelayer(address)", stranger));
        oracle.push(u, sig);
        IAttestedOracle.PriceUpdate[] memory us = new IAttestedOracle.PriceUpdate[](0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("NotRelayer(address)", stranger));
        oracle.pushMany(us, new bytes[](0));
        // a de-registered signer is no longer a relayer either
        vm.prank(timelock);
        oracle.setSigner(vm.addr(OTHER_PK), true, bytes32(0));
        vm.prank(timelock);
        oracle.setSigner(vm.addr(OTHER_PK), false, bytes32(0));
        vm.prank(vm.addr(OTHER_PK));
        vm.expectRevert(abi.encodeWithSignature("NotRelayer(address)", vm.addr(OTHER_PK)));
        oracle.push(u, sig);

        vm.prank(signer);
        oracle.push(u, sig);
        IAttestedOracle.PriceUpdate memory u2 = _update(PID_A, 191e18, uint64(block.timestamp) + 1, false, 3);
        vm.prank(timelock);
        oracle.push(u2, _sign(SIGNER_PK, u2));
        IAttestedOracle.PriceUpdate memory u3 = _update(PID_A, 192e18, uint64(block.timestamp) + 2, false, 3);
        address keeper = makeAddr("keeper");
        cfg.grantRole(cfg.KEEPER_ROLE(), keeper);
        vm.prank(keeper);
        oracle.push(u3, _sign(SIGNER_PK, u3));
        assertEq(oracle.latest(PID_A).priceWad, 192e18);
    }

    function test_push_storesAndEmits() public {
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 190e18, uint64(block.timestamp), false, 5);
        bytes memory sig = _sign(SIGNER_PK, u);
        address relayer = makeAddr("relayer");
        cfg.grantRole(cfg.KEEPER_ROLE(), relayer); // KEEPER relays (signers and the timelock may too)
        vm.expectEmit(true, false, false, true, address(oracle));
        emit PricePushed(PID_A, 190e18, uint64(block.timestamp), false, 5, signer);
        vm.prank(relayer);
        oracle.push(u, sig);

        IAttestedOracle.PriceData memory d = oracle.latest(PID_A);
        assertEq(d.priceWad, 190e18);
        assertEq(d.publishedAt, uint64(block.timestamp));
        assertFalse(d.held);
        assertEq(d.sourceCount, 5);
        (uint256 p, bool held) = oracle.priceOf(PID_A);
        assertEq(p, 190e18);
        assertFalse(held);
        assertFalse(oracle.isStale(PID_A));
    }

    function test_push_unregisteredSignerReverts() public {
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 1e18, uint64(block.timestamp), false, 3);
        bytes memory sig = _sign(OTHER_PK, u);
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, vm.addr(OTHER_PK)));
        oracle.push(u, sig);
    }

    function test_push_malformedSignatureReverts() public {
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 1e18, uint64(block.timestamp), false, 3);
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, address(0)));
        oracle.push(u, hex"deadbeef");
    }

    function test_push_highSMalleableSignatureReverts() public {
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 1e18, uint64(block.timestamp), false, 3);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, oracle.hashPrice(u));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 sHigh = bytes32(n - uint256(s));
        uint8 vFlip = v == 27 ? 28 : 27;
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, address(0)));
        oracle.push(u, abi.encodePacked(r, sHigh, vFlip));
    }

    function test_push_tamperedFieldRecoversOtherAddress() public {
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 1e18, uint64(block.timestamp), false, 3);
        bytes memory sig = _sign(SIGNER_PK, u);
        u.priceWad = 2e18; // relayer tampers with the price
        vm.expectPartialRevert(IAttestedOracle.BadSigner.selector);
        oracle.push(u, sig);
    }

    function test_push_crossDomainReplayReverts() public {
        AttestedOracle other = new AttestedOracle(address(cfg), signer, bytes32(0));
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 1e18, uint64(block.timestamp), false, 3);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, other.hashPrice(u));
        vm.expectPartialRevert(IAttestedOracle.BadSigner.selector);
        oracle.push(u, abi.encodePacked(r, s, v));
    }

    function test_push_notNewerReverts() public {
        _push(PID_A, 1e18, false);
        uint64 t = oracle.latest(PID_A).publishedAt;
        IAttestedOracle.PriceUpdate memory same = _update(PID_A, 2e18, t, false, 3);
        bytes memory sig = _sign(SIGNER_PK, same);
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.NotNewer.selector, t, t));
        oracle.push(same, sig);

        IAttestedOracle.PriceUpdate memory older = _update(PID_A, 2e18, t - 1, false, 3);
        sig = _sign(SIGNER_PK, older);
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.NotNewer.selector, t, t - 1));
        oracle.push(older, sig);
    }

    function test_push_futureBound() public {
        IAttestedOracle.PriceUpdate memory ok = _update(PID_A, 1e18, uint64(block.timestamp + 5), false, 3);
        oracle.push(ok, _sign(SIGNER_PK, ok));
        IAttestedOracle.PriceUpdate memory bad = _update(PID_B, 1e18, uint64(block.timestamp + 6), false, 3);
        bytes memory sig = _sign(SIGNER_PK, bad);
        vm.expectRevert(
            abi.encodeWithSelector(AttestedOracle.FuturePrice.selector, block.timestamp + 6, block.timestamp)
        );
        oracle.push(bad, sig);
    }

    function test_push_minSources() public {
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 1e18, uint64(block.timestamp), false, 2);
        bytes memory sig = _sign(SIGNER_PK, u);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.InsufficientSources.selector, 2, 3));
        oracle.push(u, sig);
        // held prices may carry fewer sources (even zero)
        IAttestedOracle.PriceUpdate memory h = _update(PID_A, 1e18, uint64(block.timestamp), true, 0);
        oracle.push(h, _sign(SIGNER_PK, h));
        (, bool held) = oracle.priceOf(PID_A);
        assertTrue(held);
    }

    function test_push_zeroPriceReverts() public {
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 0, uint64(block.timestamp), false, 3);
        bytes memory sig = _sign(SIGNER_PK, u);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.ZeroPrice.selector, PID_A));
        oracle.push(u, sig);
    }

    // ------------------------------------------------------------------ staleness

    function test_priceOf_neverPublishedIsStale() public {
        assertTrue(oracle.isStale(PID_B));
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.StalePrice.selector, PID_B, uint64(0)));
        oracle.priceOf(PID_B);
    }

    function test_priceOf_staleBoundary() public {
        _push(PID_A, 1e18, false);
        uint64 t = oracle.latest(PID_A).publishedAt;
        vm.warp(uint256(t) + 300); // age == maxPriceAge: still fresh
        assertFalse(oracle.isStale(PID_A));
        oracle.priceOf(PID_A);
        vm.warp(uint256(t) + 301);
        assertTrue(oracle.isStale(PID_A));
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.StalePrice.selector, PID_A, t));
        oracle.priceOf(PID_A);
        // latest() still returns the stored value
        assertEq(oracle.latest(PID_A).priceWad, 1e18);
    }

    function test_priceOf_followsConfigMaxPriceAge() public {
        _push(PID_A, 1e18, false);
        vm.warp(block.timestamp + 100);
        cfg.setMaxPriceAge(50);
        assertTrue(oracle.isStale(PID_A));
        cfg.setMaxPriceAge(1000);
        assertFalse(oracle.isStale(PID_A));
    }

    function test_priceOf_futurePublishedNotStale() public {
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 1e18, uint64(block.timestamp + 5), false, 3);
        oracle.push(u, _sign(SIGNER_PK, u));
        assertFalse(oracle.isStale(PID_A));
        (uint256 p,) = oracle.priceOf(PID_A);
        assertEq(p, 1e18);
    }

    // ------------------------------------------------------------------ pushMany

    function test_pushMany_lengthMismatch() public {
        IAttestedOracle.PriceUpdate[] memory us = new IAttestedOracle.PriceUpdate[](2);
        bytes[] memory sigs = new bytes[](1);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.LengthMismatch.selector, 2, 1));
        oracle.pushMany(us, sigs);
    }

    function test_pushMany_skipsStaleEntries() public {
        _push(PID_A, 1e18, false);
        uint64 tA = oracle.latest(PID_A).publishedAt;
        vm.warp(block.timestamp + 10);
        IAttestedOracle.PriceUpdate[] memory us = new IAttestedOracle.PriceUpdate[](3);
        bytes[] memory sigs = new bytes[](3);
        us[0] = _update(PID_A, 5e18, tA, false, 3); // not newer -> skipped
        us[1] = _update(PID_B, 7e18, uint64(block.timestamp), false, 3);
        us[2] = _update(PID_B, 8e18, uint64(block.timestamp - 1), false, 3); // older than us[1] -> skipped
        for (uint256 i; i < 3; ++i) {
            sigs[i] = _sign(SIGNER_PK, us[i]);
        }
        vm.expectEmit(true, false, false, true, address(oracle));
        emit PriceSkipped(PID_A, tA, tA);
        oracle.pushMany(us, sigs);
        assertEq(oracle.latest(PID_A).priceWad, 1e18);
        assertEq(oracle.latest(PID_B).priceWad, 7e18);
    }

    function test_pushMany_badSignatureRevertsWholeBatch() public {
        IAttestedOracle.PriceUpdate[] memory us = new IAttestedOracle.PriceUpdate[](2);
        bytes[] memory sigs = new bytes[](2);
        us[0] = _update(PID_A, 5e18, uint64(block.timestamp), false, 3);
        us[1] = _update(PID_B, 7e18, uint64(block.timestamp), false, 3);
        sigs[0] = _sign(SIGNER_PK, us[0]);
        sigs[1] = _sign(OTHER_PK, us[1]);
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, vm.addr(OTHER_PK)));
        oracle.pushMany(us, sigs);
        assertEq(oracle.latest(PID_A).publishedAt, 0);
    }

    function test_pushMany_badSignatureOnStaleEntryStillReverts() public {
        _push(PID_A, 1e18, false);
        uint64 tA = oracle.latest(PID_A).publishedAt;
        IAttestedOracle.PriceUpdate[] memory us = new IAttestedOracle.PriceUpdate[](1);
        bytes[] memory sigs = new bytes[](1);
        us[0] = _update(PID_A, 5e18, tA - 1, false, 3);
        sigs[0] = _sign(OTHER_PK, us[0]);
        vm.expectPartialRevert(IAttestedOracle.BadSigner.selector);
        oracle.pushMany(us, sigs);
    }

    function test_pushMany_invalidEntryReverts() public {
        IAttestedOracle.PriceUpdate[] memory us = new IAttestedOracle.PriceUpdate[](1);
        bytes[] memory sigs = new bytes[](1);
        us[0] = _update(PID_A, 5e18, uint64(block.timestamp), false, 1);
        sigs[0] = _sign(SIGNER_PK, us[0]);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.InsufficientSources.selector, 1, 3));
        oracle.pushMany(us, sigs);
    }

    function test_pushMany_empty() public {
        oracle.pushMany(new IAttestedOracle.PriceUpdate[](0), new bytes[](0));
    }

    // ------------------------------------------------------------------ signer registry / params

    function test_setSigner_onlyTimelock() public {
        address s = vm.addr(OTHER_PK);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.NotTimelock.selector, address(this)));
        oracle.setSigner(s, true, bytes32("q"));

        vm.expectEmit(true, false, false, true, address(oracle));
        emit SignerSet(s, true, bytes32("q"));
        vm.prank(timelock);
        oracle.setSigner(s, true, bytes32("q"));
        assertTrue(oracle.isSigner(s));
        assertEq(oracle.attestationOf(s), bytes32("q"));

        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 3e18, uint64(block.timestamp), false, 3);
        oracle.push(u, _sign(OTHER_PK, u));
        assertEq(oracle.latest(PID_A).priceWad, 3e18);
    }

    function test_setSigner_zeroAddressReverts() public {
        vm.prank(timelock);
        vm.expectRevert(AttestedOracle.ZeroAddress.selector);
        oracle.setSigner(address(0), true, bytes32(0));
    }

    function test_setSigner_deactivateBlocksPushes() public {
        vm.prank(timelock);
        oracle.setSigner(signer, false, bytes32(0));
        assertFalse(oracle.isSigner(signer));
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 3e18, uint64(block.timestamp), false, 3);
        bytes memory sig = _sign(SIGNER_PK, u);
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, signer));
        oracle.push(u, sig);
    }

    function test_setSigner_timelockReadLive() public {
        address newTl = makeAddr("newTimelock");
        cfg.setTimelock(newTl);
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.NotTimelock.selector, timelock));
        oracle.setSigner(signer, false, bytes32(0));
        vm.prank(newTl);
        oracle.setSigner(signer, false, bytes32(0));
    }

    function test_setMinSources() public {
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.NotTimelock.selector, address(this)));
        oracle.setMinSources(1);
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.BadMinSources.selector, 0));
        oracle.setMinSources(0);

        vm.expectEmit(false, false, false, true, address(oracle));
        emit MinSourcesSet(1);
        vm.prank(timelock);
        oracle.setMinSources(1);
        assertEq(oracle.minSources(), 1);
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 3e18, uint64(block.timestamp), false, 1);
        oracle.push(u, _sign(SIGNER_PK, u));
        assertEq(oracle.latest(PID_A).sourceCount, 1);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_push_roundTrip(bytes32 pid, uint256 price, uint32 dt, bool held, uint32 sources)
        public
    {
        vm.assume(pid != bytes32(0));
        price = bound(price, 1, type(uint128).max);
        dt = uint32(bound(dt, 0, 5));
        if (!held) sources = uint32(bound(sources, 3, type(uint32).max));
        IAttestedOracle.PriceUpdate memory u =
            _update(pid, price, uint64(block.timestamp + dt), held, sources);
        oracle.push(u, _sign(SIGNER_PK, u));
        IAttestedOracle.PriceData memory d = oracle.latest(pid);
        assertEq(d.priceWad, price);
        assertEq(d.held, held);
        assertEq(d.sourceCount, sources);
        assertEq(d.publishedAt, uint64(block.timestamp + dt));
    }

    function testFuzz_push_unregisteredKeyAlwaysReverts(uint256 pk, uint256 price) public {
        pk = bound(pk, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        vm.assume(pk != SIGNER_PK);
        price = bound(price, 1, type(uint128).max);
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, price, uint64(block.timestamp), false, 3);
        bytes memory sig = _sign(pk, u);
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, vm.addr(pk)));
        oracle.push(u, sig);
    }

    function testFuzz_staleness(uint32 maxAge, uint32 elapsed) public {
        maxAge = uint32(bound(maxAge, 1, 30 days));
        elapsed = uint32(bound(elapsed, 0, 60 days));
        cfg.setMaxPriceAge(maxAge);
        _push(PID_A, 1e18, false);
        uint64 t = oracle.latest(PID_A).publishedAt;
        vm.warp(uint256(t) + elapsed);
        bool expectStale = elapsed > maxAge;
        assertEq(oracle.isStale(PID_A), expectStale);
        if (expectStale) {
            vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.StalePrice.selector, PID_A, t));
        }
        oracle.priceOf(PID_A);
    }

    function testFuzz_monotonicPublishedAt(uint64 a, uint64 b) public {
        a = uint64(bound(a, 1, block.timestamp + 5));
        b = uint64(bound(b, 1, block.timestamp + 5));
        IAttestedOracle.PriceUpdate memory ua = _update(PID_A, 1e18, a, false, 3);
        oracle.push(ua, _sign(SIGNER_PK, ua));
        IAttestedOracle.PriceUpdate memory ub = _update(PID_A, 2e18, b, false, 3);
        bytes memory sig = _sign(SIGNER_PK, ub);
        if (b <= a) {
            vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.NotNewer.selector, a, b));
            oracle.push(ub, sig);
            assertEq(oracle.latest(PID_A).priceWad, 1e18);
        } else {
            oracle.push(ub, sig);
            assertEq(oracle.latest(PID_A).priceWad, 2e18);
        }
    }
}
