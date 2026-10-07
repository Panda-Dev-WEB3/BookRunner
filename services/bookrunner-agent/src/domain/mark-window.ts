// Mark-window gate for desk capital flows (BookrunnerDesk A3-02 / A7-01). InventoryToVenue, InventoryToVault,
// FundDesk and ReturnToVault bump the book's flowNonce, which voids a mark signed against the previous nonce,
// so the desk refuses them from a key (MarkPending) while a mark is pending: the book is Live / Retiring and
// its latest ended mark period (block.timestamp rounded down to markInterval) has no applied mark. Before the
// first mark the reference is the book's subscriptionEnds. The agent mirrors the rule: capital legs are
// skipped while the gate is closed (or would close before the tx lands) and retried on a later cycle.
import type { BookState } from "@bookrunner/shared";
import type { HedgeLeg, HedgePlan } from "./hedge-planner";

export interface MarkWindowState {
  state: BookState;
  /** book.lastMarkPeriodEnd() (0 = no mark applied yet). */
  lastMarkPeriodEnd: number;
  /** book.subscriptionEnds(). */
  subscriptionEnds: number;
  /** config.markInterval() (seconds). */
  markInterval: number;
}

/** Seconds of headroom: a tx sent now may land up to this long after the read. */
export const MARK_WINDOW_GUARD_SEC = 30;

/**
 * BookrunnerDesk.capitalFlowOpen() evaluated at `nowSec + guardSec` (the gate only closes as time passes
 * within a period's mark cycle, so open at the later instant implies open now).
 */
export function capitalFlowOpen(s: MarkWindowState, nowSec: number, guardSec = MARK_WINDOW_GUARD_SEC): boolean {
  if (s.state !== "Live" && s.state !== "Retiring") return true;
  if (s.markInterval <= 0) return true;
  const t = nowSec + Math.max(0, guardSec);
  const periodStart = t - (t % s.markInterval);
  const ref = s.lastMarkPeriodEnd === 0 ? s.subscriptionEnds : s.lastMarkPeriodEnd;
  return ref >= periodStart;
}

const CAPITAL_LEGS = new Set<HedgeLeg["kind"]>(["recall_mm", "fund_desk", "return_to_vault"]);

export const isCapitalLeg = (l: HedgeLeg): boolean => CAPITAL_LEGS.has(l.kind);

/**
 * The plan with its capital-flow legs removed while a mark is pending. Buys funded by a removed recall /
 * FundDesk leg are removed too (the desk would lack the USDC). A plan left without legs becomes
 * `none` / MARK_PENDING; the next cycle re-plans from chain state once the mark has landed.
 */
export function gateCapitalLegs(plan: HedgePlan, open: boolean): { plan: HedgePlan; skipped: HedgeLeg["kind"][] } {
  if (open || !plan.legs.some(isCapitalLeg)) return { plan, skipped: [] };
  const funded = plan.legs.some((l) => l.kind === "recall_mm" || l.kind === "fund_desk");
  const keep = plan.legs.filter((l) => !isCapitalLeg(l) && !(funded && l.kind === "buy"));
  const skipped = plan.legs.filter((l) => !keep.includes(l)).map((l) => l.kind);
  if (keep.length === 0) return { plan: { ...plan, action: "none", reason: "MARK_PENDING", legs: [] }, skipped };
  return { plan: { ...plan, legs: keep }, skipped };
}
