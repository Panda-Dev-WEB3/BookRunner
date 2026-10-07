// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BookFixture} from "../../book/utils/BookFixture.sol";

/// @notice AUDIT area 5 — Backstop cover is never repaid: after the backstop covers a Senior shortfall,
///         a later recovery of the same book flows past the (already restored) Senior straight to the
///         Junior residual. Over a zero-P&L round trip the shared backstop loses the cover and Junior
///         (sponsor + Junior LPs) gains exactly that amount.
contract Area5BackstopSubsidyTest is BookFixture {
    function setUp() public {
        _setUpBook();
    }

    /// Secure behaviour: a book whose venue value goes down and fully back up (net P&L 0) must leave
    /// the backstop whole and Junior no better off than before the round trip.
    function test_audit_backstopCoverLeaksToJunior() public {
        _goLive(); // S 70k / J 30k, 100k deployed
        usdc.mint(address(backstop), 50_000e6); // shared backstop, funded by every book's carry
        uint256 backstopBefore = usdc.balanceOf(address(backstop));

        // mark 1: -40k -> Junior wiped (30k), Senior impaired 10k, backstop covers 10k
        _markWithPnl(-40_000e6);
        (uint256 s1, uint256 j1) = book.trancheNav();
        assertEq(j1, 0);
        assertEq(s1, 70_000e6);
        assertEq(book.seniorImpairment(), 0);
        assertEq(backstopBefore - usdc.balanceOf(address(backstop)), 10_000e6);

        // mark 2: the venue value fully recovers (+40k) -> net venue P&L over both marks = 0
        _markWithPnl(40_000e6);
        (uint256 s2, uint256 j2) = book.trancheNav();
        assertEq(s2, 70_000e6);

        // The backstop is down 10k and nobody owes it anything ...
        uint256 backstopLoss = backstopBefore - usdc.balanceOf(address(backstop));
        // ... while Junior ends with 40k for 30k in, on a zero-P&L round trip.
        assertLe(j2, 30_000e6, "Junior pocketed the backstop cover on recovery");
        assertEq(backstopLoss, 0, "backstop cover never repaid");
    }
}
