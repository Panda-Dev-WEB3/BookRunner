import { describe, expect, test } from "bun:test";
import { checkCopy } from "@bookrunner/shared/copy";
import { splitDistribution } from "@bookrunner/shared/waterfall";
import {
  DEFAULT_SIM,
  LAUNCH_TERMS,
  PROTOCOL_DEFAULTS,
  type SimInput,
  clampBps,
  feeSentence,
  lossSentence,
  pctText,
  presetFromBook,
  quoteDemo,
  share,
  simulateFees,
  simulateLoss,
  splitCapital,
  usdFromNumber,
  usdText,
} from "../src/components/learn/sim";

const U = 1_000_000n; // 1 USDC in 6dp
const sim = (patch: Partial<SimInput> = {}): SimInput => ({ ...DEFAULT_SIM, ...patch });

describe("unit conversion", () => {
  test("usdFromNumber converts slider dollars to 6dp and rejects junk", () => {
    expect(usdFromNumber(1)).toBe(U);
    expect(usdFromNumber(0.5)).toBe(500_000n);
    expect(usdFromNumber(1_234.567891)).toBe(1_234_567_891n);
    expect(usdFromNumber(-5)).toBe(0n);
    expect(usdFromNumber(Number.NaN)).toBe(0n);
    expect(usdFromNumber(Number.POSITIVE_INFINITY)).toBe(0n);
  });

  test("clampBps keeps bps in range", () => {
    expect(clampBps(6_000)).toBe(6_000n);
    expect(clampBps(12_000)).toBe(10_000n);
    expect(clampBps(-3)).toBe(0n);
    expect(clampBps(Number.NaN)).toBe(0n);
  });

  test("splitCapital floors Senior and leaves the dust in Junior", () => {
    expect(splitCapital(100_000, 7_000)).toEqual({ senior: 70_000n * U, junior: 30_000n * U });
    const odd = splitCapital(0.000003, 5_000); // 3 raw units
    expect(odd.senior + odd.junior).toBe(3n);
    expect(odd.senior).toBe(1n);
    expect(splitCapital(1_000, 20_000)).toEqual({ senior: 1_000n * U, junior: 0n });
  });
});

describe("simulateFees (RevenueRouter.distribute through the shared splitDistribution)", () => {
  test("expenses -> 10% carry -> Senior hurdle share -> Junior residual", () => {
    const o = simulateFees(sim({ capitalUsd: 100_000, seniorBps: 7_000, feeFlowUsd: 1_000, expensesUsd: 20, hurdleBps: 6_000 }));
    expect(o.gross).toBe(1_000n * U);
    expect(o.expenses).toBe(20n * U);
    expect(o.expensesCapped).toBe(false);
    expect(o.net).toBe(980n * U);
    expect(o.carry).toBe(98n * U);
    expect(o.carryToBuyback).toBe(49n * U);
    expect(o.carryToBackstop).toBe(49n * U);
    expect(o.toTranches).toBe(882n * U);
    expect(o.senior).toBe(529_200_000n);
    expect(o.junior).toBe(352_800_000n);
    expect(o.rule).toBe("hurdle");
    expect(o.dust).toBe(0n);
    expect(o.seniorAfter).toBe(70_000n * U + 529_200_000n);
    expect(o.juniorAfter).toBe(30_000n * U + 352_800_000n);
  });

  test("expenses are capped at 20% of gross", () => {
    const o = simulateFees(sim({ feeFlowUsd: 1_000, expensesUsd: 500 }));
    expect(o.expenseCap).toBe(200n * U);
    expect(o.expenses).toBe(200n * U);
    expect(o.expensesRequested).toBe(500n * U);
    expect(o.expensesCapped).toBe(true);
    expect(o.net).toBe(800n * U);
  });

  test("the odd unit of carry goes to the backstop (BkrnFeeRouter)", () => {
    const o = simulateFees(sim({ feeFlowUsd: 0.00001, expensesUsd: 0 })); // 10 raw units -> carry 1
    expect(o.carry).toBe(1n);
    expect(o.carryToBuyback).toBe(0n);
    expect(o.carryToBackstop).toBe(1n);
  });

  test("a book with no Senior shares sends everything left to Junior, and vice versa", () => {
    const noSenior = simulateFees(sim({ seniorBps: 0 }));
    expect(noSenior.rule).toBe("all-junior");
    expect(noSenior.senior).toBe(0n);
    expect(noSenior.junior).toBe(noSenior.toTranches);
    const noJunior = simulateFees(sim({ seniorBps: 10_000 }));
    expect(noJunior.rule).toBe("all-senior");
    expect(noJunior.junior).toBe(0n);
    expect(noJunior.senior).toBe(noJunior.toTranches);
  });

  test("matches splitDistribution exactly and conserves every unit", () => {
    const cases: Array<Partial<SimInput>> = [
      { feeFlowUsd: 5.75, expensesUsd: 1, hurdleBps: 6_000 },
      { feeFlowUsd: 12_345.678901, expensesUsd: 3_000, hurdleBps: 7_500 },
      { feeFlowUsd: 0, expensesUsd: 10 },
      { feeFlowUsd: 99_999, expensesUsd: 0, hurdleBps: 10_000 },
      { feeFlowUsd: 1, expensesUsd: 0, hurdleBps: 0 },
    ];
    for (const c of cases) {
      const i = sim(c);
      const o = simulateFees(i);
      const { senior: S, junior: J } = splitCapital(i.capitalUsd, i.seniorBps);
      const r = splitDistribution({
        gross: usdFromNumber(i.feeFlowUsd),
        expensesRequested: usdFromNumber(i.expensesUsd),
        expenseCapBps: BigInt(PROTOCOL_DEFAULTS.expenseCapBps),
        carryBps: BigInt(PROTOCOL_DEFAULTS.carryBps),
        seniorHurdleBps: BigInt(i.hurdleBps),
        seniorSupply: S,
        juniorSupply: J,
      });
      expect({ e: o.expenses, c: o.carry, s: o.senior, j: o.junior }).toEqual({ e: r.expenses, c: r.carry, s: r.senior, j: r.junior });
      expect(o.expenses + o.carryToBuyback + o.carryToBackstop + o.senior + o.junior + o.dust).toBe(o.gross);
      expect(o.dust).toBe(0n);
    }
  });
});

