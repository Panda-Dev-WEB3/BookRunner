// API payload -> view models for the desk (pure; test/model.test.ts). Nothing here invents a value:
// a figure the API or the chain did not give stays null and renders as a dash.
import { apiAmount } from "./amount";
import { toNum } from "./format";
import type {
  AgentListOut,
  BookDetail,
  BookListItem,
  CharterDetail,
  CharterListItem,
  LimitsView,
  MandateView,
  MarkItem,
  NavPoint,
  PositionOut,
  SettlementItem,
  TrancheName,
} from "./types";

// ------------------------------------------------------------------ books
/** "PERP_NVDA_USDC" -> "NVDA", "RHX5-PERP" -> "RHX5"; a charter ticker wins. */
export function bookTicker(symbol: string, charterTicker?: string | null): string {
  if (charterTicker) return charterTicker.toUpperCase();
  const m = /^PERP_([A-Z0-9.]+)_[A-Z]+$/i.exec(symbol) ?? /^([A-Z0-9.]+)-PERP$/i.exec(symbol);
  return (m?.[1] ?? symbol).toUpperCase();
}

export const venueLabel = (v: string | null | undefined): string => (v === "pool_engine" ? "In-house pool engine" : v === "orderly" ? "Orderly" : "Unknown venue");

/** Engraved card art for a book: NVDA and TSLA have their own plates, everything else the exchange. */
export function bookArt(ticker: string): { src: string; alt: string } {
  if (ticker === "NVDA") return { src: "/assets/market-images/optimized/greek-nvda-v10.webp", alt: "Advanced semiconductor in Greek architecture and the BookRunner knight-blue palette" };
  if (ticker === "TSLA") return { src: "/assets/market-images/optimized/greek-tsla-v10.webp", alt: "Electric vehicle in Greek architecture and the BookRunner knight-blue palette" };
  return { src: "/assets/market-images/optimized/greek-index-v10.webp", alt: "Stock exchange in Greek architecture and the BookRunner knight-blue palette" };
}

/** CSS status class for a book / charter / key state ("Live" -> "live"; kills and rejections red). */
export function statusClass(state: string | null | undefined): string {
  const s = (state ?? "").toLowerCase();
  if (["killed", "rejected", "cancelled", "revoked", "kill", "breach"].includes(s)) return "killed";
  if (["filed", "queued", "pending", "subscription", "warn", "scheduled"].includes(s)) return "queued";
  return s.replace(/[^a-z0-9-]/g, "") || "unknown";
}

export interface BookCardView {
  bookId: number;
  symbol: string;
  ticker: string;
  venue: string;
  state: string;
  /** Book NAV at the last mark (falls back to the indexed NAV). */
  markedNav: number | null;
  /** Live (unmarked) NAV from the risk service, when it is reporting. */
  liveNav: number | null;
  seniorNav: number | null;
  juniorNav: number | null;
  seniorPrice: string;
  juniorPrice: string;
  inventoryUtil: number | null;
  riskState: string | null;
  lastMarkAt: string | null;
  lastMarkId: number | null;
  nextMarkAt: string | null;
  cadence: string | null;
  subscriptionEnds: string | null;
}

export function bookCard(b: BookListItem): BookCardView {
  return {
    bookId: b.bookId,
    symbol: b.symbol,
    ticker: bookTicker(b.symbol),
    venue: venueLabel(b.venue),
    state: b.state,
    markedNav: toNum(b.lastMark?.navUsd ?? b.navUsd),
    liveNav: toNum(b.liveNav?.navUsd),
    seniorNav: toNum(b.seniorNavUsd),
    juniorNav: toNum(b.juniorNavUsd),
    seniorPrice: b.seniorSharePrice,
    juniorPrice: b.juniorSharePrice,
    inventoryUtil: b.limits?.inventoryUtil ?? null,
    riskState: b.limits?.state ?? null,
    lastMarkAt: b.lastMark?.periodEndAt ?? null,
    lastMarkId: b.lastMark?.markId ?? null,
    nextMarkAt: b.markSchedule?.nextPeriodEndAt ?? null,
    cadence: b.markSchedule?.cadence ?? null,
    subscriptionEnds: b.subscriptionEnds,
  };
}

