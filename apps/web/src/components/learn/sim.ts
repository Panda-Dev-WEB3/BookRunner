// Pure adapters behind the How it works page: the waterfall simulator (fee flow and mark losses) and
// the mandate quote check. Every money figure comes from the NORMATIVE shared math
// (packages/shared/src/waterfall.ts, mandate.ts); this file only converts slider values into protocol
// units (USD 6dp bigint, bps) and reads the results back for display.
import { checkQuote } from "@bookrunner/shared/mandate";
import type { Mandate } from "@bookrunner/shared/types";
import { BPS, USD, WAD } from "@bookrunner/shared/units";
import { applyMarkPnl, drawdownKill, splitDistribution } from "@bookrunner/shared/waterfall";

/** Protocol defaults on BookrunnerConfig (ARCHITECTURE.md §2.1): carry 10% of net fee flow, expenses capped at 20%. */
export const PROTOCOL_DEFAULTS = { carryBps: 1_000, expenseCapBps: 2_000 } as const;

/** Charter terms of the three testnet launch books (ARCHITECTURE.md §7), used until a live book is loaded. */
export const LAUNCH_TERMS = { seniorHurdleBps: 6_000, seniorCapBps: 7_000, killAtDrawdownBps: -800 } as const;

export type SimMode = "fees" | "loss";

export interface SimInput {
  /** Book capital (Senior + Junior NAV), whole USDC. */
  capitalUsd: number;
  /** Senior share of book capital, bps (0..10000). */
  seniorBps: number;
  /** Gross fee flow settled over the period, whole USDC. */
  feeFlowUsd: number;
  /** Expenses the keeper asks for (oracle, keeper gas), whole USDC; capped on-chain. */
  expensesUsd: number;
  /** Charter: Senior's share of fee flow left after expenses and carry, bps. */
  hurdleBps: number;
  /** Loss at the mark, whole USDC (clamped to book capital). */
  lossUsd: number;
  /** USDC in the shared backstop pool, whole USDC. */
  backstopUsd: number;
  /** Mandate kill level, negative bps (0 or above disables). */
  killAtDrawdownBps: number;
  carryBps?: number;
  expenseCapBps?: number;
}

export const DEFAULT_SIM: SimInput = {
  capitalUsd: 100_000,
  seniorBps: 7_000,
  feeFlowUsd: 1_000,
  expensesUsd: 20,
  hurdleBps: LAUNCH_TERMS.seniorHurdleBps,
  lossUsd: 5_000,
  backstopUsd: 5_000,
  killAtDrawdownBps: LAUNCH_TERMS.killAtDrawdownBps,
};

/** Whole (or fractional) USDC from a slider -> USD 6dp. Non-finite and negative values become 0. */
export function usdFromNumber(n: number): bigint {
  if (!Number.isFinite(n) || n <= 0) return 0n;
  return BigInt(Math.round(n * 1e6));
}

/** bps clamped to [lo, hi] and rounded (slider values are numbers). */
export function clampBps(bps: number, lo = 0, hi = 10_000): bigint {
  if (!Number.isFinite(bps)) return BigInt(lo);
  return BigInt(Math.min(hi, Math.max(lo, Math.round(bps))));
}

/** Senior and Junior NAV for a capital and a Senior share (floor; Junior keeps the dust). */
export function splitCapital(capitalUsd: number, seniorBps: number): { senior: bigint; junior: bigint } {
  const total = usdFromNumber(capitalUsd);
  const senior = (total * clampBps(seniorBps)) / BPS;
  return { senior, junior: total - senior };
}

// ------------------------------------------------------------------ fee flow (RevenueRouter.distribute)
export interface FeeOutcome {
  seniorNav: bigint;
  juniorNav: bigint;
  gross: bigint;
  expensesRequested: bigint;
  /** gross * expenseCapBps: the most expenses can take. */
  expenseCap: bigint;
  expenses: bigint;
  expensesCapped: boolean;
  /** gross - expenses */
  net: bigint;
  carry: bigint;
  /** BkrnFeeRouter split: half buys BKRN for stakers, the rest (odd unit included) goes to the backstop. */
  carryToBuyback: bigint;
  carryToBackstop: bigint;
  /** net - carry: what the tranches share. */
  toTranches: bigint;
  senior: bigint;
  junior: bigint;
  /** Which rule split toTranches: the hurdle share, or everything to the only tranche with shares. */
  rule: "hurdle" | "all-junior" | "all-senior" | "none";
  seniorAfter: bigint;
  juniorAfter: bigint;
  /** gross - every payout; 0 with the shared math (Junior takes the remainder). */
  dust: bigint;
}

