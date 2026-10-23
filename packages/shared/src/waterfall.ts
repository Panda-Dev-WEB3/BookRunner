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
//    Waterfall.sol section 5 mirrors these; vectors "premium", "poolCredit", "poolMark", "poolWindow" and "poolBook".
//    The book owes the pool its allocation as a SENIOR DEBT netted from NAV: whatever draws the IF is absorbed by
//    Junior then Senior; the Backstop never covers that debt nor funds the pool (owner ruling N-1): the pool's claim is
//    the debt capped by the book's own capital (Backstop money excluded); a shortfall is provisional (N2-2) until
//    retirement.
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
 * Minimum own capital of a pool-funded book (pool audit 2026-10-23 B-M2): the tranche capital raised must be at least
 * `minOwnCapitalBps` of the IF the pool lends (InsurancePool.minOwnCapitalBps, 5000 = 50% by default). Book.closeWindow
 * checks the raise; MarketCharter (UNDERCAPITALISED) the charter's MM inventory at filing.
 */
export function poolCapitalOk(trancheCapital: bigint, ifTargetUsd: bigint, minOwnCapitalBps: bigint): boolean {
  return trancheCapital * BPS >= ifTargetUsd * minOwnCapitalBps;
}

/**
 * The explicit insurance ledger of a pool-funded book (pool audit 2026-10-23 B-H1, B-M1, B-L2, B-L3; Book storage).
 * Moved only by explicit events, never rebuilt from NAV:
 * - seniorIfImpairment: the part of seniorImpairment that is insurance debt (never covered by the Backstop; a gain
 *   restores it only after the Backstop is repaid);
 * - juniorIfLoss: IF draws Junior absorbed; had the IF never been drawn Junior would still hold them in front of Senior,
 *   so a later other loss reaching Senior is insurance debt up to it (the Backstop never covers more than without them);
 * - coverHeld: Backstop cover Senior still holds (never own capital: never backs nor repays the pool's claim);
 * - poolValue: the pool's claim (< poolDebt only while the tranches hold no own capital: provisional, N2-2);
 * - ifDraw: the outstanding IF draw at the last mark, max(0, poolDebt - IF equity).
 */
export interface PoolMarkState {
  seniorNav: bigint;
  juniorNav: bigint;
  seniorImpairment: bigint;
  seniorIfImpairment: bigint;
  juniorIfLoss: bigint;
  coverHeld: bigint;
  backstopDebt: bigint;
  perfIndex: bigint;
  highWater: bigint;
  poolValue: bigint;
  poolDebt: bigint;
  ifDraw: bigint;
}

export interface PoolMarkInputs {
  netAssets: bigint; // max(vault idle + deployed - unfunded claims - backstop repayment owed, 0)
  insuranceEquityUsd: bigint; // signed in the mark, capped at its deployed value
  due: boolean; // the debt is due: a fall of the draw is never read as an IF recovery
  juniorSupply: bigint;
  backstopAvailable: bigint;
}

export interface PoolMarkResult {
  s: PoolMarkState;
  nav: bigint; // tranche NAV before cover, the Backstop repayment included: netAssets - poolValue'
  pnl: bigint;
  drawdownBps: bigint;
  juniorLoss: bigint;
  seniorLoss: bigint;
  seniorIfLoss: bigint;
  poolLoss: bigint;
  poolRestored: bigint;
  seniorRestored: bigint;
  juniorGain: bigint;
  backstopRepaid: bigint;
  backstopCovered: bigint;
}

/**
 * Book.applyMark P&L of a pool-funded book (Waterfall.applyPoolMarkPnl): the change of the book's net assets against
 * what the tranches and the pool's claim held, allocated on the ledger. While Live the change splits exactly into an IF
 * recovery (first), the other P&L, then the IF draw; once due only a net loss is split. The IF draw since the last mark is the insurance
 * debt's loss (Junior, Senior's own capital, the pool's claim; never the cover). Any other loss: Junior first (within a
 * mark, before the IF draw), then up to juniorIfLoss an IF loss of Senior's, then the cover, Senior's own capital, the
 * pool. A gain: the pool's shortfall first, an IF recovery (not due) to the IF losses, then Senior's other impairment,
 * the Backstop, Senior's IF impairment, Junior. Cover: only Senior's other impairment, only while Junior is empty.
 */
