// Trading page v2 history logic (pure; test/trade-history.test.ts): the price chart's runs (a held, session-closed
// stretch is drawn apart from the open session, and a gap in the record breaks the line), its summary, the trade
// history's labels and the CSV export (generated in the browser from the API's rows).
import type { TradeFill, TradeHistoryPoint } from "../../lib/api-types";

export const HISTORY_RANGE_OPTIONS = [
  { value: "1D", label: "1D", title: "One day, 5-minute steps" },
  { value: "1W", label: "1W", title: "One week, 30-minute steps" },
  { value: "1M", label: "1M", title: "30 days, 2-hour steps" },
] as const;
export type HistoryRange = (typeof HISTORY_RANGE_OPTIONS)[number]["value"];

export interface ChartPoint {
  t: number;
  v: number;
  held: boolean;
}

/** Points with a finite close, ascending. */
export function chartPoints(points: readonly TradeHistoryPoint[]): ChartPoint[] {
  return points
    .map((p) => ({ t: p.t, v: Number(p.close), held: p.held }))
    .filter((p) => Number.isFinite(p.v) && p.v > 0)
    .sort((a, b) => a.t - b.t);
}

/**
 * Runs of consecutive points drawn as one line: a new run starts where the held flag changes (the session-closed
 * stretch is dashed) or where more than `maxGapSteps` steps are missing (no price was recorded: the line breaks). A
 * change of state shares its boundary point so the line stays continuous across it.
 */
export function chartRuns(pts: readonly ChartPoint[], stepSec: number, maxGapSteps = 2): Array<{ held: boolean; points: ChartPoint[] }> {
  const runs: Array<{ held: boolean; points: ChartPoint[] }> = [];
  let cur: { held: boolean; points: ChartPoint[] } | null = null;
  let prev: ChartPoint | null = null;
  for (const p of pts) {
    const gap = prev !== null && p.t - prev.t > stepSec * (maxGapSteps + 1);
    if (!cur || gap) {
      cur = { held: p.held, points: [p] };
      runs.push(cur);
    } else if (p.held !== cur.held) {
      cur = { held: p.held, points: prev ? [prev, p] : [p] };
      runs.push(cur);
    } else cur.points.push(p);
    prev = p;
  }
  return runs;
}

export interface HistorySummary {
  first: number;
  last: number;
  high: number;
  low: number;
  /** last / first - 1 */
  change: number;
}

/** First open, last close, highest high and lowest low of the range (from the steps' OHLC). */
export function historySummary(points: readonly TradeHistoryPoint[]): HistorySummary | null {
  const ok = points.filter((p) => Number(p.close) > 0);
  if (ok.length === 0) return null;
  const first = Number(ok[0]!.open);
  const last = Number(ok[ok.length - 1]!.close);
  const high = Math.max(...ok.map((p) => Number(p.high)));
  const low = Math.min(...ok.map((p) => Number(p.low)));
  return { first, last, high, low, change: first > 0 ? last / first - 1 : 0 };
}

// ------------------------------------------------------------------ trade history

export const FILL_KIND_LABEL: Record<TradeFill["kind"], string> = {
  trade: "Trade",
  liquidation: "Liquidation",
  close_out: "Closed out (wind-down)",
  deposit: "Margin deposit",
  withdrawal: "Margin withdrawal",
  funding: "Funding",
};

/** Rows per page of the history table, and per API read of the CSV export (the API's page bound). */
export const FILLS_PAGE_SIZE = 25;
export const FILLS_EXPORT_PAGE = 500;
/**
 * Pause between two page reads of the export (nginx zone bookrunner_history: 2/s per IP, bursts of 20): 600 ms keeps a
 * full export (20 pages) under the rate itself, whatever else the page reads meanwhile.
 */
export const FILLS_EXPORT_PACE_MS = 600;

/** A CSV cell: quoted when it holds a comma, quote or line break; a text cell starting with = + - @ is defused. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The trade history as CSV (newest first, as served): exact decimals, UTC timestamps, the market's symbol. */
export function fillsCsv(rows: readonly TradeFill[], o: { settlementSymbol: string; marketLabel: (marketId: number) => string }): string {
  const sym = o.settlementSymbol;
  const head = [
    "time_utc",
    "market",
    "type",
    "side",
    "size_units",
    "price",
    `notional_${sym}`,
    `fee_${sym}`,
    `realised_pnl_${sym}`,
    `funding_paid_${sym}`,
    `margin_change_${sym}`,
    `bad_debt_${sym}`,
    "position_after_units",
    "block",
    "tx_hash",
  ];
  const lines = rows.map((r) =>
    [r.at, o.marketLabel(r.marketId), FILL_KIND_LABEL[r.kind], r.side ?? "", r.size, r.price, r.notionalUsd, r.feeUsd, r.realisedPnlUsd, r.fundingUsd, r.marginUsd, r.badDebtUsd, r.positionAfter, r.block, r.txHash]
      .map(csvCell)
      .join(","),
  );
  return `${[head.map(csvCell).join(","), ...lines].join("\r\n")}\r\n`;
}

/** File name of the export: bookrunner-trades-<wallet 0x1234…abcd>-<market or all>-<YYYY-MM-DD>.csv */
export function fillsCsvName(wallet: string, market: string | null, nowMs: number): string {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const w = `${wallet.slice(0, 6)}-${wallet.slice(-4)}`.toLowerCase();
  const m = (market ?? "all-markets").replace(/[^A-Za-z0-9_-]+/g, "-");
  return `bookrunner-trades-${w}-${m}-${day}.csv`;
}
