// Visual models for the fee-flow waterfall of a distribution and for the loss order of a mark.
// Amounts are exact (bigint, 6dp); loss attribution uses the NORMATIVE shared waterfall math.
import { WAD } from "@bookrunner/shared/units";
import { applyMarkPnl } from "@bookrunner/shared/waterfall";
import { usdRaw } from "./format";

export interface DistributionIn {
  id?: number;
  period?: number | null;
  ts?: string;
  source?: string;
  grossUsd: string;
  expensesUsd: string;
  carryUsd: string;
  seniorUsd: string;
  juniorUsd: string;
  txHash?: string;
}

export type StepKey = "gross" | "expenses" | "carry" | "senior" | "junior";

export interface WaterfallStep {
  key: StepKey;
  label: string;
  note: string;
  amount: bigint;
  /** floating bar [from, to] on a 0..gross scale */
  from: bigint;
  to: bigint;
}

export interface WaterfallModel {
  gross: bigint;
  steps: WaterfallStep[];
  /** gross - (expenses + carry + senior + junior): rounding dust that stays in the book */
  dust: bigint;
  conserved: boolean;
  /** Senior's part of what reached the tranches, in bps */
  seniorShareBps: number | null;
}

const NOTES: Record<StepKey, string> = {
  gross: "Fee flow settled into the book's router over the period",
  expenses: "Oracle, keeper and venue operating costs, capped on-chain",
  carry: "Protocol carry on net fee flow: half to BKRN buybacks, half to the backstop pool",
  senior: "Senior's fixed share of what reached the tranches",
  junior: "Residual fee flow to the Junior tranche",
};

const LABELS: Record<StepKey, string> = {
  gross: "Gross fee flow",
  expenses: "Expenses",
  carry: "Protocol carry",
  senior: "Senior share",
  junior: "Junior residual",
};

export function distributionModel(d: DistributionIn): WaterfallModel | null {
  const gross = usdRaw(d.grossUsd);
  const expenses = usdRaw(d.expensesUsd) ?? 0n;
  const carry = usdRaw(d.carryUsd) ?? 0n;
  const senior = usdRaw(d.seniorUsd) ?? 0n;
  const junior = usdRaw(d.juniorUsd) ?? 0n;
  if (gross === null) return null;
  let level = gross;
  const steps: WaterfallStep[] = [{ key: "gross", label: LABELS.gross, note: NOTES.gross, amount: gross, from: 0n, to: gross }];
  for (const [key, amount] of [
    ["expenses", expenses],
    ["carry", carry],
    ["senior", senior],
    ["junior", junior],
  ] as Array<[StepKey, bigint]>) {
    const from = level - amount;
    steps.push({ key, label: LABELS[key], note: NOTES[key], amount, from: from < 0n ? 0n : from, to: level < 0n ? 0n : level });
    level = from;
  }
  const toTranches = senior + junior;
  return {
    gross,
    steps,
    dust: level,
    conserved: level >= 0n,
    seniorShareBps: toTranches > 0n ? Number((senior * 10_000n) / toTranches) : null,
  };
}

/** Latest distribution: settlements are newest first; prefer router distributions with tranche credit. */
export function pickLastDistribution<T extends DistributionIn>(items: T[]): T | null {
  const credited = items.find((s) => (usdRaw(s.seniorUsd) ?? 0n) + (usdRaw(s.juniorUsd) ?? 0n) > 0n);
  return credited ?? items.find((s) => s.source === "distribution") ?? null;
}

/** Fraction of `amount` on a 0..total scale (for bar geometry). */
export function frac(amount: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Number((amount * 1_000_000n) / total) / 1_000_000;
}

// ------------------------------------------------------------------ loss order
export interface LossIllustration {
  loss: bigint;
  juniorLoss: bigint;
  seniorLoss: bigint;
  /** Senior impairment the backstop may cover once Junior is exhausted (up to the pool). */
  backstopEligible: bigint;
  backstopCovered: bigint;
  seniorAfter: bigint;
  juniorAfter: bigint;
  drawdownBps: number;
}

/**
 * Attributes a hypothetical mark loss with the shared applyMarkPnl: Junior first, then Senior; the
 * backstop covers Senior impairment only when Junior is exhausted, up to what the pool holds.
 * `backstopPool` null = pool size unknown (no cover applied, eligibility still reported).
 */
export function illustrateLoss(seniorNav: bigint, juniorNav: bigint, loss: bigint, backstopPool: bigint | null): LossIllustration {
  const total = seniorNav + juniorNav;
  const l = loss < 0n ? 0n : loss > total ? total : loss;
  const r = applyMarkPnl(
    { seniorNav, juniorNav, seniorImpairment: 0n, perfIndex: WAD, highWater: WAD },
    { nav: total - l, juniorSupply: juniorNav > 0n ? 1n : 0n, backstopAvailable: backstopPool ?? 0n },
  );
  return {
    loss: l,
    juniorLoss: r.juniorLoss,
    seniorLoss: r.seniorLoss,
    backstopEligible: r.juniorNav === 0n ? r.seniorLoss : 0n,
    backstopCovered: r.backstopCovered,
    seniorAfter: r.seniorNav,
    juniorAfter: r.juniorNav,
    drawdownBps: Number(r.drawdownBps),
  };
}
