// Oracle price stream for the book's price id: Redis CHANNELS.oraclePrice (seeded from
// KEYS.oracleLast), with an AttestedOracle.latest() fallback when Redis goes quiet. Every newer print
// feeds the EWMA volatility estimator.

import type { OraclePriceMsg } from "@bookrunner/shared";
import { type Hex, zeroHash } from "viem";
import type { OraclePoint } from "../chain/book-chain";
import type { EwmaVolatility } from "../domain/volatility";

export function parseOracleMsg(raw: string): OraclePriceMsg | null {
  try {
    const m = JSON.parse(raw) as Partial<OraclePriceMsg>;
    const price = typeof m.price === "number" ? m.price : m.priceWad ? Number(BigInt(m.priceWad)) / 1e18 : NaN;
    if (!(price > 0) || typeof m.publishedAt !== "number" || !Number.isFinite(m.publishedAt)) return null;
    return { ...(m as OraclePriceMsg), price, held: !!m.held };
  } catch {
    return null;
  }
}

export function oracleMsgFromChain(priceId: string, priceIdHex: Hex, p: OraclePoint): OraclePriceMsg | null {
  if (p.priceWad <= 0n || p.publishedAt <= 0) return null;
  return {
    priceId,
    underlying: priceIdHex,
    priceWad: p.priceWad.toString(),
    price: Number(p.priceWad) / 1e18,
    publishedAt: p.publishedAt,
    held: p.held,
    sourceCount: p.sourceCount,
    sources: [],
    sourcesHash: zeroHash,
    signature: "0x",
  };
}

export class PriceFeed {
  private last: OraclePriceMsg | null = null;

  constructor(
    readonly priceId: string,
    private readonly vol: EwmaVolatility,
  ) {}

  /** Accepts strictly newer prints only. Returns true when the print was used. */
  ingest(msg: OraclePriceMsg | null): boolean {
    if (!msg || !(msg.price > 0)) return false;
    if (msg.priceId && msg.priceId !== this.priceId) return false;
    if (this.last && msg.publishedAt <= this.last.publishedAt) return false;
    this.last = msg;
    this.vol.update(msg.price, msg.publishedAt, msg.held);
    return true;
  }

  latest(): OraclePriceMsg | null {
    return this.last;
  }

  ageSec(nowMs: number): number {
    return this.last ? nowMs / 1000 - this.last.publishedAt : Number.POSITIVE_INFINITY;
  }
}
