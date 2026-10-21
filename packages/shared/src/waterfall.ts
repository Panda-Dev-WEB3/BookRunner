// NORMATIVE waterfall math. contracts/src/libraries/Waterfall.sol MUST produce identical results
// (parity vectors: contracts/test/vectors/waterfall.json from scripts/gen-vectors.ts, consumed by forge test).
// All values are bigint in protocol units (USD 6dp, WAD prices, bps). Rounding: always floor; payouts
// never exceed what is owed, dust stays in the book.

import { BPS, WAD, minBig } from "./units";

export const SPONSOR_MIN_JUNIOR_BPS = 1_000n; // sponsor holds >= 10% of Junior at close (priority + cap)

// ---------------------------------------------------------------------------------------------
// 1. Window close: allocation with senior cap and sponsor priority in Junior.
//    Sponsor priority: the sponsor's Junior commitment is allocated first and the Junior eligible for
//    allocation is capped at 10x it (everyone else: at most 9x the sponsor, pro-rata, excess refunded),
//    so the sponsor always holds >= 10% of allocated Junior and outside over-commitment can never cancel
//    the book. Without a sponsor commitment nothing is capped and the window fails SPONSOR_SKIN.
// ---------------------------------------------------------------------------------------------
export interface WindowInput {
  ifTargetUsd: bigint;
  mmInventoryUsd: bigint;
  seniorCapBps: bigint; // Senior max share of book capital
  seniorCommitted: bigint;
  juniorCommitted: bigint;
  sponsorJuniorCommitted: bigint;
}

export type WindowFailure = "NO_JUNIOR" | "SPONSOR_SKIN" | "IF_UNFUNDED";

export interface WindowResult {
  ok: boolean;
  reason?: WindowFailure;
  seniorAllocated: bigint;
  juniorAllocated: bigint;
  sponsorJuniorAllocated: bigint; // the sponsor's part of juniorAllocated (allocated first)
}

export function allocateWindow(i: WindowInput): WindowResult {
  const R = i.ifTargetUsd + i.mmInventoryUsd; // max raise
  const c = i.seniorCapBps;
  const S = i.seniorCommitted;
  const P = i.sponsorJuniorCommitted;
  // Junior eligible for allocation: capped at 10x the sponsor's commitment (uncapped without one)
  const J = P === 0n ? i.juniorCommitted : minBig(i.juniorCommitted, (P * BPS) / SPONSOR_MIN_JUNIOR_BPS);

  const sa0 = minBig(S, (R * c) / BPS);
  let ja = minBig(J, R - sa0);
  // Senior may not exceed c of final book capital: sa <= ja * c / (1 - c)
  const saCapByJunior = c >= BPS ? sa0 : (ja * c) / (BPS - c);
  const sa = minBig(sa0, saCapByJunior);
  ja = minBig(J, R - sa);
  const sp = minBig(P, ja); // sponsor allocated first

  let reason: WindowFailure | undefined;
  if (ja === 0n) reason = "NO_JUNIOR";
  // only reachable without a sponsor commitment (priority + cap keep sp >= 10% of ja otherwise)
  else if (sp * BPS < ja * SPONSOR_MIN_JUNIOR_BPS) reason = "SPONSOR_SKIN";
  else if (sa + ja < i.ifTargetUsd) reason = "IF_UNFUNDED";

  return reason
    ? { ok: false, reason, seniorAllocated: 0n, juniorAllocated: 0n, sponsorJuniorAllocated: 0n }
    : { ok: true, seniorAllocated: sa, juniorAllocated: ja, sponsorJuniorAllocated: sp };
}

/** Per-wallet settlement of a commitment: shares (1 share = 1 USDC unit at close) + refund. */
export function walletAllocation(commit: bigint, totalCommitted: bigint, totalAllocated: bigint) {
  if (totalCommitted === 0n) return { shares: 0n, refund: 0n };
  return {
    shares: (commit * totalAllocated) / totalCommitted,
    refund: (commit * (totalCommitted - totalAllocated)) / totalCommitted,
  };
}

/**
 * Per-wallet settlement of a Junior window commitment with sponsor priority: the sponsor receives
 * min(sponsorCommitted, totalAllocated) shares first; every other wallet shares the rest pro-rata on the
 * non-sponsor commitments. Domain: totalAllocated <= totalCommitted, sponsorCommitted <= totalCommitted
 * and, for the sponsor, commit === sponsorCommitted. Senior and top-up rounds use plain pro-rata.
 */
