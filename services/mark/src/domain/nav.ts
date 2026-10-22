// NAV composition (pure).
//   desk value       = desk USDC + sum(registry.valueUsd(token, qty))   (multiplier applied once, by the registry)
//   deployedValueUsd = adapter.deployedValueUsd (IF + max(MM, 0) + in-transit) + desk value
//   navUsd           = markedNav(vaultIdle, unfundedClaims, deployedValueUsd)  (shared waterfall.ts, as on-chain)
//
// Retiring dust rule [ext]: Book.finalizeRetirement needs a final mark with deployedValueUsd == 0
// exactly. The wind-down recalls every venue unit (keeper) and returns every desk USDC unit and
// flattens every token position worth >= 0.001 USD (agent). A token position worth less than that
// cannot be sold within the desk's maxSlippageBps (the swap output rounds below the bound), so for
// a Retiring book such positions are valued at 0 here (written off; at most 0.001 USD per held
// token, which stays on the desk). Never applied to venue capital, desk USDC, or a Live book.
import { markedNav } from "@bookrunner/shared";
import type { DeskPosition, MarkSnapshot } from "./types";

/** Default per-position dust bound (USD 6dp): the agent's Retiring flatten floor (RETIRE_FLATTEN_MIN_USD). */
export const RETIRE_TOKEN_DUST_USD = 1_000n;

/** Retiring books: desk token positions worth less than `dustUsd` valued at 0 (see header). */
export function writeOffRetiringDust<S extends Pick<MarkSnapshot, "book" | "desk">>(s: S, dustUsd: bigint): { snapshot: S; writtenOff: DeskPosition[] } {
  if (s.book.state !== "Retiring" || dustUsd <= 0n) return { snapshot: s, writtenOff: [] };
  const writtenOff = s.desk.positions.filter((p) => p.valueUsd > 0n && p.valueUsd < dustUsd);
  if (writtenOff.length === 0) return { snapshot: s, writtenOff };
  const positions = s.desk.positions.map((p) => (p.valueUsd > 0n && p.valueUsd < dustUsd ? { ...p, valueUsd: 0n } : p));
  return { snapshot: { ...s, desk: { ...s.desk, positions } }, writtenOff };
}

export function deskHedgeValueUsd(desk: MarkSnapshot["desk"]): bigint {
  return desk.positions.reduce((s, p) => s + p.valueUsd, 0n);
}

export function deskValueUsd(desk: MarkSnapshot["desk"]): bigint {
  return desk.usdc + deskHedgeValueUsd(desk);
}

export interface NavComposition {
  deskValueUsd: bigint;
  deskHedgeValueUsd: bigint;
  deployedValueUsd: bigint;
  navUsd: bigint;
}

/**
 * The insurance pool's claim netted from NAV beyond unfundedClaims (2026-10, Book.navLiabilities): the pool's claim at
 * the book's last mark (the debt capped by the book's own capital, Backstop money excluded; below the debt only while the
 * book is exhausted, a provisional shortfall) while it is not due yet; once due, Book.liabilities() -> unfundedClaims
 * carries it already. Informational: the book re-values the claim at the mark's own snapshot.
 */
export function poolDebtNetted(s: Pick<MarkSnapshot, "insuranceDebt">): bigint {
  const d = s.insuranceDebt;
  return d && !d.due ? d.claim : 0n;
}

/**
 * The IF equity the mark signs (MarkInput.insuranceEquityUsd, 2026-10): the venue IF figure of the SAME snapshot whose
 * deployedValueUsd the mark carries (after the signed venue report overlay), so the book can keep Backstop cover off
 * the insurance debt (Waterfall.poolCoverNav: IF draw = the pool's claim - this).
 *
 * Pool follow-up m-6: plus the IF in transit (`insuranceInTransitUsd`, the IF part of inTransitUsd, which
 * deployedValueUsd already counts), so an IF recall in flight is not read as an IF draw. An IF deposit in flight needs
 * nothing: the adapter counts it as insurance at once and no venue report from before it can value the snapshot
 * (domain/venue.ts reportConsistent).
 *
 * A negative venue IF figure signs as 0 (kept, review m-6): the field is a uint256 (so are the adapter's insuranceUsd
 * and the signed VenueReport's), and 0 is the right reading for the cover cap: the draw is then the whole claim, which
 * keeps all of the insurance debt off the Backstop, while a deficit beyond the IF (the part of `insuranceUsd` below 0,
 * already netted from deployedValueUsd) is a book loss OTHER than the debt (the pool funded only the allocation), which
 * N-1 lets the Backstop cover like an MM loss. Keeping the sign would add that deficit to the draw and refuse it cover.
 */
export function markInsuranceEquityUsd(s: Pick<MarkSnapshot, "venue">): bigint {
  const venueIf = s.venue.insuranceUsd > 0n ? s.venue.insuranceUsd : 0n;
  return venueIf + (s.venue.insuranceInTransitUsd ?? 0n);
}

export function composeNav(s: Pick<MarkSnapshot, "vaultIdle" | "unfundedClaims" | "venue" | "desk" | "insuranceDebt">): NavComposition {
  const desk = deskValueUsd(s.desk);
  const deployedValueUsd = s.venue.deployedValueUsd + desk;
  return {
    deskValueUsd: desk,
    deskHedgeValueUsd: deskHedgeValueUsd(s.desk),
    deployedValueUsd,
    // informational (the book computes its own): a pool-funded book's NAV is net of the pool's debt
    navUsd: markedNav(s.vaultIdle, s.unfundedClaims + poolDebtNetted(s), deployedValueUsd),
  };
}

/** Cross-checks that should hold if the contracts follow the interface docs (non-fatal, logged). */
export function navCrossChecks(s: MarkSnapshot, nav: NavComposition): string[] {
  const out: string[] = [];
  const expectedAdapter = s.venue.insuranceUsd + (s.venue.marginUsd > 0n ? s.venue.marginUsd : 0n) + s.venue.inTransitUsd;
  if (s.venue.poolEquityUsd === null && expectedAdapter !== s.venue.deployedValueUsd) {
    out.push(`adapter.deployedValueUsd ${s.venue.deployedValueUsd} != insurance + max(margin,0) + inTransit ${expectedAdapter}`);
  }
  if ((s.venue.insuranceInTransitUsd ?? 0n) > s.venue.inTransitUsd) {
    out.push(`adapter.insuranceInTransitUsd ${s.venue.insuranceInTransitUsd} > inTransitUsd ${s.venue.inTransitUsd}`);
  }
  if (s.desk.onchainValueUsd !== null && s.desk.onchainValueUsd !== nav.deskValueUsd) {
    out.push(`desk.valueUsd() ${s.desk.onchainValueUsd} != USDC + registry valuation ${nav.deskValueUsd}`);
  }
  if (s.vaultIdleView !== null && s.vaultIdleView !== s.vaultIdle) {
    out.push(`vault.idle() ${s.vaultIdleView} != USDC.balanceOf(vault) ${s.vaultIdle}`);
  }
  return out;
}
