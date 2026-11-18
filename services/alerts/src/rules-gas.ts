// Alert rules for the GasTank (2026-11; contracts/src/GasTank.sol, topped up by services/waterfall gasTankKeeper.ts).
// Pure Snapshot -> Conditions, registered in rules.ts RULES. Snapshot.gasTank null (no tank in the deployment) or
// undefined (a read failed: the rpc rule covers RPC trouble) -> every rule here is quiet.
//
// - gas_tank_low — the tank holds less than ALERT_GAS_TANK_MIN_ETH (0.05): WARNING; CRITICAL below a quarter of it or
//   when empty. The treasury must send ETH (docs/RUNBOOK.md "Gas tank"): once the tank is empty a wallet below its
//   floor is no longer topped up and its service stops signing / sending.
// - gas_tank_cap_hit:<wallet|global> — a wallet is below its floor but the tank cannot pay it because its own daily
//   cap (topUpQuote reason 3) or the global daily cap (reason 4) is used up: WARNING, CRITICAL once the wallet holds
//   less than a quarter of its floor. The cap resets at 00:00 UTC; a wallet that burns through its cap every day
//   needs a higher cap or a look at why it spends so much (the timelock raises it: GasTank.setService / setGlobalDailyCap).
// - gas_tank_paused — the tank is paused (the GUARDIAN or the timelock paused it; only the timelock lifts it): WARNING,
//   CRITICAL while a wallet is below its floor.
import { formatEther } from "viem";
import type { RuleConfig } from "./config";
import type { Condition, Snapshot } from "./types";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const label = (s: { address: string; role: string | null }) => (s.role ? `${s.role} ${short(s.address)}` : short(s.address));

export function gasTankLow(s: Snapshot, c: RuleConfig): Condition[] {
  const t = s.gasTank;
  if (!t || c.gasTankMinWei <= 0n || t.balanceWei >= c.gasTankMinWei) return [];
  return [
    {
      key: "gas_tank_low",
      rule: "gas_tank_low",
      severity: t.balanceWei === 0n || t.balanceWei < c.gasTankMinWei / 4n ? "critical" : "warning",
      summary: `gas tank ${short(t.address)} holds ${formatEther(t.balanceWei)} ETH (min ${formatEther(c.gasTankMinWei)}): the treasury must send ETH, wallets below their floor are no longer topped up once it is empty`,
    },
  ];
}

export function gasTankCapHit(s: Snapshot, _c: RuleConfig): Condition[] {
  const t = s.gasTank;
  if (!t) return [];
  const out: Condition[] = [];
  for (const w of t.services) {
    if (w.reason !== 3 && w.reason !== 4) continue;
    const global = w.reason === 4;
    out.push({
      key: `gas_tank_cap_hit:${w.address}`,
      rule: "gas_tank_cap_hit",
      severity: w.balanceWei < w.floorWei / 4n ? "critical" : "warning",
      summary: `${label(w)} has ${formatEther(w.balanceWei)} ETH (floor ${formatEther(w.floorWei)}) but the gas tank's ${global ? `global daily cap (${formatEther(t.globalSentTodayWei)} of ${formatEther(t.globalDailyCapWei)} ETH sent today)` : `daily cap for it (${formatEther(w.sentTodayWei)} of ${formatEther(w.dailyCapWei)} ETH sent today)`} is used up: no top-up until 00:00 UTC unless the timelock raises the cap`,
    });
  }
  return out;
}

export function gasTankPaused(s: Snapshot, _c: RuleConfig): Condition[] {
  const t = s.gasTank;
  if (!t || !t.paused) return [];
  const needy = t.services.filter((w) => w.balanceWei < w.floorWei);
  return [
    {
      key: "gas_tank_paused",
      rule: "gas_tank_paused",
      severity: needy.length > 0 ? "critical" : "warning",
      summary: `gas tank ${short(t.address)} is paused${needy.length > 0 ? `; below their floor: ${needy.map(label).join(", ")}` : ""} (only the timelock lifts the pause)`,
    },
  ];
}

export const GAS_TANK_RULES = {
  gas_tank_low: gasTankLow,
  gas_tank_cap_hit: gasTankCapHit,
  gas_tank_paused: gasTankPaused,
} as const;
