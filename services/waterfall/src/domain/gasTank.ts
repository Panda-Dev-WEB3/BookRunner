// GasTank top-up decision (pure; 2026-11, contracts/src/GasTank.sol). The keeper job reads, for every allow-listed
// service wallet, the tank's own topUpQuote(service) = (amount, reason) and sends topUp(service) only when the tank
// would send something. Everything that decides (floor, target, the daily caps, a pause, the tank's balance) is
// the contract's: this mirrors its reason codes and never second-guesses them.
import type { Address } from "viem";

/** GasTank.topUpQuote reason: 0 sendable, 1 not listed / paused / empty tank, 2 at or above the floor, 3 the wallet's daily cap is used, 4 the global daily cap is used, 5 the wallet was topped up less than the minimum interval ago (nothing to do: it waits). */
export type TopUpReason = 0 | 1 | 2 | 3 | 4 | 5;

export interface TankServiceQuote {
  service: Address;
  /** what topUp(service) would send now (wei); 0 = it would revert */
  amountWei: bigint;
  reason: TopUpReason;
}

export interface TankSnapshot {
  tank: Address;
  paused: boolean;
  /** the tank's ETH balance (wei) */
  balanceWei: bigint;
  services: TankServiceQuote[];
}

export type TankAction =
  | { kind: "topup"; service: Address; amountWei: bigint }
  | { kind: "capped"; service: Address; scope: "service" | "global" }
  | { kind: "blocked"; service: Address; why: "paused" | "empty" | "unlisted" };

/** One action per wallet that is below its floor and needs attention; wallets at or above the floor produce none. */
export function planTankPass(s: TankSnapshot): TankAction[] {
  const out: TankAction[] = [];
  for (const q of s.services) {
    if (q.amountWei > 0n) out.push({ kind: "topup", service: q.service, amountWei: q.amountWei });
    else if (q.reason === 3) out.push({ kind: "capped", service: q.service, scope: "service" });
    else if (q.reason === 4) out.push({ kind: "capped", service: q.service, scope: "global" });
    else if (q.reason === 1) out.push({ kind: "blocked", service: q.service, why: s.paused ? "paused" : s.balanceWei === 0n ? "empty" : "unlisted" });
  }
  return out;
}