describe("simulateLoss (Book.applyMark through the shared applyMarkPnl)", () => {
  const base = sim({ capitalUsd: 100_000, seniorBps: 7_000, killAtDrawdownBps: -800 });

  test("Junior absorbs first; a small loss leaves Senior untouched", () => {
    const o = simulateLoss({ ...base, lossUsd: 5_000, backstopUsd: 5_000 });
    expect(o.juniorLoss).toBe(5_000n * U);
    expect(o.seniorLoss).toBe(0n);
    expect(o.backstopCovered).toBe(0n);
    expect(o.juniorAfter).toBe(25_000n * U);
    expect(o.seniorAfter).toBe(70_000n * U);
    expect(o.drawdownBps).toBe(-500);
    expect(o.killed).toBe(false);
    expect(o.juniorExhausted).toBe(false);
  });

  test("past Junior, Senior absorbs and the backstop covers up to the pool", () => {
    const o = simulateLoss({ ...base, lossUsd: 40_000, backstopUsd: 5_000 });
    expect(o.juniorLoss).toBe(30_000n * U);
    expect(o.seniorLoss).toBe(10_000n * U);
    expect(o.backstopCovered).toBe(5_000n * U);
    expect(o.seniorShortfall).toBe(5_000n * U);
    expect(o.seniorAfter).toBe(65_000n * U);
    expect(o.juniorAfter).toBe(0n);
    expect(o.juniorExhausted).toBe(true);
    expect(o.drawdownBps).toBe(-4_000);
    expect(o.killed).toBe(true);
  });

  test("the backstop never pays more than the shortfall", () => {
    const o = simulateLoss({ ...base, lossUsd: 31_000, backstopUsd: 50_000 });
    expect(o.seniorLoss).toBe(1_000n * U);
    expect(o.backstopCovered).toBe(1_000n * U);
    expect(o.seniorAfter).toBe(70_000n * U);
  });

  test("the kill fires at the kill level, not before", () => {
    expect(simulateLoss({ ...base, lossUsd: 7_999 }).killed).toBe(false);
    expect(simulateLoss({ ...base, lossUsd: 8_000 }).killed).toBe(true);
    expect(simulateLoss({ ...base, lossUsd: 50_000, killAtDrawdownBps: 0 }).killed).toBe(false); // disabled
    expect(simulateLoss({ ...base, lossUsd: 0 }).killed).toBe(false);
  });

  test("a loss larger than the book is clamped to its NAV", () => {
    const o = simulateLoss({ ...base, lossUsd: 1_000_000, backstopUsd: 0 });
    expect(o.loss).toBe(100_000n * U);
    expect(o.seniorAfter).toBe(0n);
    expect(o.juniorAfter).toBe(0n);
    expect(o.drawdownBps).toBe(-10_000);
  });

  test("with no Junior, Senior is first in line and the backstop may cover it", () => {
    const o = simulateLoss({ ...base, seniorBps: 10_000, lossUsd: 2_000, backstopUsd: 500 });
    expect(o.juniorLoss).toBe(0n);
    expect(o.seniorLoss).toBe(2_000n * U);
    expect(o.backstopCovered).toBe(500n * U);
  });
});

