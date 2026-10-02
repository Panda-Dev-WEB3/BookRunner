// Tolerant parsers for activity feeds the dashboards show but the current API router does not type:
// book.fills, book.hedges, receipts.list (optional procedures; see integration notes). Rows follow
// the DB tables (fills, hedges, receipts) and are accepted as {items: [...]} or a bare array.

export interface FillRow {
  ts: string;
  side: "buy" | "sell";
  qty: number;
  px: number;
  feeUsd: number;
  venueTradeId: string;
  maker: boolean;
  trader: string | null;
  receiptId: number | null;
}

export interface HedgeRow {
  id: number | null;
  ts: string;
  asset: string;
  qtyRaw: string;
  px: number;
  mult: number;
  venue: string;
  valueUsd: string | null;
  txHash: string | null;
  receiptId: number | null;
}

export interface ReceiptRow {
  id: number;
  kind: number;
  kindName: string;
  ts: string;
  hourStart: string | null;
  payloadHash: string | null;
}

const KIND_NAMES = ["quote", "fill", "hedge", "decision"];

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const s = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const iso = (v: unknown): string | null => {
  if (typeof v === "number") return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === "string") {
    const d = new Date(/^\d+$/.test(v) ? Number(v) * (v.length > 12 ? 1 : 1000) : v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (v instanceof Date) return v.toISOString();
  return null;
};

function itemsOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const o = rec(raw);
  if (o && Array.isArray(o.items)) return o.items;
  return [];
}

export function parseFills(raw: unknown): FillRow[] {
  const out: FillRow[] = [];
  for (const it of itemsOf(raw)) {
    const o = rec(it);
    if (!o) continue;
    const ts = iso(o.ts);
    const qty = num(o.qty);
    const px = num(o.px);
    const side = o.side === "buy" || o.side === "sell" ? o.side : null;
    if (!ts || qty === null || px === null || !side) continue;
    out.push({
      ts,
      side,
      qty,
      px,
      feeUsd: num(o.feeUsd) ?? 0,
      venueTradeId: s(o.venueTradeId) ?? "",
      maker: o.maker === undefined ? true : Boolean(o.maker),
      trader: s(o.trader),
      receiptId: num(o.receiptId),
    });
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts));
}

export function parseHedges(raw: unknown): HedgeRow[] {
  const out: HedgeRow[] = [];
  for (const it of itemsOf(raw)) {
    const o = rec(it);
    if (!o) continue;
    const ts = iso(o.ts);
    const px = num(o.px);
    const qtyRaw = s(o.qtyRaw);
    if (!ts || px === null || qtyRaw === null) continue;
    out.push({
      id: num(o.id),
      ts,
      asset: s(o.asset) ?? "",
      qtyRaw,
      px,
      mult: num(o.mult) ?? 1,
      venue: s(o.venue) ?? "UNIV3",
      valueUsd: s(o.valueUsd),
      txHash: s(o.txHash),
      receiptId: num(o.receiptId),
    });
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts));
}

export function parseReceipts(raw: unknown): ReceiptRow[] {
  const out: ReceiptRow[] = [];
  for (const it of itemsOf(raw)) {
    const o = rec(it);
    if (!o) continue;
    const id = num(o.id ?? o.receiptId);
    const kind = num(o.kind);
    const ts = iso(o.ts);
    if (id === null || kind === null || !ts) continue;
    out.push({ id, kind, kindName: s(o.kindName) ?? KIND_NAMES[kind] ?? "unknown", ts, hourStart: iso(o.hourStart), payloadHash: s(o.payloadHash) });
  }
  return out.sort((a, b) => b.id - a.id);
}

/** Hedge quantity in whole units given raw base units (Stock Tokens: 18 decimals). */
export function hedgeQty(qtyRaw: string, decimals = 18): number | null {
  if (!/^-?\d+$/.test(qtyRaw)) return null;
  const neg = qtyRaw.startsWith("-");
  const digits = neg ? qtyRaw.slice(1) : qtyRaw;
  const padded = digits.padStart(decimals + 1, "0");
  const n = Number(`${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`);
  return neg ? -n : n;
}
