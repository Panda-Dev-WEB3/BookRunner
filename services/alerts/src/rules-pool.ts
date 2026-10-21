// Alert rules for the protocol-wide InsurancePool (docs/ARCHITECTURE.md §2.10, contracts/src/InsurancePool.sol). Pure
// functions Snapshot -> Conditions, like rules.ts; registered in rules.ts RULES. Snapshot.pool null (no insurancePool in
// the deployment) or undefined (a core read failed: the rpc rule covers RPC trouble) -> every rule here is quiet.
//
// - pool_utilisation — claims / pool assets (utilisationBps) above ALERT_POOL_UTILISATION_BPS (9000) for 5 min: WARNING;
//   at or above ALERT_POOL_UTILISATION_CRITICAL_BPS (9800): CRITICAL. Free liquidity is then nearly gone: queued
//   withdrawals fill only partially and new allocations are refused (buffer).
// - Epoch processing. An epoch needs processing only when something is queued (pendingShares > 0, depositsPending > 0,
//   or fillEpoch < procEpoch); otherwise the queue skips idle epochs by itself and nothing alerts. processEpoch()
//   (anyone) needs the epoch to have ended and, when the epoch itself holds requests, every active pool-funded book to
//   have marked after its end (staleBooks(procEndsAt) == 0) or processGrace to have passed. One situation pages once:
//   - pool_epoch_in_grace:<epoch> — the epoch ended with requests in it, staleBooks > 0 and the grace has not passed:
//     WARNING once ALERT_POOL_GRACE_WARN_SECONDS (default: the network's mark grace) past the end, naming the books not
//     marked since (active positions with lastMarkAt < procEndsAt). Root cause = marks (mark_overdue may fire for them).
//   - pool_epoch_overdue:<epoch> — still unprocessed although processable: WARNING past ALERT_POOL_EPOCH_OVERDUE_SECONDS
//     (7200) after the end; CRITICAL once procEndsAt + processGrace passed (processable by anyone in any case: the keeper
//     is down). Suppressed while pool_epoch_in_grace's situation holds (gated and in grace), so the two never fire for the
//     same epoch at once: in grace = in_grace (warning), after the grace = overdue (critical). staleBooks unreadable:
//     overdue alone, warning past the threshold, critical after the grace. The oldest epoch empty (requests only in later
//     epochs): overdue stays a warning (processing it only advances the queue).
// - pool_market_debt:<market> — per market (bytes32 underlying, labelled with a snapshot book's ticker, else the hex):
//   debt the pool has marked down on its ACTIVE books (sum of allocation - claim > 0): WARNING; CRITICAL when it reaches
//   ALERT_POOL_MARKET_DEBT_CRITICAL_BPS (500) of pool assets. It recovers if the books' marks rise again. Written-off
//   debt of retired books on the market is quoted in the summary, but does not keep the condition firing (it never
//   resolves on-chain): it pages once as pool_debt_written_off instead.
// - pool_debt_written_off:<bookId> — a retired (inactive) book's allocation - claim > 0: the loss is final. CRITICAL,
//   one-off (no "resolved"), reported while the final mark is younger than ALERT_POOL_WRITE_OFF_NOTIFY_SECONDS (7 d).
// - pool_book_unrepaid:<bookId> — a retired book with claim > 0 (debt still owed to the pool after its final mark)
//   ALERT_POOL_UNREPAID_SECONDS (6 h) after that mark: WARNING.
// - pool_first_loss_low — firstLossBps below params().firstLossTargetBps (10%) while poolAssets > 0: WARNING (new
//   allocations are refused, so pool-funded books cannot close their window); CRITICAL when the slice is 0 while
//   claims are outstanding (depleted: the next loss is the depositors'). forSec 5 min.
import type { RuleConfig } from "./config";
import type { BookSnap, Condition, PoolBookSnap, PoolSnap, Snapshot } from "./types";

