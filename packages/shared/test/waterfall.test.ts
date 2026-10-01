import { describe, expect, test } from "bun:test";
import { allocateWindow, applyMarkPnl, bucketIndex, initialDeployment, splitDistribution, walletAllocation } from "../src/waterfall";
import { WAD, usd } from "../src/units";

describe("allocateWindow", () => {
  const base = { ifTargetUsd: usd(25_000), mmInventoryUsd: usd(75_000), seniorCapBps: 7000n };

  test("undersubscribed: everything allocated", () => {
    const r = allocateWindow({ ...base, seniorCommitted: usd(40_000), juniorCommitted: usd(30_000), sponsorJuniorCommitted: usd(5_000) });
    expect(r).toEqual({ ok: true, seniorAllocated: usd(40_000), juniorAllocated: usd(30_000) });
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
    expect(r).toEqual({ ok: true, seniorAllocated: usd(70_000), juniorAllocated: usd(30_000) });
  });

  test("sponsor below 10% of junior cancels", () => {
    const r = allocateWindow({ ...base, seniorCommitted: usd(10_000), juniorCommitted: usd(30_000), sponsorJuniorCommitted: usd(2_999) });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("SPONSOR_SKIN");
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
});

describe("buckets", () => {
  test("ceil to mark interval", () => {
    expect(bucketIndex(86_400n, 86_400n)).toBe(1n);
    expect(bucketIndex(86_401n, 86_400n)).toBe(2n);
    expect(bucketIndex(1n, 300n)).toBe(1n);
  });
});