describe("display helpers", () => {
  test("usdText groups, rounds half up and keeps the sign", () => {
    expect(usdText(1_234_567_890n)).toBe("1,234.57");
    expect(usdText(1_234_567_890n, 0)).toBe("1,235");
    expect(usdText(-529_200_000n)).toBe("-529.20");
    expect(usdText(0n)).toBe("0.00");
    expect(usdText(5n, 6)).toBe("0.000005");
  });

  test("pctText", () => {
    expect(pctText(6_000)).toBe("60%");
    expect(pctText(-800)).toBe("-8%");
    expect(pctText(1_250)).toBe("12.5%");
    expect(pctText(5)).toBe("0.05%");
    expect(pctText(0)).toBe("0%");
  });

  test("share is a clamped 0..1 fraction", () => {
    expect(share(1n, 4n)).toBe(0.25);
    expect(share(5n, 0n)).toBe(0);
    expect(share(9n, 3n)).toBe(1);
    expect(share(-1n, 3n)).toBe(0);
  });

  test("sentences say where the money went, in allowed words", () => {
    const f = simulateFees(sim({ capitalUsd: 100_000, seniorBps: 7_000, feeFlowUsd: 1_000, expensesUsd: 20, hurdleBps: 6_000 }));
    expect(feeSentence(f)).toContain("Senior earned 529.20 USDC and Junior earned 352.80 USDC");
    expect(feeSentence(simulateFees(sim({ feeFlowUsd: 0 })))).toContain("No fee flow");
    expect(feeSentence(simulateFees(sim({ seniorBps: 0 })))).toContain("no Senior shares");
    const small = lossSentence(simulateLoss(sim({ lossUsd: 5_000 })));
    expect(small).toContain("Senior lost nothing");
    const big = lossSentence(simulateLoss(sim({ lossUsd: 40_000, backstopUsd: 5_000 })));
    expect(big).toContain("Senior absorbed 10,000.00 USDC");
    expect(big).toContain("The backstop covered 5,000.00 USDC");
    expect(lossSentence(simulateLoss(sim({ lossUsd: 40_000, backstopUsd: 0 })))).toContain("pool was empty");
    expect(lossSentence(simulateLoss(sim({ lossUsd: 0 })))).toContain("No loss");
    for (const s of [feeSentence(f), small, big]) expect(checkCopy(s)).toEqual([]);
  });
});

describe("presetFromBook", () => {
  test("starts from a book's marked tranche NAVs and charter terms", () => {
    const p = presetFromBook({ seniorNavUsd: "73518.963306", juniorNavUsd: "32060.424307", seniorHurdleBps: 6_000, killAtDrawdownBps: -800 });
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.capitalUsd).toBe(105_579);
    expect(p.seniorBps).toBe(6_963);
    expect(p.hurdleBps).toBe(6_000);
    expect(p.killAtDrawdownBps).toBe(-800);
    expect(p.feeFlowUsd).toBe(DEFAULT_SIM.feeFlowUsd);
  });

  test("falls back to the base terms and rejects books without NAV", () => {
    const p = presetFromBook({ seniorNavUsd: "100", juniorNavUsd: "0" });
    expect(p?.hurdleBps).toBe(LAUNCH_TERMS.seniorHurdleBps);
    expect(p?.lossUsd).toBe(100);
    expect(presetFromBook({ seniorNavUsd: null, juniorNavUsd: "1" })).toBeNull();
    expect(presetFromBook({ seniorNavUsd: "0", juniorNavUsd: "0" })).toBeNull();
    expect(presetFromBook({ seniorNavUsd: "x", juniorNavUsd: "1" })).toBeNull();
  });
});

describe("quoteDemo (shared checkQuote)", () => {
  const limits = { minQuoteWidthBps: 8, maxSkewBps: 25 };
  test("a quote inside both limits passes", () => {
    const d = quoteDemo(100, 12, 5, limits);
    expect(d.ok).toBe(true);
    expect(d.widthBps).toBeCloseTo(12, 6);
    expect(d.skewBps).toBeCloseTo(5, 6);
    expect(d.bid).toBeLessThan(d.ask);
  });
  test("too narrow, crossed or too far from the oracle fails", () => {
    expect(quoteDemo(100, 4, 0, limits)).toMatchObject({ ok: false, widthOk: false, skewOk: true });
    expect(quoteDemo(100, 0, 0, limits)).toMatchObject({ ok: false, widthOk: false });
    expect(quoteDemo(100, 12, 30, limits)).toMatchObject({ ok: false, widthOk: true, skewOk: false });
    expect(quoteDemo(100, 12, -30, limits)).toMatchObject({ ok: false, skewOk: false });
  });
  test("the limits themselves are allowed", () => {
    expect(quoteDemo(100, 8, 25, limits).ok).toBe(true);
    expect(quoteDemo(100, 8, -25, limits).ok).toBe(true);
  });
});
