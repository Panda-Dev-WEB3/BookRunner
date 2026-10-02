import { type Address, type Hex, decodeAbiParameters, encodeAbiParameters } from "viem";
import type { OraclePriceMsg } from "./queues";
import type { MarkInput } from "./types";

// EIP-712 definitions shared with MarkRegistry.sol and AttestedOracle.sol (keep in lockstep).

export const markDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "Bookrunner MarkRegistry", version: "1", chainId, verifyingContract }) as const;

export const markTypes = {
  Mark: [
    { name: "bookId", type: "uint256" },
    { name: "periodEnd", type: "uint64" },
    { name: "navUsd", type: "uint256" },
    { name: "deployedValueUsd", type: "uint256" },
    { name: "flowNonce", type: "uint64" },
    { name: "inventoryRoot", type: "bytes32" },
    { name: "pnlJsonHash", type: "bytes32" },
    { name: "receiptsRoot", type: "bytes32" },
  ],
} as const;

export const markTypedData = (chainId: number, registry: Address, m: MarkInput) =>
  ({ domain: markDomain(chainId, registry), types: markTypes, primaryType: "Mark", message: m }) as const;

export const oracleDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "Bookrunner AttestedOracle", version: "1", chainId, verifyingContract }) as const;

export const priceTypes = {
  Price: [
    { name: "underlying", type: "bytes32" },
    { name: "priceWad", type: "uint256" },
    { name: "publishedAt", type: "uint64" },
    { name: "held", type: "bool" },
    { name: "sourceCount", type: "uint32" },
    { name: "sourcesHash", type: "bytes32" },
  ],
} as const;

export interface PriceUpdate {
  underlying: Hex;
  priceWad: bigint;
  publishedAt: bigint;
  held: boolean;
  sourceCount: number;
  sourcesHash: Hex;
}

export const priceTypedData = (chainId: number, oracle: Address, p: PriceUpdate) =>
  ({ domain: oracleDomain(chainId, oracle), types: priceTypes, primaryType: "Price", message: p }) as const;

/** The EIP-712 PriceUpdate an OraclePriceMsg was signed over (the oracle service signs exactly this). */
export function priceUpdateFromMsg(m: OraclePriceMsg): PriceUpdate {
  return {
    underlying: m.underlying,
    priceWad: BigInt(m.priceWad),
    publishedAt: BigInt(m.publishedAt),
    held: m.held,
    sourceCount: m.sourceCount,
    sourcesHash: m.sourcesHash,
  };
}

// ---- pull oracle (docs/LOW_GAS.md §1) ----
// priceData = abi.encode(IAttestedOracle.PriceUpdate[] updates, bytes[] sigs): the trailing argument of
// AttestedOracle.update / BookrunnerDesk.executeWithPrices / PoolEngine.trade + liquidate /
// MarkRegistry.commitAndApply. Empty bytes ("0x") = "no update" (the consumer skips oracle.update).

export const PRICE_DATA_PARAMS = [
  {
    name: "updates",
    type: "tuple[]",
    components: [
      { name: "underlying", type: "bytes32" },
      { name: "priceWad", type: "uint256" },
      { name: "publishedAt", type: "uint64" },
      { name: "held", type: "bool" },
      { name: "sourceCount", type: "uint32" },
      { name: "sourcesHash", type: "bytes32" },
    ],
  },
  { name: "sigs", type: "bytes[]" },
] as const;

/** priceData that makes the consumer skip `oracle.update`. */
export const EMPTY_PRICE_DATA = "0x" as const;

/**
 * abi.encode(PriceUpdate[], bytes[]). One signature per update (same order). Zero updates encode to
 * EMPTY_PRICE_DATA ("0x"), never to an abi-encoded pair of empty arrays.
 */
