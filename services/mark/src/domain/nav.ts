// NAV composition (pure).
//   desk value       = desk USDC + sum(registry.valueUsd(token, qty))   (multiplier applied once, by the registry)
//   deployedValueUsd = adapter.deployedValueUsd (IF + max(MM, 0) + in-transit) + desk value
//   navUsd           = markedNav(vaultIdle, unfundedClaims, deployedValueUsd)  (shared waterfall.ts, as on-chain)
import { markedNav } from "@bookrunner/shared";
import type { MarkSnapshot } from "./types";

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
