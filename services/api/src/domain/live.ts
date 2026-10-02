// Tolerant parsers for live state other services keep in Redis (KEYS.* in shared queues.ts).
import type { LimitsSnapshot } from "@bookrunner/shared/mandate";
import type { OraclePriceMsg, QuoteMsg } from "@bookrunner/shared/queues";
import { USD_DECIMALS, parseFixed } from "@bookrunner/shared/units";
import type { LimitsRow } from "../data/types";
import { usdStr } from "../format";

const toIso = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === "string") {
    const d = new Date(/^\d+$/.test(v) ? Number(v) * (v.length > 12 ? 1 : 1000) : v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
};

/** Accepts a 6dp decimal string, a raw integer string with `raw: true`, or a number. */
export function usdFromLoose(v: unknown): string | null {
  if (v == null) return null;
  try {
    if (typeof v === "number") return Number.isFinite(v) ? usdStr(parseFixed(v.toFixed(USD_DECIMALS), USD_DECIMALS)) : null;
    if (typeof v === "bigint") return usdStr(v);
    if (typeof v === "string" && v.trim() !== "") return usdStr(parseFixed(v.trim(), USD_DECIMALS));
  } catch {
    return null;
  }
  return null;
}

export interface LiveNavView {
  navUsd: string | null;
  seniorNavUsd: string | null;
  juniorNavUsd: string | null;
  deployedValueUsd: string | null;
  drawdownBps: number | null;
  ts: string | null;
  source: "live";
}

/** KEYS.liveNav JSON written by risk/mark (shape owned by those services; parsed defensively). */
export function parseLiveNav(raw: unknown): LiveNavView | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const nav = usdFromLoose(o.navUsd ?? o.nav ?? o.liveNavUsd);
  if (nav === null) return null;
  const tranches = (o.tranches ?? {}) as Record<string, unknown>;
  const dd = o.drawdownBps;
  return {
    navUsd: nav,
    seniorNavUsd: usdFromLoose(o.seniorNavUsd ?? o.seniorNav ?? tranches.seniorNav),
    juniorNavUsd: usdFromLoose(o.juniorNavUsd ?? o.juniorNav ?? tranches.juniorNav),
    deployedValueUsd: usdFromLoose(o.deployedValueUsd),
    drawdownBps: typeof dd === "number" && Number.isFinite(dd) ? dd : null,
    ts: toIso(o.ts ?? o.updatedAt ?? o.at),
    source: "live",
  };
}

export interface LimitsView {
  state: string;
  inventoryUtil: number;
  skewUtil: number;
  hedgeRatioBps: number | null;
  drawdownBps: number;
  offHours: boolean;
  breaches: string[];
  netExposureUsd: number | null;
  liveNavUsd: number | null;
  ts: string | null;
  source: "live" | "db";
}

const numOr = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** A USD figure as a number: the risk service writes 6dp decimal strings ("-866.510000"). */
const usdNum = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * KEYS.riskState: LimitsSnapshot + meta. The risk service nests the meta (RiskStatePayload.meta:
 * ts in ms, netExposureUsd / liveNavUsd as decimal strings); older writers put it at the top level.
 * Reading only the top level left net exposure and the update time empty under a 'live' label.
 */
export function parseRiskState(raw: unknown): (LimitsView & { meta: Record<string, unknown> }) | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<LimitsSnapshot> & Record<string, unknown>;
  if (typeof o.state !== "string") return null;
  const { state, inventoryUtil, skewUtil, hedgeRatioBps, drawdownBps, offHours, breaches, meta: nested, ...top } = o;
  const meta: Record<string, unknown> = { ...top, ...(nested && typeof nested === "object" ? (nested as Record<string, unknown>) : {}) };
  return {
    state,
    inventoryUtil: numOr(inventoryUtil, 0),
    skewUtil: numOr(skewUtil, 0),
    hedgeRatioBps: typeof hedgeRatioBps === "number" ? hedgeRatioBps : null,
    drawdownBps: numOr(drawdownBps, 0),
    offHours: Boolean(offHours),
    breaches: Array.isArray(breaches) ? breaches.map(String) : [],
    netExposureUsd: usdNum(meta.netExposureUsd),
    liveNavUsd: usdNum(meta.liveNavUsd),
    ts: toIso(meta.ts ?? meta.updatedAt),
    source: "live",
    meta,
  };
}

export function limitsRowToView(r: LimitsRow): LimitsView {
  return {
    state: r.state,
    inventoryUtil: r.inventoryUtil,
    skewUtil: r.skewUtil,
    hedgeRatioBps: r.hedgeRatio,
    drawdownBps: r.drawdownBps,
    offHours: r.offHours,
    breaches: Array.isArray(r.breaches) ? (r.breaches as unknown[]).map(String) : [],
    netExposureUsd: r.netExposureUsd,
    liveNavUsd: r.liveNavUsd,
    ts: r.ts.toISOString(),
    source: "db",
  };
}

export function parseQuote(raw: unknown): QuoteMsg | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<QuoteMsg>;
  return typeof o.bid === "number" && typeof o.ask === "number" && typeof o.ts === "number" ? (o as QuoteMsg) : null;
}

export interface OraclePriceView {
  priceId: string;
  price: number;
  priceWad: string | null;
  publishedAt: string;
  held: boolean;
  sourceCount: number;
  stale: boolean;
  source: "live" | "db";
}

export function parseOraclePrice(raw: unknown, nowMs: number, maxAgeSec: number): OraclePriceView | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<OraclePriceMsg>;
  if (typeof o.priceId !== "string" || typeof o.price !== "number" || typeof o.publishedAt !== "number") return null;
  return {
    priceId: o.priceId,
    price: o.price,
    priceWad: typeof o.priceWad === "string" ? o.priceWad : null,
    publishedAt: new Date(o.publishedAt * 1000).toISOString(),
    held: Boolean(o.held),
    sourceCount: numOr(o.sourceCount, 0),
    stale: nowMs / 1000 - o.publishedAt > maxAgeSec,
    source: "live",
  };
}
