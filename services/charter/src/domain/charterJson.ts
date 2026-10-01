// JSON-safe form of BRTypes.Charter as stored in charters.struct_json (bigint -> decimal string,
// addresses/hex lowercase). The indexer writes this shape; keep both sides in lockstep
// (suggested shared addition: packages/shared charterToJson/charterFromJson).
import type { Charter, Mandate } from "@bookrunner/shared";
import { type Address, type Hex, getAddress } from "viem";
import { z } from "zod";

export interface MandateJson {
  maxInventoryUsd: string;
  maxSkewBps: number;
  minQuoteWidthBps: number;
  maxHedgeLeverage: number;
  hedgeRatioMinBps: number;
  hedgeRatioMaxBps: number;
  noNewRiskOffHours: boolean;
  killAtDrawdownBps: number;
  hedgeAllowRoot: Hex;
}

export interface CharterJson {
  underlying: Hex;
  venue: number;
  oracle: number;
  sessions: Hex;
  ifTargetUsd: string;
  mmInventoryUsd: string;
  mandate: MandateJson;
  seniorHurdleBps: number;
  seniorCapBps: number;
  subscriptionWindow: number;
  juniorNoticeSeconds: string;
  sponsor: Address;
  perWalletCapUsd: string;
  symbol: Hex;
  takerFeeBps: number;
  makerFeeBps: number;
}

const lower = <T extends string>(s: T): T => s.toLowerCase() as T;

export function mandateToJson(m: Mandate): MandateJson {
  return {
    maxInventoryUsd: m.maxInventoryUsd.toString(),
    maxSkewBps: m.maxSkewBps,
    minQuoteWidthBps: m.minQuoteWidthBps,
    maxHedgeLeverage: m.maxHedgeLeverage,
    hedgeRatioMinBps: m.hedgeRatioMinBps,
    hedgeRatioMaxBps: m.hedgeRatioMaxBps,
    noNewRiskOffHours: m.noNewRiskOffHours,
    killAtDrawdownBps: m.killAtDrawdownBps,
    hedgeAllowRoot: lower(m.hedgeAllowRoot),
  };
}

export function charterToJson(c: Charter): CharterJson {
  return {
    underlying: lower(c.underlying),
    venue: c.venue,
    oracle: c.oracle,
    sessions: lower(c.sessions),
    ifTargetUsd: c.ifTargetUsd.toString(),
    mmInventoryUsd: c.mmInventoryUsd.toString(),
    mandate: mandateToJson(c.mandate),
    seniorHurdleBps: c.seniorHurdleBps,
    seniorCapBps: c.seniorCapBps,
    subscriptionWindow: c.subscriptionWindow,
    juniorNoticeSeconds: c.juniorNoticeSeconds.toString(),
    sponsor: lower(c.sponsor),
    perWalletCapUsd: c.perWalletCapUsd.toString(),
    symbol: lower(c.symbol),
    takerFeeBps: c.takerFeeBps,
    makerFeeBps: c.makerFeeBps,
  };
}

const big = z.union([z.string().regex(/^-?\d+$/), z.number().int(), z.bigint()]).transform((v) => BigInt(v));
const int = z.union([z.number().int(), z.string().regex(/^-?\d+$/)]).transform((v) => Number(v));
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v.toLowerCase() as Hex);

const mandateSchema = z.object({
  maxInventoryUsd: big,
  maxSkewBps: int,
  minQuoteWidthBps: int,
  maxHedgeLeverage: int,
  hedgeRatioMinBps: int,
  hedgeRatioMaxBps: int,
  noNewRiskOffHours: z.boolean(),
  killAtDrawdownBps: int,
  hedgeAllowRoot: hex32,
});

const charterSchema = z.object({
  underlying: hex32,
  venue: int,
  oracle: int,
  sessions: hex32,
  ifTargetUsd: big,
  mmInventoryUsd: big,
  mandate: mandateSchema,
  seniorHurdleBps: int,
  seniorCapBps: int,
  subscriptionWindow: int,
  juniorNoticeSeconds: big,
  sponsor: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  perWalletCapUsd: big,
  symbol: hex32,
  takerFeeBps: int,
  makerFeeBps: int,
});

/** Parses struct_json (or any JSON-ish Charter, e.g. a viem read result) back into a Charter. */
export function charterFromJson(j: unknown): Charter {
  const p = charterSchema.parse(j);
  return {
    ...p,
    venue: p.venue as Charter["venue"],
    oracle: p.oracle as Charter["oracle"],
    sponsor: getAddress(p.sponsor),
  };
}
