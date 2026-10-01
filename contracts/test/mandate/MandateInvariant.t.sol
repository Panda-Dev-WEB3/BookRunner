// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IBookrunnerDesk} from "../../src/interfaces/IBookrunnerDesk.sol";
import {MMMandate} from "../../src/MMMandate.sol";
import {BookrunnerDesk} from "../../src/BookrunnerDesk.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MandateBase} from "./utils/MandateBase.sol";
import {MandateMockAdapter, MandateMockOracle, MandateMockStaking} from "./utils/MandateMocks.sol";

/// @dev Drives the desk / mandate through random sequences of agent, risk, sponsor and committee actions.
contract MandateHandler is Test {
    MMMandate internal mandate;
    BookrunnerDesk internal desk;
    MandateMockAdapter internal adapter;
    MandateMockOracle internal oracle;
    MandateMockStaking internal staking;
    MockERC20 internal nvda;
    address internal key;
    address internal risk;
    address internal sponsor;
    address internal operator;
    address internal committee;
    bytes32[] internal proof;
    BRTypes.Mandate internal terms;
    bytes32 internal constant NVDA_ID = "NVDA";

    /// @dev Successful actions by a key after it was revoked / the mandate killed (must stay 0).
    uint256 public revokedKeySuccesses;
    uint256 public hedgesOk;
    uint256 public quotesOk;

    constructor(
        MMMandate m,
        BookrunnerDesk d,
        MandateMockAdapter a,
        MandateMockOracle o,
        MandateMockStaking s,
        MockERC20 t,
        address[5] memory actors,
        bytes32[] memory proof_
    ) {
        mandate = m;
        desk = d;
        adapter = a;
        oracle = o;
        staking = s;
        nvda = t;
        (key, risk, sponsor, operator, committee) = (actors[0], actors[1], actors[2], actors[3], actors[4]);
        proof = proof_;
        terms = m.getMandate();
    }

    function _execAs(address who, IBookrunnerDesk.ActionKind k, bytes memory data, bytes32[] memory p)
        internal
        returns (bool ok)
    {
        IBookrunnerDesk.Action memory a = IBookrunnerDesk.Action({kind: k, data: data, proof: p});
        vm.prank(who);
        try desk.execute(a) {
            ok = true;
        } catch {}
    }

    function _empty() internal pure returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    function _reRegister() internal {
        staking.setAvailable(operator, staking.availableOf(operator) + 1_000_000e18);
        vm.prank(operator);
        mandate.consentKey(key, true);
        vm.prank(sponsor);
        try mandate.registerKey(key, operator, uint64(block.timestamp + 30 days), terms.maxInventoryUsd) {}
            catch {}
    }

    // ------------------------------------------------------------------ actions

    function fund(uint256 amount) external {
        _execAs(key, IBookrunnerDesk.ActionKind.FundDesk, abi.encode(bound(amount, 1, 30_000e6)), _empty());
    }

    function hedgeBuy(uint256 usd) external {
        usd = bound(usd, 1e6, 25_000e6);
        bytes memory d = abi.encode(address(nvda), true, usd, uint256(0), uint24(3000), bytes32("UNIV3"));
        if (_execAs(key, IBookrunnerDesk.ActionKind.Hedge, d, proof)) hedgesOk++;
    }

    function hedgeSell(uint256 pct) external {
        uint256 bal = nvda.balanceOf(address(desk));
        if (bal == 0) return;
        uint256 amt = bal * bound(pct, 1, 100) / 100;
        if (amt == 0) return;
        bytes memory d = abi.encode(address(nvda), false, amt, uint256(0), uint24(3000), bytes32("UNIV3"));
        if (_execAs(key, IBookrunnerDesk.ActionKind.Hedge, d, proof)) hedgesOk++;
    }

    function flatten(uint256 pct, bool asRisk) external {
        uint256 bal = nvda.balanceOf(address(desk));
        if (bal == 0) return;
        uint256 amt = bal * bound(pct, 1, 100) / 100;
        if (amt == 0) return;
        bytes memory d = abi.encode(address(nvda), amt, uint256(0), uint24(3000), bytes32("UNIV3"));
        _execAs(asRisk ? risk : key, IBookrunnerDesk.ActionKind.Flatten, d, _empty());
    }

    function returnToVault(uint256 amount) external {
        _execAs(
            key, IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(bound(amount, 1, 30_000e6)), _empty()
        );
    }

    function setQuote(uint16 spread, int16 skew, uint128 maxNet) external {
        bytes memory d =
            abi.encode(spread, skew, uint128(bound(maxNet, 0, uint256(terms.maxInventoryUsd) * 2)));
        if (_execAs(key, IBookrunnerDesk.ActionKind.SetQuote, d, _empty())) quotesOk++;
    }

    function setExposure(int256 e) external {
        adapter.setExposure(bound(e, -100_000e6, 100_000e6));
    }

    function toggleHeld(bool held) external {
        oracle.setHeld(NVDA_ID, held);
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 900));
        oracle.set(NVDA_ID, 190e18, uint64(block.timestamp), false);
    }

    /// @dev Revoke the key, then try to act with it in the same block (revocation race).
    function revokeAndRace(uint256 amount) external {
        if (!mandate.isActiveKey(key)) {
            _reRegister();
            return;
        }
        vm.prank(sponsor);
        mandate.revokeKey(key, "INV");
        if (_execAs(key, IBookrunnerDesk.ActionKind.FundDesk, abi.encode(bound(amount, 1, 1000e6)), _empty()))
        {
            revokedKeySuccesses++;
        }
        if (_execAs(key, IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(uint256(1)), _empty())) {
            revokedKeySuccesses++;
        }
        _reRegister();
    }

    /// @dev Kill, try to act with the (revoked) key, then re-mandate and re-register.
    function killAndRemandate(uint256 amount) external {
        if (!mandate.killed()) {
            vm.prank(risk);
            mandate.kill("INV");
        }
        if (_execAs(key, IBookrunnerDesk.ActionKind.FundDesk, abi.encode(bound(amount, 1, 1000e6)), _empty()))
        {
            revokedKeySuccesses++;
        }
        bytes memory q = abi.encode(uint16(100), int16(0), uint128(1));
        if (_execAs(key, IBookrunnerDesk.ActionKind.SetQuote, q, _empty())) revokedKeySuccesses++;
        vm.prank(committee);
        mandate.remandate(terms);
        _reRegister();
    }
}

