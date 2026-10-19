// Verification of the oracle's EIP-712 signed PriceUpdate when it is read from Redis (audit 2026-10 lead "Redis is a
// shared trust domain"). Redis is not trusted for a price: a consumer that acts on one (the agent's quote, ops-venue's
// builder price push) takes it only when the signature recovers, under the deployment's AttestedOracle domain
// (chainId + oracle address), to an oracle signer, and then only from the SIGNED fields (priceWad, publishedAt, held,
// underlying); the unsigned fields of a message (price, priceId, sources, ...) are informative.
//   - oracleSignerCheck: who is an oracle signer: a pinned list, or AttestedOracle.isSigner on-chain (cached; an RPC
//     error THROWS, it is never cached as a "no").
//   - OraclePriceVerifier: one verdict per signed message (cached by fields + signature), "signer check unavailable"
//     never cached.
//   - verifiedOracleMsg: an OraclePriceMsg from Redis -> the same message rebuilt from its signed fields, or the reason
//     it is refused (unsigned, wrong signer, another underlying).
import type { Address, Hex } from "viem";
import { ROLE_CACHE_MS, cachedAddressCheck } from "./busAuth";
import { type PriceUpdate, recoverPriceSigner } from "./eip712";
import type { OraclePriceMsg } from "./queues";

/** Who may sign a price: the oracle's EIP-712 domain and its signer set. */
export interface PriceSignerCheck {
  chainId: number;
  /** the deployment's AttestedOracle (EIP-712 verifying contract) */
  oracle: Address;
  /** true / false = a signer or not; THROWS when the check is unavailable (RPC): never a cached "no" */
  isOracleSigner(addr: Address): Promise<boolean>;
}

/** How long an on-chain signer answer is reused. */
export const ORACLE_SIGNER_CACHE_MS = ROLE_CACHE_MS;

/**
 * The signer check: the pinned addresses when `pinned` is set (comma-separated), else AttestedOracle.isSigner on-chain
 * (`isSignerOnChain`, cached ORACLE_SIGNER_CACHE_MS; an RPC error propagates and is not cached).
 */
export function oracleSignerCheck(o: { chainId: number; oracle: Address; pinned?: string | undefined; pinnedEnv?: string; isSignerOnChain: (a: Address) => Promise<boolean>; now?: () => number }): PriceSignerCheck {
  const check = cachedAddressCheck({ pinned: o.pinned, ...(o.pinnedEnv ? { pinnedEnv: o.pinnedEnv } : {}), onChain: o.isSignerOnChain, ...(o.now ? { now: o.now } : {}), ttlMs: ORACLE_SIGNER_CACHE_MS });
  return { chainId: o.chainId, oracle: o.oracle, isOracleSigner: check };
}

/** A verified price (signer recovered and allowed) or the reason it is refused. */
export type PriceVerdict = { ok: true; signer: Address } | { ok: false; reason: string };

const SIG_RE = /^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/;

/** Verdicts per signed message: the recovery (and the on-chain check) runs once per distinct signed price. */
export class OraclePriceVerifier {
  private readonly verdicts = new Map<string, PriceVerdict>();

  constructor(
    readonly check: PriceSignerCheck,
    private readonly maxCached = 1_024,
  ) {}

  /**
   * The verdict for `u` signed with `signature`. Refusals: "malformed signature", "signed by X, which is not an oracle
   * signer"; "signer check unavailable for X: ..." when the signer check could not run (never cached: asked again).
   */
  async verify(u: PriceUpdate, signature: Hex): Promise<PriceVerdict> {
    const key = `${u.underlying.toLowerCase()}|${u.priceWad}|${u.publishedAt}|${u.held}|${u.sourceCount}|${u.sourcesHash.toLowerCase()}|${signature.toLowerCase()}`;
    const hit = this.verdicts.get(key);
    if (hit) return hit;
    const signer = SIG_RE.test(signature) ? await recoverPriceSigner(this.check.chainId, this.check.oracle, u, signature) : null;
    let verdict: PriceVerdict;
    if (!signer) {
      verdict = { ok: false, reason: "malformed signature" };
    } else {
      let ok: boolean;
      try {
        ok = await this.check.isOracleSigner(signer);
      } catch (err) {
        return { ok: false, reason: `signer check unavailable for ${signer}: ${err instanceof Error ? err.message : String(err)}` };
      }
      verdict = ok ? { ok: true, signer } : { ok: false, reason: `signed by ${signer}, which is not an oracle signer` };
    }
    // evict the oldest verdict only: a flood of forged signatures never flushes the genuine ones in one go
    if (this.verdicts.size >= this.maxCached) this.verdicts.delete(this.verdicts.keys().next().value as string);
    this.verdicts.set(key, verdict);
    return verdict;
  }
}

/** The signed PriceUpdate of an OraclePriceMsg-shaped object, or null when a signed field is missing / malformed. */
export function signedUpdateOf(m: unknown): { update: PriceUpdate; signature: Hex } | null {
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  if (typeof o.signature !== "string" || typeof o.underlying !== "string" || typeof o.priceWad !== "string" || typeof o.sourcesHash !== "string") return null;
  if (typeof o.sourceCount !== "number" || typeof o.publishedAt !== "number" || typeof o.held !== "boolean") return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(o.underlying) || !/^0x[0-9a-fA-F]{64}$/.test(o.sourcesHash)) return null;
  if (!Number.isSafeInteger(o.publishedAt) || o.publishedAt <= 0 || !Number.isInteger(o.sourceCount) || o.sourceCount < 0) return null;
  let priceWad: bigint;
  try {
    priceWad = BigInt(o.priceWad);
  } catch {
    return null;
  }
  if (priceWad <= 0n) return null;
  return {
    update: { underlying: o.underlying as Hex, priceWad, publishedAt: BigInt(o.publishedAt), held: o.held, sourceCount: o.sourceCount, sourcesHash: o.sourcesHash as Hex },
    signature: o.signature as Hex,
  };
}

/**
 * An OraclePriceMsg read from Redis, verified: the message rebuilt from its SIGNED fields (price = priceWad / 1e18,
 * publishedAt, held, underlying), or the reason it is refused. `expectedUnderlying` is the price id the consumer trades
 * (never taken from Redis): a valid signature over another underlying is refused (a signed NVDA price is never used as
 * TSLA's).
 */
export async function verifiedOracleMsg(raw: unknown, verifier: OraclePriceVerifier, expectedUnderlying: Hex): Promise<{ msg: OraclePriceMsg } | { reason: string }> {
  const s = signedUpdateOf(raw);
  if (!s) return { reason: "unsigned oracle price (no EIP-712 signature / signed fields)" };
  if (s.update.underlying.toLowerCase() !== expectedUnderlying.toLowerCase()) return { reason: `signed for another underlying (${s.update.underlying})` };
  const v = await verifier.verify(s.update, s.signature);
  if (!v.ok) return { reason: v.reason };
  const m = raw as Partial<OraclePriceMsg>;
  return {
    msg: {
      priceId: typeof m.priceId === "string" ? m.priceId : "",
      underlying: s.update.underlying,
      priceWad: s.update.priceWad.toString(),
      price: Number(s.update.priceWad) / 1e18,
      publishedAt: Number(s.update.publishedAt),
      held: s.update.held,
      sourceCount: s.update.sourceCount,
      sources: Array.isArray(m.sources) ? m.sources : [],
      sourcesHash: s.update.sourcesHash,
      signature: s.signature,
    },
  };
}
