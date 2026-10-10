// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/IERC4337.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IBookrunnerDesk} from "../../src/interfaces/IBookrunnerDesk.sol";
import {IMMMandate} from "../../src/interfaces/IMMMandate.sol";
import {IAttestedOracle} from "../../src/interfaces/IAttestedOracle.sol";
import {MMMandate} from "../../src/MMMandate.sol";
import {BookrunnerDesk} from "../../src/BookrunnerDesk.sol";
import {HedgeExecutor} from "../../src/HedgeExecutor.sol";
import {StockTokenRegistry} from "../../src/StockTokenRegistry.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockStockToken} from "../../src/mocks/MockStockToken.sol";
import {MandateBase} from "./utils/MandateBase.sol";
import {MandateMockEntryPoint, MandateRevoker} from "./utils/MandateMocks.sol";
import {StandardMerkle} from "./utils/StandardMerkle.sol";

/// @notice ARCHITECTURE §2.10 red-team checks owned by A-mandate.
contract MandateRedTeamTest is MandateBase {
    using MessageHashUtils for bytes32;

    function _act(IBookrunnerDesk.ActionKind k, bytes memory d)
        internal
        pure
        returns (IBookrunnerDesk.Action memory)
    {
        return _action(k, d);
    }

    function _userOp(IBookrunnerDesk.Action memory a, uint256 pk, bytes32 opHash)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op.sender = address(desk);
        op.callData = abi.encodeCall(IBookrunnerDesk.execute, (a));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, opHash.toEthSignedMessageHash());
        op.signature = abi.encodePacked(r, s, v);
    }

    function _useMockEntryPoint() internal returns (MandateMockEntryPoint ep) {
        ep = new MandateMockEntryPoint();
        cfg.setEntryPoint(address(ep));
        desk.syncEntryPoint();
    }

    // ================================================================== mandate escalation

    /// @notice A desk key cannot touch key management, terms, kill/retire, or protocol admin.
    function test_redteam_escalation_keyCannotAdminister() public {
        vm.startPrank(key);
        vm.expectRevert(abi.encodeWithSelector(MMMandate.Unauthorized.selector, key));
        mandate.registerKey(makeAddr("k2"), key, uint64(block.timestamp + 1 days), type(uint128).max);
        BRTypes.Mandate memory loose = _defaultMandate();
        loose.maxInventoryUsd = type(uint128).max;
        loose.maxSkewBps = type(int16).max;
        vm.expectRevert(abi.encodeWithSelector(MMMandate.Unauthorized.selector, key));
        mandate.remandate(loose);
        vm.expectRevert(abi.encodeWithSelector(MMMandate.Unauthorized.selector, key));
        mandate.kill("SELF");
        vm.expectRevert(abi.encodeWithSelector(MMMandate.Unauthorized.selector, key));
        mandate.setRetiring();
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotMandate.selector, key));
        desk.syncKey(makeAddr("k3"), type(uint64).max);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.Unauthorized.selector, key));
        desk.setMaxSlippageBps(2000);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.Unauthorized.selector, key));
        desk.withdrawNative(payable(key), 0);
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.Unauthorized.selector, key));
        exec.setRouter(UNIV3, key);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.Unauthorized.selector, key));
        registry.setFloatCap(address(nvda), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.Unauthorized.selector, key));
        registry.setMultiplier(address(nvda), 1e30);
        // validateUserOp is EntryPoint-only
        PackedUserOperation memory op;
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotEntryPoint.selector, key));
        desk.validateUserOp(op, bytes32(0), 0);
        // the executor only serves registered desks
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.NotDesk.selector, key));
        exec.swapExactIn(UNIV3, address(usdc), address(nvda), 3000, 1, 0, key);
        vm.stopPrank();
    }

    /// @notice A desk key cannot exceed any mandate limit through typed actions.
    function test_redteam_escalation_keyCannotExceedLimits() public {
        vm.startPrank(key);
        // inventory beyond IF / MM capacity
        vm.expectRevert(
            abi.encodeWithSelector(IMMMandate.InventoryLimit.selector, uint256(IF_TARGET) + 1, IF_TARGET)
        );
        desk.execute(
            _act(
                IBookrunnerDesk.ActionKind.InventoryToVenue,
                abi.encode(BRTypes.ACCOUNT_IF, uint256(IF_TARGET) + 1)
            )
        );
        vm.expectRevert(
            abi.encodeWithSelector(IMMMandate.InventoryLimit.selector, uint256(MM_INV) + 1, MM_INV)
        );
        desk.execute(
            _act(
                IBookrunnerDesk.ActionKind.InventoryToVenue,
                abi.encode(BRTypes.ACCOUNT_MM, uint256(MM_INV) + 1)
            )
        );
        // hedge budget beyond maxInventory * bandMax
        uint256 cap = uint256(MAX_INV) * 12_000 / 10_000;
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.InventoryLimit.selector, cap + 1, cap));
        desk.execute(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(cap + 1)));
        // SetQuote cannot raise maxNetExposure above maxInventoryUsd, nor narrow / skew past limits
        vm.expectRevert(
            abi.encodeWithSelector(IMMMandate.InventoryLimit.selector, uint256(MAX_INV) + 1, MAX_INV)
        );
        desk.execute(
            _act(IBookrunnerDesk.ActionKind.SetQuote, abi.encode(uint16(10), int16(0), uint128(MAX_INV) + 1))
        );
        vm.expectRevert(
            abi.encodeWithSelector(IMMMandate.InventoryLimit.selector, uint256(type(uint128).max), MAX_INV)
        );
        desk.execute(
            _act(IBookrunnerDesk.ActionKind.SetQuote, abi.encode(uint16(10), int16(0), type(uint128).max))
        );
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.QuoteWidthTooNarrow.selector, uint16(0), uint16(8)));
        desk.execute(_act(IBookrunnerDesk.ActionKind.SetQuote, abi.encode(uint16(0), int16(0), uint128(1))));
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.SkewTooWide.selector, type(int16).min, int16(25)));
        desk.execute(
            _act(IBookrunnerDesk.ActionKind.SetQuote, abi.encode(uint16(10), type(int16).min, uint128(1)))
        );
        vm.stopPrank();
        assertEq(adapter.quoteCalls(), 0);

        // hedge outside the allow-list (asset or venue) and beyond the band
        adapter.setExposure(-20_000e6);
        _fundDesk(50_000e6);
        IBookrunnerDesk.Action memory a = _hedgeAction(address(tsla), true, 1000e6, 0);
        a.proof = _proof(address(nvda), UNIV3);
        vm.prank(key);
        vm.expectRevert(
            abi.encodeWithSelector(IMMMandate.HedgeNotAllowed.selector, _asset(address(tsla)), UNIV3)
        );
        desk.execute(a);
        vm.prank(key);
        vm.expectRevert();
        desk.execute(_hedgeAction(address(nvda), true, 45_000e6, 0));
        assertEq(nvda.balanceOf(address(desk)), 0);
    }

    /// @notice There is no generic call: arbitrary selectors and out-of-range kinds revert.
    function test_redteam_escalation_noNonTypedActions() public {
        bytes4[4] memory sels = [
            bytes4(keccak256("execute(address,uint256,bytes)")),
            bytes4(keccak256("executeBatch((address,uint256,bytes)[])")),
            bytes4(keccak256("approve(address,uint256)")),
            bytes4(keccak256("transfer(address,uint256)"))
        ];
        usdc.mint(address(desk), 1000e6);
        for (uint256 i; i < sels.length; ++i) {
            vm.prank(key);
            (bool ok,) = address(desk).call(abi.encodeWithSelector(sels[i], key, uint256(1000e6), ""));
            assertFalse(ok);
        }
        for (uint256 kind = 7; kind < 10; ++kind) {
            bytes memory raw =
                abi.encodeCall(IBookrunnerDesk.execute, (_act(IBookrunnerDesk.ActionKind.Hedge, "")));
            assembly {
                mstore(add(raw, 0x44), kind)
            }
            vm.prank(key);
            (bool ok,) = address(desk).call(raw);
            assertFalse(ok);
        }
        assertEq(usdc.balanceOf(address(desk)), 1000e6);
        assertEq(usdc.allowance(address(desk), key), 0);
    }

    // ================================================================== key revocation race

    function test_redteam_revocationRace_revokeThenExecuteSameBlock() public {
        vm.prank(sponsor);
        mandate.revokeKey(key, "RACE");
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotAuthorized.selector, key));
        desk.execute(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(1))));
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotAuthorized.selector, key));
        desk.execute(_flattenAction(address(nvda), 1, 0));
    }

    function test_redteam_revocationRace_revokeThenValidateSameBlock() public {
        bytes32 h = keccak256("op");
        PackedUserOperation memory op =
            _userOp(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(1))), keyPk, h);
        vm.prank(entryPoint);
        assertEq(uint160(desk.validateUserOp(op, h, 0)), 0);
        vm.prank(risk);
        mandate.revokeKey(key, "RACE");
        vm.prank(entryPoint);
        assertEq(desk.validateUserOp(op, h, 0), 1);
    }

    /// @notice Validation passed, then another op in the same bundle revokes the key: execution fails.
    function test_redteam_revocationRace_revokedBetweenValidationAndExecution() public {
        MandateMockEntryPoint ep = _useMockEntryPoint();
        MandateRevoker revoker = new MandateRevoker();
        cfg.grant(RISK_ROLE, address(revoker));
        bytes32 h = keccak256("fund");
        PackedUserOperation memory op =
            _userOp(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(500e6))), keyPk, h);
        (uint256 vd, bool ok, bytes memory ret) = ep.handleOpWithInterleave(
            address(desk),
            op,
            h,
            address(revoker),
            abi.encodeCall(MandateRevoker.revoke, (mandate, key, "RACE"))
        );
        assertEq(uint160(vd), 0, "validated");
        assertFalse(ok, "execution must fail");
        assertEq(ret, abi.encodeWithSelector(BookrunnerDesk.NotAuthorized.selector, key));
        assertEq(usdc.balanceOf(address(desk)), 0);
    }

    function test_redteam_revocationRace_killBetweenValidationAndExecution() public {
        MandateMockEntryPoint ep = _useMockEntryPoint();
        MandateRevoker revoker = new MandateRevoker();
        cfg.grant(RISK_ROLE, address(revoker));
        bytes32 h = keccak256("fund");
        PackedUserOperation memory op =
            _userOp(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(500e6))), keyPk, h);
        (, bool ok,) = ep.handleOpWithInterleave(
            address(desk), op, h, address(revoker), abi.encodeCall(MandateRevoker.kill, (mandate, "BREACH"))
        );
        assertFalse(ok);
        assertTrue(mandate.killed());
        assertEq(usdc.balanceOf(address(desk)), 0);
    }

    // ================================================================== off-hours

    function test_redteam_offHours_riskAddingBlockedReducingAllowed() public {
        adapter.setExposure(-20_000e6);
        _fundDesk(40_000e6);
        engine.setQuote(1, 20, 0, 30_000e6);
        uint256 tokens = _buyNvda(10_000e6);
        oracle.setHeld(NVDA_ID, true); // feed holds: off-hours
        assertTrue(mandate.offHours());

        vm.startPrank(key);
        // risk-adding venue deployment and desk funding
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        desk.execute(
            _act(IBookrunnerDesk.ActionKind.InventoryToVenue, abi.encode(BRTypes.ACCOUNT_MM, uint256(1e6)))
        );
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        desk.execute(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(1e6))));
        // quote "widening" of risk capacity: tighter spread or larger max net exposure
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        desk.execute(
            _act(IBookrunnerDesk.ActionKind.SetQuote, abi.encode(uint16(19), int16(0), uint128(30_000e6)))
        );
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        desk.execute(
            _act(IBookrunnerDesk.ActionKind.SetQuote, abi.encode(uint16(20), int16(0), uint128(40_000e6)))
        );
        // a hedge that overshoots past flat adds net risk (|-20k + 35k| > |-20k + 10k|)
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        desk.execute(_hedgeAction(address(nvda), true, 25_000e6, 0));
        vm.stopPrank();

        // reducing legs: hedge that shrinks |exposure + hedge|, recall, defensive quote, flatten
        _exec(key, _hedgeAction(address(nvda), true, 5000e6, 0));
        _exec(
            key,
            _act(IBookrunnerDesk.ActionKind.InventoryToVault, abi.encode(BRTypes.ACCOUNT_MM, uint256(1e6)))
        );
        _exec(
            key,
            _act(IBookrunnerDesk.ActionKind.SetQuote, abi.encode(uint16(40), int16(0), uint128(10_000e6)))
        );
        // a key Flatten that would grow |exposure + hedge| (-5k -> -7.5k) is risk-adding: blocked off-hours
        vm.prank(key);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        desk.execute(_flattenAction(address(nvda), tokens / 4, 0));
        // the RISK role's emergency Flatten stays unchecked
        _exec(risk, _flattenAction(address(nvda), tokens / 4, 0));
        _exec(key, _act(IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(uint256(1000e6))));
    }

    function test_redteam_offHours_longVenueHedgeBlocked() public {
        adapter.setExposure(20_000e6);
        _fundDesk(5000e6);
        oracle.setHeld(NVDA_ID, true);
        vm.prank(key);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        desk.execute(_hedgeAction(address(nvda), true, 1000e6, 0));
    }

    function test_redteam_staleOracle_isOffHours_flattenStillWorks() public {
        adapter.setExposure(-20_000e6);
        _fundDesk(10_000e6);
        uint256 tokens = _buyNvda(10_000e6);
        vm.warp(block.timestamp + 301);
        assertTrue(mandate.offHours());
        vm.prank(key);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        desk.execute(
            _act(IBookrunnerDesk.ActionKind.InventoryToVenue, abi.encode(BRTypes.ACCOUNT_IF, uint256(1e6)))
        );
        // valuation needs a fresh price: risk-adding hedges cannot be priced, so they revert
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.StalePrice.selector, NVDA_ID, uint64(T0)));
        desk.execute(_hedgeAction(address(nvda), true, 1000e6, 0));
        // RISK can always flatten
        _exec(risk, _flattenAction(address(nvda), tokens, 0));
        assertEq(nvda.balanceOf(address(desk)), 0);
    }

    // ================================================================== Stock Tokens not borrowable

    function test_redteam_notBorrowable_sellCappedByHoldings() public {
        adapter.setExposure(-20_000e6);
        _fundDesk(15_000e6);
        uint256 tokens = _buyNvda(15_000e6);
        vm.prank(key);
        vm.expectRevert(IMMMandate.SpotShortNotAllowed.selector);
        desk.execute(_hedgeAction(address(nvda), false, tokens + 1, 0));
        vm.prank(risk);
        vm.expectRevert(IMMMandate.SpotShortNotAllowed.selector);
        desk.execute(_flattenAction(address(nvda), tokens + 1, 0));
        // view path agrees
        vm.expectRevert(IMMMandate.SpotShortNotAllowed.selector);
        mandate.checkHedge(
            key,
            IMMMandate.HedgeParams(_asset(address(nvda)), UNIV3, false, tokens + 1, 1, 100),
            _proof(address(nvda), UNIV3)
        );
        // a token the desk never held cannot be sold at all
        vm.prank(key);
        vm.expectRevert(IMMMandate.SpotShortNotAllowed.selector);
        desk.execute(_hedgeAction(address(tsla), false, 1, 0));
    }

    function test_redteam_notBorrowable_longSpotCannotOffsetLongVenue() public {
        adapter.setExposure(20_000e6);
        _fundDesk(15_000e6);
        vm.prank(key);
        vm.expectRevert(
            abi.encodeWithSelector(
                IMMMandate.HedgeRatioOutOfBand.selector, uint256(0), uint256(5000), uint256(12_000)
            )
        );
        desk.execute(_hedgeAction(address(nvda), true, 10_000e6, 0));
    }

    // ================================================================== float caps

    function test_redteam_floatCaps() public {
        vm.prank(timelock);
        registry.setFloatCap(address(nvda), 50e18); // 9,500 USD of NVDA
        adapter.setExposure(-20_000e6);
        _fundDesk(20_000e6);
        _buyNvda(9500e6); // exactly 50 tokens
        assertEq(nvda.balanceOf(address(desk)), 50e18);
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.FloatCapExceeded.selector, 50e18 + 1e16, 50e18));
        desk.execute(_hedgeAction(address(nvda), true, 1.9e6, 0));
        // lowering the cap below holdings blocks buys, never sells
        vm.prank(timelock);
        registry.setFloatCap(address(nvda), 10e18);
        vm.prank(key);
        vm.expectRevert();
        desk.execute(_hedgeAction(address(nvda), true, 190e6, 0));
        adapter.setExposure(-10_000e6); // keep the sell inside the band
        _exec(key, _hedgeAction(address(nvda), false, 5e18, 0));
        assertEq(nvda.balanceOf(address(desk)), 45e18);
        // a zero cap means no hedge inventory may be bought
        vm.prank(timelock);
        registry.setFloatCap(address(tsla), 0);
        vm.prank(key);
        vm.expectRevert();
        desk.execute(_hedgeAction(address(tsla), true, 440e6, 0));
    }

    // ================================================================== multiplier double-apply

    function test_redteam_multiplierDoubleApply_deskValuation() public {
        adapter.setExposure(-20_000e6);
        _fundDesk(1900e6);
        _buyNvda(1900e6); // 10 whole tokens
        assertEq(nvda.balanceOf(address(desk)), 10e18);
        assertEq(desk.hedgeNotionalUsd(), 1900e6);
        assertEq(desk.valueUsd(), 1900e6);
        vm.prank(timelock);
        registry.setMultiplier(address(nvda), 2e18);
        assertEq(desk.hedgeNotionalUsd(), 3800e6); // exactly 2x, never 4x
        assertEq(desk.valueUsd(), 3800e6);
        assertEq(mandate.deskHedgeNotionalUsd(), 3800e6);
        assertEq(mandate.hedgeRatioBps(), 3800e6 * 10_000 / 20_000e6);
    }

    /// @notice VERIFY C2/T2 on mainnet: the registry reads the token's ERC-8056 `uiMultiplier()` and the
    ///         oracle signs Robinhood's per-TOKEN Chainlink price divided by that multiplier. The desk then
    ///         values its inventory at qty x feed price: the multiplier is applied exactly once end to end.
    function test_redteam_multiplierLiveUiMultiplier_perTokenFeed_valuedOnce() public {
        adapter.setExposure(-20_000e6);
        _fundDesk(1900e6);
        _buyNvda(1900e6); // 10 whole tokens
        // turn the devnet token into an ERC-8056 Stock Token in place (same ERC-20 storage layout)
        vm.etch(address(nvda), address(new MockStockToken("x", "x", 1e18)).code);
        MockStockToken st = MockStockToken(address(nvda));
        st.updateMultiplier(1.05e18);
        vm.startPrank(timelock);
        registry.setMultiplier(address(nvda), 1.05e18); // anchor
        registry.setMultiplierSource(address(nvda), true);
        vm.stopPrank();

        // Chainlink feed (per token) = 190 x 1.05 = 199.5; the oracle signs 199.5 / 1.05 = 190 per share
        uint256 feedPerToken = 199.5e18;
        oracle.set(NVDA_ID, feedPerToken * 1e18 / 1.05e18, uint64(block.timestamp), false);
        assertEq(desk.hedgeNotionalUsd(), 1995e6); // 10 x 199.5: not 1900 (missing), not 2094.75 (twice)
        assertEq(desk.valueUsd(), 1995e6);
        assertEq(mandate.deskHedgeNotionalUsd(), 1995e6);

        // reinvested dividend: multiplier 1.06 immediately, feed 190 x 1.06 = 201.4, per share still 190
        st.updateMultiplier(1.06e18);
        assertEq(desk.hedgeNotionalUsd(), 2014e6);

        // an unexplained 10x jump fails closed (like a stale price) until governance re-anchors
        st.updateMultiplier(10.6e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                StockTokenRegistry.MultiplierOutOfBand.selector, address(nvda), 10.6e18, 1.05e18
            )
        );
        desk.hedgeNotionalUsd();
        vm.prank(timelock);
        registry.setNextMultiplierAnchor(address(nvda), 10.6e18);
        oracle.set(NVDA_ID, 19e18, uint64(block.timestamp), false); // 201.4 / 10.6 per share post-split
        assertEq(desk.hedgeNotionalUsd(), 2014e6);
    }

    // ================================================================== Orderly stale-report rule

    function test_redteam_orderlyStaleReport_onlyReducingLegs() public {
        _deployBook(BRTypes.VENUE_ORDERLY);
        _registerDefaultKey();
        adapter.setExposure(-20_000e6);
        adapter.report(uint64(block.timestamp));
        _fundDesk(20_000e6);
        _buyNvda(15_000e6);
        vm.warp(block.timestamp + 250); // oracle still fresh (300s) ...
        _refreshPrices();
        vm.warp(block.timestamp + 1000); // ... report now 1250s old > 4 * 300
        _refreshPrices();
        vm.prank(key);
        vm.expectRevert(
            abi.encodeWithSelector(MMMandate.StaleVenueReport.selector, uint64(T0), uint256(1200))
        );
        desk.execute(_hedgeAction(address(nvda), true, 1000e6, 0));
        // reducing the hedge is still allowed
        _exec(key, _hedgeAction(address(nvda), false, 5e18, 0));
        // a fresh report re-enables hedge-adding legs
        adapter.report(uint64(block.timestamp));
        _exec(key, _hedgeAction(address(nvda), true, 1000e6, 0));
    }

    // ================================================================== allow-list proofs (merkle.ts)

    // Vector produced by packages/shared/src/merkle.ts hedgeAllowTree (StandardMerkleTree, bun) over
    // (tokenUnderlying(token), HEDGE_VENUES.UNIV3) for the five tokens below, plus (A11CE, ORDERLY).
    bytes32 internal constant VEC_ROOT = 0x42a7e87ac901f0632c0349498a3eae29da571ff0a4cd66ef5e8e8a6cad0f6fd9;
    address internal constant T_A = address(0x0A11CE);
    address internal constant T_B = address(0x0B0B00);
    address internal constant T_C = address(0xC0FFEE);
    address internal constant T_D = address(0x0D00D0);
    address internal constant T_E = address(0x0E0E00);

    function _vecProof(uint256 i) internal pure returns (bytes32[] memory p) {
        bytes32 L2a = 0x82b80da65ebf45380611f3c570a77f3b57456a9416ce4f6c254b8f3423323608;
        bytes32 L1a = 0x8f7a705aa64f0f875cf495480e211b7228ffa5079a3c91c02d9e32b812f4187e;
        bytes32 L1b = 0x240041aa7afed6f7eeadb43f659b32f73df77a1b034f3470fd7c770686ab75f6;
        bytes32 L1c = 0xcc58567fc89fa45dbfe33eae01b48169379b0226eedb5c5876cfc357ce1f5d87;
        if (i == 0) {
            p = new bytes32[](3);
            (p[0], p[1], p[2]) =
            (0x9dbee696dd2e182c9b6d7d119789523a70e8236c3cf43fca2906cb8d8f4f3078, L1a, L2a);
        } else if (i == 1) {
            p = new bytes32[](3);
            (p[0], p[1], p[2]) =
            (0x06275675c49d0742df6533a75222bb4719ee992c1863689adb7eba11bff897e5, L1b, L2a);
        } else if (i == 2) {
            p = new bytes32[](2);
            (p[0], p[1]) = (0xa5d4d91265f83905f4300d2f5564bb120c414f17d09173e8a38a5e2042073d5f, L1c);
        } else if (i == 3) {
            p = new bytes32[](2);
            (p[0], p[1]) = (0xd638b688af08910e97e9c11c4a3ed119e369dc7dcb8f8cd635a0ebb126a9b089, L1c);
        } else if (i == 4) {
            p = new bytes32[](3);
            (p[0], p[1], p[2]) =
            (0x889050b38092c1dfc72156e2efec783a71328d7c059cef29bce4e1679e442a65, L1a, L2a);
        } else {
            p = new bytes32[](3);
            (p[0], p[1], p[2]) =
            (0x234e03927c42e042d772a43817cdb1e1569791acf49c34ea15ea35820c9297e9, L1b, L2a);
        }
    }

    function _vecPairs() internal pure returns (bytes32[6] memory assets, bytes32[6] memory venues) {
        address[5] memory t = [T_A, T_B, T_C, T_D, T_E];
        for (uint256 i; i < 5; ++i) {
            assets[i] = bytes32(uint256(uint160(t[i])));
            venues[i] = "UNIV3";
        }
        assets[5] = bytes32(uint256(uint160(T_A)));
        venues[5] = "ORDERLY";
    }

    function _installVectorTokens() internal {
        address[5] memory t = [T_A, T_B, T_C, T_D, T_E];
        address tmpl = address(new MockERC20("ST", "ST", 18));
        vm.startPrank(timelock);
        for (uint256 i; i < 5; ++i) {
            vm.etch(t[i], tmpl.code);
            bytes32 pid = bytes32(uint256(0x5000 + i));
            registry.register(t[i], pid, 1e18, 1000e18);
            exec.setRoute("UNIV3", t[i], 3000, address(0), 0);
            oracle.set(pid, 100e18, uint64(block.timestamp), false);
            router.setPrice(t[i], 100e18);
        }
        vm.stopPrank();
        BRTypes.Mandate memory m = _defaultMandate();
        m.hedgeAllowRoot = VEC_ROOT;
        vm.prank(committee);
        mandate.remandate(m);
        _registerDefaultKey();
    }

    /// @notice The Solidity StandardMerkleTree port reproduces merkle.ts exactly (root + every proof).
    function test_redteam_allowList_portMatchesMerkleTs() public pure {
        (bytes32[6] memory assets, bytes32[6] memory venues) = _vecPairs();
        bytes32[] memory leaves = new bytes32[](6);
        for (uint256 i; i < 6; ++i) {
            leaves[i] = StandardMerkle.leaf(assets[i], venues[i]);
        }
        bytes32[] memory tree = StandardMerkle.build(leaves);
        assertEq(tree[0], VEC_ROOT);
        for (uint256 i; i < 6; ++i) {
            bytes32[] memory got = StandardMerkle.proof(tree, leaves[i]);
            bytes32[] memory want = _vecProof(i);
            assertEq(got.length, want.length);
            for (uint256 j; j < got.length; ++j) {
                assertEq(got[j], want[j]);
            }
        }
    }

    /// @notice MMMandate verifies proofs produced by merkle.ts hedgeAllowTree (hardcoded vector).
    function test_redteam_allowList_merkleTsProofsVerify() public {
        _installVectorTokens();
        adapter.setExposure(-20_000e6);
        (bytes32[6] memory assets, bytes32[6] memory venues) = _vecPairs();
        for (uint256 i; i < 6; ++i) {
            mandate.checkHedge(
                key, IMMMandate.HedgeParams(assets[i], venues[i], true, 1e18, 15_000e6, 100), _vecProof(i)
            );
        }
        // proofs are bound to their (asset, venue) pair
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.HedgeNotAllowed.selector, assets[1], venues[0]));
        mandate.checkHedge(
            key, IMMMandate.HedgeParams(assets[1], venues[0], true, 1e18, 15_000e6, 100), _vecProof(0)
        );
        bytes32 univ4 = "UNIV4";
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.HedgeNotAllowed.selector, assets[2], univ4));
        mandate.checkHedge(
            key, IMMMandate.HedgeParams(assets[2], univ4, true, 1e18, 15_000e6, 100), _vecProof(2)
        );
        // an intermediate node is not accepted as a leaf (double hashing)
        bytes32[] memory shortProof = new bytes32[](1);
        shortProof[0] = 0x82b80da65ebf45380611f3c570a77f3b57456a9416ce4f6c254b8f3423323608;
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.HedgeNotAllowed.selector, assets[0], venues[0]));
        mandate.checkHedge(
            key, IMMMandate.HedgeParams(assets[0], venues[0], true, 1e18, 15_000e6, 100), shortProof
        );

        // end-to-end through the desk with a merkle.ts proof
        _fundDesk(15_000e6);
        IBookrunnerDesk.Action memory a;
        a.kind = IBookrunnerDesk.ActionKind.Hedge;
        a.data = abi.encode(T_C, true, uint256(15_000e6), uint256(0), uint24(3000), bytes32("UNIV3"));
        a.proof = _vecProof(2);
        _exec(key, a);
        assertEq(MockERC20(T_C).balanceOf(address(desk)), 150e18);
    }
}
