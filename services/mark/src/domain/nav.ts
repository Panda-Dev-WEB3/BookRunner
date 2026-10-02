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

export function composeNav(s: Pick<MarkSnapshot, "vaultIdle" | "unfundedClaims" | "venue" | "desk">): NavComposition {
  const desk = deskValueUsd(s.desk);
  const deployedValueUsd = s.venue.deployedValueUsd + desk;
  return {
    deskValueUsd: desk,
    deskHedgeValueUsd: deskHedgeValueUsd(s.desk),
    deployedValueUsd,
    navUsd: markedNav(s.vaultIdle, s.unfundedClaims, deployedValueUsd),
  };
}

/** Cross-checks that should hold if the contracts follow the interface docs (non-fatal, logged). */
export function navCrossChecks(s: MarkSnapshot, nav: NavComposition): string[] {
  const out: string[] = [];
  const expectedAdapter = s.venue.insuranceUsd + (s.venue.marginUsd > 0n ? s.venue.marginUsd : 0n) + s.venue.inTransitUsd;
  if (s.venue.poolEquityUsd === null && expectedAdapter !== s.venue.deployedValueUsd) {
    out.push(`adapter.deployedValueUsd ${s.venue.deployedValueUsd} != insurance + max(margin,0) + inTransit ${expectedAdapter}`);
  }
  if (s.desk.onchainValueUsd !== null && s.desk.onchainValueUsd !== nav.deskValueUsd) {
    out.push(`desk.valueUsd() ${s.desk.onchainValueUsd} != USDC + registry valuation ${nav.deskValueUsd}`);
  }
  if (s.vaultIdleView !== null && s.vaultIdleView !== s.vaultIdle) {
    out.push(`vault.idle() ${s.vaultIdleView} != USDC.balanceOf(vault) ${s.vaultIdle}`);
  }
  return out;
}
