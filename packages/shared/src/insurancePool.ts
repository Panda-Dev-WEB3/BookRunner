// Insurance pool (2026-10, docs/ARCHITECTURE.md §2.10): charter rules and protocol defaults shared by the charter
// service, the api and the web forms. Mirrors MarketCharter's CharterRules.poolReason and InsurancePool's bounds.

/** New charters default to a pool-funded IF (owner-approved design 2026-10-20). */
export const DEFAULT_IF_FROM_POOL = true;
/** InsurancePool.MAX_PREMIUM_BPS == CharterRules.MAX_PREMIUM_BPS: a charter's premium is at most 50% of gross fee flow. */
export const MAX_PREMIUM_BPS = 5000;
/** The pool's premium floor at deployment (InsurancePool.premiumFloorBps(), timelocked, <= MAX_PREMIUM_BPS). */
export const DEFAULT_PREMIUM_FLOOR_BPS = 1200;

export type PoolCharterReason = "BAD_PREMIUM" | "NO_POOL";

/**
 * CharterRules.poolReason (MarketCharter.validate, checked after BAD_FEES): a pool-funded IF needs a configured pool
 * and premiumBps <= MAX_PREMIUM_BPS (0 = the pool's floor); a book-funded IF pays no premium.
 */
export function poolCharterReason(c: { ifFromPool: boolean; premiumBps: number }, poolConfigured: boolean): PoolCharterReason | null {
  if (!c.ifFromPool) return c.premiumBps === 0 ? null : "BAD_PREMIUM";
  if (c.premiumBps > MAX_PREMIUM_BPS) return "BAD_PREMIUM";
  if (!poolConfigured) return "NO_POOL";
  return null;
}
