// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {Book} from "../../src/Book.sol";
import {PoolBookFixture} from "./utils/PoolBookFixture.sol";

/// @notice Parity of a pool-funded book with the NORMATIVE TypeScript waterfall (packages/shared/src/waterfall.ts):
///         every `poolBook` row of test/vectors/waterfall.json (scripts/gen-vectors.ts) is run through the real Book,
///         InsurancePool and RevenueRouter — window (no IF raised), premium + split + credit, NAV net of the pool's
///         senior debt, the pool's value of it, mark P&L — and must reproduce the TS numbers exactly.
///   poolBook: [seniorCommitted, juniorCommitted, ifTarget, mmInventory, gross, expensesRequested, premiumBps (as
///              filed), ifLoss, mmLoss(0|1), mmPnlAbs, | seniorAllocated, juniorAllocated, premium, expenses, carry,
///              senior, junior, seniorCredit, juniorCredit, poolValue, nav, S', J'] (the IF is a senior debt: an IF draw
///              is a book loss; the pool's claim is the debt capped by what the book holds)
contract PoolBookParityTest is PoolBookFixture {
    string internal json;
    uint256 internal rows;
    uint256 internal snap;

    function setUp() public {
        json = vm.readFile("test/vectors/waterfall.json");
        rows = vm.parseJsonUint(json, ".poolBookCount");
        _deployPoolInfra();
        snap = vm.snapshotState();
    }

    function test_vectorCount() public view {
        assertEq(rows, 32, "poolBook vector count");
    }

    /// @dev Four tests of 8 rows each (one test per row block keeps each under the test gas limit).
    function test_parity_poolBook_0() public {
        _rows(0, 8);
    }

    function test_parity_poolBook_1() public {
        _rows(8, 16);
    }

    function test_parity_poolBook_2() public {
        _rows(16, 24);
    }

    function test_parity_poolBook_3() public {
        _rows(24, rows);
    }

    function _rows(uint256 from, uint256 to) internal {
        for (uint256 i = from; i < to; i++) {
            vm.revertToState(snap);
            uint256[] memory v = vm.parseJsonUintArray(json, string.concat(".poolBook[", vm.toString(i), "]"));
            assertEq(v.length, 23, "poolBook row width");
            _runRow(v, string.concat("poolBook[", vm.toString(i), "]"));
        }
    }

    function _runRow(uint256[] memory v, string memory tag) internal {
        BRTypes.Charter memory c = _poolCharter();
        c.ifTargetUsd = uint128(v[2]);
        c.mmInventoryUsd = uint128(v[3]);
        c.premiumBps = uint16(v[6]);
        _deployPoolBook(c);

        // window: Senior alice, Junior all from the sponsor
        if (v[0] > 0) _deposit(senior, alice, v[0]);
        _deposit(junior, sponsor, v[1]);
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, v[10], string.concat(tag, " seniorAllocated"));
        assertEq(j, v[11], string.concat(tag, " juniorAllocated"));
        assertEq(venue.ifEquity(), v[2], string.concat(tag, " IF from the pool"));

        // fee flow: premium first, then expenses -> carry -> Senior -> Junior, credited
        usdc.mint(address(rrouter), v[4]);
        rrouter.notifySettlement(BRTypes.SRC_ENGINE_FEES, v[4]);
        vm.prank(keeper);
        rrouter.distribute(1, v[5]);
        uint256[5] memory t = rrouter.totals();
        assertEq(rrouter.premiumTotal(), v[12], string.concat(tag, " premium"));
        assertEq(t[1], v[13], string.concat(tag, " expenses"));
        assertEq(t[2], v[14], string.concat(tag, " carry"));
        assertEq(t[3], v[15], string.concat(tag, " senior"));
        assertEq(t[4], v[16], string.concat(tag, " junior"));
        (uint256 s1, uint256 j1) = book.trancheNav();
        assertEq(s1 - s, v[17], string.concat(tag, " seniorCredit"));
        assertEq(j1 - j, v[18], string.concat(tag, " juniorCredit"));

        // venue moves: traders' bad debt on the IF, MM P&L; then the mark
        venue.setIfEquity(v[2] - v[7]);
        uint256 mm = venue.mmValue();
        venue.setMmValue(v[8] == 1 ? mm - v[9] : mm + v[9]);
        _applyPoolMark();
        (, uint256 debt, uint256 value,,) = book.insuranceDebt();
        assertEq(debt, v[2], string.concat(tag, " debt (nominal until retirement)"));
        assertEq(value, v[19], string.concat(tag, " poolValue"));
        assertEq(pool.bookPosition(BOOK_ID).claim, v[19], string.concat(tag, " pool claim"));
        Book.LastMark memory lm = book.lastMarkSummary();
        assertEq(lm.navUsd, v[20], string.concat(tag, " nav"));
        (uint256 s2, uint256 j2) = book.trancheNav();
        assertEq(s2, v[21], string.concat(tag, " S'"));
        assertEq(j2, v[22], string.concat(tag, " J'"));
    }
}
