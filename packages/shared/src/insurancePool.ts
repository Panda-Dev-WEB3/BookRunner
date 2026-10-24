// Insurance pool (2026-10, docs/ARCHITECTURE.md §2.10): charter rules and protocol defaults shared by the charter
// service, the api and the web forms. Mirrors MarketCharter's CharterRules.poolReason and InsurancePool's bounds.

import { poolCapitalOk } from "./waterfall";

/** New charters default to a pool-funded IF (owner-approved design 2026-10-20). */
export const DEFAULT_IF_FROM_POOL = true;
/** InsurancePool.MAX_PREMIUM_BPS == CharterRules.MAX_PREMIUM_BPS: a charter's premium is at most 50% of gross fee flow. */
export const MAX_PREMIUM_BPS = 5000;
/** The pool's premium floor at deployment (InsurancePool.premiumFloorBps(), timelocked, <= MAX_PREMIUM_BPS). */
export const DEFAULT_PREMIUM_FLOOR_BPS = 1200;

/**
 * The pool's minimum own capital of a pool-funded book at deployment (InsurancePool.minOwnCapitalBps(), timelocked,
 * <= 20000; pool audit 2026-10-23 B-M2): the tranches must raise at least half of the IF the pool lends.
 */
export const DEFAULT_MIN_OWN_CAPITAL_BPS = 5000;

export type PoolCharterReason = "BAD_PREMIUM" | "BAD_FALLBACK" | "NO_POOL" | "UNDERCAPITALISED";

/** New charters do not opt in to the tranche-funded fallback (fix round 2, V-3): a pool that cannot fund cancels the book. */
export const DEFAULT_IF_POOL_FALLBACK = false;

/** A Charter as the contract's struct argument: ifPoolFallback (optional in TS, absent in charters stored before) defaults off. */
export function charterArg<C extends { ifPoolFallback?: boolean }>(c: C): C & { ifPoolFallback: boolean } {
  return { ...c, ifPoolFallback: c.ifPoolFallback ?? DEFAULT_IF_POOL_FALLBACK };
}

/**
 * CharterRules.poolReason + the B-M2 rule (MarketCharter.validate, checked after BAD_FEES): a pool-funded IF needs a
 * configured pool, premiumBps <= MAX_PREMIUM_BPS (0 = the pool's floor) and an MM inventory (the planned tranche
 * raise) of at least `minOwnCapitalBps` of the IF (UNDERCAPITALISED; Book.closeWindow checks the actual raise the same
 * way); a book-funded IF pays no premium and cannot opt in to the pool fallback (BAD_FALLBACK, fix round 2 V-3). The
 * capital rule is checked when the amounts are given.
 */
export function poolCharterReason(
  c: { ifFromPool: boolean; premiumBps: number; ifPoolFallback?: boolean; ifTargetUsd?: bigint; mmInventoryUsd?: bigint },
  poolConfigured: boolean,
  minOwnCapitalBps: number = DEFAULT_MIN_OWN_CAPITAL_BPS,
): PoolCharterReason | null {
  if (!c.ifFromPool) {
    if (c.premiumBps !== 0) return "BAD_PREMIUM";
    return c.ifPoolFallback ? "BAD_FALLBACK" : null;
  }
  if (c.premiumBps > MAX_PREMIUM_BPS) return "BAD_PREMIUM";
  if (!poolConfigured) return "NO_POOL";
  if (c.ifTargetUsd !== undefined && c.mmInventoryUsd !== undefined && !poolCapitalOk(c.mmInventoryUsd, c.ifTargetUsd, BigInt(minOwnCapitalBps))) {
    return "UNDERCAPITALISED";
  }
  return null;
}