export function juniorWindowAllocation(
  commit: bigint,
  isSponsor: boolean,
  totalCommitted: bigint,
  sponsorCommitted: bigint,
  totalAllocated: bigint,
) {
  const sp = minBig(sponsorCommitted, totalAllocated);
  if (isSponsor) return { shares: sp, refund: commit - sp };
  return walletAllocation(commit, totalCommitted - sponsorCommitted, totalAllocated - sp);
}

/** Initial deployment at close: IF first, then MM inventory; remainder stays idle in the vault. */
export function initialDeployment(total: bigint, ifTargetUsd: bigint, mmInventoryUsd: bigint) {
  const ifAmount = minBig(ifTargetUsd, total);
  const mmAmount = minBig(mmInventoryUsd, total - ifAmount);
  return { ifAmount, mmAmount, idle: total - ifAmount - mmAmount };
}

// ---------------------------------------------------------------------------------------------
// 2. Fee-flow distribution (RevenueRouter.distribute).
//    expenses (capped) -> carry (carryBps of net) -> Senior share (seniorHurdleBps of the rest)
//    -> Junior residual.
// ---------------------------------------------------------------------------------------------
export interface SplitInput {
  gross: bigint;
  expensesRequested: bigint;
  expenseCapBps: bigint;
  carryBps: bigint; // 1000
  seniorHurdleBps: bigint;
  seniorSupply: bigint;
  juniorSupply: bigint;
}

export interface SplitResult {
  gross: bigint;
  expenses: bigint;
  carry: bigint;
  senior: bigint;
  junior: bigint;
}

export function splitDistribution(i: SplitInput): SplitResult {
  const expenses = minBig(i.expensesRequested, (i.gross * i.expenseCapBps) / BPS);
  const net = i.gross - expenses;
  const carry = (net * i.carryBps) / BPS;
  const after = net - carry;
  let senior: bigint;
  let junior: bigint;
  if (i.seniorSupply === 0n) {
    senior = 0n;
    junior = after;
  } else if (i.juniorSupply === 0n) {
    senior = after;
    junior = 0n;
  } else {
    senior = (after * i.seniorHurdleBps) / BPS;
    junior = after - senior;
  }
  return { gross: i.gross, expenses, carry, senior, junior };
}

// ---------------------------------------------------------------------------------------------
// 2b. Fee-flow credit (Book.creditDistribution), audit 2026-10 L-1.
//    The residual of a distribution (the Junior amount, or everything when Junior has no supply: the
//    router then credits it all to Senior) follows the mark gain order: Senior impairment first, then
//    backstop debt (that part leaves the tranches and is paid to the backstop from vault idle), then
//    Junior (Senior when Junior has no supply). Senior's hurdle share is Senior's own income.
// ---------------------------------------------------------------------------------------------
export interface DistributionInput {
  senior: bigint;
  junior: bigint;
  juniorSupply: bigint;
  seniorImpairment: bigint;
  backstopDebt: bigint;
}

export interface DistributionResult {
  seniorCredit: bigint;
  juniorCredit: bigint;
  seniorRestored: bigint;
  backstopRepaid: bigint;
  seniorImpairment: bigint;
  backstopDebt: bigint;
}

export function applyDistribution(i: DistributionInput): DistributionResult {
  const residual = i.juniorSupply === 0n ? i.senior + i.junior : i.junior;
  const hurdle = i.senior + i.junior - residual;
  const seniorRestored = minBig(residual, i.seniorImpairment);
  const backstopRepaid = minBig(residual - seniorRestored, i.backstopDebt);
  const rest = residual - seniorRestored - backstopRepaid;
  const toSenior = i.juniorSupply === 0n;
  return {
    seniorCredit: hurdle + seniorRestored + (toSenior ? rest : 0n),
    juniorCredit: toSenior ? 0n : rest,
    seniorRestored,
    backstopRepaid,
    seniorImpairment: i.seniorImpairment - seniorRestored,
    backstopDebt: i.backstopDebt - backstopRepaid,
  };
}

