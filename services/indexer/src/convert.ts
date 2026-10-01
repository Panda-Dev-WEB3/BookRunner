// Value conversions for indexing: decoded-arg accessors (runtime-checked, so ABI drift in
// implementations surfaces as a clear error), DB units, CIDs, charter JSON.
import { bytes32ToStr, dbUsd } from "@bookrunner/shared";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import * as Digest from "multiformats/hashes/digest";
import { sha256 } from "multiformats/hashes/sha2";
import { type Address, type Hex, hexToBytes } from "viem";

export class ArgError extends Error {}

type Args = Record<string, unknown>;

export const arg = {
  big(a: Args, k: string): bigint {
    const v = a[k];
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
    throw new ArgError(`arg ${k}: expected integer, got ${typeof v}`);
  },
  num(a: Args, k: string): number {
    return Number(arg.big(a, k));
  },
  addr(a: Args, k: string): Address {
    const v = a[k];
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return v.toLowerCase() as Address;
    throw new ArgError(`arg ${k}: expected address`);
  },
  hex(a: Args, k: string): Hex {
    const v = a[k];
    if (typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v)) return v.toLowerCase() as Hex;
    throw new ArgError(`arg ${k}: expected hex`);
  },
  bool(a: Args, k: string): boolean {
    const v = a[k];
    if (typeof v === "boolean") return v;
    throw new ArgError(`arg ${k}: expected bool`);
  },
  bigs(a: Args, k: string): bigint[] {
    const v = a[k];
    if (Array.isArray(v) && v.every((x) => typeof x === "bigint")) return v as bigint[];
    throw new ArgError(`arg ${k}: expected uint[]`);
  },
  obj(a: Args, k: string): Record<string, unknown> {
    const v = a[k];
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    throw new ArgError(`arg ${k}: expected tuple`);
  },
};

export const usdDb = (raw6: bigint): string => dbUsd.toDb(raw6);
export const WAD = 10n ** 18n;
export const wadToNumber = (w: bigint): number => Number(w) / 1e18;
export const isZeroHex = (h: string): boolean => /^0x0*$/i.test(h);

/** ASCII bytes32 -> string; falls back to the hex when not decodable. */
export function symbolStr(b: Hex): string {
  try {
    const s = bytes32ToStr(b);
    return /^[\x20-\x7e]*$/.test(s) ? s : b;
  } catch {
    return b;
  }
}

/** bytes32 sha2-256 digest -> CIDv1 (raw codec) string; "" for the zero digest. */
export function cidFromDigest(digest: Hex): string {
  if (isZeroHex(digest)) return "";
  const bytes = hexToBytes(digest);
  if (bytes.length !== 32) throw new ArgError(`digest must be 32 bytes: ${digest}`);
  return CID.create(1, raw.code, Digest.create(sha256.code, bytes)).toString();
}

export const REVENUE_SOURCE_NAMES = ["venue_taker_share", "engine_fees", "funding", "liquidation", "other"] as const;
export const revenueSourceName = (id: number): string => REVENUE_SOURCE_NAMES[id] ?? `source_${id}`;

/**
 * charters.struct_json shape (BRTypes.Charter with bigint -> decimal string, hex lowercase); same as
 * services/charter/src/domain/charterJson.ts (suggested shared addition).
 */
export function charterStructToJson(c: Record<string, unknown>): Record<string, unknown> {
  const conv = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string" && v.startsWith("0x")) return v.toLowerCase();
    if (Array.isArray(v)) return v.map(conv);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, conv(x)]));
    return v;
  };
  return conv(c) as Record<string, unknown>;
}
