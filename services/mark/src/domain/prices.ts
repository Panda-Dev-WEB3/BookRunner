// Signed oracle prices for the mark (pure). docs/LOW_GAS.md §1: prices stay EIP-712 signed off-chain
// (AttestedOracle PRICE_TYPEHASH unchanged) and ride in the transaction that needs them; off-chain readers
// value positions from the oracle service's latest signed bundle, never from strict on-chain views.
//
//   priceData = abi.encode(PriceUpdate[] updates, bytes[] signatures)      (AttestedOracle.update)
//
// Sources (tolerant parsing, the oracle service owns the formats): Redis `bkrn:oracle:bundle` (an object
// with `priceData` hex and/or an array of signed price messages, or a bare array) and the per-key signed
// messages `KEYS.oracleLast(priceId)` (OraclePriceMsg incl. `signature`).
import type { PriceUpdate } from "@bookrunner/shared";
import { type Hex, decodeAbiParameters, encodeAbiParameters, isHex } from "viem";

/** Redis key of the oracle service's latest signed bundle (services-pull). */
export const ORACLE_BUNDLE_KEY = "bkrn:oracle:bundle";

export interface SignedPrice extends PriceUpdate {
  /** human key (e.g. "NVDA") when the source carried one */
  priceId: string | null;
  signature: Hex;
}

const PRICE_DATA_PARAMS = [
  {
    type: "tuple[]",
    name: "updates",
    components: [
      { name: "underlying", type: "bytes32" },
      { name: "priceWad", type: "uint256" },
      { name: "publishedAt", type: "uint64" },
      { name: "held", type: "bool" },
      { name: "sourceCount", type: "uint32" },
      { name: "sourcesHash", type: "bytes32" },
    ],
  },
  { type: "bytes[]", name: "signatures" },
] as const;

export function encodePriceData(prices: readonly SignedPrice[]): Hex {
  if (prices.length === 0) return "0x";
  return encodeAbiParameters(PRICE_DATA_PARAMS, [
    prices.map((p) => ({ underlying: p.underlying, priceWad: p.priceWad, publishedAt: p.publishedAt, held: p.held, sourceCount: p.sourceCount, sourcesHash: p.sourcesHash })),
    prices.map((p) => p.signature),
  ]);
}

export function decodePriceData(data: Hex): SignedPrice[] {
  if (!data || data === "0x") return [];
  const [updates, sigs] = decodeAbiParameters(PRICE_DATA_PARAMS, data);
  return updates.map((u, i) => ({
    priceId: null,
    underlying: u.underlying.toLowerCase() as Hex,
    priceWad: u.priceWad,
    publishedAt: u.publishedAt,
    held: u.held,
    sourceCount: u.sourceCount,
    sourcesHash: u.sourcesHash,
    signature: (sigs[i] ?? "0x") as Hex,
  }));
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

const big = (v: unknown): bigint | null => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return null;
};

/** One signed price from an OraclePriceMsg-like object ({...fields, signature} or {update: {...}, signature}). */
export function parseSignedPrice(v: unknown): SignedPrice | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const u = (o.update && typeof o.update === "object" ? o.update : o) as Record<string, unknown>;
  const signature = o.signature ?? o.sig ?? u.signature;
  const priceWad = big(u.priceWad);
  const publishedAt = big(u.publishedAt);
  const sourceCount = typeof u.sourceCount === "number" && Number.isInteger(u.sourceCount) && u.sourceCount >= 0 ? u.sourceCount : null;
  if (typeof u.underlying !== "string" || !BYTES32.test(u.underlying)) return null;
  if (typeof u.sourcesHash !== "string" || !BYTES32.test(u.sourcesHash)) return null;
  if (priceWad === null || publishedAt === null || publishedAt === 0n || sourceCount === null || typeof u.held !== "boolean") return null;
  if (typeof signature !== "string" || !isHex(signature) || signature.length < 132) return null;
  const priceId = typeof o.priceId === "string" ? o.priceId : typeof u.priceId === "string" ? u.priceId : null;
  return {
    priceId,
    underlying: u.underlying.toLowerCase() as Hex,
    priceWad,
    publishedAt,
    held: u.held,
    sourceCount,
    sourcesHash: u.sourcesHash.toLowerCase() as Hex,
    signature: signature as Hex,
  };
}

/** Every signed price found in a bundle value (JSON string / object / array; unknown shapes yield []). */
export function parseOracleBundle(raw: unknown): SignedPrice[] {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const out: SignedPrice[] = [];
  const visit = (x: unknown, depth: number) => {
    if (depth > 3 || x === null || x === undefined) return;
    if (Array.isArray(x)) {
      for (const item of x) {
        const p = parseSignedPrice(item);
        if (p) out.push(p);
        else visit(item, depth + 1);
      }
      return;
    }
    if (typeof x !== "object") return;
    const single = parseSignedPrice(x);
    if (single) {
      out.push(single);
      return;
    }
    const o = x as Record<string, unknown>;
    if (typeof o.priceData === "string" && isHex(o.priceData)) {
      try {
        out.push(...decodePriceData(o.priceData));
      } catch {
        /* malformed priceData */
      }
    }
    for (const [k, val] of Object.entries(o)) if (k !== "priceData") visit(val, depth + 1);
  };
  visit(v, 0);
  return out;
}

/** Newest price per underlying (lower-case bytes32 key). Later duplicates with the same publishedAt keep the first. */
export function newestByUnderlying(prices: readonly SignedPrice[]): Map<string, SignedPrice> {
  const m = new Map<string, SignedPrice>();
  for (const p of prices) {
    const k = p.underlying.toLowerCase();
    const cur = m.get(k);
    if (!cur || p.publishedAt > cur.publishedAt) m.set(k, { ...p, priceId: p.priceId ?? cur?.priceId ?? null });
    else if (cur.priceId === null && p.priceId !== null && p.publishedAt === cur.publishedAt) m.set(k, { ...cur, priceId: p.priceId });
  }
  return m;
}

/**
 * The signed price to value `underlying` with, when it is newer than what the chain stores (else null:
 * the stored on-chain price is at least as recent and is used). Prices published after the snapshot
 * block (+5 s, the oracle's acceptance window) are ignored — they could not be applied at that block.
 */
export function pickSignedPrice(prices: ReadonlyMap<string, SignedPrice> | undefined, underlying: Hex, onchainPublishedAt: bigint, blockTs: bigint): SignedPrice | null {
  const p = prices?.get(underlying.toLowerCase());
  if (!p) return null;
  if (p.publishedAt <= onchainPublishedAt) return null;
  if (p.publishedAt > blockTs + 5n) return null;
  return p;
}
