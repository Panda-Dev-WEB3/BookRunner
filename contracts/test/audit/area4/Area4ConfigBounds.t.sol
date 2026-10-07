// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {BookrunnerConfig} from "../../../src/BookrunnerConfig.sol";

/// @notice AREA 4 audit PoC — A4-03: BookrunnerConfig accepts 0 for parameters where 0 bricks a
///         protocol function (it already rejects 0 for markInterval / maxPriceAge / maxTradePriceAge).
contract Area4ConfigBoundsTest is Test {
    BookrunnerConfig internal config;

    function setUp() public {
        config = new BookrunnerConfig(address(this));
    }

    /// @notice maxMarkAge == 0: MarkRegistry._commit requires block.timestamp - periodEnd <= 0 with
    ///         periodEnd aligned to markInterval, i.e. a mark is only committable in the exact second the
    ///         period ends. Marks stop for every book -> redemption buckets never settle (BOUNTY_SCOPE:
    ///         "redemption blocked by permission").
    function test_audit_maxMarkAgeZeroRejected() public {
        vm.expectRevert(abi.encodeWithSelector(BookrunnerConfig.ParamOutOfRange.selector, bytes32("maxMarkAge"), 0));
        config.setParam("maxMarkAge", 0);
    }

    /// @notice committeeWindow == 0: MarketCharter.decide always reverts DecisionWindowClosed (every
    ///         charter is immediately expirable) and RiskCommittee.approveAction always reverts
    ///         ActionExpired, disabling the committee's emergency REVOKE_KEY / RETIRE / SLASH_SPONSOR path.
    function test_audit_committeeWindowZeroRejected() public {
        vm.expectRevert(
            abi.encodeWithSelector(BookrunnerConfig.ParamOutOfRange.selector, bytes32("committeeWindow"), 0)
        );
        config.setParam("committeeWindow", 0);
    }
}
