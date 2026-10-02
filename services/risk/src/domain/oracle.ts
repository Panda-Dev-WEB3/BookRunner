// Oracle readings and the off-hours flag. Pure.
//   off-hours = feed `held` (session closed) OR stale (older than config.maxPriceAge) — the same
//   condition MMMandate.offHours() / PoolEngine use on-chain.
import { type OraclePriceMsg, parseFixed } from "@bookrunner/shared";
import type { OracleReading } from "../types";

export const NO_ORACLE: OracleReading = { priceWad: 0n, publishedAt: 0, held: false, stale: true, source: "none" };

export function oracleFromChain(
  latest: { priceWad: bigint; publishedAt: bigint | number; held: boolean },
  isStale: boolean,
): OracleReading {
  const publishedAt = Number(latest.publishedAt);
  // a never-pushed feed (publishedAt == 0) is stale regardless of what isStale() reports
  return { priceWad: latest.priceWad, publishedAt, held: latest.held, stale: isStale || publishedAt === 0, source: "chain" };
}

/**
 * The oracle service's signed print (pull oracle, docs/LOW_GAS.md §1), used when it is newer than the stored
 * on-chain price: staleness is judged off-chain against the wall clock, never from an on-chain view (a quiet
 * market's stored price is old by design in pull mode).
 */
export function oracleFromSigned(p: { priceWad: bigint; publishedAt: bigint; held: boolean }, nowSec: number, maxPriceAgeSec: number): OracleReading {
  const publishedAt = Number(p.publishedAt);
  return { priceWad: p.priceWad, publishedAt, held: p.held, stale: publishedAt === 0 || nowSec - publishedAt > maxPriceAgeSec, source: "signed" };
}

/** Fallback from KEYS.oracleLast(priceId) when the on-chain read fails. */
export function oracleFromRedis(msg: OraclePriceMsg | null, nowSec: number, maxPriceAgeSec: number): OracleReading {
  if (!msg || !msg.publishedAt) return NO_ORACLE;
  let priceWad = 0n;
  try {
    priceWad = msg.priceWad ? BigInt(msg.priceWad) : parseFixed(String(msg.price), 18);
  } catch {
    priceWad = 0n;
  }
  return {
    priceWad,
    publishedAt: msg.publishedAt,
    held: !!msg.held,
    stale: nowSec - msg.publishedAt > maxPriceAgeSec,
    source: "redis",
  };
}

export function isOffHours(o: OracleReading): boolean {
  return o.held || o.stale;
}

export function oraclePrice(o: OracleReading): number | null {
  return o.priceWad > 0n ? Number(o.priceWad) / 1e18 : null;
}