export function applyPoolMarkPnl(state: PoolMarkState, i: PoolMarkInputs): PoolMarkResult {
  const s = { ...state };
  const r: PoolMarkResult = { s, nav: 0n, pnl: 0n, drawdownBps: 0n, juniorLoss: 0n, seniorLoss: 0n, seniorIfLoss: 0n, poolLoss: 0n, poolRestored: 0n, seniorRestored: 0n, juniorGain: 0n, backstopRepaid: 0n, backstopCovered: 0n };
  const accounted = s.seniorNav + s.juniorNav;
  const draw = s.poolDebt > i.insuranceEquityUsd ? s.poolDebt - i.insuranceEquityUsd : 0n;
  const held = accounted + s.poolValue;
  if (!i.due) {
    // Live: the draw moves only by IF P&L: an IF recovery first, then the other P&L, then the IF draw
    const up = draw > s.ifDraw ? draw - s.ifDraw : 0n;
    const down = s.ifDraw > draw ? s.ifDraw - draw : 0n;
    if (down > 0n) poolGain(s, r, down, down, i.juniorSupply);
    const plus = i.netAssets + up;
    const minus = held + down;
    if (plus > minus) poolGain(s, r, plus - minus, 0n, i.juniorSupply);
    else if (plus < minus) poolLossOther(s, r, minus - plus);
    poolLossIf(s, r, up);
  } else if (i.netAssets < held) {
    // due: only a net loss is split (the draw first within it), no fall of the draw is an IF recovery
    const loss = held - i.netAssets;
    const ifLoss = draw > s.ifDraw ? minBig(loss, draw - s.ifDraw) : 0n;
    poolLossOther(s, r, loss - ifLoss);
    poolLossIf(s, r, ifLoss);
  } else if (i.netAssets > held) {
    poolGain(s, r, i.netAssets - held, 0n, i.juniorSupply);
  }
  r.nav = i.netAssets - s.poolValue;
  r.pnl = r.nav - accounted;

  const other = s.seniorImpairment - s.seniorIfImpairment;
  if (s.juniorNav === 0n && other > 0n) {
    const c = minBig(other, i.backstopAvailable);
    r.backstopCovered = c;
    s.seniorNav += c;
    s.seniorImpairment -= c;
    s.backstopDebt += c;
    s.coverHeld += c;
  }

  const pi = accounted > 0n ? (s.perfIndex * r.nav) / accounted : s.perfIndex;
  const hw = pi > s.highWater ? pi : s.highWater;
  r.drawdownBps = hw > 0n ? ((pi - hw) * BPS) / hw : 0n;
  s.perfIndex = pi;
  s.highWater = hw;
  s.ifDraw = draw;
  return r;
}

function poolLossOther(s: PoolMarkState, r: PoolMarkResult, x: bigint) {
  const j = minBig(x, s.juniorNav);
  s.juniorNav -= j;
  r.juniorLoss += j;
  x -= j;
  const sw = minBig(x, s.juniorIfLoss);
  s.juniorIfLoss -= sw;
  poolLossIfSenior(s, r, sw);
  x -= sw;
  const sl = minBig(x, s.seniorNav);
  s.coverHeld -= minBig(sl, s.coverHeld);
  s.seniorNav -= sl;
  s.seniorImpairment += sl;
  r.seniorLoss += sl;
  const p = minBig(x - sl, s.poolValue);
  s.poolValue -= p;
  r.poolLoss += p;
}

function poolLossIf(s: PoolMarkState, r: PoolMarkResult, x: bigint) {
  const j = minBig(x, s.juniorNav);
  s.juniorNav -= j;
  s.juniorIfLoss += j;
  r.juniorLoss += j;
  poolLossIfSenior(s, r, x - j);
}

function poolLossIfSenior(s: PoolMarkState, r: PoolMarkResult, x: bigint) {
  const own = minBig(x, s.seniorNav - s.coverHeld);
  const p = minBig(x - own, s.poolValue);
  s.poolValue -= p;
  r.poolLoss += p;
  const c = minBig(x - own - p, s.coverHeld);
  s.coverHeld -= c;
  const sl = own + c;
  s.seniorNav -= sl;
  s.seniorImpairment += sl;
  s.seniorIfImpairment += sl;
  r.seniorLoss += sl;
  r.seniorIfLoss += sl;
}

