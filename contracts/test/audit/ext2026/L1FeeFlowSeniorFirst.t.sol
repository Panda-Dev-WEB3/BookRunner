// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Book} from "../../../src/Book.sol";
import {Waterfall} from "../../../src/libraries/Waterfall.sol";
import {BookFixture} from "../../book/utils/BookFixture.sol";

/// @notice Audit 2026-10 L-1: fee flow was credited to Junior while Senior was impaired or the backstop was
///         still owed (only mark gains repaid them). The Junior residual of a distribution now follows the mark
///         gain order: Senior impairment first, then backstop debt, then Junior. Senior's hurdle share is
///         Senior's own income and is credited as before.
contract L1FeeFlowSeniorFirstTest is BookFixture {
    function setUp() public {
        _setUpBook();
        _goLive(); // S 70k / J 30k, 100k deployed, idle 0
        usdc.mint(address(backstop), 50_000e6);
    }

    function _debt() internal view returns (uint256 debt, uint256 owed) {
        return book.backstopDebt();
    }

    /// @dev The auditor's scenario: Junior wiped, Senior short 10k, the backstop covers only 4k (impairment 6k,
    ///      debt 4k). A fee distribution of 600 Senior / 10,000 Junior used to raise Junior to 10,000 while Senior
    ///      stayed 6k short and the backstop stayed owed 4k.
    function test_L1_poc_juniorResidualRestoresSeniorThenRepaysBackstop() public {
        usdc.burn(address(backstop), 46_000e6); // the backstop holds 4k
        _markWithPnl(-40_000e6);
        assertEq(book.seniorImpairment(), 6000e6, "Senior impaired");
        (uint256 debt,) = _debt();
        assertEq(debt, 4000e6, "backstop owed");
        (uint256 s0, uint256 j0) = book.trancheNav();
        assertEq(j0, 0, "Junior wiped");

        _credit(600e6, 10_000e6);

        (uint256 s1, uint256 j1) = book.trancheNav();
        assertEq(book.seniorImpairment(), 0, "impairment restored first");
        assertEq(s1, s0 + 600e6 + 6000e6, "Senior: hurdle share + restoration");
        (uint256 debtAfter, uint256 owed) = _debt();
        assertEq(debtAfter, 0, "backstop debt repaid next");
        assertEq(owed, 4000e6, "repayment owed, netted from NAV until the vault pays it");
        assertEq(j1, 0, "nothing left for Junior");
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs, "accounting identity");

        book.fundClaims();
        (, owed) = _debt();
        assertEq(owed, 0);
        assertEq(usdc.balanceOf(address(backstop)), 4000e6, "backstop made whole from fee flow");
    }

    function test_L1_backstopDebtOnly_repaidBeforeJunior() public {
        _markWithPnl(-40_000e6); // Junior wiped, Senior short 10k, fully covered: debt 10k, no impairment
        assertEq(book.seniorImpairment(), 0);
        _credit(0, 15_000e6);
        (uint256 debt, uint256 owed) = _debt();
        assertEq(debt, 0);
        assertEq(owed, 10_000e6);
        (, uint256 j) = book.trancheNav();
        assertEq(j, 5000e6, "Junior gets the rest");
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
    }

    function test_L1_partialResidual_restoresPartially() public {
        usdc.burn(address(backstop), 46_000e6);
        _markWithPnl(-40_000e6); // impairment 6k, debt 4k
        _credit(0, 2500e6);
        assertEq(book.seniorImpairment(), 3500e6);
        (uint256 debt, uint256 owed) = _debt();
        assertEq(debt, 4000e6, "debt waits for the impairment");
        assertEq(owed, 0);
        (, uint256 j) = book.trancheNav();
        assertEq(j, 0);
    }

    function test_L1_emitsDistributionRepaid() public {
        usdc.burn(address(backstop), 46_000e6);
        _markWithPnl(-40_000e6);
        usdc.mint(address(vault), 10_600e6);
        vm.expectEmit(true, false, false, true, address(book));
        emit Book.DistributionRepaid(BOOK_ID, 6000e6, 4000e6);
        vm.prank(router);
        book.creditDistribution(600e6, 10_000e6);
    }

    function test_L1_control_healthyBook_unchanged() public {
        (uint256 s0, uint256 j0) = book.trancheNav();
        _credit(600e6, 300e6);
        (uint256 s1, uint256 j1) = book.trancheNav();
        assertEq(s1, s0 + 600e6);
        assertEq(j1, j0 + 300e6);
    }

    /// @dev No Junior supply: the router credits everything to Senior, so all of it is residual.
    function test_L1_pureFunction_juniorSupplyZero_allResidual() public pure {
        Waterfall.DistributionResult memory r = Waterfall.applyDistribution(
            Waterfall.DistributionInput({
                senior: 1000, junior: 0, juniorSupply: 0, seniorImpairment: 300, backstopDebt: 500
            })
        );
        assertEq(r.seniorRestored, 300);
        assertEq(r.backstopRepaid, 500);
        assertEq(r.seniorCredit, 500, "restored 300 + residual 200");
        assertEq(r.juniorCredit, 0);
        assertEq(r.seniorImpairment, 0);
        assertEq(r.backstopDebt, 0);
    }

    function testFuzz_L1_conservationAndOrder(uint128 s, uint128 j, uint128 imp, uint128 debt, bool noJunior)
        public
        pure
    {
        Waterfall.DistributionResult memory r = Waterfall.applyDistribution(
            Waterfall.DistributionInput({
                senior: s, junior: j, juniorSupply: noJunior ? 0 : 1, seniorImpairment: imp, backstopDebt: debt
            })
        );
        assertEq(
            r.seniorCredit + r.juniorCredit + r.backstopRepaid, uint256(s) + j, "credit + repayment == distributed"
        );
        assertEq(r.seniorImpairment, uint256(imp) - r.seniorRestored);
        assertEq(r.backstopDebt, uint256(debt) - r.backstopRepaid);
        if (r.juniorCredit > 0) assertTrue(r.seniorImpairment == 0 && r.backstopDebt == 0, "Junior only once whole");
        if (r.backstopRepaid > 0) assertEq(r.seniorImpairment, 0, "impairment before the backstop");
        if (!noJunior) assertGe(r.seniorCredit, s, "Senior keeps its hurdle share");
    }
}
