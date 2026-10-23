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

export type PoolCharterReason = "BAD_PREMIUM" | "NO_POOL" | "UNDERCAPITALISED";

/**
 * CharterRules.poolReason + the B-M2 rule (MarketCharter.validate, checked after BAD_FEES): a pool-funded IF needs a
 * configured pool, premiumBps <= MAX_PREMIUM_BPS (0 = the pool's floor) and an MM inventory (the planned tranche
 * raise) of at least `minOwnCapitalBps` of the IF (UNDERCAPITALISED; Book.closeWindow checks the actual raise the same
 * way); a book-funded IF pays no premium. The capital rule is checked when the amounts are given.
 */
export function poolCharterReason(
  c: { ifFromPool: boolean; premiumBps: number; ifTargetUsd?: bigint; mmInventoryUsd?: bigint },
  poolConfigured: boolean,
  minOwnCapitalBps: number = DEFAULT_MIN_OWN_CAPITAL_BPS,
): PoolCharterReason | null {
  if (!c.ifFromPool) return c.premiumBps === 0 ? null : "BAD_PREMIUM";
  if (c.premiumBps > MAX_PREMIUM_BPS) return "BAD_PREMIUM";
  if (!poolConfigured) return "NO_POOL";
  if (c.ifTargetUsd !== undefined && c.mmInventoryUsd !== undefined && !poolCapitalOk(c.mmInventoryUsd, c.ifTargetUsd, BigInt(minOwnCapitalBps))) {
    return "UNDERCAPITALISED";
  }
  return null;
}
