// Trading page v2 (2026-11): the market's price history (one-minute OHLC of the oracle's signed price, downsampled to a
// bounded number of points per range) and a trader's trade and PnL history from the engine's own events (indexed, never
// Redis). Pure. Sizes and prices are read through the same helpers as the rest of the trading page (unitsStr / wadStr
// and the shared engine math), so a later per-market factor applies in one place.
import { usdStr, wadStr } from "../format";
import type { EnginePriceMinuteRow, EngineTraderEventRow } from "../data/types";
import { abs, newEntry, notionalUsd, pnlUsd } from "./engine";
import { signedUsd, unitsStr } from "./trade";

// ------------------------------------------------------------------ price history

export const HISTORY_RANGES = ["1D", "1W", "1M"] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

/**
 * Per range: the span, the point step (span / step stays under MAX_HISTORY_POINTS) and how long a result is cached.
 * 1D: 5-minute points (288), 1W: 30-minute (336), 1M: 2-hour (360).
 */
export const HISTORY_SPEC: Record<HistoryRange, { spanSec: number; stepSec: number; cacheSec: number }> = {
  "1D": { spanSec: 86_400, stepSec: 300, cacheSec: 5 },
  "1W": { spanSec: 7 * 86_400, stepSec: 1_800, cacheSec: 30 },
  "1M": { spanSec: 30 * 86_400, stepSec: 7_200, cacheSec: 120 },
};
export const MAX_HISTORY_POINTS = 400;
/** One-minute rows a range may read at most (its span in minutes, plus the partly covered first step). */
export const minuteRowsFor = (r: HistoryRange) => Math.ceil((HISTORY_SPEC[r].spanSec + HISTORY_SPEC[r].stepSec) / 60) + 1;

export interface HistoryPoint {
  /** start of the step, unix seconds */
  t: number;
  open: string;
  high: string;
  low: string;
  close: string;
  /** every minute of the step was a held (session closed) price */
  held: boolean;
}

/** Start of the range, aligned down to the step grid (so a step is never cut in two). */
export const historyFrom = (range: HistoryRange, nowSec: number) => {
  const { spanSec, stepSec } = HISTORY_SPEC[range];
  return Math.floor((nowSec - spanSec) / stepSec) * stepSec;
};

/** One-minute candles (ascending) -> one point per step: open of the first minute, close of the last, high / low. */
export function aggregateCandles(rows: readonly Pick<EnginePriceMinuteRow, "bucket" | "openWad" | "highWad" | "lowWad" | "closeWad" | "held">[], stepSec: number, fromSec: number, toSec: number): HistoryPoint[] {
  const out: Array<{ t: number; open: bigint; high: bigint; low: bigint; close: bigint; held: boolean }> = [];
  const sorted = [...rows].sort((a, b) => a.bucket.getTime() - b.bucket.getTime());
  for (const r of sorted) {
    const sec = Math.floor(r.bucket.getTime() / 1000);
    if (sec < fromSec || sec > toSec) continue;
    const t = Math.floor(sec / stepSec) * stepSec;
    const [o, h, l, c] = [BigInt(r.openWad), BigInt(r.highWad), BigInt(r.lowWad), BigInt(r.closeWad)];
    const last = out[out.length - 1];
    if (last && last.t === t) {
      if (h > last.high) last.high = h;
      if (l < last.low) last.low = l;
      last.close = c;
      last.held = last.held && r.held;
    } else out.push({ t, open: o, high: h, low: l, close: c, held: r.held });
  }
  return out.slice(-MAX_HISTORY_POINTS).map((p) => ({ t: p.t, open: wadStr(p.open), high: wadStr(p.high), low: wadStr(p.low), close: wadStr(p.close), held: p.held }));
}

// ------------------------------------------------------------------ trade and PnL history

/** At most this many events of one trader are read (oldest first: the entry-price replay needs the start). */
export const MAX_TRADER_EVENTS = 10_000;

export type FillKind = "trade" | "liquidation" | "close_out" | "deposit" | "withdrawal" | "funding";

export interface FillView {
  id: string;
  at: string;
  block: number;
  txHash: string;
  marketId: number;
  kind: FillKind;
  side: "buy" | "sell" | null;
  /** traded / closed size, absolute units */
  size: string | null;
  price: string | null;
  notionalUsd: string | null;
  /** taker fee of a trade, liquidation fee of a liquidation (paid from margin) */
  feeUsd: string;
  /** realised PnL of the closed part (null: no position closed, or unknown when the replay lacks the entry) */
  realisedPnlUsd: string | null;
  /** funding settled (positive: paid by the trader) */
  fundingUsd: string | null;
  /** margin deposited (> 0) or withdrawn (< 0) */
  marginUsd: string | null;
  /** a loss beyond the margin, absorbed by the market's insurance fund then its pool */
  badDebtUsd: string | null;
  /** signed position after the event (units), null for margin and funding rows */
  positionAfter: string | null;
}

export interface FillTotals {
  trades: number;
  liquidations: number;
  realisedPnlUsd: string;
  tradingFeesUsd: string;
  liquidationFeesUsd: string;
  feesUsd: string;
  /** net funding paid (positive) or received (negative) */
  fundingUsd: string;
  /** realised PnL - fees - funding paid */
  netUsd: string;
  depositedUsd: string;
  withdrawnUsd: string;
  /** a liquidation whose entry price the replay could not establish: its PnL is left out of the totals */
  unknownPnl: number;
}

