// Alert rules for the BuybackGuard (tech update #9; contracts/src/BuybackGuard.sol, poked by services/waterfall
// ethReferenceKeeper.ts). Pure Snapshot -> Conditions, registered in rules.ts RULES. Snapshot.ethReference null (no guard in
// the deployment) or undefined (a read failed: the rpc rule covers RPC trouble) -> the ETH reference rules are quiet.
//
// - eth_reference_stale — the guard's ETH reference is not the fresh on-chain TWAP for 15 minutes although the TWAP pool is
//   configured: WARNING while the governance fallback covers it (source 2), CRITICAL when nothing is in force (source 0:
//   via-ETH buybacks revert EthReferenceUnavailable and wait; the liquidation keeper keeps its last gas price). Causes: the
//   keeper is not poking (waterfall log "pokeEthReference refused or failed"), the pool is too thin (EthPoolThin), a spot
//   push or a fast move trips the deviation bound (TwapDeviation), or the pool history does not cover the window ("OLD").
// - eth_reference_fallback_expiring — the governance fallback is the reference in force and expires in under 3 days (CRITICAL
//   under 6 hours): renew it through the timelock (BuybackGuard.setEthFallback) or fix the poke.
// - buyback_depth_zero — BuybackGuard.maxBuyback() is 0 (the BKRN pool has no usable liquidity) while buybackPending is above
//   the buyback floor for 15 minutes: WARNING. The router refuses any call, the keeper sends nothing until liquidity returns.
import type { RuleConfig } from "./config";
import type { Condition, Snapshot } from "./types";

const dur = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.floor(s / 3600)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
};
const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const eth = (wad: bigint) => `${(Number(wad / 10n ** 14n) / 1e4).toFixed(2)} USDG/ETH`;

export function ethReferenceStale(s: Snapshot, _c: RuleConfig): Condition[] {
  const r = s.ethReference;
  if (!r || !r.configured || r.source === 1) return [];
  const none = r.source === 0;
  return [
    {
      key: "eth_reference_stale",
      rule: "eth_reference_stale",
      severity: none ? "critical" : "warning",
      forSec: 900,
      summary: none
        ? `the BuybackGuard has no ETH reference (the TWAP value is older than ${dur(r.maxAgeSec)} or never stored, and no unexpired fallback): via-ETH buybacks revert and wait; check the waterfall's pokeEthReference (thin pool, deviation, history) or set a fallback through the timelock`
        : `the BuybackGuard ETH reference is the governance FALLBACK ${eth(r.valueWad)} (the pool TWAP value is ${r.storedAt === 0 ? "never stored" : `${dur(s.now / 1000 - r.storedAt)} old`}, trusted for ${dur(r.maxAgeSec)}): check the waterfall's pokeEthReference`,
    },
  ];
}

export function ethReferenceFallbackExpiring(s: Snapshot, _c: RuleConfig): Condition[] {
  const r = s.ethReference;
  if (!r || r.source !== 2 || r.fallbackExpiry === 0) return [];
  const left = r.fallbackExpiry - s.now / 1000;
  if (left >= 3 * 86_400) return [];
  return [
    {
      key: "eth_reference_fallback_expiring",
      rule: "eth_reference_fallback_expiring",
      severity: left < 6 * 3600 ? "critical" : "warning",
      summary: `the BuybackGuard fallback ETH reference ${eth(r.valueWad)} is the one in force and expires in ${dur(left)}: renew it (BuybackGuard.setEthFallback, timelock) or restore the pool TWAP`,
    },
  ];
}

export function buybackDepthZero(s: Snapshot, c: RuleConfig): Condition[] {
  if (s.buybackDepthCapUsd !== 0) return [];
  const last = s.buybackSamples[s.buybackSamples.length - 1];
  if (!last || last.value < c.buybackMinUsd) return [];
  return [
    {
      key: "buyback_depth_zero",
      rule: "buyback_depth_zero",
      severity: "warning",
      forSec: 900,
      summary: `buybackPending is ${usd(last.value)} but the BuybackGuard depth cap is 0: the BKRN pool has no usable liquidity, so no buyback can be sent (it resumes when liquidity returns)`,
    },
  ];
}

export const BUYBACK_GUARD_RULES = {
  eth_reference_stale: ethReferenceStale,
  eth_reference_fallback_expiring: ethReferenceFallbackExpiring,
  buyback_depth_zero: buybackDepthZero,
} as const;