// ---------------------------------------------------------------------------------------------
// 3. Mark application (Book.applyMark). nav = vault.idle() - unfundedClaims + mark.deployedValueUsd
//    Loss: Junior first, then Senior (seniorImpairment += senior loss); if Junior == 0 and Senior is
//    impaired, the backstop covers min(seniorImpairment, backstop balance); the cover becomes backstop
//    debt (Book.backstopDebt()).
//    Gain: restores seniorImpairment first, then repays backstop debt (that part leaves the tranches:
//    S' + J' == nav + backstopCovered - backstopRepaid), then Junior residual (Senior if Junior
//    supply == 0).
//    Performance index moves by nav / accounted (pre-backstop); drawdown from its high-water mark.
// ---------------------------------------------------------------------------------------------
export interface MarkState {
  seniorNav: bigint; // S
  juniorNav: bigint; // J
  seniorImpairment: bigint;
  perfIndex: bigint; // WAD
  highWater: bigint; // WAD
  /** Backstop cover not yet repaid from later gains (Book.backstopDebt(); 0 when omitted). */
  backstopDebt?: bigint;
}

export interface MarkInputs {
  nav: bigint;
  juniorSupply: bigint;
  backstopAvailable: bigint;
}

export interface MarkResult extends MarkState {
  pnl: bigint; // signed: nav - accounted
  juniorLoss: bigint;
  seniorLoss: bigint;
  backstopCovered: bigint;
  seniorRestored: bigint;
  juniorGain: bigint;
  drawdownBps: bigint; // <= 0
  /** Gain paid back to the backstop at this mark (leaves the tranches). */
  backstopRepaid: bigint;
  /** Debt after this mark: debt - backstopRepaid + backstopCovered. */
  backstopDebt: bigint;
}

export function applyMarkPnl(s: MarkState, m: MarkInputs): MarkResult {
  let S = s.seniorNav;
  let J = s.juniorNav;
  let imp = s.seniorImpairment;
  const debt = s.backstopDebt ?? 0n;
  const accounted = S + J;
  const pnl = m.nav - accounted;
  let juniorLoss = 0n;
  let seniorLoss = 0n;
  let backstopCovered = 0n;
  let backstopRepaid = 0n;
  let seniorRestored = 0n;
  let juniorGain = 0n;

  if (pnl < 0n) {
    const loss = -pnl; // <= S + J because nav >= 0
    juniorLoss = minBig(loss, J);
    J -= juniorLoss;
    seniorLoss = loss - juniorLoss;
    S -= seniorLoss;
    imp += seniorLoss;
  } else if (pnl > 0n) {
    seniorRestored = minBig(pnl, imp);
    S += seniorRestored;
    imp -= seniorRestored;
    backstopRepaid = minBig(pnl - seniorRestored, debt);
    const rest = pnl - seniorRestored - backstopRepaid;
    if (m.juniorSupply === 0n) S += rest;
    else {
      J += rest;
      juniorGain = rest;
    }
  }

  if (J === 0n && imp > 0n) {
    backstopCovered = minBig(imp, m.backstopAvailable);
    S += backstopCovered;
    imp -= backstopCovered;
  }

  const perfIndex = accounted > 0n ? (s.perfIndex * m.nav) / accounted : s.perfIndex;
  const highWater = perfIndex > s.highWater ? perfIndex : s.highWater;
  const drawdownBps = highWater > 0n ? ((perfIndex - highWater) * BPS) / highWater : 0n;

  return {
    seniorNav: S,
    juniorNav: J,
    seniorImpairment: imp,
    perfIndex,
    highWater,
    pnl,
    juniorLoss,
    seniorLoss,
    backstopCovered,
    seniorRestored,
    juniorGain,
    drawdownBps,
    backstopRepaid,
    backstopDebt: debt - backstopRepaid + backstopCovered,
  };
}

/** Kill check at mark. killAtDrawdownBps must be negative (charter validation); >= 0 disables. */
export function drawdownKill(drawdownBps: bigint, killAtDrawdownBps: bigint): boolean {
  return killAtDrawdownBps < 0n && drawdownBps <= killAtDrawdownBps;
}

// ---------------------------------------------------------------------------------------------
// 4. Share prices and redemption buckets.
// ---------------------------------------------------------------------------------------------
export function sharePriceWad(trancheNav: bigint, supply: bigint): bigint {
  return supply === 0n ? WAD : (trancheNav * WAD) / supply;
}

export function sharesToAssets(shares: bigint, priceWad: bigint): bigint {
  return (shares * priceWad) / WAD;
}