contract MandateInvariantTest is MandateBase {
    MandateHandler internal handler;
    uint256 internal constant CAP = 200e18;

    function setUp() public override {
        super.setUp();
        vm.prank(timelock);
        registry.setFloatCap(address(nvda), CAP);
        adapter.setExposure(-40_000e6);
        handler = new MandateHandler(
            mandate,
            desk,
            adapter,
            oracle,
            staking,
            nvda,
            [key, risk, sponsor, operator, committee],
            _proof(address(nvda), UNIV3)
        );
        targetContract(address(handler));
    }

    /// @notice Non-vacuity: the handler reaches the hedge, quote, race and kill paths.
    function test_handlerExercisesPaths() public {
        handler.fund(20_000e6);
        handler.hedgeBuy(15_000e6);
        assertEq(handler.hedgesOk(), 1);
        assertGt(nvda.balanceOf(address(desk)), 0);
        handler.setQuote(20, 5, 10_000e6);
        assertEq(handler.quotesOk(), 1);
        handler.revokeAndRace(1);
        handler.killAndRemandate(1);
        assertEq(handler.revokedKeySuccesses(), 0);
        assertTrue(mandate.isActiveKey(key));
        handler.flatten(100, true);
        assertEq(nvda.balanceOf(address(desk)), 0);
    }

    /// @notice Float cap: desk Stock Token inventory never exceeds registry floatCapRaw.
    function invariant_floatCapNeverExceeded() public view {
        assertLe(nvda.balanceOf(address(desk)), CAP);
    }

    /// @notice Key revocation race: a revoked key (or any key after kill) never executes.
    function invariant_revokedKeysNeverAct() public view {
        assertEq(handler.revokedKeySuccesses(), 0);
    }

    /// @notice Mandate bounds: any quote that reached the engine is within the mandate.
    function invariant_quotesWithinMandate() public view {
        if (adapter.quoteCalls() == 0) return;
        BRTypes.Mandate memory m = mandate.getMandate();
        assertLe(adapter.lastMaxNet(), m.maxInventoryUsd);
        assertGe(adapter.lastSpread(), m.minQuoteWidthBps);
        int256 sk = int256(adapter.lastSkew());
        assertLe(sk < 0 ? -sk : sk, int256(m.maxSkewBps));
    }

    /// @notice Held-token bookkeeping matches balances (no untracked inventory, no stale entries).
    function invariant_heldSetConsistent() public view {
        address[] memory held = desk.heldTokens();
        bool listed;
        for (uint256 i; i < held.length; ++i) {
            if (held[i] == address(nvda)) listed = true;
        }
        assertEq(listed, nvda.balanceOf(address(desk)) != 0);
    }

    /// @notice The executor never retains balances or allowances between calls.
    function invariant_executorHoldsNothing() public view {
        assertEq(nvda.balanceOf(address(exec)), 0);
        assertEq(usdc.balanceOf(address(exec)), 0);
        assertEq(usdc.allowance(address(desk), address(exec)), 0);
        assertEq(nvda.allowance(address(desk), address(exec)), 0);
        assertEq(usdc.allowance(address(exec), address(router)), 0);
        assertEq(nvda.allowance(address(exec), address(router)), 0);
    }

    /// @notice Keys are bounded; a killed mandate has no usable key on either side (mandate + desk mirror).
    function invariant_keysBoundedAndKillRevokes() public view {
        address[] memory ks = mandate.activeKeys();
        assertLe(ks.length, mandate.MAX_ACTIVE_KEYS());
        if (mandate.killed()) {
            assertEq(ks.length, 0);
            assertEq(desk.sessionKeyValidUntil(key), 0);
        }
        // mirror agreement for the agent key
        if (mandate.getKey(key).active) {
            assertEq(desk.sessionKeyValidUntil(key), mandate.getKey(key).validUntil);
        } else {
            assertEq(desk.sessionKeyValidUntil(key), 0);
        }
    }
}
