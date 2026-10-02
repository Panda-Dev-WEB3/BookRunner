// Activity feeds (book.fills, book.hedges, receipts.list): row -> view mapping, the fills keyset
// cursor, and linking fill / hedge rows to their receipt leaves. Producers (bookrunner-agent, risk)
// write each fill / hedge row together with a receipt whose payload carries venueTradeId (fills) or
// txHash (hedges); there is no receipt_id column, so the link is resolved here by payload field.
import { RECEIPT_KIND } from "@bookrunner/shared/merkle";
import type { FillCursor, FillRow, HedgeRow, ReadModel, ReceiptLinkField, ReceiptRow } from "../data/types";
import { dbUsdStr } from "../format";
import { RECEIPT_KIND_NAMES } from "./receipts";

export interface FillView {
  ts: string;
  /** Book's perspective. */
  side: "buy" | "sell";
  qty: number;
  px: number;
  feeUsd: number;
  venueTradeId: string;
  maker: boolean;
  trader: string | null;
  receiptId: number | null;
}

export interface HedgeView {
  id: number;
  ts: string;
  asset: string;
  /** Signed raw token units (+ buy, - sell). */
  qtyRaw: string;
  px: number;
  mult: number;
  venue: string;
  valueUsd: string | null;
  txHash: string;
  receiptId: number | null;
}

export interface ReceiptListView {
  id: number;
  bookId: number;
  kind: number;
  kindName: string;
  ts: string;
  hourStart: string;
  payloadHash: string;
}

export const fillView = (r: FillRow, receiptId: number | null): FillView => ({
  ts: r.ts.toISOString(),
  side: r.side === "sell" ? "sell" : "buy",
  qty: r.qty,
  px: r.px,
  feeUsd: r.feeUsd,
  venueTradeId: r.venueTradeId,
  maker: r.maker,
  trader: r.trader,
  receiptId,
});

export const hedgeView = (r: HedgeRow, receiptId: number | null): HedgeView => ({
  id: r.id,
  ts: r.ts.toISOString(),
  asset: r.asset,
  qtyRaw: String(r.qtyRaw),
  px: r.px,
  mult: r.mult,
  venue: r.venue,
  valueUsd: dbUsdStr(r.valueUsd),
  txHash: r.txHash,
  receiptId,
});

export const receiptListView = (r: ReceiptRow): ReceiptListView => ({
  id: r.id,
  bookId: r.bookId,
  kind: r.kind,
  kindName: RECEIPT_KIND_NAMES[r.kind] ?? "unknown",
  ts: r.ts.toISOString(),
  hourStart: r.hourStart.toISOString(),
  payloadHash: r.payloadHash,
});

// ------------------------------------------------------------------ fills cursor
/** "<unix ms>:<venueTradeId>" of the last row of a page (fills have no id). */
export const encodeFillCursor = (r: Pick<FillRow, "ts" | "venueTradeId">): string => `${r.ts.getTime()}:${r.venueTradeId}`;

export function decodeFillCursor(s: string): FillCursor | null {
  const m = /^(\d{1,16}):(.+)$/s.exec(s);
  if (!m) return null;
  const ts = new Date(Number(m[1]));
  return Number.isNaN(ts.getTime()) ? null : { ts, venueTradeId: m[2]! };
}

// ------------------------------------------------------------------ receipt links
/** Producers stamp the receipt with the action time; allow some skew between the row ts and it. */
const LINK_SLACK_MS = 5 * 60_000;

/**
 * Receipt ids for rows, keyed by their link value (txHash lowercased). The scan is bounded to the
 * receipt hours the rows can fall in: hour_start = floor(ts / interval) * interval.
 */
export async function receiptIdsFor(
  data: ReadModel,
  bookId: number,
  kind: number,
  field: ReceiptLinkField,
  rows: Array<{ ts: Date; value: string }>,
  receiptsIntervalSeconds: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (rows.length === 0) return out;
  const times = rows.map((r) => r.ts.getTime());
  const from = new Date(Math.min(...times) - receiptsIntervalSeconds * 1000 - LINK_SLACK_MS);
  const to = new Date(Math.max(...times) + LINK_SLACK_MS);
  const norm = (v: string) => (field === "txHash" ? v.toLowerCase() : v);
  const values = [...new Set(rows.map((r) => norm(r.value)))];
  const links = await data.receiptLinks(bookId, kind, field, values, from, to);
  // oldest receipt wins when a value repeats (links are ascending by id)
  for (const l of links) if (!out.has(norm(l.value))) out.set(norm(l.value), l.id);
  return out;
}

export const linkKinds = { fill: RECEIPT_KIND.FILL, hedge: RECEIPT_KIND.HEDGE } as const;