/** Senior: eligible at request time. Junior: request time + notice. Notice != gate. */
export function redeemEligibleAt(kind: 0 | 1, requestedAt: bigint, juniorNoticeSeconds: bigint): bigint {
  return kind === 0 ? requestedAt : requestedAt + juniorNoticeSeconds;
}

/** Bucket (requestId) = ceil(eligibleAt / markInterval). A mark with periodEnd T settles buckets <= T / interval. */
export function bucketIndex(eligibleAt: bigint, markInterval: bigint): bigint {
  return (eligibleAt + markInterval - 1n) / markInterval;
}

export function settlesUpTo(periodEnd: bigint, markInterval: bigint): bigint {
  return periodEnd / markInterval;
}

/**
 * Book NAV used on-chain at applyMark (Waterfall.markedNavNet): max(idle + deployed - unfundedClaims, 0).
 * Unfunded redemption claims are a liability of the whole book, not only of idle cash — netting them
 * against idle alone would hand a phantom gain to remaining holders whenever idle < unfundedClaims.
 */
export function markedNav(vaultIdle: bigint, unfundedClaims: bigint, deployedValueUsd: bigint): bigint {
  const gross = vaultIdle + deployedValueUsd;
  return gross > unfundedClaims ? gross - unfundedClaims : 0n;
}

// ---------------------------------------------------------------------------------------------
// 5. Insurance pool (2026-10, docs/ARCHITECTURE.md §2.10): a pool-funded book (charter.ifFromPool).
//    Waterfall.sol section 5 mirrors these; vectors "premium", "poolDebt", "poolWindow" and "poolBook".
//    The book owes the pool its allocation as a SENIOR DEBT netted from NAV: whatever draws the IF is the book's loss
//    first (Junior -> Senior -> backstop); the pool's claim is what the book can repay (poolRecoverable).
// ---------------------------------------------------------------------------------------------

/** IF target the window raises from the tranches: 0 when the InsurancePool funds the IF. */
export function windowIfTarget(ifTargetUsd: bigint, ifFromPool: boolean): bigint {
  return ifFromPool ? 0n : ifTargetUsd;
}

/** Premium rate a pool-funded charter is filed at (MarketCharter.file): the sponsor's rate, never below the pool's
 *  floor of that moment, at most BPS. The book then pays charter.premiumBps (a later floor change never re-prices it). */
export function effectivePremiumBps(charterPremiumBps: bigint, floorBps: bigint): bigint {
  const bps = charterPremiumBps > floorBps ? charterPremiumBps : floorBps;
  return bps > BPS ? BPS : bps;
}

/** The pool's premium comes off gross first; `rest` is then split by splitDistribution. premium + rest == gross. */
export function premiumSplit(gross: bigint, premiumBps: bigint) {
  const premium = (gross * premiumBps) / BPS;
  return { premium, rest: gross - premium };
}

export interface PoolSplitResult extends SplitResult {
  premium: bigint;
}

/**
 * RevenueRouter.distribute of a pool-funded book: premium first (premiumBps of gross), then the ordinary split
 * of the rest (expenses capped on the rest -> carry -> Senior -> Junior). `gross` stays the whole gross:
 * premium + expenses + carry + senior + junior == gross.
 */
export function splitPoolDistribution(i: SplitInput, premiumBps: bigint): PoolSplitResult {
  const { premium, rest } = premiumSplit(i.gross, premiumBps);
  return { ...splitDistribution({ ...i, gross: rest }), gross: i.gross, premium };
}

/**
 * What a pool-funded book can repay the pool at a mark (Book -> pool.markBook): the debt, capped by vault idle + the
 * mark's deployed value. Below the debt only once the book is exhausted; that shortfall is the pool's loss.
 */
export function poolRecoverable(debt: bigint, vaultIdle: bigint, deployedValueUsd: bigint): bigint {
  const assets = vaultIdle + deployedValueUsd;
  return assets < debt ? assets : debt;
}

/**
 * NAV of a pool-funded book at applyMark: the pool's debt is netted like any other liability, at the same snapshot as
 * the IF in deployedValueUsd: markedNav(idle, unfundedClaims + debt, deployed). An IF draw lowers it (a book loss).
 */
export function poolBookNav(vaultIdle: bigint, unfundedClaims: bigint, poolDebt: bigint, deployedValueUsd: bigint): bigint {
  return markedNav(vaultIdle, unfundedClaims + poolDebt, deployedValueUsd);
}