export interface OverviewView {
  books: number;
  liveBooks: number;
  /** Sum of every book's NAV at its last mark (USD). */
  totalMarkedNav: number | null;
  latestMarkAt: string | null;
  /** Seconds since the newest mark's period end (null without marks). */
  latestMarkAgeSec: number | null;
  cadence: string | null;
}

export function overview(list: BookListItem[], nowMs: number): OverviewView {
  const cards = list.map(bookCard);
  const navs = cards.map((c) => c.markedNav).filter((n): n is number => n !== null);
  const latest = cards
    .map((c) => c.lastMarkAt)
    .filter((t): t is string => !!t)
    .sort()
    .at(-1) ?? null;
  return {
    books: list.length,
    liveBooks: list.filter((b) => b.state === "Live").length,
    totalMarkedNav: navs.length ? navs.reduce((a, n) => a + n, 0) : null,
    latestMarkAt: latest,
    latestMarkAgeSec: latest ? Math.max(0, Math.round((nowMs - Date.parse(latest)) / 1000)) : null,
    cadence: list.find((b) => b.markSchedule?.cadence)?.markSchedule.cadence ?? null,
  };
}

// ------------------------------------------------------------------ deposits / top-up
export interface TopUpRound {
  open: boolean;
  endsAt: number;
  seniorCapacityUsd: bigint;
  juniorCapacityUsd: bigint;
}

/** Raw Book.topUp() tuple -> TopUpRound. */
export function parseTopUp(raw: readonly [boolean, bigint | number, bigint, bigint]): TopUpRound {
  return { open: raw[0], endsAt: Number(raw[1]), seniorCapacityUsd: raw[2], juniorCapacityUsd: raw[3] };
}

/** Period end of the first mark on or after `tSec` (a top-up round settles there, never earlier). */
export const firstMarkAtOrAfter = (tSec: number, intervalSec: number): number => {
  const i = Math.max(1, Math.floor(intervalSec));
  return Math.ceil(tSec / i) * i;
};

export type DepositWindow =
  | { kind: "subscription"; endsAt: string | null; open: boolean }
  | { kind: "topup"; endsAtSec: number; settlesAtSec: number | null; seniorCapacityUsd: bigint; juniorCapacityUsd: bigint }
  | { kind: "closed"; reason: string };

/** Whether (and until when) the book takes deposits now. */
export function depositWindow(state: string, subscriptionEnds: string | null, topUp: TopUpRound | null, nowSec: number, markIntervalSec: number | null): DepositWindow {
  if (state === "Subscription") {
    const ends = subscriptionEnds ? Date.parse(subscriptionEnds) / 1000 : null;
    return { kind: "subscription", endsAt: subscriptionEnds, open: ends !== null && nowSec < ends };
  }
  if (state === "Live") {
    if (topUp && topUp.open && topUp.endsAt > nowSec) {
      return {
        kind: "topup",
        endsAtSec: topUp.endsAt,
        settlesAtSec: markIntervalSec ? firstMarkAtOrAfter(topUp.endsAt, markIntervalSec) : null,
        seniorCapacityUsd: topUp.seniorCapacityUsd,
        juniorCapacityUsd: topUp.juniorCapacityUsd,
      };
    }
    return { kind: "closed", reason: "No top-up round is open. A Live book takes deposits only during a sponsor top-up round." };
  }
  return { kind: "closed", reason: `The book is ${state}; it does not take deposits.` };
}

// ------------------------------------------------------------------ risk
export interface Meter {
  label: string;
  /** 0..1 of the limit (may exceed 1 on a breach). */
  util: number | null;
  text: string;
  alert: boolean;
}

export interface RiskView {
  state: string;
  operating: string;
  inventory: Meter;
  skew: Meter;
  hedge: { ratioBps: number | null; minBps: number | null; maxBps: number | null; inBand: boolean | null };
  drawdown: { bps: number | null; killAtBps: number | null; util: number | null };
  offHours: boolean | null;
  breaches: string[];
  netExposureUsd: number | null;
  asOf: string | null;
}

const pctText = (u: number | null) => (u === null ? "-" : `${(u * 100).toFixed(1)}% of limit`);

