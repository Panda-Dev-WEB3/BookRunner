// NORMATIVE waterfall math. contracts/src/libraries/Waterfall.sol MUST produce identical results
// (parity vectors: packages/shared/test/waterfall.vectors.json, consumed by both bun test and forge test).
// All values are bigint in protocol units (USD 6dp, WAD prices, bps). Rounding: always floor; payouts
// never exceed what is owed, dust stays in the book.

import { BPS, WAD, minBig } from "./units";

export const SPONSOR_MIN_JUNIOR_BPS = 1_000n; // sponsor must hold >= 10% of Junior at close

// ---------------------------------------------------------------------------------------------
// 1. Window close: pro-rata allocation with senior cap and sponsor skin check.
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
}

export function allocateWindow(i: WindowInput): WindowResult {
  const R = i.ifTargetUsd + i.mmInventoryUsd; // max raise
  const c = i.seniorCapBps;
  const S = i.seniorCommitted;
  const J = i.juniorCommitted;

  const sa0 = minBig(S, (R * c) / BPS);
  let ja = minBig(J, R - sa0);
  // Senior may not exceed c of final book capital: sa <= ja * c / (1 - c)
  const saCapByJunior = c >= BPS ? sa0 : (ja * c) / (BPS - c);
  const sa = minBig(sa0, saCapByJunior);
  ja = minBig(J, R - sa);

  let reason: WindowFailure | undefined;
  if (ja === 0n) reason = "NO_JUNIOR";
  // pro-rata scaling is uniform, so the sponsor's share of allocated Junior == share of committed Junior
  else if (i.sponsorJuniorCommitted * BPS < J * SPONSOR_MIN_JUNIOR_BPS) reason = "SPONSOR_SKIN";
  else if (sa + ja < i.ifTargetUsd) reason = "IF_UNFUNDED";

  return reason
    ? { ok: false, reason, seniorAllocated: 0n, juniorAllocated: 0n }
    : { ok: true, seniorAllocated: sa, juniorAllocated: ja };
}

/** Per-wallet settlement of a commitment: shares (1 share = 1 USDC unit at close) + refund. */
export function walletAllocation(commit: bigint, totalCommitted: bigint, totalAllocated: bigint) {
  if (totalCommitted === 0n) return { shares: 0n, refund: 0n };
  return {
    shares: (commit * totalAllocated) / totalCommitted,
    refund: (commit * (totalCommitted - totalAllocated)) / totalCommitted,
  };
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
// 3. Mark application (Book.applyMark). nav = vault.idle() - unfundedClaims + mark.deployedValueUsd
//    Loss: Junior first, then Senior (seniorImpairment += senior loss); if Junior == 0 and Senior is
//    impaired, the backstop covers min(seniorImpairment, backstop balance).
//    Gain: restores seniorImpairment first, then Junior residual (Senior if Junior supply == 0).
//    Performance index moves by nav / accounted (pre-backstop); drawdown from its high-water mark.
// ---------------------------------------------------------------------------------------------
export interface MarkState {
  seniorNav: bigint; // S
  juniorNav: bigint; // J
  seniorImpairment: bigint;
  perfIndex: bigint; // WAD
  highWater: bigint; // WAD
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
}

export function applyMarkPnl(s: MarkState, m: MarkInputs): MarkResult {
  let S = s.seniorNav;
  let J = s.juniorNav;
  let imp = s.seniorImpairment;
  const accounted = S + J;
  const pnl = m.nav - accounted;
  let juniorLoss = 0n;
  let seniorLoss = 0n;
  let backstopCovered = 0n;
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
    const rest = pnl - seniorRestored;
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

/** Book NAV used on-chain at applyMark. */
export function markedNav(vaultIdle: bigint, unfundedClaims: bigint, deployedValueUsd: bigint): bigint {
  const cash = vaultIdle > unfundedClaims ? vaultIdle - unfundedClaims : 0n;
  return cash + deployedValueUsd;
}