const big = (v: string | null | undefined): bigint => (v ? BigInt(v) : 0n);

/**
 * A trader's rows from the engine events (oldest first in, newest first out) and the totals. The entry price is
 * replayed per market with the engine's own averaging (shared `newEntry`) so a liquidation, whose event carries no
 * PnL, gets the engine's `pnlUsd(size, entry, price)`. A wind-down close-out (Trade then ClosedOut in one transaction)
 * is one row.
 */
export function buildFills(events: readonly EngineTraderEventRow[]): { rows: FillView[]; totals: FillTotals } {
  const sorted = [...events].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const closeOuts = new Map<string, EngineTraderEventRow>();
  for (const e of sorted) if (e.kind === "closed_out") closeOuts.set(`${e.txHash}:${e.logIndex - 1}`, e);
  const state = new Map<number, { size: bigint; entry: bigint | null }>();
  const t = { trades: 0, liquidations: 0, pnl: 0n, tradeFees: 0n, liqFees: 0n, funding: 0n, dep: 0n, wd: 0n, unknown: 0 };
  const rows: FillView[] = [];
  for (const e of sorted) {
    const st = state.get(e.marketId) ?? { size: 0n, entry: 0n };
    const base = { id: `${e.txHash}:${e.logIndex}`, at: e.ts.toISOString(), block: e.block, txHash: e.txHash, marketId: e.marketId };
    const none = { side: null, size: null, price: null, notionalUsd: null, feeUsd: usdStr(0n), realisedPnlUsd: null, fundingUsd: null, marginUsd: null, badDebtUsd: null, positionAfter: null };
    if (e.kind === "trade") {
      const delta = big(e.sizeRaw);
      const after = big(e.newSizeRaw);
      const before = after - delta;
      const fill = big(e.priceWad);
      // a replay that disagrees with the event (history cut short) loses the entry until the next open from flat
      const entry = st.size === before ? st.entry : null;
      const nextEntry = after === 0n ? 0n : before === 0n || before > 0n !== after > 0n ? fill : entry === null ? null : newEntry(before, after, entry, fill);
      state.set(e.marketId, { size: after, entry: nextEntry });
      const fee = big(e.feeRaw);
      const pnl = big(e.pnlRaw);
      const co = closeOuts.get(`${e.txHash}:${e.logIndex}`);
      const closedOut = co !== undefined && co.trader === e.trader && after === 0n;
      t.trades++;
      t.tradeFees += fee;
      t.pnl += pnl;
      rows.push({
        ...base,
        ...none,
        kind: closedOut ? "close_out" : "trade",
        side: delta > 0n ? "buy" : "sell",
        size: unitsStr(abs(delta)),
        price: wadStr(fill),
        notionalUsd: usdStr(notionalUsd(delta, fill)),
        feeUsd: usdStr(fee),
        realisedPnlUsd: before !== 0n && (before > 0n) !== (delta > 0n) ? signedUsd(pnl) : null,
        badDebtUsd: closedOut ? usdStr(big(co.badDebtRaw)) : null,
        positionAfter: unitsStr(after),
      });
    } else if (e.kind === "liquidation") {
      const size = big(e.sizeRaw);
      const px = big(e.priceWad);
      const fee = big(e.feeRaw);
      const pnl = st.size === size && st.entry !== null ? pnlUsd(size, st.entry, px) : null;
      state.set(e.marketId, { size: 0n, entry: 0n });
      t.liquidations++;
      t.liqFees += fee;
      if (pnl === null) t.unknown++;
      else t.pnl += pnl;
      rows.push({
        ...base,
        ...none,
        kind: "liquidation",
        side: size > 0n ? "sell" : "buy",
        size: unitsStr(abs(size)),
        price: wadStr(px),
        notionalUsd: usdStr(notionalUsd(size, px)),
        feeUsd: usdStr(fee),
        realisedPnlUsd: pnl === null ? null : signedUsd(pnl),
        badDebtUsd: usdStr(big(e.badDebtRaw)),
        positionAfter: unitsStr(0n),
      });
    } else if (e.kind === "margin") {
      const d = big(e.marginDeltaRaw);
      if (d >= 0n) t.dep += d;
      else t.wd += -d;
      rows.push({ ...base, ...none, kind: d >= 0n ? "deposit" : "withdrawal", marginUsd: signedUsd(d) });
    } else if (e.kind === "funding") {
      const f = big(e.fundingRaw);
      t.funding += f;
      rows.push({ ...base, ...none, kind: "funding", fundingUsd: signedUsd(f) });
    }
    // closed_out rows are folded into their Trade row above
  }
  const fees = t.tradeFees + t.liqFees;
  return {
    rows: rows.reverse(),
    totals: {
      trades: t.trades,
      liquidations: t.liquidations,
      realisedPnlUsd: signedUsd(t.pnl),
      tradingFeesUsd: usdStr(t.tradeFees),
      liquidationFeesUsd: usdStr(t.liqFees),
      feesUsd: usdStr(fees),
      fundingUsd: signedUsd(t.funding),
      netUsd: signedUsd(t.pnl - fees - t.funding),
      depositedUsd: usdStr(t.dep),
      withdrawnUsd: usdStr(t.wd),
      unknownPnl: t.unknown,
    },
  };
}
