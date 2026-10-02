// Recall-before-mark planning (pure). Redemptions queued for the next mark are settled from vault idle;
// whatever idle (+ withdrawals already in flight: requested-but-unconfirmed AND confirmed-unswept)
// cannot cover is recalled from the venue MM account ahead of the mark (Orderly recalls are
// asynchronous, so this runs every keeper tick, early; an in-flight recall is never re-requested).
// MM recalls are capped by what the venue will pay now (engine: PoolEngine.withdrawLiquidity limits).
// Retiring + flat books recall all remaining venue capital (IF + MM) for the final mark, down to the
// last unit: Book.finalizeRetirement needs a final mark with deployedValueUsd == 0 exactly, so the
// wind-down ignores the minRecallUsd dust floor.
import { ACCOUNT, BPS, type BookState, WAD, absBig } from "@bookrunner/shared";

export interface RecallInput {
  state: BookState;
  /** Pending redemption shares in buckets due at the next mark. */
  dueShares: { senior: bigint; junior: bigint };
  /** Current share prices (WAD, last applied mark). */
  sharePriceWad: { senior: bigint; junior: bigint };
  unfundedClaims: bigint;
  vaultIdle: bigint;
  /** Confirmed withdrawals not yet swept to the vault. */
  inTransit: bigint;
  /** Requested withdrawals the venue has not confirmed yet (Orderly pendingWithdrawUsd IF + MM). */
  pendingWithdraw: bigint;
  /** Engine: the most withdrawLiquidity accepts now; null = bounded by the MM margin only (Orderly). */
  mmWithdrawable: bigint | null;
  insuranceEquity: bigint;
  marginEquity: bigint; // signed
  netExposure: bigint; // signed
  /** Headroom on due assets for price moves until the mark (bps). */
  bufferBps: bigint;
  minRecallUsd: bigint;
  /** |netExposure| at or below this counts as flat. */
  flatThresholdUsd: bigint;
  recallAllWhenRetiring: boolean;
}

export type RecallAccount = (typeof ACCOUNT)[keyof typeof ACCOUNT];

export interface RecallPlan {
  dueAssets: bigint;
  need: bigint;
  available: bigint;
  shortfall: bigint;
  recalls: Array<{ account: RecallAccount; amount: bigint; reason: "redemptions" | "retire" }>;
  /** Shortfall the plan cannot cover (venue MM capacity exhausted). */
  uncovered: bigint;
}

export function dueAssets(shares: { senior: bigint; junior: bigint }, price: { senior: bigint; junior: bigint }): bigint {
  return (shares.senior * price.senior) / WAD + (shares.junior * price.junior) / WAD;
}

export function planRecall(i: RecallInput): RecallPlan {
  const due = dueAssets(i.dueShares, i.sharePriceWad);
  const need = due + (due * i.bufferBps) / BPS + i.unfundedClaims;
  const inFlight = i.inTransit + i.pendingWithdraw;
  const available = i.vaultIdle + inFlight;
  const shortfall = need > available ? need - available : 0n;
  const plan: RecallPlan = { dueAssets: due, need, available, shortfall, recalls: [], uncovered: 0n };
  if (i.state !== "Live" && i.state !== "Retiring") {
    plan.uncovered = shortfall;
    return plan;
  }
  let mm = i.marginEquity > 0n ? i.marginEquity : 0n;
  if (i.mmWithdrawable !== null && i.mmWithdrawable < mm) mm = i.mmWithdrawable > 0n ? i.mmWithdrawable : 0n;

  const flat = absBig(i.netExposure) <= i.flatThresholdUsd;
  // Wind-down: once flat and nothing is in flight, recall everything still on the venue (no dust floor).
  if (i.state === "Retiring" && i.recallAllWhenRetiring && flat && inFlight === 0n) {
    if (mm > 0n) plan.recalls.push({ account: ACCOUNT.MM, amount: mm, reason: "retire" });
    if (i.insuranceEquity > 0n) plan.recalls.push({ account: ACCOUNT.IF, amount: i.insuranceEquity, reason: "retire" });
    const recalled = plan.recalls.reduce((s, r) => s + r.amount, 0n);
    plan.uncovered = shortfall > recalled ? shortfall - recalled : 0n;
    return plan;
  }

  if (shortfall >= i.minRecallUsd && shortfall > 0n) {
    const amount = shortfall < mm ? shortfall : mm;
    if (amount >= i.minRecallUsd && amount > 0n) plan.recalls.push({ account: ACCOUNT.MM, amount, reason: "redemptions" });
    plan.uncovered = shortfall - (plan.recalls[0]?.amount ?? 0n);
  } else {
    plan.uncovered = 0n;
  }
  return plan;
}

/**
 * PoolEngine.withdrawLiquidity succeeds only for amount <= poolCash with poolEquity - amount >=
 * requiredPoolMargin. While traders hold positions a buffer (5% of the required margin + 1 USD)
 * absorbs price / funding drift between the read and the mined tx; a flat pool needs none.
 */
export function engineWithdrawableUsd(poolCashUsd: bigint, poolEquityUsd: bigint, requiredPoolMarginUsd: bigint): bigint {
  const buffer = requiredPoolMarginUsd > 0n ? requiredPoolMarginUsd / 20n + 1_000_000n : 0n;
  const headroom = poolEquityUsd - requiredPoolMarginUsd - buffer;
  if (headroom <= 0n) return 0n;
  return poolCashUsd < headroom ? poolCashUsd : headroom;
}