export function encodePriceData(updates: readonly PriceUpdate[], sigs: readonly Hex[]): Hex {
  if (updates.length !== sigs.length) throw new Error(`encodePriceData: ${updates.length} updates but ${sigs.length} signatures`);
  if (updates.length === 0) return EMPTY_PRICE_DATA;
  return encodeAbiParameters(PRICE_DATA_PARAMS, [
    updates.map((u) => ({
      underlying: u.underlying,
      priceWad: u.priceWad,
      publishedAt: u.publishedAt,
      held: u.held,
      sourceCount: u.sourceCount,
      sourcesHash: u.sourcesHash,
    })),
    [...sigs],
  ]);
}

/** Inverse of encodePriceData ("0x" -> no updates). Throws on malformed data or a length mismatch. */
export function decodePriceData(priceData: Hex): { updates: PriceUpdate[]; sigs: Hex[] } {
  if (priceData === "0x" || priceData === ("0X" as Hex)) return { updates: [], sigs: [] };
  const [updates, sigs] = decodeAbiParameters(PRICE_DATA_PARAMS, priceData);
  if (updates.length !== sigs.length) throw new Error(`decodePriceData: ${updates.length} updates but ${sigs.length} signatures`);
  return {
    updates: updates.map((u) => ({
      underlying: u.underlying,
      priceWad: u.priceWad,
      publishedAt: u.publishedAt,
      held: u.held,
      sourceCount: Number(u.sourceCount),
      sourcesHash: u.sourcesHash,
    })),
    sigs: [...sigs],
  };
}

// ---- signed venue reports (docs/LOW_GAS.md §2) ----
// OrderlyAdapter.reportSigned(insuranceUsd, marginUsd, netExposureUsd, asOf, sig), signed by an
// OPS_VENUE holder; relayed by anyone (mark keeper inside MarkRegistry.commitAndApply, desk hedges).

export const venueReportDomain = (chainId: number, adapter: Address) =>
  ({ name: "Bookrunner OrderlyAdapter", version: "1", chainId, verifyingContract: adapter }) as const;

/** REPORT_TYPEHASH = keccak256("VenueReport(uint256 insuranceUsd,int256 marginUsd,int256 netExposureUsd,uint64 asOf)") */
export const venueReportTypes = {
  VenueReport: [
    { name: "insuranceUsd", type: "uint256" },
    { name: "marginUsd", type: "int256" },
    { name: "netExposureUsd", type: "int256" },
    { name: "asOf", type: "uint64" },
  ],
} as const;

export interface VenueReport {
  insuranceUsd: bigint; // USD 6dp
  marginUsd: bigint; // USD 6dp, signed
  netExposureUsd: bigint; // USD 6dp, signed (positive = book long)
  asOf: bigint; // unix seconds
}

export const venueReportTypedData = (chainId: number, adapter: Address, r: VenueReport) =>
  ({ domain: venueReportDomain(chainId, adapter), types: venueReportTypes, primaryType: "VenueReport", message: r }) as const;

export const VENUE_REPORT_PARAMS = [
  { name: "insuranceUsd", type: "uint256" },
  { name: "marginUsd", type: "int256" },
  { name: "netExposureUsd", type: "int256" },
  { name: "asOf", type: "uint64" },
  { name: "sig", type: "bytes" },
] as const;

/** venueReport argument of MarkRegistry.commitAndApply: abi.encode(insuranceUsd, marginUsd, netExposureUsd, asOf, sig). */
export function encodeVenueReport(r: VenueReport, sig: Hex): Hex {
  return encodeAbiParameters(VENUE_REPORT_PARAMS, [r.insuranceUsd, r.marginUsd, r.netExposureUsd, r.asOf, sig]);
}

/** Inverse of encodeVenueReport; "0x" (no report) -> null. */
export function decodeVenueReport(data: Hex): { report: VenueReport; sig: Hex } | null {
  if (data === "0x") return null;
  const [insuranceUsd, marginUsd, netExposureUsd, asOf, sig] = decodeAbiParameters(VENUE_REPORT_PARAMS, data);
  return { report: { insuranceUsd, marginUsd, netExposureUsd, asOf }, sig };
}
