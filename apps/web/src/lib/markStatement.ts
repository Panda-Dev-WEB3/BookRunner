// Tolerant reader for the PnL statement signed into each mark (marks.pnl_json, hashed into the mark
// as pnlJsonHash): venue state, desk hedge book and the period's PnL split. Used for the per-mark
// venue / desk tables and as the source of net exposure when the live risk snapshot lacks it.

export interface DeskPositionView {
  token: string;
  qtyRaw: string;
  priceWad: string | null;
  valueUsd: string | null;
}

export interface MarkStatement {
  markId: number;
  periodEndAt: string;
  venue: {
    marginUsd: string | null;
    insuranceUsd: string | null;
    netExposureUsd: string | null;
    inTransitUsd: string | null;
    valuationAt: number | null;
  };
  desk: { usdc: string | null; hedgeValueUsd: string | null; positions: DeskPositionView[] };
  pnl: { realizedUsd: string | null; unrealizedUsd: string | null; feeFlowUsd: string | null; fundingUsd: string | null; markPnlUsd: string | null };
  hedgeRatioBps: number | null;
  vaultIdleUsd: string | null;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const dec = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return v.trim();
  return null;
};
const int = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

export interface MarkWithPnl {
  markId: number;
  periodEndAt: string;
  pnl?: unknown;
}

export function parseMarkStatement(m: MarkWithPnl): MarkStatement | null {
  if (!m.pnl || typeof m.pnl !== "object") return null;
  const o = rec(m.pnl);
  const venue = rec(o.venue);
  const desk = rec(o.desk);
  const pnl = rec(o.pnl);
  const limits = rec(o.limits);
  const positions = (Array.isArray(desk.positions) ? desk.positions : [])
    .map((p) => {
      const x = rec(p);
      const token = typeof x.token === "string" ? x.token : null;
      const qtyRaw = typeof x.qtyRaw === "string" || typeof x.qtyRaw === "number" ? String(x.qtyRaw) : null;
      if (!token || !qtyRaw || !/^-?\d+$/.test(qtyRaw)) return null;
      return { token, qtyRaw, priceWad: typeof x.priceWad === "string" ? x.priceWad : null, valueUsd: dec(x.valueUsd) };
    })
    .filter((p): p is DeskPositionView => p !== null);
  return {
    markId: m.markId,
    periodEndAt: m.periodEndAt,
    venue: {
      marginUsd: dec(venue.marginUsd),
      insuranceUsd: dec(venue.insuranceUsd),
      netExposureUsd: dec(venue.netExposureUsd),
      inTransitUsd: dec(venue.inTransitUsd),
      valuationAt: int(venue.valuationAt),
    },
    desk: { usdc: dec(desk.usdc), hedgeValueUsd: dec(desk.hedgeValueUsd), positions },
    pnl: {
      realizedUsd: dec(pnl.realizedUsd),
      unrealizedUsd: dec(pnl.unrealizedUsd),
      feeFlowUsd: dec(pnl.feeFlowUsd),
      fundingUsd: dec(pnl.fundingUsd),
      markPnlUsd: dec(pnl.markPnlUsd),
    },
    hedgeRatioBps: int(limits.hedgeRatioBps),
    vaultIdleUsd: dec(o.vaultIdleUsd),
  };
}

/** Statements of the given marks, newest first, skipping marks without a parsable statement. */
export function markStatements(marks: MarkWithPnl[]): MarkStatement[] {
  return marks
    .map(parseMarkStatement)
    .filter((s): s is MarkStatement => s !== null)
    .sort((a, b) => b.markId - a.markId);
}

/** WAD price string -> number (display only). */
export function wadToNumber(w: string | null | undefined): number | null {
  if (!w || !/^\d+$/.test(w)) return null;
  const padded = w.padStart(19, "0");
  const n = Number(`${padded.slice(0, -18)}.${padded.slice(-18)}`);
  return Number.isFinite(n) ? n : null;
}
