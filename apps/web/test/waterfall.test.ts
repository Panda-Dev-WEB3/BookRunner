import { describe, expect, test } from "bun:test";
import { distributionModel, frac, illustrateLoss, pickLastDistribution } from "../src/lib/waterfall";

const dist = (g: string, e: string, c: string, s: string, j: string, source = "distribution") => ({
  grossUsd: g,
  expensesUsd: e,
  carryUsd: c,
  seniorUsd: s,
  juniorUsd: j,
  source,
});

describe("distributionModel", () => {
  test("steps cascade gross -> expenses -> carry -> Senior -> Junior and conserve", () => {
    const m = distributionModel(dist("5.750000", "1.000000", "0.475000", "2.565000", "1.710000"));
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.steps.map((s) => s.key)).toEqual(["gross", "expenses", "carry", "senior", "junior"]);
    expect(m.gross).toBe(5_750_000n);
    expect(m.dust).toBe(0n);
    expect(m.conserved).toBe(true);
    expect(m.seniorShareBps).toBe(6000);
    // floating bars: each step sits directly below the previous level
    const [, exp, carry, senior, junior] = m.steps;
    expect(exp).toMatchObject({ from: 4_750_000n, to: 5_750_000n });
    expect(carry).toMatchObject({ from: 4_275_000n, to: 4_750_000n });
    expect(senior).toMatchObject({ from: 1_710_000n, to: 4_275_000n });
    expect(junior).toMatchObject({ from: 0n, to: 1_710_000n });
  });

  test("dust stays in the book; over-allocation is flagged", () => {
    expect(distributionModel(dist("1.000003", "0", "0.100000", "0.540000", "0.360000"))?.dust).toBe(3n);
    expect(distributionModel(dist("1", "0", "0", "1", "1"))?.conserved).toBe(false);
    expect(distributionModel(dist("x", "0", "0", "0", "0"))).toBeNull();
    expect(distributionModel(dist("0", "0", "0", "0", "0"))?.seniorShareBps).toBeNull();
  });

  test("pickLastDistribution prefers the newest credited distribution", () => {
    const items = [dist("0", "0", "0", "0", "0"), dist("5", "1", "0.4", "2.16", "1.44"), dist("9", "1", "0.8", "4.32", "2.88")];
    expect(pickLastDistribution(items)).toBe(items[1] as (typeof items)[number]);
    expect(pickLastDistribution([dist("0", "0", "0", "0", "0")])?.grossUsd).toBe("0");
    expect(pickLastDistribution([dist("0", "0", "0", "0", "0", "venue_taker_share")])).toBeNull();
    expect(pickLastDistribution([])).toBeNull();
  });

  test("frac", () => {
    expect(frac(1n, 4n)).toBe(0.25);
    expect(frac(5n, 0n)).toBe(0);
  });
});

describe("illustrateLoss (loss order Junior -> Senior -> backstop)", () => {
  const S = 70_000_000_000n;
  const J = 30_000_000_000n;
  test("Junior absorbs first", () => {
    const r = illustrateLoss(S, J, 10_000_000_000n, null);
    expect(r.juniorLoss).toBe(10_000_000_000n);
    expect(r.seniorLoss).toBe(0n);
    expect(r.backstopEligible).toBe(0n);
    expect(r.juniorAfter).toBe(20_000_000_000n);
    expect(r.drawdownBps).toBe(-1000);
  });
  test("Senior absorbs only once Junior is exhausted; that part is eligible for the backstop", () => {
    const r = illustrateLoss(S, J, 40_000_000_000n, null);
    expect(r.juniorLoss).toBe(J);
    expect(r.seniorLoss).toBe(10_000_000_000n);
    expect(r.juniorAfter).toBe(0n);
    expect(r.backstopEligible).toBe(10_000_000_000n);
    expect(r.backstopCovered).toBe(0n); // pool size unknown: no cover applied
  });
  test("backstop covers up to the pool", () => {
    const r = illustrateLoss(S, J, 40_000_000_000n, 4_000_000_000n);
    expect(r.backstopCovered).toBe(4_000_000_000n);
    expect(r.seniorAfter).toBe(64_000_000_000n);
  });
  test("loss is clamped to NAV", () => {
    const r = illustrateLoss(S, J, 1_000_000_000_000n, null);
    expect(r.loss).toBe(S + J);
    expect(r.seniorAfter).toBe(0n);
  });
});