export function simulateFees(i: SimInput): FeeOutcome {
  const { senior: S, junior: J } = splitCapital(i.capitalUsd, i.seniorBps);
  const gross = usdFromNumber(i.feeFlowUsd);
  const expensesRequested = usdFromNumber(i.expensesUsd);
  const expenseCapBps = clampBps(i.expenseCapBps ?? PROTOCOL_DEFAULTS.expenseCapBps);
  const r = splitDistribution({
    gross,
    expensesRequested,
    expenseCapBps,
    carryBps: clampBps(i.carryBps ?? PROTOCOL_DEFAULTS.carryBps),
    seniorHurdleBps: clampBps(i.hurdleBps),
    // supplies only decide the zero-supply cases; NAV stands in for share supply here
    seniorSupply: S,
    juniorSupply: J,
  });
  const net = gross - r.expenses;
  const toTranches = net - r.carry;
  const carryToBuyback = r.carry / 2n;
  const rule: FeeOutcome["rule"] = S === 0n && J === 0n ? "none" : S === 0n ? "all-junior" : J === 0n ? "all-senior" : "hurdle";
  return {
    seniorNav: S,
    juniorNav: J,
    gross,
    expensesRequested,
    expenseCap: (gross * expenseCapBps) / BPS,
    expenses: r.expenses,
    expensesCapped: expensesRequested > r.expenses,
    net,
    carry: r.carry,
    carryToBuyback,
    carryToBackstop: r.carry - carryToBuyback,
    toTranches,
    senior: r.senior,
    junior: r.junior,
    rule,
    seniorAfter: S + r.senior,
    juniorAfter: J + r.junior,
    dust: gross - r.expenses - r.carry - r.senior - r.junior,
  };
}

// ------------------------------------------------------------------ losses (Book.applyMark)
export interface LossOutcome {
  seniorNav: bigint;
  juniorNav: bigint;
  /** The loss applied (clamped to Senior + Junior NAV). */
  loss: bigint;
  juniorLoss: bigint;
  seniorLoss: bigint;
  backstopPool: bigint;
  backstopCovered: bigint;
  /** Senior loss the backstop did not cover. */
  seniorShortfall: bigint;
  juniorExhausted: boolean;
  seniorAfter: bigint;
  juniorAfter: bigint;
  /** Drawdown of the book's performance index at this mark, bps (<= 0). */
  drawdownBps: number;
  killAtDrawdownBps: number;
  /** The mark would kill the mandate (drawdown at or past the kill level). */
  killed: boolean;
}

export function simulateLoss(i: SimInput): LossOutcome {
  const { senior: S, junior: J } = splitCapital(i.capitalUsd, i.seniorBps);
  const total = S + J;
  const asked = usdFromNumber(i.lossUsd);
  const loss = asked > total ? total : asked;
  const pool = usdFromNumber(i.backstopUsd);
  const r = applyMarkPnl(
    { seniorNav: S, juniorNav: J, seniorImpairment: 0n, perfIndex: WAD, highWater: WAD },
    { nav: total - loss, juniorSupply: J, backstopAvailable: pool },
  );
  const kill = Number.isFinite(i.killAtDrawdownBps) ? Math.round(i.killAtDrawdownBps) : 0;
  return {
    seniorNav: S,
    juniorNav: J,
    loss,
    juniorLoss: r.juniorLoss,
    seniorLoss: r.seniorLoss,
    backstopPool: pool,
    backstopCovered: r.backstopCovered,
    seniorShortfall: r.seniorLoss - r.backstopCovered,
    juniorExhausted: r.juniorNav === 0n,
    seniorAfter: r.seniorNav,
    juniorAfter: r.juniorNav,
    drawdownBps: Number(r.drawdownBps),
    killAtDrawdownBps: kill,
    killed: loss > 0n && drawdownKill(r.drawdownBps, BigInt(kill)),
  };
}

// ------------------------------------------------------------------ display helpers
/** Share of `part` in `whole` as a 0..1 number (bar geometry only). */
export function share(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  if (part >= whole) return 1;
  return Number((part * 1_000_000n) / whole) / 1_000_000;
}

