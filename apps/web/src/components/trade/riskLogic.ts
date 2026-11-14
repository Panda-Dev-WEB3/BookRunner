// Liquidation-risk warnings of the trading page (pure; test/trade-risk.test.ts). A position's margin ratio (equity /
// notional) is read against the requirement that applies: maintenance while the stock's session is open, the off-hours
// requirement (2x initial margin, at most 100 %) while the price is held. Levels by the ratio's multiple of that
// requirement: watch below 2x, danger below 1.5x, imminent below 1.2x (within 20 % of liquidation), liquidatable below
// 1x. "If the session closes now" reads the same ratio against the off-hours requirement. The order panel warns before
// a trade that would leave the position within 20 % of either requirement; an opt-in browser notification (only while
// the page is open) follows a level that gets worse. Fail safe (review M4): a ratio that cannot be read is "unknown",
// never "comfortable", and with no price (session state unknown) the stricter of the two requirements applies.
import type { TradeMarket, TradePositionOut, TradeQuoteOut } from "../../lib/api-types";
import type { Tone } from "../../lib/limits";

export type RiskLevel = "unknown" | "ok" | "watch" | "danger" | "imminent" | "liquidatable";

/** Upper bounds (multiples of the requirement) of each level; at or above WATCH the position is "ok". */
export const RISK_BANDS = { watch: 2, danger: 1.5, imminent: 1.2, liquidatable: 1 } as const;
/** The order panel warns when the resulting position sits within this multiple of a requirement (20 % above it). */
export const PRE_TRADE_BAND = RISK_BANDS.imminent;

const RANK: Record<RiskLevel, number> = { unknown: 0, ok: 0, watch: 1, danger: 2, imminent: 3, liquidatable: 4 };
export const riskRank = (l: RiskLevel) => RANK[l];

/** Level of an open position's margin ratio (bps) against a requirement (bps); "unknown" when either cannot be read. */
export function riskLevel(ratioBps: number | null | undefined, requirementBps: number): RiskLevel {
  if (ratioBps == null || !Number.isFinite(ratioBps) || !(requirementBps > 0)) return "unknown";
  const x = ratioBps / requirementBps;
  if (x < RISK_BANDS.liquidatable) return "liquidatable";
  if (x < RISK_BANDS.imminent) return "imminent";
  if (x < RISK_BANDS.danger) return "danger";
  if (x < RISK_BANDS.watch) return "watch";
  return "ok";
}

export const RISK_META: Record<RiskLevel, { label: string; tone: Tone; callout: "info" | "warn" | "risk" }> = {
  unknown: { label: "Risk unknown", tone: "warn", callout: "warn" },
  ok: { label: "Margin comfortable", tone: "good", callout: "info" },
  watch: { label: "Watch", tone: "warn", callout: "warn" },
  danger: { label: "Danger", tone: "critical", callout: "risk" },
  imminent: { label: "Liquidation close", tone: "critical", callout: "risk" },
  liquidatable: { label: "Liquidatable", tone: "critical", callout: "risk" },
};

