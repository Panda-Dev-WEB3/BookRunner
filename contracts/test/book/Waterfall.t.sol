// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Waterfall} from "../../src/libraries/Waterfall.sol";

/// @notice Property / fuzz tests of the waterfall library (red-team: ordering under partial losses).
contract WaterfallTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_USD = 1e18; // 1e12 USD in 6dp

    // ---- window ----

    function testFuzz_allocateWindow_bounds(
        uint256 ifTarget,
        uint256 mm,
        uint256 capBps,
        uint256 sC,
        uint256 jC,
        uint256 spC
    ) public pure {
        ifTarget = bound(ifTarget, 0, MAX_USD);
        mm = bound(mm, 0, MAX_USD);
        capBps = bound(capBps, 0, BPS);
        sC = bound(sC, 0, MAX_USD);
        jC = bound(jC, 0, MAX_USD);
        spC = bound(spC, 0, jC);
        Waterfall.WindowResult memory r = Waterfall.allocateWindow(
            Waterfall.WindowInput({
                ifTargetUsd: ifTarget,
                mmInventoryUsd: mm,
                seniorCapBps: capBps,
                seniorCommitted: sC,
                juniorCommitted: jC,
                sponsorJuniorCommitted: spC
            })
        );
        if (!r.ok) {
            assertEq(r.seniorAllocated + r.juniorAllocated, 0);
            assertGt(r.reason, 0);
            return;
        }
        assertEq(r.reason, 0);
        assertLe(r.seniorAllocated, sC);
        assertLe(r.juniorAllocated, jC);
        assertGt(r.juniorAllocated, 0);
        assertLe(r.seniorAllocated + r.juniorAllocated, ifTarget + mm, "<= max raise");
        assertGe(r.seniorAllocated + r.juniorAllocated, ifTarget, "IF funded");
        // senior <= cap of final capital (floor rounding of the cap formula)
        assertLe(r.seniorAllocated * BPS, (r.seniorAllocated + r.juniorAllocated) * capBps + BPS);
        // sponsor priority: allocated first, Junior capped at 10x the sponsor => skin always held
        assertEq(r.sponsorJuniorAllocated, spC < r.juniorAllocated ? spC : r.juniorAllocated);
        assertLe(r.juniorAllocated, spC * 10, "Junior <= 10x sponsor");
        assertGe(r.sponsorJuniorAllocated * BPS, r.juniorAllocated * Waterfall.SPONSOR_MIN_JUNIOR_BPS);
    }

    /// @dev A sponsor with a Junior commitment never fails SPONSOR_SKIN, however much others commit.
    function testFuzz_allocateWindow_committedSponsorNeverSkinCancels(uint256 jC, uint256 spC, uint256 sC)
        public
        pure
    {
        jC = bound(jC, 1, MAX_USD);
        spC = bound(spC, 1, jC);
        sC = bound(sC, 0, MAX_USD);
        Waterfall.WindowResult memory r = Waterfall.allocateWindow(
            Waterfall.WindowInput({
                ifTargetUsd: 25_000e6,
                mmInventoryUsd: 75_000e6,
                seniorCapBps: 7000,
                seniorCommitted: sC,
                juniorCommitted: jC,
                sponsorJuniorCommitted: spC
            })
        );
        assertTrue(r.reason != Waterfall.REASON_SPONSOR_SKIN);
    }

    function test_allocateWindow_noSponsorCommitment_skinFails() public pure {
        Waterfall.WindowResult memory r = Waterfall.allocateWindow(
            Waterfall.WindowInput({
                ifTargetUsd: 25_000e6,
                mmInventoryUsd: 75_000e6,
                seniorCapBps: 7000,
                seniorCommitted: 50_000e6,
                juniorCommitted: 30_000e6,
                sponsorJuniorCommitted: 0
            })
        );
        assertFalse(r.ok);
        assertEq(r.reason, Waterfall.REASON_SPONSOR_SKIN);
        assertEq(r.sponsorJuniorAllocated, 0);
    }

    function test_allocateWindow_outsiderOverCommit_cappedNotCancelled() public pure {
        // sponsor 10k, others 111k committed: Junior eligible 100k, raise room 30k
        Waterfall.WindowResult memory r = Waterfall.allocateWindow(
            Waterfall.WindowInput({
                ifTargetUsd: 25_000e6,
                mmInventoryUsd: 75_000e6,
                seniorCapBps: 7000,
                seniorCommitted: 70_000e6,
                juniorCommitted: 121_000e6,
                sponsorJuniorCommitted: 10_000e6
            })
        );
        assertTrue(r.ok);
        assertEq(r.seniorAllocated, 70_000e6);
        assertEq(r.juniorAllocated, 30_000e6);
        assertEq(r.sponsorJuniorAllocated, 10_000e6);
    }

    function testFuzz_juniorWindowAllocation_sumsBounded(
        uint256 sp,
        uint256 c1,
        uint256 c2,
        uint256 c3,
        uint256 alloc
    ) public pure {
        uint256[4] memory c =
            [bound(sp, 0, MAX_USD), bound(c1, 0, MAX_USD), bound(c2, 0, MAX_USD), bound(c3, 0, MAX_USD)];
        uint256 total = c[0] + c[1] + c[2] + c[3];
        alloc = bound(alloc, 0, total);
        uint256 shares;
        uint256 refunds;
        for (uint256 i = 0; i < 4; i++) {
            (uint256 s, uint256 r) = Waterfall.juniorWindowAllocation(c[i], i == 0, total, c[0], alloc);
            assertLe(s + r, c[i], "never more than committed");
            if (i == 0) {
                assertEq(s, c[0] < alloc ? c[0] : alloc, "sponsor first");
                assertEq(s + r, c[0]);
            } else if (c[0] == 0) {
                // without a sponsor commitment it is plain pro-rata
                (uint256 w, uint256 x) = Waterfall.walletAllocation(c[i], total, alloc);
                assertEq(s, w);
                assertEq(r, x);
            }
            shares += s;
            refunds += r;
        }
        assertLe(shares, alloc, "shares <= allocated");
        assertGe(shares + 3, alloc, "dust <= 1 per pro-rata wallet");
        assertLe(refunds, total - alloc, "refunds <= unallocated");
    }

    function test_allocateWindow_capAboveBpsClamped() public pure {
        Waterfall.WindowResult memory r = Waterfall.allocateWindow(
            Waterfall.WindowInput({
                ifTargetUsd: 10,
                mmInventoryUsd: 90,
                seniorCapBps: 20_000,
                seniorCommitted: 1000,
                juniorCommitted: 50,
                sponsorJuniorCommitted: 50
            })
        );
        // out-of-domain cap (charter validation rejects it) is clamped to 100%: no underflow, Senior
        // takes the whole raise and the window fails NO_JUNIOR
        assertFalse(r.ok);
        assertEq(r.reason, Waterfall.REASON_NO_JUNIOR);
    }

    function testFuzz_walletAllocation_sumsBounded(uint256 c1, uint256 c2, uint256 c3, uint256 alloc)
        public
        pure
    {
        c1 = bound(c1, 0, MAX_USD);
        c2 = bound(c2, 0, MAX_USD);
        c3 = bound(c3, 0, MAX_USD);
        uint256 total = c1 + c2 + c3;
        alloc = bound(alloc, 0, total);
        (uint256 s1, uint256 r1) = Waterfall.walletAllocation(c1, total, alloc);
        (uint256 s2, uint256 r2) = Waterfall.walletAllocation(c2, total, alloc);
        (uint256 s3, uint256 r3) = Waterfall.walletAllocation(c3, total, alloc);
        assertLe(s1 + s2 + s3, alloc);
        assertLe(r1 + r2 + r3, total - alloc);
        assertLe(s1 + r1, c1);
        assertGe(s1 + r1 + 2, c1); // at most 1 unit of dust per floor
        // window round: roundAllocation == walletAllocation
        (uint256 s1b, uint256 r1b) = Waterfall.roundAllocation(c1, total, alloc, alloc);
        assertEq(s1b, s1);
        assertEq(r1b, r1);
    }

    function testFuzz_initialDeployment(uint256 total, uint256 ifTarget, uint256 mm) public pure {
        total = bound(total, 0, MAX_USD);
        ifTarget = bound(ifTarget, 0, MAX_USD);
        mm = bound(mm, 0, MAX_USD);
        (uint256 a, uint256 b, uint256 idle) = Waterfall.initialDeployment(total, ifTarget, mm);
        assertEq(a + b + idle, total);
        assertLe(a, ifTarget);
        assertLe(b, mm);
        if (b > 0) assertEq(a, ifTarget, "IF first");
    }

    // ---- split ----

    function testFuzz_split_conservesAndOrders(
        uint256 gross,
        uint256 exp,
        uint256 capBps,
        uint256 carryBps,
        uint256 hurdle,
        uint256 sSup,
        uint256 jSup
    ) public pure {
        gross = bound(gross, 0, MAX_USD);
        exp = bound(exp, 0, MAX_USD);
        capBps = bound(capBps, 0, BPS);
        carryBps = bound(carryBps, 0, BPS);
        hurdle = bound(hurdle, 0, BPS);
        sSup = bound(sSup, 0, 2);
        jSup = bound(jSup, 0, 2);
        Waterfall.SplitResult memory o = Waterfall.splitDistribution(
            Waterfall.SplitInput({
                gross: gross,
                expensesRequested: exp,
                expenseCapBps: capBps,
                carryBps: carryBps,
                seniorHurdleBps: hurdle,
                seniorSupply: sSup,
                juniorSupply: jSup
            })
        );
        assertEq(o.expenses + o.carry + o.senior + o.junior, gross, "conservation");
        assertLe(o.expenses, exp);
        assertLe(o.expenses * BPS, gross * capBps);
        assertEq(o.carry, ((gross - o.expenses) * carryBps) / BPS, "carry on net fee flow only");
        if (sSup == 0) assertEq(o.senior, 0);
        if (jSup == 0 && sSup != 0) assertEq(o.junior, 0);
    }

    // ---- mark ----

    function _mark(uint256 s, uint256 j, uint256 imp, uint256 nav, uint256 jSup, uint256 avail)
        internal
        pure
        returns (Waterfall.MarkResult memory)
    {
        return Waterfall.applyMarkPnl(
            Waterfall.MarkState({
                seniorNav: s, juniorNav: j, seniorImpairment: imp, perfIndex: WAD, highWater: WAD
            }),
            Waterfall.MarkInputs({nav: nav, juniorSupply: jSup, backstopAvailable: avail})
        );
    }

    /// @dev RED-TEAM: losses Junior -> Senior -> backstop; conservation S' + J' == nav + covered.
    function testFuzz_mark_lossOrdering(uint256 s, uint256 j, uint256 imp, uint256 nav, uint256 avail)
        public
        pure
    {
        s = bound(s, 0, MAX_USD);
        j = bound(j, 0, MAX_USD);
        imp = bound(imp, 0, MAX_USD);
        nav = bound(nav, 0, s + j);
        avail = bound(avail, 0, MAX_USD);
        Waterfall.MarkResult memory r = _mark(s, j, imp, nav, 1, avail);
        uint256 loss = s + j - nav;
        assertEq(r.seniorNav + r.juniorNav, nav + r.backstopCovered, "conservation");
        assertEq(r.juniorLoss + r.seniorLoss, loss);
        if (loss <= j) {
            assertEq(r.seniorLoss, 0, "senior untouched while junior absorbs");
            assertEq(r.juniorNav, j - loss);
        } else {
            assertEq(r.juniorNav, 0, "junior exhausted first");
            assertEq(r.seniorLoss, loss - j);
        }
        if (r.backstopCovered > 0) assertEq(r.juniorNav, 0, "backstop only after junior is exhausted");
        assertLe(r.backstopCovered, avail);
        assertEq(r.seniorImpairment + r.backstopCovered, imp + r.seniorLoss);
        assertLe(r.drawdownBps, 0);
    }

    function testFuzz_mark_gainOrdering(uint256 s, uint256 j, uint256 imp, uint256 gain, bool noJunior)
        public
        pure
    {
        s = bound(s, 0, MAX_USD);
        j = bound(j, 1, MAX_USD);
        imp = bound(imp, 0, MAX_USD);
        gain = bound(gain, 1, MAX_USD);
        Waterfall.MarkResult memory r = _mark(s, j, imp, s + j + gain, noJunior ? 0 : 1, 0);
        assertEq(r.seniorRestored, gain < imp ? gain : imp, "impairment restored first");
        assertEq(r.seniorImpairment, imp - r.seniorRestored);
        assertEq(r.seniorNav + r.juniorNav, s + j + gain);
        if (noJunior) assertEq(r.juniorNav, j);
        else assertEq(r.juniorNav, j + gain - r.seniorRestored);
        assertEq(r.drawdownBps, 0);
        assertGt(r.perfIndex, WAD - 1);
    }

    function testFuzz_drawdownKill(int256 dd, int256 killAt) public pure {
        dd = bound(dd, -10_000, 0);
        killAt = bound(killAt, -10_000, 10_000);
        bool k = Waterfall.drawdownKill(dd, killAt);
        if (killAt >= 0) assertFalse(k);
        else assertEq(k, dd <= killAt);
    }

    function test_perfIndex_hugeMoves_noOverflow() public pure {
        Waterfall.MarkResult memory r = Waterfall.applyMarkPnl(
            Waterfall.MarkState({
                seniorNav: 1, juniorNav: 0, seniorImpairment: 0, perfIndex: 1e50, highWater: 1e50
            }),
            Waterfall.MarkInputs({nav: 1e24, juniorSupply: 0, backstopAvailable: 0})
        );
        assertEq(r.perfIndex, 1e74);
        assertEq(r.highWater, 1e74);
    }

    // ---- prices / buckets ----

    function testFuzz_sharePrice_neverOverpays(uint256 nav, uint256 supply, uint256 shares) public pure {
        nav = bound(nav, 0, MAX_USD);
        supply = bound(supply, 1, MAX_USD);
        shares = bound(shares, 0, supply);
        uint256 p = Waterfall.sharePriceWad(nav, supply);
        assertLe(Waterfall.sharesToAssets(supply, p), nav);
        assertLe(Waterfall.sharesToAssets(shares, p) + Waterfall.sharesToAssets(supply - shares, p), nav);
        assertEq(Waterfall.sharePriceWad(nav, 0), WAD);
    }

    /// @dev A request eligible at e settles at the first mark T (multiple of interval) with T >= e.
    function testFuzz_bucket_settlesAtFirstMarkAfterEligibility(uint256 e, uint256 interval, uint256 k)
        public
        pure
    {
        interval = bound(interval, 1, 30 days);
        e = bound(e, 0, 1e12);
        k = bound(k, 0, 1e6);
        uint256 b = Waterfall.bucketIndex(e, interval);
        uint256 t = k * interval;
        assertEq(b <= Waterfall.settlesUpTo(t, interval), e <= t);
        assertEq(Waterfall.redeemEligibleAt(0, e, 7 days), e);
        assertEq(Waterfall.redeemEligibleAt(1, e, 7 days), e + 7 days);
    }

    function testFuzz_markedNav_variants(uint256 idle, uint256 unfunded, uint256 deployed) public pure {
        idle = bound(idle, 0, MAX_USD);
        unfunded = bound(unfunded, 0, MAX_USD);
        deployed = bound(deployed, 0, MAX_USD);
        uint256 ts = Waterfall.markedNav(idle, unfunded, deployed);
        uint256 net = Waterfall.markedNavNet(idle, unfunded, deployed);
        if (idle >= unfunded) assertEq(ts, net);
        else assertLe(net, ts); // the TS formula ignores the uncovered part of the liability
        assertEq(net, idle + deployed > unfunded ? idle + deployed - unfunded : 0);
    }
}