const iso = (unixSec: number) => new Date(unixSec * 1000).toISOString().replace(/\.000Z$/, "Z");
const dur = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${(s / 86_400).toFixed(1)}d`;
};
const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const shares = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });

const bookMap = (s: Snapshot) => new Map((s.books ?? []).map((b) => [b.bookId, b]));
const bookLabel = (books: Map<number, BookSnap>, id: number) => {
  const b = books.get(id);
  return b ? `book ${id} ${b.name ?? b.symbol}` : `book ${id}`;
};
const pos = (v: number) => (v > 0 ? v : 0);
/** USD figures are floats of 6dp amounts: below a tenth of a cent is rounding, not debt */
const EPS = 0.0005;

// ------------------------------------------------------------------ utilisation
export function poolUtilisation(s: Snapshot, c: RuleConfig): Condition[] {
  const p = s.pool;
  if (!p || p.poolAssetsUsd <= 0 || p.utilisationBps <= c.poolUtilisationBps) return [];
  return [
    {
      key: "pool_utilisation",
      rule: "pool_utilisation",
      severity: p.utilisationBps >= c.poolUtilisationCriticalBps ? "critical" : "warning",
      forSec: 300,
      summary: `insurance pool utilisation ${pct(p.utilisationBps)} (limit ${pct(c.poolUtilisationBps)}): claims ${usd(p.claimsUsd)} of pool assets ${usd(p.poolAssetsUsd)}, free liquidity ${usd(p.freeLiquidityUsd)}: queued withdrawals fill only partially and new allocations are refused`,
    },
  ];
}

// ------------------------------------------------------------------ epochs
interface EpochView {
  age: number;
  graceEnds: number;
  pastGrace: boolean;
  /** the epoch itself holds requests (false: only later epochs do); null = epochInfo unreadable */
  content: boolean | null;
  /** the freshness gate holds (stale books and requests in the epoch); null = staleBooks unreadable */
  gated: boolean | null;
  queued: string;
}

/** The oldest unprocessed epoch when it ended with something queued; null = nothing to process. */
function epochView(p: PoolSnap, nowSec: number): EpochView | null {
  const queuedAny = p.pendingShares > 0 || p.depositsPendingUsd > 0 || p.fillEpoch < p.procEpoch;
  if (!queuedAny || p.procEndsAt > nowSec) return null;
  const content = p.epoch ? p.epoch.withdrawShares > 0 || p.epoch.depositUsd > 0 || p.fillEpoch < p.procEpoch : null;
  const gated = content === false ? false : p.staleBooks === null ? null : p.staleBooks > 0;
  const graceEnds = p.procEndsAt + p.processGraceSec;
  const parts: string[] = [];
  if (p.epoch && content) {
    if (p.epoch.withdrawShares > 0) parts.push(`${shares(p.epoch.withdrawShares)} withdrawal shares`);
    if (p.epoch.depositUsd > 0) parts.push(`${usd(p.epoch.depositUsd)} of deposits`);
    if (p.fillEpoch < p.procEpoch) parts.push(`unfilled withdrawals from epoch ${p.fillEpoch}`);
  } else {
    parts.push(`${content === false ? "nothing in it, but later epochs hold " : ""}${shares(p.pendingShares)} withdrawal shares and ${usd(p.depositsPendingUsd)} of deposits queued in all`);
  }
  return { age: nowSec - p.procEndsAt, graceEnds, pastGrace: nowSec >= graceEnds, content, gated, queued: parts.join(", ") };
}

export function poolEpochInGrace(s: Snapshot, c: RuleConfig): Condition[] {
  const p = s.pool;
  if (!p) return [];
  const v = epochView(p, s.now / 1000);
  if (!v || v.gated !== true || v.pastGrace || v.age < c.poolGraceWarnSec) return [];
  const books = bookMap(s);
  const stale = p.books.filter((b) => b.active && b.lastMarkAt < p.procEndsAt);
  const named = stale.map((b) => `${bookLabel(books, b.bookId)} (last mark ${iso(b.lastMarkAt)})`).join(", ");
  return [
    {
      key: `pool_epoch_in_grace:${p.procEpoch}`,
      rule: "pool_epoch_in_grace",
      severity: "warning",
      summary: `insurance pool epoch ${p.procEpoch} ended ${iso(p.procEndsAt)} (${dur(v.age)} ago) with ${v.queued}: ${p.staleBooks} active book(s) have not marked since its end${named ? ` (${named})` : ""}; processing waits for their marks until ${iso(v.graceEnds)} (processGrace ${dur(p.processGraceSec)}), then anyone can process it stale: check the mark service`,
    },
  ];
}

export function poolEpochOverdue(s: Snapshot, c: RuleConfig): Condition[] {
  const p = s.pool;
  if (!p) return [];
  const v = epochView(p, s.now / 1000);
  if (!v) return [];
  if (v.gated === true && !v.pastGrace) return []; // pool_epoch_in_grace's situation: processing is not possible yet
  if (v.age <= c.poolEpochOverdueSec && !v.pastGrace) return [];
  const why =
    v.gated === true
      ? `every active book was given until ${iso(v.graceEnds)} to mark (processGrace ${dur(p.processGraceSec)}); since then anyone can process it (stale)`
      : v.gated === null
        ? `staleBooks unreadable; it is processable by anyone at the latest since ${iso(v.graceEnds)} (processGrace ${dur(p.processGraceSec)})`
        : "every active book has marked since its end (or nothing in it is gated): processEpoch() is open to anyone";
  return [
    {
      key: `pool_epoch_overdue:${p.procEpoch}`,
      rule: "pool_epoch_overdue",
      severity: v.pastGrace && v.content !== false ? "critical" : "warning",
      summary: `insurance pool epoch ${p.procEpoch} ended ${iso(p.procEndsAt)} and is still unprocessed ${dur(v.age)} later with ${v.queued}: ${why}. Deposits and withdrawals wait: is the keeper calling processEpoch()?`,
    },
  ];
}

// ------------------------------------------------------------------ book debt
/** Per market: marked-down debt of its active books; retired books' write-offs and unrepaid claims per book. */
export function poolMarketDebt(s: Snapshot, c: RuleConfig): Condition[] {
  const p = s.pool;
  if (!p) return [];
  const books = bookMap(s);
  const nowSec = s.now / 1000;
  const out: Condition[] = [];
  const byMarket = new Map<string, PoolBookSnap[]>();
  for (const b of p.books) byMarket.set(b.market, [...(byMarket.get(b.market) ?? []), b]);

  for (const [market, list] of byMarket) {
    const active = list.filter((b) => b.active && b.allocationUsd - b.claimUsd > EPS);
    const shortfall = active.reduce((a, b) => a + pos(b.allocationUsd - b.claimUsd), 0);
    if (shortfall <= EPS) continue;
    const known = list.map((b) => books.get(b.bookId)).find((b) => b !== undefined);
    const label = known ? (known.name ?? known.symbol) : market;
    const writtenOff = list.filter((b) => !b.active).reduce((a, b) => a + pos(b.allocationUsd - b.claimUsd), 0);
    const flLoss = active.reduce((a, b) => a + b.lossFirstLossUsd, 0);
    const depLoss = active.reduce((a, b) => a + b.lossDepositorsUsd, 0);
    const critical = p.poolAssetsUsd <= 0 || shortfall * 10_000 >= c.poolMarketDebtCriticalBps * p.poolAssetsUsd;
    const detail = active.map((b) => `${bookLabel(books, b.bookId)} ${usd(b.allocationUsd - b.claimUsd)} of ${usd(b.allocationUsd)}`).join(", ");
    out.push({
      key: `pool_market_debt:${market}`,
      rule: "pool_market_debt",
      severity: critical ? "critical" : "warning",
      summary: `insurance pool market ${label}: ${usd(shortfall)} of IF debt marked down on ${active.length} active book(s) (${detail}), ${p.poolAssetsUsd > 0 ? `${pct((shortfall * 10_000) / p.poolAssetsUsd)} of pool assets` : "pool assets 0"} (critical at ${pct(c.poolMarketDebtCriticalBps)}); absorbed by the first-loss slice ${usd(flLoss)}, depositors ${usd(depLoss)}; it recovers only if the books' marks rise again${writtenOff > EPS ? `; ${usd(writtenOff)} already written off on retired books of this market` : ""}`,
    });
  }

  for (const b of p.books) {
    if (b.active) continue;
    const since = nowSec - b.lastMarkAt;
    const lost = b.allocationUsd - b.claimUsd;
    if (lost > EPS && since <= c.poolWriteOffNotifySec) {
      out.push({
        key: `pool_debt_written_off:${b.bookId}`,
        rule: "pool_debt_written_off",
        severity: "critical",
        notifyResolve: false,
        summary: `${bookLabel(books, b.bookId)} retired with ${usd(lost)} of its ${usd(b.allocationUsd)} insurance pool IF debt unrecoverable at its final mark (${iso(b.lastMarkAt)}): absorbed by the first-loss slice ${usd(b.lossFirstLossUsd)}, depositors ${usd(b.lossDepositorsUsd)}`,
      });
    }
    if (b.claimUsd > EPS && since > c.poolUnrepaidSec) {
      out.push({
        key: `pool_book_unrepaid:${b.bookId}`,
        rule: "pool_book_unrepaid",
        severity: "warning",
        summary: `${bookLabel(books, b.bookId)} is retired (final mark ${iso(b.lastMarkAt)}, ${dur(since)} ago) and still owes the insurance pool ${usd(b.claimUsd)}: the vault repays once the book's cash is back from the venue; anyone can retry with Book.settleInsurance()`,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ first-loss slice
export function poolFirstLossLow(s: Snapshot, _c: RuleConfig): Condition[] {
  const p = s.pool;
  if (!p || p.poolAssetsUsd <= 0 || p.firstLossBps >= p.firstLossTargetBps) return [];
  const depleted = p.firstLossUsd <= 0 && p.claimsUsd > 0;
  return [
    {
      key: "pool_first_loss_low",
      rule: "pool_first_loss_low",
      severity: depleted ? "critical" : "warning",
      forSec: 300,
      summary: `insurance pool first-loss slice ${usd(p.firstLossUsd)} is ${pct(p.firstLossBps)} of pool assets ${usd(p.poolAssetsUsd)} (target ${pct(p.firstLossTargetBps)}): new allocations are refused until it is topped up (depositFirstLoss)${depleted ? `; it is EMPTY with ${usd(p.claimsUsd)} of claims outstanding: the next loss is the depositors'` : ""}`,
    },
  ];
}

export const POOL_RULES = {
  pool_utilisation: poolUtilisation,
  pool_epoch_in_grace: poolEpochInGrace,
  pool_epoch_overdue: poolEpochOverdue,
  pool_market_debt: poolMarketDebt,
  pool_first_loss_low: poolFirstLossLow,
} as const;
