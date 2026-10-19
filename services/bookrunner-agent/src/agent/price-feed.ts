// Oracle price stream for the book's price id: Redis CHANNELS.oraclePrice (seeded from
// KEYS.oracleLast), with an AttestedOracle.latest() fallback when Redis goes quiet. Every newer print
// feeds the EWMA volatility estimator.
//
// Redis is not trusted for the quote price (audit 2026-10 lead "Redis is a shared trust domain"): a print read from
// Redis reaches the feed only through VerifiedPriceInput, i.e. when it carries the oracle's EIP-712 signed PriceUpdate
// for THIS book's price id, recovering to an AttestedOracle signer (on-chain isSigner, cached) under the deployment's
// domain; price, publishedAt and held then come from the signed fields only. An unsigned / forged / foreign print is
// dropped (logged), so a Redis writer can at worst withhold prices (the quote is pulled as STALE_PRICE, and the
// AttestedOracle fallback takes over), never move the quote. A replayed genuine print is not newer, so it is ignored.

import { type Logger, type OraclePriceMsg, type OraclePriceVerifier, verifiedOracleMsg } from "@bookrunner/shared";
import { type Hex, zeroHash } from "viem";
import type { OraclePoint } from "../chain/book-chain";
import type { EwmaVolatility } from "../domain/volatility";

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

/** Redis prints -> verified OraclePriceMsg (see the header). Refusals are counted and logged once per reason. */
export class VerifiedPriceInput {
  rejected = 0;
  private lastReason = "";

  constructor(
    private readonly verifier: OraclePriceVerifier,
    /** the book's price id (bytes32, from the chain at startup): the only underlying accepted */
    private readonly underlying: Hex,
    private readonly log: Logger,
  ) {}

  /** A raw Redis value (channel message or key); null when absent, unreadable or refused. */
  async accept(raw: unknown): Promise<OraclePriceMsg | null> {
    if (raw === null || raw === undefined) return null;
    let o: unknown = raw;
    if (typeof raw === "string") {
      try {
        o = JSON.parse(raw);
      } catch {
        o = null;
      }
    }
    const r = await verifiedOracleMsg(o, this.verifier, this.underlying);
    if ("msg" in r) {
      this.lastReason = "";
      return r.msg;
    }
    this.rejected++;
    if (r.reason !== this.lastReason) {
      this.lastReason = r.reason;
      this.log.warn({ reason: r.reason, rejected: this.rejected }, "oracle price from Redis REJECTED (not used for quoting)");
    }
    return null;
  }
}
