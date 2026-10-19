// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IAttestedOracle} from "../../src/interfaces/IAttestedOracle.sol";
import {IMMMandate} from "../../src/interfaces/IMMMandate.sol";
import {MMMandate} from "../../src/MMMandate.sol";
import {MandateBase} from "./utils/MandateBase.sol";
import {MandateMockBook} from "./utils/MandateMocks.sol";

/// @dev An oracle whose reads always revert.
contract RevertingOracle {
    function latest(bytes32) external pure returns (IAttestedOracle.PriceData memory) {
        revert("oracle down");
    }
}

/// @title Mutation-testing kills for MMMandate (audit 2026-10, Task 7c; docs/MUTATION-2026-10.md)
/// @notice Each test pins a boundary or a fail-safe that a surviving mutant of src/MMMandate.sol changed without any
///         existing test noticing: component checks at initialize, the spot float cap and holdings bounds, the
///         naked-spot rule's prior position, the hedge band's edges, key expiry at its last second, the fail-safe
///         off-hours read and the canonical-token check.
contract MandateMutationKillsTest is MandateBase {
    function _hp(address token, bytes32 v, bool buy, uint256 qty, uint256 notional)
        internal
        pure
        returns (IMMMandate.HedgeParams memory)
    {
        return IMMMandate.HedgeParams({
            asset: bytes32(uint256(uint160(token))), venue: v, buy: buy, qtyRaw: qty, notionalUsd: notional, leverage: 100
        });
    }

    /// @dev Kills `c.desk == 0 || c.vault == 0 && c.adapter == 0` (and the mirror): each missing component alone reverts.
    function test_mut_init_eachMissingComponentRefused() public {
        for (uint256 i; i < 3; ++i) {
            MMMandate m = MMMandate(Clones.clone(address(mandateImpl)));
            MandateMockBook b = new MandateMockBook();
            BRTypes.BookComponents memory comps;
            comps.mandate = address(m);
            comps.desk = i == 0 ? address(0) : address(desk);
            comps.vault = i == 1 ? address(0) : address(vault);
            comps.adapter = i == 2 ? address(0) : address(adapter);
            b.setUp(8, _charter(BRTypes.VENUE_POOL_ENGINE), comps);
            vm.expectRevert(MMMandate.ComponentMismatch.selector);
            m.initialize(address(cfg), 8, address(b));
        }
    }

    /// @dev Kills `held + qty > cap` -> `>=` and `qty > held` -> `>=`: buying up to exactly the float cap and selling
    ///      exactly the whole holding are allowed.
    function test_mut_spot_exactFloatCapAndWholeHoldingAllowed() public {
        adapter.setExposure(-20_000e6);
        bytes32[] memory p = _proof(address(nvda), UNIV3);
        uint256 cap = _tokenInfo(address(nvda)).floatCapRaw;
        mandate.checkHedge(key, _hp(address(nvda), UNIV3, true, cap, 15_000e6), p);

        _fundDesk(15_000e6);
        _buyNvda(15_000e6);
        uint256 held = nvda.balanceOf(address(desk));
        assertGt(held, 0);
        mandate.checkHedge(key, _hp(address(nvda), UNIV3, false, held, 4000e6), p);
        vm.expectRevert(IMMMandate.SpotShortNotAllowed.selector);
        mandate.checkHedge(key, _hp(address(nvda), UNIV3, false, held + 1, 4000e6), p);
    }

    /// @dev Kills `prior = |exposure + before|` -> `|exposure - before|` and `net > limit` -> `>=`: below the band
    ///      threshold a spot buy may not leave a naked net position above max(5% of maxInventory, its prior value),
    ///      and a leg that keeps it unchanged is allowed.
    function test_mut_spot_nakedRuleUsesThePriorNetPosition() public {
        adapter.setExposure(-20_000e6);
        _fundDesk(5000e6);
        _buyNvda(5000e6);
        int256 h = desk.hedgeNotionalUsd();
        assertGt(h, 3000e6);
        adapter.setExposure(-2000e6); // below the 5% (2,500) threshold: band not enforced, naked-spot rule applies
        bytes32[] memory p = _proof(address(nvda), UNIV3);
        uint256 limit = uint256(h - 2000e6); // |exposure + before| > 2,500
        uint256 net = limit + 1000e6;
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.InventoryLimit.selector, net, limit));
        mandate.checkHedge(key, _hp(address(nvda), UNIV3, true, 1, 1000e6), p);
        // net unchanged (== limit): allowed
        mandate.checkHedge(key, _hp(address(nvda), UNIV3, true, 1, 0), p);
    }

    /// @dev Kills `rAfter >= lo` -> `>` and `rAfter <= hi` -> `<`: from inside the band, landing exactly on either
    ///      edge is in band (ratio = hedge / |exposure|: 5,000 bps at 10,000 USD, 12,000 bps at 24,000 USD).
    function test_mut_band_edgesAreInBand() public {
        adapter.setExposure(-20_000e6);
        _fundDesk(15_000e6);
        _buyNvda(15_000e6);
        int256 h = desk.hedgeNotionalUsd(); // ~15,000: ratio ~7,500, in band
        bytes32[] memory p = _proof(address(nvda), V_ENGINE);
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, false, 1, uint256(h - 10_000e6)), p);
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, true, 1, uint256(24_000e6 - h)), p);
        // one unit past either edge is out of band and farther than the start
        vm.expectRevert(
            abi.encodeWithSelector(IMMMandate.HedgeRatioOutOfBand.selector, uint256(4999), uint256(5000), uint256(12_000))
        );
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, false, 1, uint256(h - 9999e6)), p);
    }

    /// @dev Kills `block.timestamp > validUntil` -> `>=` in `_requireActiveKey` and in `_canRevoke`: a key is usable
    ///      in its last second, and only its own parties may revoke it until it has expired.
    function test_mut_key_lastSecondStillActive() public {
        uint64 until = uint64(block.timestamp + 30 days);
        assertEq(mandate.getKey(key).validUntil, until);
        vm.warp(until);
        _refreshPrices();
        assertTrue(mandate.isActiveKey(key));
        mandate.checkQuote(key, 8, 0, 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MMMandate.Unauthorized.selector, stranger));
        mandate.revokeKey(key, "EARLY");

        vm.warp(uint256(until) + 1);
        _refreshPrices();
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.KeyExpired.selector, key));
        mandate.checkQuote(key, 8, 0, 1);
        vm.prank(stranger);
        mandate.revokeKey(key, "EXPIRED");
    }

    /// @dev Kills `catch { return true; }` -> `false` in offHours: an oracle that cannot be read is off-hours.
    function test_mut_offHours_unreadableOracleFailsSafe() public {
        assertFalse(mandate.offHours());
        cfg.setOracle(address(new RevertingOracle()));
        assertTrue(mandate.offHours());
    }

    /// @dev Kills the removal of `uint256(asset) >> 160 != 0`: an asset id whose low 160 bits are a canonical token
    ///      but whose high bits are set is not that token.
    function test_mut_spot_assetWithHighBitsIsNotTheToken() public {
        adapter.setExposure(-20_000e6);
        bytes32 dirty = bytes32(uint256(uint160(address(nvda))) | (uint256(1) << 200));
        vm.expectRevert(abi.encodeWithSelector(MMMandate.NotCanonicalToken.selector, dirty));
        mandate.checkHedge(
            key, IMMMandate.HedgeParams(dirty, UNIV3, true, 1, 15_000e6, 100), _proof(address(nvda), UNIV3)
        );
    }
}
