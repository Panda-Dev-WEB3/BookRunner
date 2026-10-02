// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EngineBase} from "./utils/EngineBase.sol";
import {AttestedOracle} from "../../src/AttestedOracle.sol";
import {IAttestedOracle} from "../../src/interfaces/IAttestedOracle.sol";

/// @notice LOW_GAS.md §1 pull oracle: `AttestedOracle.update(bytes priceData)`, priceData =
///         abi.encode(PriceUpdate[], bytes[]). Anyone relays; newer entries are verified + stored; entries that
///         are not newer are skipped (never revert for "not newer"); a bad signature reverts.
contract AttestedOracleUpdateTest is EngineBase {
    event PricePushed(
        bytes32 indexed underlying,
        uint256 priceWad,
        uint64 publishedAt,
        bool held,
        uint32 sourceCount,
        address signer
    );

    uint256 internal constant OTHER_PK = 0xB0B;
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        _deployCore();
    }

    function _one(IAttestedOracle.PriceUpdate memory u, bytes memory sig) internal pure returns (bytes memory) {
        IAttestedOracle.PriceUpdate[] memory us = new IAttestedOracle.PriceUpdate[](1);
        bytes[] memory sigs = new bytes[](1);
        us[0] = u;
        sigs[0] = sig;
        return abi.encode(us, sigs);
    }

    function _two(
        IAttestedOracle.PriceUpdate memory a,
        bytes memory sa,
        IAttestedOracle.PriceUpdate memory b,
        bytes memory sb
    ) internal pure returns (bytes memory) {
        IAttestedOracle.PriceUpdate[] memory us = new IAttestedOracle.PriceUpdate[](2);
        bytes[] memory sigs = new bytes[](2);
        (us[0], us[1]) = (a, b);
        (sigs[0], sigs[1]) = (sa, sb);
        return abi.encode(us, sigs);
    }

    // ------------------------------------------------------------------ happy path

    function test_update_anyoneRelays_storesAndEmits() public {
        uint64 t = uint64(block.timestamp);
        bytes memory pd = _priceData(PID_A, 190e18, t, false);
        assertFalse(oracle.canRelay(stranger)); // not a heartbeat relayer ...
        vm.expectEmit(true, false, false, true, address(oracle));
        emit PricePushed(PID_A, 190e18, t, false, 3, signer);
        vm.prank(stranger); // ... but the pull path is open to anyone
        oracle.update(pd);

        IAttestedOracle.PriceData memory d = oracle.latest(PID_A);
        assertEq(d.priceWad, 190e18);
        assertEq(d.publishedAt, t);
        assertFalse(d.held);
        assertEq(d.sourceCount, 3);
        (uint256 p, bool held) = oracle.priceOf(PID_A);
        assertEq(p, 190e18);
        assertFalse(held);
    }

    function test_update_emptyIsNoop() public {
        vm.recordLogs();
        vm.prank(stranger);
        oracle.update("");
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(oracle.latest(PID_A).publishedAt, 0);
    }

    function test_update_batchOfUnderlyings() public {
        uint64 t = uint64(block.timestamp);
        IAttestedOracle.PriceUpdate memory a = _update(PID_A, 101e18, t, false, 3);
        IAttestedOracle.PriceUpdate memory b = _update(PID_B, 202e18, t, true, 1); // held: fewer sources ok
        oracle.update(_two(a, _sign(SIGNER_PK, a), b, _sign(SIGNER_PK, b)));
        assertEq(oracle.latest(PID_A).priceWad, 101e18);
        assertEq(oracle.latest(PID_B).priceWad, 202e18);
        assertTrue(oracle.latest(PID_B).held);
    }

    function test_update_heldPriceStored() public {
        oracle.update(_priceData(PID_A, 99e18, uint64(block.timestamp), true));
        (uint256 p, bool held) = oracle.priceOf(PID_A);
        assertEq(p, 99e18);
        assertTrue(held);
    }

    // ------------------------------------------------------------------ not newer: skipped

    function test_update_notNewerSkippedSilently() public {
        _price(PID_A, PX);
        uint64 t = oracle.latest(PID_A).publishedAt;
        vm.warp(block.timestamp + 10);
        vm.recordLogs();
        vm.prank(stranger);
        oracle.update(_priceData(PID_A, 1e18, t, false)); // same publishedAt
        vm.prank(stranger);
        oracle.update(_priceData(PID_A, 1e18, t - 1, false)); // older
        assertEq(vm.getRecordedLogs().length, 0, "skips emit nothing");
        assertEq(oracle.latest(PID_A).priceWad, PX);
        assertEq(oracle.latest(PID_A).publishedAt, t);
    }

    /// @dev Replay: the same bundle twice is a no-op, and an old bundle replayed after a newer price landed
    ///      never rolls the stored price back.
    function test_update_replayIsNoop() public {
        bytes memory pd = _priceData(PID_A, 101e18, uint64(block.timestamp), false);
        oracle.update(pd);
        vm.recordLogs();
        oracle.update(pd);
        assertEq(vm.getRecordedLogs().length, 0);

        vm.warp(block.timestamp + 5);
        oracle.update(_priceData(PID_A, 102e18, uint64(block.timestamp), false));
        oracle.update(pd);
        assertEq(oracle.latest(PID_A).priceWad, 102e18);
        assertEq(oracle.latest(PID_A).publishedAt, uint64(block.timestamp));
    }

    /// @dev An entry that is not newer cannot change state, so it is skipped without spending an ecrecover
    ///      on it — even a garbage signature there does not fail the bundle.
    function test_update_notNewerEntryIsNotVerified() public {
        _price(PID_A, PX);
        uint64 t = oracle.latest(PID_A).publishedAt;
        oracle.update(_one(_update(PID_A, 5e18, t, false, 3), hex"deadbeef"));
        oracle.update(_one(_update(PID_A, 5e18, t, false, 3), _sign(OTHER_PK, _update(PID_A, 5e18, t, false, 3))));
        assertEq(oracle.latest(PID_A).priceWad, PX);
    }

    function test_update_duplicateEntriesInOneBundle() public {
        uint64 t = uint64(block.timestamp);
        IAttestedOracle.PriceUpdate memory a = _update(PID_A, 101e18, t, false, 3);
        IAttestedOracle.PriceUpdate memory b = _update(PID_A, 105e18, t, false, 3);
        oracle.update(_two(a, _sign(SIGNER_PK, a), b, _sign(SIGNER_PK, b)));
        assertEq(oracle.latest(PID_A).priceWad, 101e18, "second entry is not newer: skipped");

        vm.warp(block.timestamp + 2);
        IAttestedOracle.PriceUpdate memory c = _update(PID_A, 102e18, t + 1, false, 3);
        IAttestedOracle.PriceUpdate memory d = _update(PID_A, 103e18, t + 2, false, 3);
        oracle.update(_two(c, _sign(SIGNER_PK, c), d, _sign(SIGNER_PK, d)));
        assertEq(oracle.latest(PID_A).priceWad, 103e18, "both newer: the last one wins");
    }

    // ------------------------------------------------------------------ bad signatures revert

    function test_update_wrongSignerReverts() public {
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 190e18, uint64(block.timestamp), false, 3);
        bytes memory pd = _one(u, _sign(OTHER_PK, u));
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, vm.addr(OTHER_PK)));
        oracle.update(pd);
        assertEq(oracle.latest(PID_A).publishedAt, 0);
    }

    function test_update_tamperedPayloadReverts() public {
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 190e18, uint64(block.timestamp), false, 3);
        bytes memory sig = _sign(SIGNER_PK, u);
        u.priceWad = 1e18; // changed after signing
        vm.expectPartialRevert(IAttestedOracle.BadSigner.selector);
        oracle.update(_one(u, sig));
        u.priceWad = 190e18;
        u.held = true;
        vm.expectPartialRevert(IAttestedOracle.BadSigner.selector);
        oracle.update(_one(u, sig));
        assertEq(oracle.latest(PID_A).publishedAt, 0);
    }

    function test_update_malformedSignatureReverts() public {
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 190e18, uint64(block.timestamp), false, 3);
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, address(0)));
        oracle.update(_one(u, hex"deadbeef"));
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, address(0)));
        oracle.update(_one(u, ""));
    }

    function test_update_deregisteredSignerReverts() public {
        vm.prank(timelock);
        oracle.setSigner(signer, false, bytes32(0));
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 190e18, uint64(block.timestamp), false, 3);
        bytes memory pd = _one(u, _sign(SIGNER_PK, u));
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, signer));
        oracle.update(pd);
    }

    /// @dev The EIP-712 domain binds the oracle address and the chain id: a signature for another deployment
    ///      or another chain never verifies here.
    function test_update_wrongDomainReverts() public {
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 190e18, uint64(block.timestamp), false, 3);
        AttestedOracle other = new AttestedOracle(address(cfg), signer, bytes32(0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, other.hashPrice(u));
        vm.expectPartialRevert(IAttestedOracle.BadSigner.selector);
        oracle.update(_one(u, abi.encodePacked(r, s, v)));

        uint256 chainId = block.chainid;
        vm.chainId(chainId + 1);
        bytes memory foreign = _sign(SIGNER_PK, u);
        vm.chainId(chainId);
        vm.expectPartialRevert(IAttestedOracle.BadSigner.selector);
        oracle.update(_one(u, foreign));
        assertEq(oracle.latest(PID_A).publishedAt, 0);
    }

    function test_update_oneBadEntryRevertsWholeBundle() public {
        uint64 t = uint64(block.timestamp);
        IAttestedOracle.PriceUpdate memory a = _update(PID_A, 101e18, t, false, 3);
        IAttestedOracle.PriceUpdate memory b = _update(PID_B, 202e18, t, false, 3);
        bytes memory pd = _two(a, _sign(SIGNER_PK, a), b, _sign(OTHER_PK, b));
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, vm.addr(OTHER_PK)));
        oracle.update(pd);
        assertEq(oracle.latest(PID_A).publishedAt, 0, "valid entry rolled back with the bundle");
    }

    // ------------------------------------------------------------------ same validation as push

    function test_update_validationLikePush() public {
        uint64 t = uint64(block.timestamp);
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 0, t, false, 3);
        bytes memory pd = _one(u, _sign(SIGNER_PK, u));
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.ZeroPrice.selector, PID_A));
        oracle.update(pd);

        u = _update(PID_A, 1e18, t + 6, false, 3);
        pd = _one(u, _sign(SIGNER_PK, u));
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.FuturePrice.selector, t + 6, block.timestamp));
        oracle.update(pd);
        u = _update(PID_A, 1e18, t + 5, false, 3); // MAX_FUTURE_DRIFT is tolerated
        oracle.update(_one(u, _sign(SIGNER_PK, u)));

        u = _update(PID_B, 1e18, t, false, 2);
        pd = _one(u, _sign(SIGNER_PK, u));
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.InsufficientSources.selector, uint32(2), uint32(3)));
        oracle.update(pd);
    }

    function test_update_lengthMismatchAndMalformedEncoding() public {
        IAttestedOracle.PriceUpdate[] memory us = new IAttestedOracle.PriceUpdate[](2);
        bytes[] memory sigs = new bytes[](1);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.LengthMismatch.selector, uint256(2), uint256(1)));
        oracle.update(abi.encode(us, sigs));
        vm.expectRevert();
        oracle.update(hex"1234");
        vm.expectRevert();
        oracle.update(abi.encode(uint256(1)));
    }

    /// @dev Heartbeat push paths keep their relayer restriction (backwards compatible).
    function test_pushPathsStayRelayerOnly() public {
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 190e18, uint64(block.timestamp), false, 3);
        bytes memory sig = _sign(SIGNER_PK, u);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.NotRelayer.selector, stranger));
        oracle.push(u, sig);
        IAttestedOracle.PriceUpdate[] memory us = new IAttestedOracle.PriceUpdate[](1);
        bytes[] memory sigs = new bytes[](1);
        us[0] = u;
        sigs[0] = sig;
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AttestedOracle.NotRelayer.selector, stranger));
        oracle.pushMany(us, sigs);
        oracle.pushMany(us, sigs); // the test contract holds KEEPER
        assertEq(oracle.latest(PID_A).priceWad, 190e18);
    }

    // ------------------------------------------------------------------ fuzz

    /// @dev Stored price relayed by a heartbeat relayer (any age); the open path lands the incoming one iff it
    ///      is newer than stored and not already stale on arrival.
    function testFuzz_update_storesOnlyNewerAndNotStale(uint32 storedAge, uint32 incomingAge, uint96 price)
        public
    {
        price = uint96(bound(price, 1, type(uint96).max));
        vm.warp(T0 + 10 days);
        uint64 nowTs = uint64(block.timestamp);
        uint64 storedAt = nowTs - uint64(bound(storedAge, 0, 1 days));
        uint64 incomingAt = nowTs - uint64(bound(incomingAge, 0, 1 days));
        IAttestedOracle.PriceUpdate[] memory us = new IAttestedOracle.PriceUpdate[](1);
        bytes[] memory sigs = new bytes[](1);
        us[0] = _update(PID_A, PX, storedAt, false, 3);
        sigs[0] = _sign(SIGNER_PK, us[0]);
        oracle.pushMany(us, sigs);
        oracle.update(_priceData(PID_A, price, incomingAt, false));
        IAttestedOracle.PriceData memory d = oracle.latest(PID_A);
        if (incomingAt > storedAt && uint256(incomingAt) + cfg.maxPriceAge() >= nowTs) {
            assertEq(d.priceWad, price);
            assertEq(d.publishedAt, incomingAt);
        } else {
            assertEq(d.priceWad, PX);
            assertEq(d.publishedAt, storedAt);
        }
    }

    // ------------------------------------------------------------------ stale on arrival: skipped

    /// @dev Lookback guard: on an idle market (nothing landed for an hour) an old print is still newer than
    ///      stored, but the open path never lands a print older than maxPriceAge — exactly maxPriceAge lands.
    function test_update_staleOnArrivalSkipped() public {
        _price(PID_A, PX);
        uint64 t = oracle.latest(PID_A).publishedAt;
        vm.warp(block.timestamp + 1 hours);
        uint64 old = uint64(block.timestamp) - 301; // newer than stored, older than maxPriceAge (300)
        vm.recordLogs();
        vm.prank(stranger);
        oracle.update(_priceData(PID_A, 90e18, old, false));
        assertEq(vm.getRecordedLogs().length, 0, "skips emit nothing");
        assertEq(oracle.latest(PID_A).publishedAt, t);
        assertEq(oracle.latest(PID_A).priceWad, PX);

        uint64 edge = uint64(block.timestamp) - 300; // exactly maxPriceAge old: lands (not stale yet)
        vm.prank(stranger);
        oracle.update(_priceData(PID_A, 91e18, edge, false));
        assertEq(oracle.latest(PID_A).publishedAt, edge);
        assertFalse(oracle.isStale(PID_A));
    }

    /// @dev Stale-on-arrival entries are skipped before verification (they cannot change state), and the bound
    ///      follows config.maxPriceAge.
    function test_update_staleOnArrivalNotVerifiedAndFollowsConfig() public {
        vm.warp(block.timestamp + 1 hours);
        uint64 old = uint64(block.timestamp) - 400;
        oracle.update(_one(_update(PID_A, 5e18, old, false, 3), hex"deadbeef"));
        assertEq(oracle.latest(PID_A).publishedAt, 0);
        cfg.setMaxPriceAge(600);
        oracle.update(_priceData(PID_A, 5e18, old, false));
        assertEq(oracle.latest(PID_A).publishedAt, old);
        // within the window a bad signature still reverts
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 5e18, old + 1, false, 3);
        bytes memory pd = _one(u, _sign(OTHER_PK, u));
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, vm.addr(OTHER_PK)));
        oracle.update(pd);
    }

    /// @dev Mixed bundle: the stale entry is skipped, the fresh one for another underlying lands.
    function test_update_mixedBundleStaleEntrySkipped() public {
        vm.warp(block.timestamp + 1 hours);
        uint64 t = uint64(block.timestamp);
        IAttestedOracle.PriceUpdate memory a = _update(PID_A, 101e18, t - 1000, false, 3);
        IAttestedOracle.PriceUpdate memory b = _update(PID_B, 202e18, t, false, 3);
        oracle.update(_two(a, _sign(SIGNER_PK, a), b, _sign(SIGNER_PK, b)));
        assertEq(oracle.latest(PID_A).publishedAt, 0);
        assertEq(oracle.latest(PID_B).priceWad, 202e18);
    }

    /// @dev The relayer-gated heartbeat paths keep their old semantics: any newer print lands, whatever its age.
    function test_pushStillLandsOldPrints() public {
        vm.warp(block.timestamp + 1 hours);
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 190e18, uint64(block.timestamp) - 1000, false, 3);
        oracle.push(u, _sign(SIGNER_PK, u));
        assertEq(oracle.latest(PID_A).priceWad, 190e18);
        assertTrue(oracle.isStale(PID_A));
    }

    function testFuzz_update_neverAcceptsForeignSigner(uint256 pk) public {
        pk = bound(pk, 1, 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140);
        vm.assume(pk != SIGNER_PK);
        IAttestedOracle.PriceUpdate memory u = _update(PID_A, 190e18, uint64(block.timestamp), false, 3);
        bytes memory pd = _one(u, _sign(pk, u));
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, vm.addr(pk)));
        oracle.update(pd);
    }
}