/** Whole-dollar USDC text: 1234567890n (6dp) -> "1,234.57". */
export function usdText(raw: bigint, dp = 2): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const scale = 10n ** BigInt(6 - Math.min(Math.max(dp, 0), 6));
  const rounded = ((abs + scale / 2n) / scale) * scale;
  const whole = rounded / USD;
  const frac = (rounded % USD).toString().padStart(6, "0").slice(0, dp);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${dp > 0 ? `.${frac}` : ""}`;
}

/** bps -> "60%" / "-8%" / "12.5%". */
export function pctText(bps: number): string {
  if (!Number.isFinite(bps)) return "—";
  const v = Number((bps / 100).toFixed(2));
  return `${Object.is(v, -0) ? 0 : v}%`;
}

/** Plain-language summary of a fee-flow period (the simulator's headline). */
export function feeSentence(o: FeeOutcome): string {
  if (o.gross === 0n) return "No fee flow this period, so nothing moves down the waterfall.";
  const base = `From ${usdText(o.gross)} USDC of fee flow, Senior earned ${usdText(o.senior)} USDC and Junior earned ${usdText(o.junior)} USDC.`;
  const protocol = ` Expenses took ${usdText(o.expenses)} USDC and the protocol carry ${usdText(o.carry)} USDC.`;
  if (o.rule === "all-junior") return `${base}${protocol} With no Senior shares in the book, Junior receives everything left.`;
  if (o.rule === "all-senior") return `${base}${protocol} With no Junior shares in the book, Senior receives everything left.`;
  return `${base}${protocol}`;
}

/** Plain-language summary of a loss at the mark. */
export function lossSentence(o: LossOutcome): string {
  if (o.loss === 0n) return "No loss this period, so every tranche keeps its NAV.";
  let s = `Junior absorbed ${usdText(o.juniorLoss)} USDC of the ${usdText(o.loss)} USDC loss.`;
  if (o.seniorLoss === 0n) s += " Senior lost nothing, because Junior still had NAV left.";
  else {
    s += ` Junior is used up, so Senior absorbed ${usdText(o.seniorLoss)} USDC.`;
    s +=
      o.backstopCovered > 0n
        ? ` The backstop covered ${usdText(o.backstopCovered)} USDC of that, up to what the pool holds.`
        : " The backstop pool was empty, so it covered nothing.";
  }
  return s;
}

// ------------------------------------------------------------------ live presets
export interface BookPresetSource {
  seniorNavUsd: string | null | undefined;
  juniorNavUsd: string | null | undefined;
  seniorHurdleBps?: number | null;
  killAtDrawdownBps?: number | null;
}

/** Simulator settings that start from a live book's marked tranche NAVs and charter terms. */
export function presetFromBook(src: BookPresetSource, base: SimInput = DEFAULT_SIM): SimInput | null {
  const num = (v: string | null | undefined) => (typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN);
  const s = num(src.seniorNavUsd);
  const j = num(src.juniorNavUsd);
  if (!Number.isFinite(s) || !Number.isFinite(j) || s < 0 || j < 0 || s + j <= 0) return null;
  const capital = Math.round(s + j);
  return {
    ...base,
    capitalUsd: capital,
    seniorBps: Math.round((s / (s + j)) * 10_000),
    hurdleBps: src.seniorHurdleBps ?? base.hurdleBps,
    killAtDrawdownBps: src.killAtDrawdownBps ?? base.killAtDrawdownBps,
    lossUsd: Math.min(base.lossUsd, capital),
  };
}

// ------------------------------------------------------------------ mandate quote check
export interface QuoteLimits {
  minQuoteWidthBps: number;
  maxSkewBps: number;
}

export interface QuoteDemo {
  bid: number;
  ask: number;
  mid: number;
  widthBps: number;
  skewBps: number;
  ok: boolean;
  widthOk: boolean;
  skewOk: boolean;
}

/** Bid and ask around an oracle price for a width and skew (bps), checked with the shared checkQuote. */
export function quoteDemo(oraclePx: number, widthBps: number, skewBps: number, limits: QuoteLimits): QuoteDemo {
  const mid = oraclePx * (1 + skewBps / 10_000);
  const half = (mid * widthBps) / 20_000;
  const bid = mid - half;
  const ask = mid + half;
  const mandate: Mandate = {
    maxInventoryUsd: 1n,
    maxSkewBps: limits.maxSkewBps,
    minQuoteWidthBps: limits.minQuoteWidthBps,
    maxHedgeLeverage: 100,
    hedgeRatioMinBps: 0,
    hedgeRatioMaxBps: 10_000,
    noNewRiskOffHours: true,
    killAtDrawdownBps: -800,
    hedgeAllowRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
  };
  const c = checkQuote(mandate, { bidPx: bid, askPx: ask, oraclePx });
  return {
    bid,
    ask,
    mid,
    widthBps: c.widthBps,
    skewBps: c.skewBps,
    ok: c.ok,
    widthOk: !c.violations.includes("WIDTH") && !c.violations.includes("CROSSED"),
    skewOk: !c.violations.includes("SKEW"),
  };
}