export function riskView(limits: LimitsView | null, mandate: MandateView | null, killed = false): RiskView {
  const inv = limits?.inventoryUtil ?? null;
  const skew = limits?.skewUtil ?? null;
  const ratio = limits?.hedgeRatioBps ?? null;
  const min = mandate?.hedgeRatioMinBps ?? null;
  const max = mandate?.hedgeRatioMaxBps ?? null;
  const dd = limits?.drawdownBps ?? null;
  const kill = mandate?.killAtDrawdownBps ?? null;
  const state = killed ? "killed" : (limits?.state ?? "unknown");
  const operating = killed ? "Killed" : state === "breach" ? "Breaching" : limits?.offHours ? "Reduce-only (off-hours)" : state === "ok" ? "Within limits" : state === "unknown" ? "No risk report" : state;
  return {
    state,
    operating,
    inventory: { label: "Inventory", util: inv, text: pctText(inv), alert: inv !== null && inv > 1 },
    skew: { label: "Skew", util: skew, text: pctText(skew), alert: skew !== null && skew > 1 },
    hedge: { ratioBps: ratio, minBps: min, maxBps: max, inBand: ratio === null || min === null || max === null ? null : ratio >= min && ratio <= max },
    drawdown: { bps: dd, killAtBps: kill, util: dd !== null && kill ? Math.min(1, Math.max(0, dd / kill)) : null },
    offHours: limits?.offHours ?? null,
    breaches: (limits?.breaches ?? []).map((b) => (typeof b === "string" ? b : JSON.stringify(b))),
    netExposureUsd: limits?.netExposureUsd ?? null,
    asOf: limits?.ts ?? null,
  };
}

// ------------------------------------------------------------------ marks / settlements
export interface MarkRow {
  markId: number;
  periodEndAt: string;
  nav: number | null;
  seniorNav: number | null;
  juniorNav: number | null;
  seniorPrice: string | null;
  juniorPrice: string | null;
  pnl: number | null;
  feeFlow: number | null;
  receiptsRoot: string;
  signer: string;
  txHash: string;
}

export function markRow(m: MarkItem): MarkRow {
  const pnl = (m.pnl ?? {}) as { pnl?: { feeFlowUsd?: unknown } };
  const fee = pnl.pnl && typeof pnl.pnl.feeFlowUsd === "string" ? toNum(pnl.pnl.feeFlowUsd) : null;
  return {
    markId: m.markId,
    periodEndAt: m.periodEndAt,
    nav: toNum(m.navUsd),
    seniorNav: toNum(m.seniorNavUsd),
    juniorNav: toNum(m.juniorNavUsd),
    seniorPrice: m.seniorSharePrice,
    juniorPrice: m.juniorSharePrice,
    pnl: toNum(m.pnlUsd),
    feeFlow: fee,
    receiptsRoot: m.receiptsRoot,
    signer: m.signer,
    txHash: m.appliedTx ?? m.txHash,
  };
}

const SOURCE_LABELS: Record<string, string> = {
  distribution: "Distribution",
  venue_taker_share: "Venue fee share",
};

export interface SettlementRow {
  id: number;
  at: string;
  period: number | null;
  source: string;
  gross: number | null;
  expenses: number | null;
  carry: number | null;
  senior: number | null;
  junior: number | null;
  txHash: string | null;
}

export function settlementRow(s: SettlementItem): SettlementRow {
  return {
    id: s.id,
    at: s.ts,
    period: s.period,
    source: SOURCE_LABELS[s.source] ?? s.source.replace(/_/g, " "),
    gross: toNum(s.grossUsd),
    expenses: toNum(s.expensesUsd),
    carry: toNum(s.carryUsd),
    senior: toNum(s.seniorUsd),
    junior: toNum(s.juniorUsd),
    txHash: s.txHash,
  };
}

/** Totals over distribution rows only (fee-share rows are inflows already counted in gross). */
export function settlementTotals(rows: SettlementRow[]): { gross: number; expenses: number; carry: number; senior: number; junior: number; periods: number } {
  const d = rows.filter((r) => r.source === "Distribution");
  const sum = (k: "gross" | "expenses" | "carry" | "senior" | "junior") => d.reduce((a, r) => a + (r[k] ?? 0), 0);
  return { gross: sum("gross"), expenses: sum("expenses"), carry: sum("carry"), senior: sum("senior"), junior: sum("junior"), periods: d.length };
}