/** Price move (fraction of the mark) that reaches a liquidation price; null when there is none on price. */
export function moveToLiquidation(mark: string | null | undefined, liq: string | null | undefined): number | null {
  if (liq === "any") return 0;
  const m = Number(mark);
  const l = Number(liq);
  if (!mark || !liq || !Number.isFinite(m) || !Number.isFinite(l) || m <= 0) return null;
  return Math.abs(m - l) / m;
}

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 1 : 0)}%`;
const movePct = (f: number) => `${(f * 100).toFixed(f < 0.1 ? 1 : 0)}%`;

export interface PositionRisk {
  /** the stock's session is closed: the off-hours requirement applies now */
  held: boolean;
  /** no price: the session state is unknown, so the stricter requirement (the off-hours one) is applied */
  sessionUnknown: boolean;
  requirementBps: number;
  level: RiskLevel;
  /** the level against the off-hours requirement while the session is open (null while held: it is `level`) */
  ifClose: RiskLevel | null;
  /** price move that reaches liquidation now, and at a session close */
  moveNow: number | null;
  moveIfClose: number | null;
}

type MarketRisk = Pick<TradeMarket, "margin"> & { price: Pick<NonNullable<TradeMarket["price"]>, "held"> | null };
type PositionIn = Pick<TradePositionOut, "side" | "marginRatioBps" | "markPrice" | "liquidationPrice" | "liquidationPriceOffHours">;

export function positionRisk(p: PositionIn, m: MarketRisk): PositionRisk | null {
  if (p.side === "flat") return null;
  const sessionUnknown = !m.price;
  const held = m.price?.held === true;
  const mm = m.margin.maintenanceMarginBps;
  const oh = m.margin.offHoursMarginBps;
  // held, or unknown: the stricter requirement
  const strict = held || sessionUnknown;
  const requirementBps = strict ? Math.max(mm, oh) : mm;
  return {
    held,
    sessionUnknown,
    requirementBps,
    level: riskLevel(p.marginRatioBps, requirementBps),
    ifClose: strict ? null : riskLevel(p.marginRatioBps, oh),
    moveNow: moveToLiquidation(p.markPrice, strict ? p.liquidationPriceOffHours : p.liquidationPrice),
    moveIfClose: strict ? null : moveToLiquidation(p.markPrice, p.liquidationPriceOffHours),
  };
}

/** The warning of a level (null when "ok"); `ratioBps` and the requirement in plain numbers. `held`: the off-hours requirement applies. */
export function riskText(level: RiskLevel, ratioBps: number | null, requirementBps: number, move: number | null, held: boolean): { title: string; body: string } | null {
  if (level === "ok") return null;
  if (level === "unknown")
    return {
      title: "Liquidation risk cannot be read right now",
      body: `The margin ratio or the price is not available. Until it is, assume the stricter requirement applies (${pct(requirementBps)} of notional, the off-hours one) and keep margin above it.`,
    };
  const req = held ? `the off-hours requirement (${pct(requirementBps)} of notional while the session is closed)` : `the maintenance margin (${pct(requirementBps)} of notional)`;
  const ratio = ratioBps === null ? "—" : pct(ratioBps);
  const away = move === null ? "" : move === 0 ? " Every price liquidates it." : ` A move of about ${movePct(move)} against you reaches liquidation.`;
  switch (level) {
    case "liquidatable":
      return { title: "Below the requirement: liquidatable now", body: `The margin ratio (${ratio}) is below ${req}. Anyone may close the whole position at the oracle price, with a liquidation fee out of your margin. Add margin${held ? "" : " or reduce"} now.` };
    case "imminent":
      return { title: "Liquidation is close", body: `The margin ratio (${ratio}) is within 20% of ${req}.${away} Add margin${held ? "" : " or reduce"} to stay open.` };
    case "danger":
      return { title: "Danger: little room left", body: `The margin ratio (${ratio}) is under 1.5x ${req}.${away}` };
    case "watch":
      return { title: "Watch this position", body: `The margin ratio (${ratio}) is under 2x ${req}.${away}` };
  }
}

/** "If the session closes now": the off-hours level of a position while the session is open (null when nothing to say). */
export function ifCloseText(r: PositionRisk, offHoursBps: number): { title: string; body: string } | null {
  if (r.held || r.sessionUnknown || r.ifClose === null || riskRank(r.ifClose) < riskRank("danger")) return null;
  const move = r.moveIfClose === null ? "" : r.moveIfClose === 0 ? "" : ` (about ${movePct(r.moveIfClose)} from the price now)`;
  if (r.ifClose === "liquidatable")
    return {
      title: "If the session closes now, this position is liquidated",
      body: `While the stock's session is closed the requirement rises to ${pct(offHoursBps)} of notional (2x initial margin), above this position's margin ratio: it would be liquidated at the closing price${move}. Add margin or reduce before the close; no trade fills while it is closed.`,
    };
  return {
    title: "If the session closes now, liquidation is close",
    body: `While the stock's session is closed the requirement rises to ${pct(offHoursBps)} of notional (2x initial margin); this position would sit ${r.ifClose === "imminent" ? "within 20%" : "under 1.5x"} of it${move}. Top-ups work off-hours, trades do not.`,
  };
}

/**
 * Pre-trade warnings of the order panel: the resulting position within 20 % of the maintenance margin, or (while the
 * session is open) within 20 % of the off-hours requirement. A position already below the off-hours requirement is
 * warned (or refused) by the API's own "cannot be held through a session close" message, so it is not repeated here.
 */
export function preTradeRisk(after: Pick<TradeQuoteOut["after"], "side" | "marginRatioBps">, m: MarketRisk): Array<{ title: string; body: string }> {
  if (after.side === "flat" || after.marginRatioBps === null) return [];
  const r = after.marginRatioBps;
  const mm = m.margin.maintenanceMarginBps;
  const oh = m.margin.offHoursMarginBps;
  const out: Array<{ title: string; body: string }> = [];
  if (r / mm < PRE_TRADE_BAND)
    out.push({
      title: "This order leaves the position close to liquidation",
      body: `Its margin ratio after the trade (${pct(r)}) is within 20% of the maintenance margin (${pct(mm)}): a small move against you liquidates it. Trade a smaller size or add margin first.`,
    });
  const off = r / oh;
  if (m.price?.held !== true && off >= RISK_BANDS.liquidatable && off < PRE_TRADE_BAND)
    out.push({
      title: "Close to liquidation if the session closes",
      body: `After the trade its margin ratio (${pct(r)}) is within 20% of the off-hours requirement (${pct(oh)}, 2x initial margin), which applies while the stock's session is closed. Leave room before the close.`,
    });
  return out;
}

/**
 * The browser notification for a change of level (null: nothing to send). Only a level that gets worse and reaches
 * danger or beyond is sent, never the first reading (the page shows it already) and never an improvement.
 */
export function riskNotice(prev: { level: RiskLevel; ifClose: RiskLevel | null } | null, next: PositionRisk, label: string): { title: string; body: string } | null {
  if (!prev) return null;
  const worse = (a: RiskLevel | null, b: RiskLevel | null) => a !== null && b !== null && b !== "unknown" && riskRank(b) > riskRank(a) && riskRank(b) >= riskRank("danger");
  if (worse(prev.level, next.level)) {
    const t = next.level === "liquidatable" ? "liquidatable now" : next.level === "imminent" ? "close to liquidation" : "in danger";
    return { title: `${label}: your position is ${t}`, body: next.moveNow === null ? "Open the trading page to add margin or reduce." : `About ${movePct(next.moveNow)} from liquidation. Open the trading page to add margin or reduce.` };
  }
  if (worse(prev.ifClose, next.ifClose))
    return { title: `${label}: at risk if the session closes`, body: "At the off-hours requirement this position would be close to liquidation or below it. Add margin or reduce before the close." };
  return null;
}
