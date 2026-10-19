// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {BookFixture} from "./utils/BookFixture.sol";

/// @title Mutation-testing kills for BookLogic (audit 2026-10, Task 7c; docs/MUTATION-2026-10.md)
/// @notice Pins behaviour that a surviving mutant of src/libraries/BookLogic.sol changed without any existing test
///         noticing.
contract BookLogicMutationKillsTest is BookFixture {
    function setUp() public {
        _setUpBook();
        _goLive(); // S 70k / J 30k, 100k deployed, idle 0
        usdc.mint(address(backstop), 50_000e6);
    }

    /// @dev Kills `idle - funded` -> `idle + funded` in fundClaims: after the claims, the backstop repayment takes
    ///      exactly the idle cash that is left, so a partial repayment is paid (not refused as more than the vault
    ///      holds and left wholly owed).
    function test_mut_fundClaims_partialBackstopRepaymentFromWhatIsLeft() public {
        _markWithPnl(-40_000e6); // Junior wiped, Senior short 10k, covered by the backstop
        vm.prank(alice);
        senior.requestRedeem(40_000e6, alice, alice);
        _markWithPnl(40_000e6); // 10k repayment earned; alice's 30k claim unfunded
        (, uint256 owed) = book.backstopDebt();
        assertEq(owed, 10_000e6);
        assertEq(book.unfundedClaims(), 40_000e6);

        _recall(35_000e6); // 30k for the claim, 5k left for the backstop
        book.fundClaims();
        (, owed) = book.backstopDebt();
        assertEq(owed, 5000e6, "half the repayment paid from the 5k left");
        assertEq(usdc.balanceOf(address(backstop)), 45_000e6);
        assertEq(vault.idle(), 0);
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
    }
}
