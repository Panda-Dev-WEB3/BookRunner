import { describe, expect, test } from "bun:test";
import {
  SPONSOR_MIN_JUNIOR_BPS,
  allocateWindow,
  applyDistribution,
  applyMarkPnl,
  bucketIndex,
  effectivePremiumBps,
  initialDeployment,
  juniorWindowAllocation,
  poolBookNav,
  poolRecoverable,
  premiumSplit,
  splitDistribution,
  splitPoolDistribution,
  walletAllocation,
  windowIfTarget,
} from "../src/waterfall";
import { WAD, usd } from "../src/units";

describe("allocateWindow", () => {
  const base = { ifTargetUsd: usd(25_000), mmInventoryUsd: usd(75_000), seniorCapBps: 7000n };

  test("undersubscribed: everything allocated", () => {
    const r = allocateWindow({ ...base, seniorCommitted: usd(40_000), juniorCommitted: usd(30_000), sponsorJuniorCommitted: usd(5_000) });
    expect(r).toEqual({ ok: true, seniorAllocated: usd(40_000), juniorAllocated: usd(30_000), sponsorJuniorAllocated: usd(5_000) });
  });

  test("oversubscribed senior capped at 70% of raise and by junior ratio", () => {
    const r = allocateWindow({ ...base, seniorCommitted: usd(500_000), juniorCommitted: usd(20_000), sponsorJuniorCommitted: usd(2_000) });
    // sa0 = 70k; ja = min(20k, 30k) = 20k; sa cap by junior = 20k*7000/3000 = 46666.666666
    expect(r.ok).toBe(true);
    expect(r.juniorAllocated).toBe(usd(20_000));
    expect(r.seniorAllocated).toBe(46_666_666_666n);
  });

  test("oversubscribed both: senior 70k, junior fills to raise", () => {
    const r = allocateWindow({ ...base, seniorCommitted: usd(200_000), juniorCommitted: usd(200_000), sponsorJuniorCommitted: usd(20_000) });
    // sponsor 20k allocated first: Junior eligible = min(200k, 10 x 20k) = 200k, 30k of it allocated
    expect(r).toEqual({ ok: true, seniorAllocated: usd(70_000), juniorAllocated: usd(30_000), sponsorJuniorAllocated: usd(20_000) });
  });

  test("sponsor without a Junior commitment cancels (SPONSOR_SKIN)", () => {
    const r = allocateWindow({ ...base, seniorCommitted: usd(10_000), juniorCommitted: usd(30_000), sponsorJuniorCommitted: 0n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("SPONSOR_SKIN");
    expect(r.sponsorJuniorAllocated).toBe(0n);
  });

  test("sponsor below 10% of committed junior: Junior capped at 10x the sponsor, not cancelled", () => {
    const r = allocateWindow({ ...base, seniorCommitted: usd(10_000), juniorCommitted: usd(30_000), sponsorJuniorCommitted: usd(2_999) });
    expect(r).toEqual({ ok: true, seniorAllocated: usd(10_000), juniorAllocated: usd(29_990), sponsorJuniorAllocated: usd(2_999) });
  });

  test("outsider over-committing junior in the last block cannot cancel the book", () => {
    // sponsor 10k + carol 20k, then eve 91k: sponsor 10k / 121k < 10% of committed Junior
    const r = allocateWindow({ ...base, seniorCommitted: usd(70_000), juniorCommitted: usd(121_000), sponsorJuniorCommitted: usd(10_000) });
    expect(r).toEqual({ ok: true, seniorAllocated: usd(70_000), juniorAllocated: usd(30_000), sponsorJuniorAllocated: usd(10_000) });
    // per wallet: sponsor first, the remaining 20k pro-rata over carol + eve; never over-pays
    const sponsor = juniorWindowAllocation(usd(10_000), true, usd(121_000), usd(10_000), r.juniorAllocated);
    const carol = juniorWindowAllocation(usd(20_000), false, usd(121_000), usd(10_000), r.juniorAllocated);
    const eve = juniorWindowAllocation(usd(91_000), false, usd(121_000), usd(10_000), r.juniorAllocated);
    expect(sponsor).toEqual({ shares: usd(10_000), refund: 0n });
    expect(carol.shares).toBe((usd(20_000) * usd(20_000)) / usd(111_000));
    expect(eve.shares).toBe((usd(91_000) * usd(20_000)) / usd(111_000));
    const shares = sponsor.shares + carol.shares + eve.shares;
    const refunds = sponsor.refund + carol.refund + eve.refund;
    expect(shares <= r.juniorAllocated && shares + 2n >= r.juniorAllocated).toBe(true);
    expect(refunds <= usd(121_000) - r.juniorAllocated).toBe(true);
    expect(sponsor.shares * 10_000n >= r.juniorAllocated * SPONSOR_MIN_JUNIOR_BPS).toBe(true);
  });

  test("committed sponsor never fails the skin check and always holds >= 10% of allocated junior", () => {
    for (const J of [usd(1), usd(30_000), usd(999_999), usd(10_000_000)]) {
      for (const P of [1n, usd(1), J / 11n + 1n, J / 10n, J]) {
        if (P > J || P === 0n) continue;
        for (const S of [0n, usd(50_000), usd(1_000_000)]) {
          const r = allocateWindow({ ...base, seniorCommitted: S, juniorCommitted: J, sponsorJuniorCommitted: P });
          expect(r.reason).not.toBe("SPONSOR_SKIN");
          if (r.ok) {
            expect(r.juniorAllocated <= P * 10n).toBe(true);
            expect(r.sponsorJuniorAllocated).toBe(P < r.juniorAllocated ? P : r.juniorAllocated);
            expect(r.sponsorJuniorAllocated * 10_000n >= r.juniorAllocated * SPONSOR_MIN_JUNIOR_BPS).toBe(true);
          }
        }
      }
    }
  });

  test("cannot fund IF cancels", () => {
    const r = allocateWindow({ ...base, seniorCommitted: usd(10_000), juniorCommitted: usd(10_000), sponsorJuniorCommitted: usd(10_000) });
    expect(r.reason).toBe("IF_UNFUNDED");
  });

  test("no junior cancels", () => {
    expect(allocateWindow({ ...base, seniorCommitted: usd(10_000), juniorCommitted: 0n, sponsorJuniorCommitted: 0n }).reason).toBe("NO_JUNIOR");
  });

  test("wallet allocation never over-pays", () => {
    const total = usd(200_000);
    const alloc = usd(70_000);
    let shares = 0n;
    let refunds = 0n;
    for (const c of [usd(1), usd(33_333.333333), usd(66_666.666667), usd(99_999)]) {
      const w = walletAllocation(c, total, alloc);
      expect(w.shares + w.refund <= c).toBe(true);
      shares += w.shares;
      refunds += w.refund;
    }
    expect(shares <= alloc).toBe(true);
    expect(refunds <= total - alloc).toBe(true);
  });

  test("junior window allocation: sponsor first, others pro-rata, never over-pays", () => {
    const others = [usd(1), usd(33_333.333333), usd(66_666.666667), usd(99_999)];
    const nonSponsor = others.reduce((a, b) => a + b, 0n);
    for (const P of [0n, usd(7), usd(25_000), usd(500_000)]) {
      const total = nonSponsor + P;
      for (const alloc of [0n, P / 2n, P, total / 3n, total]) {
        const sp = juniorWindowAllocation(P, true, total, P, alloc);
        expect(sp.shares).toBe(P < alloc ? P : alloc);
        expect(sp.shares + sp.refund).toBe(P);
        let shares = sp.shares;
        let refunds = sp.refund;
        for (const c of others) {
          const w = juniorWindowAllocation(c, false, total, P, alloc);
          expect(w.shares + w.refund <= c).toBe(true);
          shares += w.shares;
          refunds += w.refund;
        }
        expect(shares <= alloc && shares + BigInt(others.length) >= alloc).toBe(true);
        expect(refunds <= total - alloc).toBe(true);
      }
    }
  });

  test("initial deployment: IF first", () => {
    expect(initialDeployment(usd(20_000), usd(25_000), usd(75_000))).toEqual({ ifAmount: usd(20_000), mmAmount: 0n, idle: 0n });
    expect(initialDeployment(usd(110_000), usd(25_000), usd(75_000))).toEqual({ ifAmount: usd(25_000), mmAmount: usd(75_000), idle: usd(10_000) });
  });
});

describe("splitDistribution", () => {
  test("expenses -> 10% carry -> senior hurdle share -> junior", () => {
    const r = splitDistribution({
      gross: usd(1_000),
      expensesRequested: usd(50),
      expenseCapBps: 2000n,
      carryBps: 1000n,
      seniorHurdleBps: 6000n,
      seniorSupply: 1n,
      juniorSupply: 1n,
    });
    expect(r).toEqual({ gross: usd(1_000), expenses: usd(50), carry: usd(95), senior: usd(513), junior: usd(342) });
    expect(r.expenses + r.carry + r.senior + r.junior).toBe(r.gross);
  });

  test("expenses capped", () => {
    const r = splitDistribution({ gross: usd(100), expensesRequested: usd(90), expenseCapBps: 2000n, carryBps: 1000n, seniorHurdleBps: 5000n, seniorSupply: 1n, juniorSupply: 1n });
    expect(r.expenses).toBe(usd(20));
  });

  test("empty tranche gets nothing", () => {
    const r = splitDistribution({ gross: usd(100), expensesRequested: 0n, expenseCapBps: 0n, carryBps: 1000n, seniorHurdleBps: 5000n, seniorSupply: 0n, juniorSupply: 1n });
    expect(r.senior).toBe(0n);
    expect(r.junior).toBe(usd(90));
  });
});

describe("applyMarkPnl", () => {
  const s0 = { seniorNav: usd(70_000), juniorNav: usd(30_000), seniorImpairment: 0n, perfIndex: WAD, highWater: WAD };

  test("loss hits junior first", () => {
    const r = applyMarkPnl(s0, { nav: usd(90_000), juniorSupply: 1n, backstopAvailable: usd(1_000_000) });
    expect(r.juniorNav).toBe(usd(20_000));
    expect(r.seniorNav).toBe(usd(70_000));
    expect(r.backstopCovered).toBe(0n);
    expect(r.drawdownBps).toBe(-1000n);
  });

  test("loss past junior hits senior, backstop covers up to balance", () => {
    const r = applyMarkPnl(s0, { nav: usd(60_000), juniorSupply: 1n, backstopAvailable: usd(4_000) });
    expect(r.juniorNav).toBe(0n);
    expect(r.seniorLoss).toBe(usd(10_000));
    expect(r.backstopCovered).toBe(usd(4_000));
    expect(r.seniorNav).toBe(usd(64_000));
    expect(r.seniorImpairment).toBe(usd(6_000));
  });

  test("gain restores senior impairment first, then junior", () => {
    const impaired = { ...s0, seniorNav: usd(64_000), juniorNav: usd(1_000), seniorImpairment: usd(6_000) };
    const r = applyMarkPnl(impaired, { nav: usd(75_000), juniorSupply: 1n, backstopAvailable: 0n });
    expect(r.seniorRestored).toBe(usd(6_000));
    expect(r.seniorNav).toBe(usd(70_000));
    expect(r.juniorNav).toBe(usd(5_000));
    expect(r.seniorImpairment).toBe(0n);
  });

  test("conservation: S + J == nav + backstopCovered", () => {
    for (const nav of [0n, usd(1), usd(50_000), usd(99_999.999999), usd(100_000), usd(123_456.789)]) {
      const r = applyMarkPnl(s0, { nav, juniorSupply: 1n, backstopAvailable: usd(500) });
      expect(r.seniorNav + r.juniorNav).toBe(nav + r.backstopCovered);
    }
  });

  test("backstop cover becomes debt, repaid from gains before the Junior residual", () => {
    // -40k: Junior wiped, Senior short 10k, the backstop covers it -> debt 10k
    const loss = applyMarkPnl(s0, { nav: usd(60_000), juniorSupply: 1n, backstopAvailable: usd(50_000) });
    expect(loss.backstopCovered).toBe(usd(10_000));
    expect(loss.backstopDebt).toBe(usd(10_000));
    expect(loss.seniorNav).toBe(usd(70_000));
    // +40k recovery: 10k back to the backstop first, Junior gets the remaining 30k
    const gain = applyMarkPnl(loss, { nav: usd(110_000), juniorSupply: 1n, backstopAvailable: 0n });
    expect(gain.backstopRepaid).toBe(usd(10_000));
    expect(gain.backstopDebt).toBe(0n);
    expect(gain.juniorNav).toBe(usd(30_000));
    expect(gain.seniorNav + gain.juniorNav).toBe(usd(110_000) - gain.backstopRepaid);
  });
});

describe("applyDistribution (audit 2026-10 L-1: fee flow repays Senior and the backstop before Junior)", () => {
  test("Senior impaired and backstop owed: the Junior residual restores Senior, then repays, Junior gets the rest", () => {
    const r = applyDistribution({ senior: usd(600), junior: usd(10_000), juniorSupply: 1n, seniorImpairment: usd(6_000), backstopDebt: usd(4_000) });
    expect(r.seniorRestored).toBe(usd(6_000));
    expect(r.backstopRepaid).toBe(usd(4_000));
    expect(r.seniorCredit).toBe(usd(6_600));
    expect(r.juniorCredit).toBe(0n);
    expect(r.seniorImpairment).toBe(0n);
    expect(r.backstopDebt).toBe(0n);
  });

  test("partial residual: impairment first, debt waits", () => {
    const r = applyDistribution({ senior: 0n, junior: usd(2_500), juniorSupply: 1n, seniorImpairment: usd(6_000), backstopDebt: usd(4_000) });
    expect(r.seniorRestored).toBe(usd(2_500));
    expect(r.backstopRepaid).toBe(0n);
    expect(r.seniorImpairment).toBe(usd(3_500));
    expect(r.backstopDebt).toBe(usd(4_000));
  });

  test("healthy book: credited as split", () => {
    const r = applyDistribution({ senior: usd(600), junior: usd(300), juniorSupply: 1n, seniorImpairment: 0n, backstopDebt: 0n });
    expect([r.seniorCredit, r.juniorCredit, r.seniorRestored, r.backstopRepaid]).toEqual([usd(600), usd(300), 0n, 0n]);
  });

  test("no Junior supply: the whole distribution is residual", () => {
    const r = applyDistribution({ senior: 1000n, junior: 0n, juniorSupply: 0n, seniorImpairment: 300n, backstopDebt: 500n });
    expect([r.seniorRestored, r.backstopRepaid, r.seniorCredit, r.juniorCredit]).toEqual([300n, 500n, 500n, 0n]);
  });

  test("conservation: seniorCredit + juniorCredit + backstopRepaid == senior + junior", () => {
    for (const [s, j, imp, debt, js] of [
      [0n, 0n, 0n, 0n, 1n],
      [5n, 7n, 3n, 100n, 1n],
      [usd(1), usd(2), usd(5), usd(5), 0n],
      [123n, 456n, 0n, 789n, 1n],
    ] as const) {
      const r = applyDistribution({ senior: s, junior: j, juniorSupply: js, seniorImpairment: imp, backstopDebt: debt });
      expect(r.seniorCredit + r.juniorCredit + r.backstopRepaid).toBe(s + j);
    }
  });
});

describe("buckets", () => {
  test("ceil to mark interval", () => {
    expect(bucketIndex(86_400n, 86_400n)).toBe(1n);
    expect(bucketIndex(86_401n, 86_400n)).toBe(2n);
    expect(bucketIndex(1n, 300n)).toBe(1n);
  });
});

import { classifyLimits, hedgeBandEnforced } from "../src/mandate";
import type { Mandate } from "../src/types";

describe("hedge band enforceability (spot is long-only)", () => {
  const m: Mandate = {
    maxInventoryUsd: usd(50_000), maxSkewBps: 25, minQuoteWidthBps: 8, maxHedgeLeverage: 100,
    hedgeRatioMinBps: 5000, hedgeRatioMaxBps: 12000, noNewRiskOffHours: true, killAtDrawdownBps: -800,
    hedgeAllowRoot: "0x00",
  };
  test("long exposure with spot-only allow-list: band not enforced, no HEDGE_BAND breach even past grace", () => {
    expect(hedgeBandEnforced(m, usd(20_000), 0n)).toBe(false);
    const s = classifyLimits({ mandate: m, netExposureUsd: usd(20_000), deskHedgeUsd: 0n, drawdownBps: 0, offHours: false, outOfBandSinceSec: 3600, killed: false });
    expect(s.breaches).not.toContain("HEDGE_BAND");
  });
  test("short exposure under-hedged past grace: HEDGE_BAND breach", () => {
    expect(hedgeBandEnforced(m, -usd(20_000), 0n)).toBe(true);
    const s = classifyLimits({ mandate: m, netExposureUsd: -usd(20_000), deskHedgeUsd: 0n, drawdownBps: 0, offHours: false, outOfBandSinceSec: 3600, killed: false });
    expect(s.breaches).toContain("HEDGE_BAND");
  });
  test("long exposure with a perp hedge venue: band enforced", () => {
    expect(hedgeBandEnforced(m, usd(20_000), 0n, true)).toBe(true);
  });
});

describe("insurance pool (2026-10): a pool-funded book", () => {
  test("the window raises only the MM inventory", () => {
    const ifTargetUsd = windowIfTarget(usd(25_000), true);
    expect(ifTargetUsd).toBe(0n);
    expect(windowIfTarget(usd(25_000), false)).toBe(usd(25_000));
    const r = allocateWindow({ ifTargetUsd, mmInventoryUsd: usd(75_000), seniorCapBps: 7000n, seniorCommitted: usd(70_000), juniorCommitted: usd(30_000), sponsorJuniorCommitted: usd(10_000) });
    // max raise 75k: Senior 52.5k (70%), Junior 22.5k; nothing left for an IF
    expect(r).toEqual({ ok: true, seniorAllocated: usd(52_500), juniorAllocated: usd(22_500), sponsorJuniorAllocated: usd(10_000) });
    expect(initialDeployment(usd(75_000), ifTargetUsd, usd(75_000))).toEqual({ ifAmount: 0n, mmAmount: usd(75_000), idle: 0n });
  });

  test("premium: max(charter, floor), capped at 100%, paid before expenses and carry", () => {
    expect(effectivePremiumBps(0n, 1200n)).toBe(1200n);
    expect(effectivePremiumBps(2000n, 1200n)).toBe(2000n);
    expect(effectivePremiumBps(20_000n, 0n)).toBe(10_000n);
    expect(premiumSplit(usd(1_000), 1200n)).toEqual({ premium: usd(120), rest: usd(880) });
    const o = splitPoolDistribution({ gross: usd(1_000), expensesRequested: usd(500), expenseCapBps: 2000n, carryBps: 1000n, seniorHurdleBps: 6000n, seniorSupply: 1n, juniorSupply: 1n }, 1200n);
    // rest 880: expenses capped at 20% of 880 = 176, carry 10% of 704 = 70.4, Senior 60% of 633.6, Junior the rest
    expect(o).toEqual({ gross: usd(1_000), premium: usd(120), expenses: usd(176), carry: 70_400_000n, senior: 380_160_000n, junior: 253_440_000n });
    expect(o.premium + o.expenses + o.carry + o.senior + o.junior).toBe(o.gross);
  });

  test("NAV nets the senior debt: the IF is never Senior / Junior value, an IF draw is a book loss first", () => {
    // venue: IF 25k + MM 75k; vault idle 0. Book-funded: nav 100k. Pool-funded: nav 75k (the MM only).
    expect(poolBookNav(0n, 0n, usd(25_000), usd(100_000))).toBe(usd(75_000));
    // bad debt (or an MM loss paid from the IF) draws 5k: deployed 95k -> nav 70k, the pool is still owed 25k
    expect(poolBookNav(0n, 0n, usd(25_000), usd(95_000))).toBe(usd(70_000));
    expect(poolRecoverable(usd(25_000), 0n, usd(95_000))).toBe(usd(25_000));
  });

  test("the pool loses only what an exhausted book cannot repay", () => {
    // IF drawn to 0 and MM down to 10k: the book holds 10k for a 25k debt
    expect(poolBookNav(0n, 0n, usd(25_000), usd(10_000))).toBe(0n);
    expect(poolRecoverable(usd(25_000), 0n, usd(10_000))).toBe(usd(10_000));
    // idle counts too
    expect(poolRecoverable(usd(25_000), usd(20_000), usd(10_000))).toBe(usd(25_000));
  });
});