// ------------------------------------------------------------------ NAV chart
export interface ChartGeometry {
  points: Array<{ x: number; y: number; value: number; at: string }>;
  min: number;
  max: number;
}

/** NAV points -> SVG coordinates inside a 710x160 box (x 40..680, y 35..125). */
export function chartGeometry(points: Array<Pick<NavPoint, "navUsd" | "ts">>): ChartGeometry | null {
  const vals = points.map((p) => ({ value: toNum(p.navUsd), at: p.ts })).filter((p): p is { value: number; at: string } => p.value !== null);
  if (!vals.length) return null;
  const nums = vals.map((v) => v.value);
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  const span = max - min || max * 0.03 || 1;
  const n = vals.length;
  return {
    min,
    max,
    points: vals.map((v, i) => ({ x: 40 + (i / (n - 1 || 1)) * 640, y: 125 - ((v.value - min) / span) * 90, value: v.value, at: v.at })),
  };
}

// ------------------------------------------------------------------ positions
export interface PositionRow {
  bookId: number;
  tranche: TrancheName;
  shares: bigint | null;
  sharePrice: string;
  valueUsd: bigint | null;
  /** Committed in the open round, held in escrow until the round settles. */
  committedUsd: bigint | null;
  claimableShares: bigint | null;
  claimableRefundUsd: bigint | null;
  claimableRedemptionUsd: bigint | null;
}

export interface RedemptionRow {
  bookId: number;
  tranche: TrancheName;
  requestId: string;
  shares: string;
  requestedAt: string;
  eligibleAt: string;
  settlesAtPeriodEnd: string;
  status: string;
  assetsUsd: string | null;
  requestTx: string | null;
}

export interface PositionView {
  rows: PositionRow[];
  redemptions: RedemptionRow[];
  totalValueUsd: bigint | null;
  claimable: boolean;
  pendingDepositUsd: bigint;
}

const z = (v: bigint | null) => v ?? 0n;

export function positionView(p: PositionOut): PositionView {
  const rows: PositionRow[] = p.tranches.map((t) => ({
    bookId: p.bookId,
    tranche: t.tranche,
    shares: apiAmount(t.shares),
    sharePrice: t.sharePrice,
    valueUsd: apiAmount(t.navValueUsd),
    committedUsd: apiAmount(t.committedUsd),
    claimableShares: apiAmount(t.claimableAllocation?.shares),
    claimableRefundUsd: apiAmount(t.claimableAllocation?.refundUsd),
    claimableRedemptionUsd: apiAmount(t.claimableRedemptionUsd),
  }));
  const redemptions: RedemptionRow[] = p.tranches.flatMap((t) =>
    t.redemptions.map((r) => ({
      bookId: p.bookId,
      tranche: t.tranche,
      requestId: r.requestId,
      shares: r.shares,
      requestedAt: r.requestedAt,
      eligibleAt: r.eligibleAt,
      settlesAtPeriodEnd: r.settlesAtPeriodEnd,
      status: r.status,
      assetsUsd: r.assetsUsd,
      requestTx: r.requestTx,
    })),
  );
  const values = rows.map((r) => r.valueUsd);
  return {
    rows,
    redemptions,
    totalValueUsd: values.every((v) => v !== null) ? values.reduce<bigint>((a, v) => a + z(v), 0n) : null,
    claimable: rows.some((r) => z(r.claimableShares) > 0n || z(r.claimableRefundUsd) > 0n || z(r.claimableRedemptionUsd) > 0n),
    pendingDepositUsd: rows.reduce((a, r) => a + z(r.committedUsd), 0n),
  };
}

/** A row worth listing: anything held, committed or claimable. */
export const positionRowVisible = (r: PositionRow): boolean =>
  z(r.shares) > 0n || z(r.committedUsd) > 0n || z(r.claimableShares) > 0n || z(r.claimableRefundUsd) > 0n || z(r.claimableRedemptionUsd) > 0n;

/** Sum of the NAV value of every position (null while any book's value is unknown). */
export function portfolioTotal(views: PositionView[]): bigint | null {
  if (!views.length) return 0n;
  if (views.some((v) => v.totalValueUsd === null)) return null;
  return views.reduce((a, v) => a + z(v.totalValueUsd), 0n);
}

