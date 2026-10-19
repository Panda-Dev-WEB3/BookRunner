// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {StockTokenRegistry} from "../../../src/StockTokenRegistry.sol";
import {MockStockToken} from "../../../src/mocks/MockStockToken.sol";
import {EngineMockConfig} from "../../engine/utils/EngineMocks.sol";

/// @title Audit 2026-10 M-2 follow-up (Task 2 review minor): full registry-side multiplier history.
/// @notice `basisMultiplier(token, basisAt)` (the multiplier in force at a price's share basis; the mark and risk
///         services value split-window positions with it) recorded only the LAST registry-side change. With two
///         changes after the basis (stored mode: two governance `setMultiplier` during one hold) it returned 0
///         ("unknown"), and the mark service fell back to the previous mark's value, or 0 with none. Fix: every
///         registry-side change is recorded (time + value before it); the multiplier in force at the basis is the
///         value before the first change after it. Stored mode is now always exact; live mode keeps the anchor
///         fallback for a token-side change with no registry change after the basis (documented).
contract LeadMultiplierHistoryTest is Test {
    address internal timelock = makeAddr("timelock");
    EngineMockConfig internal cfg;
    StockTokenRegistry internal registry;
    MockStockToken internal token;
    uint64 internal t0;

    function setUp() public {
        vm.warp(1_700_000_000);
        cfg = new EngineMockConfig(timelock);
        registry = new StockTokenRegistry(address(cfg), address(0));
        token = new MockStockToken("x", "x", 1e18);
        vm.prank(timelock);
        registry.register(address(token), bytes32("NVDA"), 1e18, 0);
        t0 = uint64(block.timestamp);
    }

    function _set(uint256 m, uint256 dt) internal {
        vm.warp(block.timestamp + dt);
        vm.prank(timelock);
        registry.setMultiplier(address(token), m);
    }

    /// @notice PoC: two stored-mode changes after the basis. The audited code returns 0 (unknown); now the value in
    ///         force at the basis.
    function test_lead_multiplierHistory_poc_twoChangesAfterBasis() public {
        _set(2e18, 10); // t0 + 10
        _set(3e18, 10); // t0 + 20
        assertEq(registry.basisMultiplier(address(token), t0), 1e18, "two changes after the basis: still exact");
        assertEq(registry.basisMultiplier(address(token), t0 + 10), 2e18);
        assertEq(registry.basisMultiplier(address(token), t0 + 15), 2e18);
        assertEq(registry.basisMultiplier(address(token), t0 + 20), 3e18, "no change since");
    }

    function test_lead_multiplierHistory_sameBlockChanges() public {
        _set(2e18, 10);
        _set(5e18, 0); // same timestamp
        _set(7e18, 10);
        assertEq(registry.basisMultiplier(address(token), t0), 1e18);
        assertEq(registry.basisMultiplier(address(token), t0 + 9), 1e18);
        assertEq(registry.basisMultiplier(address(token), t0 + 10), 5e18, "value after the block's last change");
        assertEq(registry.basisMultiplier(address(token), t0 + 20), 7e18);
    }

    /// @notice A no-op setMultiplier is not a change (unchanged M-2 rule) and records nothing.
    function test_lead_multiplierHistory_noOpNotRecorded() public {
        _set(2e18, 10);
        _set(2e18, 10);
        assertEq(registry.multiplierChangedAt(address(token)), t0 + 10);
        assertEq(registry.basisMultiplier(address(token), t0 + 5), 1e18);
    }

    /// @notice Source switches are changes too: stored 1 -> live (token at 1) -> re-anchor at a split -> stored.
    function test_lead_multiplierHistory_sourceSwitchesAndLiveReanchor() public {
        vm.warp(block.timestamp + 10);
        vm.prank(timelock);
        registry.setMultiplierSource(address(token), true); // t0 + 10, before = 1 (stored)
        vm.warp(block.timestamp + 10);
        vm.prank(timelock);
        registry.setNextMultiplierAnchor(address(token), 10e18);
        token.updateMultiplier(10e18); // token-side split at t0 + 20
        vm.warp(block.timestamp + 10);
        vm.prank(timelock);
        registry.setMultiplier(address(token), 10e18); // stamped re-anchor at t0 + 30, before = anchor 1
        vm.warp(block.timestamp + 10);
        vm.prank(timelock);
        registry.setMultiplierSource(address(token), false); // t0 + 40, before = anchor 10
        assertEq(registry.basisMultiplier(address(token), t0), 1e18);
        assertEq(registry.basisMultiplier(address(token), t0 + 15), 1e18, "pre-split anchor (live, token-side change)");
        assertEq(registry.basisMultiplier(address(token), t0 + 35), 10e18);
        assertEq(registry.basisMultiplier(address(token), t0 + 40), 10e18, "no change since");
    }

    /// @notice Live mode, a token-side change with no registry change after the basis: the anchor (documented live
    ///         case, within the band of the true value).
    function test_lead_multiplierHistory_liveTokenSideChangeUsesAnchor() public {
        vm.prank(timelock);
        registry.setMultiplierSource(address(token), true); // t0
        vm.warp(block.timestamp + 10);
        token.updateMultiplier(1.02e18); // in-band dividend step at t0 + 10
        assertEq(registry.multiplierChangedAt(address(token)), t0 + 10);
        assertEq(registry.basisMultiplier(address(token), t0 + 5), 1e18, "anchor");
    }

    /// @notice Fuzz: a random sequence of stored-mode changes; the view always returns the value in force at the basis.
    function testFuzz_lead_multiplierHistory_matchesModel(uint256 seed, uint8 nChanges, uint64 query) public {
        uint256 n = bound(nChanges, 1, 40);
        uint256[] memory at = new uint256[](n);
        uint256[] memory val = new uint256[](n);
        uint256 cur = 1e18;
        for (uint256 i; i < n; ++i) {
            uint256 dt = uint256(keccak256(abi.encode(seed, i))) % 4; // same-block changes included
            uint256 m = 1e18 + (uint256(keccak256(abi.encode(seed, i, "m"))) % 5) * 1e17;
            _set(m, dt);
            at[i] = block.timestamp;
            val[i] = m;
        }
        uint64 basis = uint64(bound(query, t0 - 5, block.timestamp + 5));
        // model: the last change at or before the basis, else the initial value
        uint256 expected = 1e18;
        for (uint256 i; i < n; ++i) {
            if (at[i] <= basis) expected = val[i];
        }
        cur = registry.basisMultiplier(address(token), basis);
        assertEq(cur, expected);
    }
}
