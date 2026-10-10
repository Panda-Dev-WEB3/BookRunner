// Public status (GET /status, apps/site /status/): per book the age of the latest mark, the risk state
// (ok / warn / breach) and the last distribution. Pure: built from read-model rows + live risk views.
// Nothing here is secret (every figure is on-chain or already on the public API); no addresses, no keys.
import type { BookRow, MarkRow, SettlementRow } from "../data/types";
import { dbUsdStr } from "../format";
import type { LimitsView } from "./live";
import { VENUE } from "@bookrunner/shared/types";

export type RiskLevel = "ok" | "warn" | "breach" | "unknown";
export type MarkStatus = "ok" | "late" | "overdue" | "not_marked";

export interface StatusBook {
  bookId: number;
  name: string | null;
  symbol: string;
  venue: "orderly" | "pool_engine";
  state: string;
  latestMark: { periodEnd: string; committedAt: string; ageSeconds: number } | null;
  /** not_marked: the book is not in a marked state (Subscription, Retired, Cancelled) */
  markStatus: MarkStatus;
  risk: RiskLevel;
  /** killed mandate (risk breach level, flagged separately) */
  killed: boolean;
  lastDistribution: { at: string; period: number | null; grossUsd: string; seniorUsd: string; juniorUsd: string; txHash: string } | null;
}

export interface StatusView {
  generatedAt: string;
  chainId: number;
  markIntervalSeconds: number;
  /** grace after markInterval before a mark counts as late */
  markGraceSeconds: number;
  /** worst of the books: ok | warn (a late mark or a risk warning) | breach (an overdue mark or a risk breach) */
  overall: "ok" | "warn" | "breach";
  books: StatusBook[];
}

const MARKED = new Set(["Live", "Retiring"]);

/** Grace before a mark is late: a quarter of the interval, between 5 min and 1 h (testnet 15 min, mainnet 1 h). */
export const markGrace = (intervalSec: number) => Math.min(3600, Math.max(300, Math.round(intervalSec / 4)));

export function riskLevel(l: LimitsView | null | undefined): { risk: RiskLevel; killed: boolean } {
  if (!l) return { risk: "unknown", killed: false };
  switch (l.state) {
    case "ok":
      return { risk: "ok", killed: false };
    case "warn":
    case "reduce_only":
      return { risk: "warn", killed: false };
    case "breach":
      return { risk: "breach", killed: false };
    case "killed":
      return { risk: "breach", killed: true };
    default:
      return { risk: "unknown", killed: false };
  }
}

export function markStatus(state: string, mark: MarkRow | null, ref: Date | null, nowMs: number, intervalSec: number): MarkStatus {
  if (!MARKED.has(state)) return "not_marked";
  const base = mark?.periodEnd ?? ref;
  if (!base) return "ok";
  const age = (nowMs - base.getTime()) / 1000;
  const grace = markGrace(intervalSec);
  if (age <= intervalSec + grace) return "ok";
  if (age <= 2 * intervalSec + grace) return "late";
  return "overdue";
}

export function buildStatus(args: {
  books: BookRow[];
  marks: MarkRow[];
  limits: Map<number, LimitsView>;
  distributions: SettlementRow[];
  markIntervalSec: number;
  chainId: number;
  now: number;
}): StatusView {
  const markBy = new Map(args.marks.map((m) => [m.bookId, m]));
  const distBy = new Map<number, SettlementRow>();
  for (const d of args.distributions) {
    const cur = distBy.get(d.bookId);
    if (!cur || d.ts > cur.ts) distBy.set(d.bookId, d);
  }
  const books: StatusBook[] = args.books.map((b) => {
    const m = markBy.get(b.id) ?? null;
    const d = distBy.get(b.id) ?? null;
    const { risk, killed } = riskLevel(args.limits.get(b.id));
    return {
      bookId: b.id,
      name: b.name,
      symbol: b.symbol,
      venue: b.venue === VENUE.POOL_ENGINE ? "pool_engine" : "orderly",
      state: b.state,
      latestMark: m ? { periodEnd: m.periodEnd.toISOString(), committedAt: m.committedAt.toISOString(), ageSeconds: Math.max(0, Math.floor((args.now - m.periodEnd.getTime()) / 1000)) } : null,
      markStatus: markStatus(b.state, m, b.subscriptionEnds, args.now, args.markIntervalSec),
      risk: MARKED.has(b.state) || risk !== "unknown" ? risk : "unknown",
      killed,
      lastDistribution: d
        ? {
            at: d.ts.toISOString(),
            period: d.period ?? null,
            grossUsd: dbUsdStr(d.grossUsd) ?? "0.000000",
            seniorUsd: dbUsdStr(d.seniorUsd) ?? "0.000000",
            juniorUsd: dbUsdStr(d.juniorUsd) ?? "0.000000",
            txHash: d.txHash,
          }
        : null,
    };
  });
  const level = (b: StatusBook): 0 | 1 | 2 => {
    if (b.risk === "breach" || b.markStatus === "overdue") return 2;
    if (b.risk === "warn" || b.markStatus === "late") return 1;
    return 0;
  };
  const worst = books.reduce<0 | 1 | 2>((w, b) => (MARKED.has(b.state) ? (Math.max(w, level(b)) as 0 | 1 | 2) : w), 0);
  return {
    generatedAt: new Date(args.now).toISOString(),
    chainId: args.chainId,
    markIntervalSeconds: args.markIntervalSec,
    markGraceSeconds: markGrace(args.markIntervalSec),
    overall: (["ok", "warn", "breach"] as const)[worst],
    books,
  };
}
