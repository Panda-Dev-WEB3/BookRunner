// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/IERC4337.sol";

import {IBookrunnerDesk} from "../../src/interfaces/IBookrunnerDesk.sol";
import {IMMMandate} from "../../src/interfaces/IMMMandate.sol";
import {IAttestedOracle} from "../../src/interfaces/IAttestedOracle.sol";
import {AttestedOracle} from "../../src/AttestedOracle.sol";
import {BookrunnerDesk} from "../../src/BookrunnerDesk.sol";
import {MandateBase} from "./utils/MandateBase.sol";
import {MandateMockEntryPoint} from "./utils/MandateMocks.sol";

/// @notice LOW_GAS.md §1 on the desk: `executeWithPrices(Action, bytes priceData)` relays the signed bundle to
///         the real AttestedOracle and then runs exactly the `execute` path, so the mandate's off-hours /
///         staleness rules and the registry valuations see the price the transaction brought; validateUserOp
///         accepts either entry point.
contract DeskPullOracleTest is MandateBase {
    using MessageHashUtils for bytes32;

    uint256 internal constant ORACLE_PK = 0xA11CE;
    uint256 internal constant OTHER_PK = 0xB0B;

    AttestedOracle internal pull;
    address internal oracleSigner;

    event ActionExecuted(address indexed key, IBookrunnerDesk.ActionKind indexed kind, bytes data);

    function setUp() public override {
        super.setUp();
        oracleSigner = vm.addr(ORACLE_PK);
        pull = new AttestedOracle(address(cfg), oracleSigner, bytes32(0));
        cfg.setOracle(address(pull)); // mandate, desk and registry read config.oracle() at call time
        pull.update(_pd(ORACLE_PK, NVDA_PX, uint64(block.timestamp), false));
    }

    // ------------------------------------------------------------------ helpers

    function _pd(uint256 pk, uint256 nvdaPx, uint64 at, bool held) internal view returns (bytes memory) {
        IAttestedOracle.PriceUpdate[] memory us = new IAttestedOracle.PriceUpdate[](2);
        bytes[] memory sigs = new bytes[](2);
        us[0] = _u(NVDA_ID, nvdaPx, at, held);
        us[1] = _u(TSLA_ID, TSLA_PX, at, held);
        for (uint256 i; i < 2; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, pull.hashPrice(us[i]));
            sigs[i] = abi.encodePacked(r, s, v);
        }
        return abi.encode(us, sigs);
    }

    function _u(bytes32 id, uint256 px, uint64 at, bool held)
        internal
        pure
        returns (IAttestedOracle.PriceUpdate memory)
    {
        return IAttestedOracle.PriceUpdate({
            underlying: id,
            priceWad: px,
            publishedAt: at,
            held: held,
            sourceCount: held ? 1 : 3,
            sourcesHash: keccak256(abi.encode(id, px, at))
        });
    }

    function _fresh() internal view returns (bytes memory) {
        return _pd(ORACLE_PK, NVDA_PX, uint64(block.timestamp), false);
    }

    function _quoteAction(uint16 spread, uint128 maxNet) internal pure returns (IBookrunnerDesk.Action memory a) {
        a.kind = IBookrunnerDesk.ActionKind.SetQuote;
        a.data = abi.encode(spread, int16(0), maxNet);
    }

    function _execP(address caller, IBookrunnerDesk.Action memory a, bytes memory pd)
        internal
        returns (bytes memory)
    {
        vm.prank(caller);
        return desk.executeWithPrices(a, pd);
    }

    // ------------------------------------------------------------------ mandate evaluated on the in-tx price

    /// @dev Pull mode: no push for an hour. The mandate reads "stale => off-hours" and refuses a
    ///      risk-adding quote through `execute`; the same action carrying a fresh price passes, and a carried
    ///      held price is off-hours again (evaluated after the in-tx update, not on what was stored before).
    function test_setQuote_offHoursJudgedOnCarriedPrice() public {
        _exec(key, _quoteAction(20, 20_000e6));
        vm.warp(block.timestamp + 1 hours);
        assertTrue(mandate.offHours());
        vm.prank(key);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        desk.execute(_quoteAction(10, 20_000e6)); // narrower spread = new risk

        _execP(key, _quoteAction(10, 20_000e6), _fresh());
        assertEq(adapter.lastSpread(), 10);
        assertFalse(mandate.offHours());

        vm.warp(block.timestamp + 1);
        bytes memory held = _pd(ORACLE_PK, NVDA_PX, uint64(block.timestamp), true);
        vm.prank(key);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        desk.executeWithPrices(_quoteAction(8, 20_000e6), held);
        _execP(key, _quoteAction(30, 10_000e6), held); // widening / shrinking the cap is fine off-hours
        assertEq(adapter.lastSpread(), 30);
        assertTrue(mandate.offHours());
    }

    /// @dev Hedges value inventory through registry.valueUsd -> oracle.priceOf (strict): a stale stored price
    ///      fails the plain `execute`, the carried price makes the same hedge go through.
    function test_hedge_valuedOnCarriedPrice() public {
        adapter.setExposure(-20_000e6);
        _fundDesk(15_000e6);
        vm.warp(block.timestamp + 1 hours);
        IBookrunnerDesk.Action memory a = _hedgeAction(address(nvda), true, 15_000e6, 1);
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.StalePrice.selector, NVDA_ID, uint64(T0)));
        desk.execute(a);

        uint256 out = abi.decode(_execP(key, a, _fresh()), (uint256));
        assertGt(out, 0);
        assertEq(nvda.balanceOf(address(desk)), out);
        assertEq(uint256(desk.hedgeNotionalUsd()), registry.valueUsd(address(nvda), out));
    }

    function test_fundDesk_offHoursJudgedOnCarriedPrice() public {
        vm.warp(block.timestamp + 1 hours);
        IBookrunnerDesk.Action memory a = _action(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(1000e6)));
        vm.prank(key);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        desk.execute(a);
        _execP(key, a, _fresh());
        assertEq(usdc.balanceOf(address(desk)), 1000e6);
    }

    // ------------------------------------------------------------------ negative paths

    function test_executeWithPrices_badSignatureRevertsAction() public {
        vm.warp(block.timestamp + 1 hours);
        bytes memory forged = _pd(OTHER_PK, 1e18, uint64(block.timestamp), false);
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, vm.addr(OTHER_PK)));
        desk.executeWithPrices(_quoteAction(10, 20_000e6), forged);
        assertEq(adapter.quoteCalls(), 0);
        assertEq(pull.latest(NVDA_ID).publishedAt, uint64(T0));
    }

    /// @dev Replays are skipped by the oracle: the stored price keeps its age, so the mandate goes off-hours
    ///      again once it is older than maxPriceAge even if the same bundle is carried again.
    function test_executeWithPrices_replayedBundleDoesNotRefresh() public {
        vm.warp(block.timestamp + 1 hours);
        bytes memory pd = _fresh();
        _execP(key, _quoteAction(10, 20_000e6), pd);
        vm.warp(block.timestamp + 301);
        vm.prank(key);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        desk.executeWithPrices(_quoteAction(9, 20_000e6), pd);
    }

    function test_executeWithPrices_emptyIsExecute() public {
        IBookrunnerDesk.Action memory a = _quoteAction(12, 30_000e6);
        vm.expectEmit(true, true, false, true, address(desk));
        emit ActionExecuted(key, IBookrunnerDesk.ActionKind.SetQuote, a.data);
        _execP(key, a, "");
        assertEq(adapter.lastSpread(), 12);
        assertEq(pull.latest(NVDA_ID).publishedAt, uint64(T0));
    }

    /// @dev Same callers as execute: a stranger cannot use the desk to relay (authorisation runs first) and
    ///      RISK still only reaches the reduce-only kinds.
    function test_executeWithPrices_authorisationUnchanged() public {
        vm.warp(block.timestamp + 10);
        bytes memory pd = _fresh();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotAuthorized.selector, stranger));
        desk.executeWithPrices(_quoteAction(10, 20_000e6), pd);
        vm.prank(risk);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotAuthorized.selector, risk));
        desk.executeWithPrices(_quoteAction(10, 20_000e6), pd);

        _fundDesk(500e6);
        _execP(risk, _action(IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(uint256(500e6))), pd);
        assertEq(usdc.balanceOf(address(desk)), 0);
        assertEq(pull.latest(NVDA_ID).publishedAt, uint64(block.timestamp));
    }

    // ------------------------------------------------------------------ ERC-4337

    function _userOpCall(bytes memory callData, uint256 pk, bytes32 opHash)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op.sender = address(desk);
        op.callData = callData;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, opHash.toEthSignedMessageHash());
        op.signature = abi.encodePacked(r, s, v);
    }

    function _useMockEntryPoint() internal returns (MandateMockEntryPoint ep) {
        ep = new MandateMockEntryPoint();
        cfg.setEntryPoint(address(ep));
        desk.syncEntryPoint();
    }

    function test_validateUserOp_acceptsExecuteWithPrices() public {
        vm.warp(block.timestamp + 1 hours);
        bytes32 h = keccak256("quote");
        bytes memory cd = abi.encodeCall(IBookrunnerDesk.executeWithPrices, (_quoteAction(10, 20_000e6), _fresh()));
        PackedUserOperation memory op = _userOpCall(cd, keyPk, h);
        vm.prank(entryPoint);
        assertEq(desk.validateUserOp(op, h, 0), uint256(T0 + 30 days) << 160);

        // wrong signer still fails validation for the new entry point
        (, uint256 strangerPk) = makeAddrAndKey("strangerKey");
        op = _userOpCall(cd, strangerPk, h);
        vm.prank(entryPoint);
        assertEq(desk.validateUserOp(op, h, 0), 1);
        // an unknown selector still fails
        op = _userOpCall(abi.encodeWithSignature("executeWithPrices(bytes)", bytes("")), keyPk, h);
        vm.prank(entryPoint);
        assertEq(desk.validateUserOp(op, h, 0), 1);
    }

    function test_entryPoint_executeWithPricesEndToEnd() public {
        MandateMockEntryPoint ep = _useMockEntryPoint();
        vm.warp(block.timestamp + 1 hours);
        bytes32 h = keccak256("quote");
        IBookrunnerDesk.Action memory a = _quoteAction(10, 20_000e6);
        bytes memory cd = abi.encodeCall(IBookrunnerDesk.executeWithPrices, (a, _fresh()));
        (uint256 vd, bool ok,) = ep.handleOp(address(desk), _userOpCall(cd, keyPk, h), h);
        assertEq(uint160(vd), 0);
        assertTrue(ok);
        assertEq(adapter.lastSpread(), 10);
        assertEq(pull.latest(NVDA_ID).publishedAt, uint64(block.timestamp));
    }

    /// @dev The validated signer is keyed by the full callData: another bundle, or the same action through the
    ///      other entry point, is not authorised by that validation.
    function test_entryPoint_otherPriceDataOrEntryPointRejected() public {
        MandateMockEntryPoint ep = _useMockEntryPoint();
        vm.warp(block.timestamp + 1 hours);
        bytes32 h = keccak256("quote");
        IBookrunnerDesk.Action memory a = _quoteAction(10, 20_000e6);
        bytes memory cd = abi.encodeCall(IBookrunnerDesk.executeWithPrices, (a, _fresh()));
        bytes memory otherPd = abi.encodeCall(
            IBookrunnerDesk.executeWithPrices, (a, _pd(ORACLE_PK, NVDA_PX + 1, uint64(block.timestamp), false))
        );
        vm.expectRevert(bytes("interleaved call failed"));
        ep.handleOpWithInterleave(address(desk), _userOpCall(cd, keyPk, h), h, address(desk), otherPd);

        bytes memory plain = abi.encodeCall(IBookrunnerDesk.execute, (a));
        vm.expectRevert(bytes("interleaved call failed"));
        ep.handleOpWithInterleave(address(desk), _userOpCall(cd, keyPk, h), h, address(desk), plain);
    }
}
