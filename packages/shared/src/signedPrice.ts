// The freshest signed oracle print of one underlying (pull oracle, docs/LOW_GAS.md §1), re-encoded alone as the
// `priceData` a transaction carries: from the oracle service's bundle (KEYS.oracleBundle) or its per-key messages
// (KEYS.oracleLast, heartbeat mode). A bundle signed for another chain or oracle is ignored (its signatures would not
// verify on this deployment's AttestedOracle). Shared by the API (trading page) and the waterfall liquidation keeper.
import { type Address, type Hex, isAddress, isHex } from "viem";
import { type PriceUpdate, decodePriceData, encodePriceData, priceUpdateFromMsg } from "./eip712";
import type { OraclePriceMsg } from "./queues";

export interface SignedPrice {
  update: PriceUpdate;
  signature: Hex;
  /** abi.encode([update], [signature]) */
  priceData: Hex;
}

export function signedPriceFor(rawBundle: unknown, messages: unknown[], underlying: Hex, domain: { chainId: number; oracle: Address }): SignedPrice | null {
  const want = underlying.toLowerCase();
  const found: Array<{ update: PriceUpdate; signature: Hex }> = [];
  const b = rawBundle && typeof rawBundle === "object" ? (rawBundle as Record<string, unknown>) : null;
  const sameDomain =
    b !== null &&
    (b.chainId === undefined || b.chainId === domain.chainId) &&
    (b.oracle === undefined || (typeof b.oracle === "string" && isAddress(b.oracle, { strict: false }) && b.oracle.toLowerCase() === domain.oracle.toLowerCase()));
  if (b && sameDomain && typeof b.priceData === "string" && isHex(b.priceData) && b.priceData !== "0x") {
    try {
      const { updates, sigs } = decodePriceData(b.priceData);
      updates.forEach((u, i) => {
        if (u.underlying.toLowerCase() === want && sigs[i]) found.push({ update: u, signature: sigs[i] });
      });
    } catch {
      /* malformed bundle: the per-key messages */
    }
  }
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const o = m as Partial<OraclePriceMsg>;
    if (typeof o.underlying !== "string" || o.underlying.toLowerCase() !== want || typeof o.signature !== "string" || !isHex(o.signature)) continue;
    try {
      found.push({ update: priceUpdateFromMsg(o as OraclePriceMsg), signature: o.signature });
    } catch {
      /* malformed message */
    }
  }
  const best = found.filter((f) => f.update.priceWad > 0n).sort((a, b2) => (a.update.publishedAt > b2.update.publishedAt ? -1 : a.update.publishedAt < b2.update.publishedAt ? 1 : 0))[0];
  return best ? { ...best, priceData: encodePriceData([best.update], [best.signature]) } : null;
}