function poolGain(s: PoolMarkState, r: PoolMarkResult, g: bigint, ifGain: bigint, jSupply: bigint) {
  const p = minBig(g, s.poolDebt - s.poolValue);
  s.poolValue += p;
  r.poolRestored += p;
  g -= p;
  const gi = minBig(g, ifGain);
  const a = minBig(gi, s.seniorIfImpairment);
  s.seniorIfImpairment -= a;
  const b = jSupply === 0n ? 0n : minBig(gi - a, s.juniorIfLoss);
  s.juniorIfLoss -= b;
  s.juniorNav += b;
  r.juniorGain += b;
  g -= a + b;
  const n = minBig(g, s.seniorImpairment - a - s.seniorIfImpairment);
  g -= n;
  const rp = minBig(g, s.backstopDebt);
  s.backstopDebt -= rp;
  if (s.coverHeld > s.backstopDebt) s.coverHeld = s.backstopDebt;
  r.backstopRepaid += rp;
  g -= rp;
  const f = minBig(g, s.seniorIfImpairment);
  s.seniorIfImpairment -= f;
  g -= f;
  // what an other gain gives the pool and Senior's IF impairment is counterfactual Junior capital
  if (ifGain === 0n && jSupply !== 0n) s.juniorIfLoss += p + f;
  const restored = a + n + f;
  s.seniorImpairment -= restored;
  s.seniorNav += restored;
  r.seniorRestored += restored;
  if (jSupply === 0n) s.seniorNav += g;
  else {
    s.juniorNav += g;
    r.juniorGain += g;
  }
}

export interface PoolDistributionInput {
  senior: bigint; // Senior hurdle share credited by the router
  junior: bigint; // Junior residual credited by the router
  juniorSupply: bigint;
  seniorImpairment: bigint;
  seniorIfImpairment: bigint;
  backstopDebt: bigint;
  coverHeld: bigint;
  juniorIfLoss: bigint;
  poolShortfall: bigint; // poolDebt - poolValue (0 once the pool's position is closed)
}

export interface PoolDistributionResult {
  seniorCredit: bigint;
  juniorCredit: bigint;
  poolRestored: bigint;
  seniorRestored: bigint;
  backstopRepaid: bigint;
  seniorImpairment: bigint;
  seniorIfImpairment: bigint;
  backstopDebt: bigint;
  coverHeld: bigint;
  juniorIfLoss: bigint;
}

/**
 * Book.creditDistribution of a pool-funded book (Waterfall.applyPoolDistribution, pool audit 2026-10-23 B-L2): while the
 * book is exhausted the fee flow restores the pool's claim first (the residual, then the hurdle share); the rest of the
 * residual follows the mark gain order (Senior's other impairment, the Backstop, Senior's IF impairment, Junior).
 * seniorCredit + juniorCredit + poolRestored + backstopRepaid == senior + junior.
 */
export function applyPoolDistribution(i: PoolDistributionInput): PoolDistributionResult {
  let residual = i.juniorSupply === 0n ? i.senior + i.junior : i.junior;
  let hurdle = i.senior + i.junior - residual;
  const pr = minBig(residual, i.poolShortfall);
  const ph = minBig(hurdle, i.poolShortfall - pr);
  residual -= pr;
  hurdle -= ph;
  const n = minBig(residual, i.seniorImpairment - i.seniorIfImpairment);
  residual -= n;
  const backstopRepaid = minBig(residual, i.backstopDebt);
  residual -= backstopRepaid;
  const f = minBig(residual, i.seniorIfImpairment);
  residual -= f;
  const toSenior = i.juniorSupply === 0n;
  const backstopDebt = i.backstopDebt - backstopRepaid;
  return {
    seniorCredit: hurdle + n + f + (toSenior ? residual : 0n),
    juniorCredit: toSenior ? 0n : residual,
    poolRestored: pr + ph,
    seniorRestored: n + f,
    backstopRepaid,
    seniorImpairment: i.seniorImpairment - n - f,
    seniorIfImpairment: i.seniorIfImpairment - f,
    backstopDebt,
    coverHeld: i.coverHeld < backstopDebt ? i.coverHeld : backstopDebt,
    juniorIfLoss: toSenior ? i.juniorIfLoss : i.juniorIfLoss + pr + f,
  };
}

/**
 * NAV of a pool-funded book at applyMark while it is not exhausted: the pool's debt is netted like any other liability,
 * at the same snapshot as the IF in deployedValueUsd: markedNav(idle, unfundedClaims + debt, deployed). An IF draw lowers
 * it (a book loss).
 */
export function poolBookNav(vaultIdle: bigint, unfundedClaims: bigint, poolDebt: bigint, deployedValueUsd: bigint): bigint {
  return markedNav(vaultIdle, unfundedClaims + poolDebt, deployedValueUsd);
}