// ------------------------------------------------------------------ charters / committee / agents
export interface CharterRowView {
  charterId: number;
  symbol: string;
  venue: string;
  status: string;
  filedAt: string;
  juryCid: string | null;
  juryRecommendApprove: boolean | null;
  bookAddr: string | null;
  approvals: number | null;
  rejections: number | null;
  approveThreshold: number | null;
  committee: Array<{ member: string; voted: boolean; bonded: boolean }>;
}

export function charterRow(c: CharterListItem, detail?: CharterDetail | null): CharterRowView {
  const t = detail?.tally ?? null;
  return {
    charterId: c.charterId,
    symbol: c.symbol,
    venue: venueLabel(c.venue),
    status: detail?.status ?? c.status,
    filedAt: c.filedAt,
    juryCid: detail?.jury?.cid ?? c.juryCid,
    juryRecommendApprove: detail?.jury?.recommendApprove ?? c.juryRecommendApprove,
    bookAddr: c.bookAddr,
    approvals: t ? t.approvals : null,
    rejections: t ? t.rejections : null,
    approveThreshold: t ? t.approveThreshold : null,
    committee: (detail?.committee ?? []).map((m) => ({ member: m.member, voted: m.voted, bonded: m.bonded })),
  };
}

/** The connected wallet holds a committee seat on this charter's committee. */
export const isCommitteeMember = (detail: CharterDetail | null | undefined, wallet: string | null): boolean =>
  !!wallet && !!detail && detail.committee.some((m) => m.member.toLowerCase() === wallet.toLowerCase());

export interface AgentRowView {
  key: string;
  operator: string | null;
  tierUsd: number | null;
  status: string;
  activeOnChain: boolean | null;
  validUntil: string | null;
  registeredTx: string | null;
  revokedReason: string | null;
}

export function agentRows(a: AgentListOut): AgentRowView[] {
  return a.keys.map((k) => ({
    key: k.key,
    operator: k.operator,
    tierUsd: toNum(k.inventoryTierUsd),
    status: k.activeOnChain === false && k.status === "active" ? "inactive" : k.status,
    activeOnChain: k.activeOnChain,
    validUntil: k.validUntil,
    registeredTx: k.registeredTx,
    revokedReason: k.revokedReason,
  }));
}

// ------------------------------------------------------------------ book detail
export interface TermsView {
  ticker: string;
  underlying: string;
  venue: string;
  oracle: string;
  sessions: string;
  ifTargetUsd: number | null;
  mmInventoryUsd: number | null;
  seniorHurdleBps: number | null;
  seniorCapBps: number | null;
  juniorNoticeSeconds: number | null;
  perWalletCapUsd: number | null;
  sponsor: string | null;
}

const SESSIONS: Record<string, string> = { "24x5": "24 hours, 5 days", "24x7": "24 hours, 7 days", nyse_rth: "NYSE regular hours" };

export function termsView(d: BookDetail): TermsView {
  const c = d.charter;
  return {
    ticker: bookTicker(d.symbol, c?.ticker),
    underlying: c?.ticker ?? c?.underlyingToken ?? d.underlying,
    venue: venueLabel(d.venue),
    oracle: c ? (c.oracle === "attested" ? "Attested multi-source" : c.oracle === "chainlink" ? "Chainlink" : "Unknown") : "-",
    sessions: c ? (c.sessionsPreset ? (SESSIONS[c.sessionsPreset] ?? c.sessionsPreset) : "Custom calendar") : "-",
    ifTargetUsd: toNum(c?.ifTargetUsd),
    mmInventoryUsd: toNum(c?.mmInventoryUsd),
    seniorHurdleBps: c?.seniorHurdleBps ?? null,
    seniorCapBps: c?.seniorCapBps ?? null,
    juniorNoticeSeconds: c?.juniorNoticeSeconds ?? null,
    perWalletCapUsd: toNum(c?.perWalletCapUsd),
    sponsor: c?.sponsor ?? null,
  };
}

/** The connected wallet is this book's sponsor (it may open top-up rounds and register keys). */
export const isSponsor = (d: BookDetail | null | undefined, wallet: string | null): boolean =>
  !!wallet && !!d?.charter && d.charter.sponsor.toLowerCase() === wallet.toLowerCase();
