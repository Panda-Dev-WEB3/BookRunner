// Signed Orderly venue reports (docs/LOW_GAS.md §2) — the canonical definition shared by ops-venue (signs),
// mark (relays inside MarkRegistry.commitAndApply), risk and api (read). Imports only viem so other
// services can import this file directly.
//
//   EIP-712 domain  ("Bookrunner OrderlyAdapter", "1", chainId, verifyingContract = the book's adapter)
//   REPORT_TYPEHASH = keccak256("VenueReport(uint256 insuranceUsd,int256 marginUsd,int256 netExposureUsd,uint64 asOf)")
//   venueReport     = abi.encode(uint256 insuranceUsd, int256 marginUsd, int256 netExposureUsd, uint64 asOf, bytes sig)
//                     (the commitAndApply argument; OrderlyAdapter.reportSigned takes the same fields)
//
// Redis: latest report JSON at `bkrn:venue:report:<bookId>` (also PUBLISHed on that channel name), the
// last VENUE_REPORT_RECENT_MAX reports newest-first in the list `bkrn:venue:report:<bookId>:recent` (a mark
// snapshot taken a few blocks behind head picks the newest report not after its block).
//
// On-chain acceptance (same rules as OrderlyAdapter.report): signer holds OPS_VENUE; no withdrawal is
// Requested (pendingWithdrawUsd == 0); asOf <= block.timestamp; asOf > lastReportAsOf (valuationAt);
// asOf > lastFlowAt (strictly: a same-second snapshot may predate the flow); values within 128-bit ranges.
import {
  type Address,
  type Hex,
  type LocalAccount,
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  isAddress,
  isHex,
  keccak256,
  parseAbiParameters,
  recoverTypedDataAddress,
  stringToHex,
  zeroAddress,
} from "viem";

export const VENUE_REPORT_DOMAIN_NAME = "Bookrunner OrderlyAdapter";
export const VENUE_REPORT_DOMAIN_VERSION = "1";
export const VENUE_REPORT_TYPE = "VenueReport(uint256 insuranceUsd,int256 marginUsd,int256 netExposureUsd,uint64 asOf)";
export const REPORT_TYPEHASH: Hex = keccak256(stringToHex(VENUE_REPORT_TYPE));

/** Latest signed report JSON per book (SET; also PUBLISHed on the same name). */
export const venueReportKey = (bookId: number | bigint) => `bkrn:venue:report:${bookId}`;
/** Recent signed reports per book, newest first (LPUSH + LTRIM). */
export const venueReportRecentKey = (bookId: number | bigint) => `bkrn:venue:report:${bookId}:recent`;
export const VENUE_REPORT_RECENT_MAX = 32;

export const venueReportDomain = (chainId: number, adapter: Address) =>
  ({ name: VENUE_REPORT_DOMAIN_NAME, version: VENUE_REPORT_DOMAIN_VERSION, chainId, verifyingContract: adapter }) as const;

export const venueReportTypes = {
  VenueReport: [
    { name: "insuranceUsd", type: "uint256" },
    { name: "marginUsd", type: "int256" },
    { name: "netExposureUsd", type: "int256" },
    { name: "asOf", type: "uint64" },
  ],
} as const;

/** The signed fields (IOrderlyAdapter.report / reportSigned inputs). */
export interface VenueReportValues {
  insuranceUsd: bigint; // uint256, IF equity floored at 0
  marginUsd: bigint; // int256, MM equity (may be negative)
  netExposureUsd: bigint; // int256, signed MM position notional (+ = book long)
  asOf: bigint; // uint64 unix seconds
}

export const venueReportTypedData = (chainId: number, adapter: Address, r: VenueReportValues) =>
  ({
    domain: venueReportDomain(chainId, adapter),
    types: venueReportTypes,
    primaryType: "VenueReport",
    message: { insuranceUsd: r.insuranceUsd, marginUsd: r.marginUsd, netExposureUsd: r.netExposureUsd, asOf: r.asOf },
  }) as const;

export function signVenueReport(account: Pick<LocalAccount, "signTypedData">, chainId: number, adapter: Address, r: VenueReportValues): Promise<Hex> {
  return account.signTypedData(venueReportTypedData(chainId, adapter, r));
}

export function venueReportDigest(chainId: number, adapter: Address, r: VenueReportValues): Hex {
  return hashTypedData(venueReportTypedData(chainId, adapter, r));
}

export function recoverVenueReportSigner(chainId: number, adapter: Address, r: VenueReportValues, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ ...venueReportTypedData(chainId, adapter, r), signature });
}

/**
 * A signed report as published (all integers as raw 6dp decimal strings; JSON-safe). A superset of
 * VenueReportMsg (packages/shared queues.ts, KEYS.venueReport): `sig` repeats `signature` and `venueReport`
 * is the ready-made commitAndApply / reportSigned argument.
 */
export interface SignedVenueReportJson {
  v: 1;
  bookId: number;
  chainId: number;
  adapter: Address;
  insuranceUsd: string;
  marginUsd: string;
  netExposureUsd: string;
  asOf: number;
  signer: Address;
  signature: Hex;
  /** = signature (VenueReportMsg field name) */
  sig: Hex;
  /** abi.encode(insuranceUsd, marginUsd, netExposureUsd, asOf, sig) */
  venueReport: Hex;
  /** unix ms when ops-venue signed it */
  signedAt: number;
}

/** Parsed (bigint) form used by consumers. */
export interface SignedVenueReport extends VenueReportValues {
  bookId: number;
  chainId: number;
  adapter: Address;
  signer: Address;
  signature: Hex;
  signedAt: number;
}

export function toSignedVenueReportJson(r: SignedVenueReport): SignedVenueReportJson {
  return {
    v: 1,
    bookId: r.bookId,
    chainId: r.chainId,
    adapter: getAddress(r.adapter),
    insuranceUsd: r.insuranceUsd.toString(),
    marginUsd: r.marginUsd.toString(),
    netExposureUsd: r.netExposureUsd.toString(),
    asOf: Number(r.asOf),
    signer: getAddress(r.signer),
    signature: r.signature,
    sig: r.signature,
    venueReport: encodeVenueReport(r),
    signedAt: r.signedAt,
  };
}

const UINT128_MAX = (1n << 128n) - 1n;
const INT128_MAX = (1n << 127n) - 1n;
const INT128_MIN = -(1n << 127n);
const UINT64_MAX = (1n << 64n) - 1n;

const bigOf = (v: unknown): bigint | null => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  return null;
};

/** Values the adapter would accept (128-bit ranges, asOf in uint64). */
export function reportInRange(r: VenueReportValues): boolean {
  return (
    r.insuranceUsd >= 0n &&
    r.insuranceUsd <= UINT128_MAX &&
    r.marginUsd >= INT128_MIN &&
    r.marginUsd <= INT128_MAX &&
    r.netExposureUsd >= INT128_MIN &&
    r.netExposureUsd <= INT128_MAX &&
    r.asOf > 0n &&
    r.asOf <= UINT64_MAX
  );
}

/** Tolerant parser for a published report (JSON string or object); null when malformed. Signature NOT verified. */
export function parseSignedVenueReport(raw: unknown): SignedVenueReport | null {
  let o: unknown = raw;
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object") return null;
  const j = o as Record<string, unknown>;
  const insuranceUsd = bigOf(j.insuranceUsd);
  const marginUsd = bigOf(j.marginUsd);
  const netExposureUsd = bigOf(j.netExposureUsd);
  const asOf = bigOf(j.asOf);
  const bookId = bigOf(j.bookId);
  const chainId = bigOf(j.chainId);
  if (insuranceUsd === null || marginUsd === null || netExposureUsd === null || asOf === null || bookId === null || chainId === null) return null;
  if (typeof j.adapter !== "string" || !isAddress(j.adapter, { strict: false })) return null;
  const signature = j.signature ?? j.sig;
  if (typeof signature !== "string" || !isHex(signature) || signature.length < 132) return null;
  // the signer is recoverable from the signature; publishers that omit it get it filled in by the caller's check
  if (j.signer !== undefined && (typeof j.signer !== "string" || !isAddress(j.signer, { strict: false }))) return null;
  const r: SignedVenueReport = {
    bookId: Number(bookId),
    chainId: Number(chainId),
    adapter: getAddress(j.adapter),
    insuranceUsd,
    marginUsd,
    netExposureUsd,
    asOf,
    // no declared signer (a bare VenueReportMsg): zero until verifyVenueReport binds the recovered one
    signer: typeof j.signer === "string" ? getAddress(j.signer) : zeroAddress,
    signature: signature as Hex,
    signedAt: typeof j.signedAt === "number" && Number.isFinite(j.signedAt) ? j.signedAt : 0,
  };
  return reportInRange(r) ? r : null;
}

/** Signature recovers to the address the report names (cheap integrity check; role checks are the caller's). */
export async function venueReportSignatureValid(r: SignedVenueReport): Promise<boolean> {
  return (await verifyVenueReport(r)) !== null;
}

/**
 * The report with `signer` = the address its signature recovers to over the adapter's domain; null when the
 * signature is malformed or recovers to another address than a declared signer. Role checks are the caller's.
 */
export async function verifyVenueReport(r: SignedVenueReport): Promise<SignedVenueReport | null> {
  try {
    const signer = await recoverVenueReportSigner(r.chainId, r.adapter, r, r.signature);
    if (r.signer !== zeroAddress && signer.toLowerCase() !== r.signer.toLowerCase()) return null;
    return { ...r, signer };
  } catch {
    return null;
  }
}

const VENUE_REPORT_PARAMS = parseAbiParameters("uint256 insuranceUsd, int256 marginUsd, int256 netExposureUsd, uint64 asOf, bytes sig");

/** MarkRegistry.commitAndApply `venueReport` argument. */
export function encodeVenueReport(r: VenueReportValues & { signature: Hex }): Hex {
  return encodeAbiParameters(VENUE_REPORT_PARAMS, [r.insuranceUsd, r.marginUsd, r.netExposureUsd, r.asOf, r.signature]);
}

export function decodeVenueReport(data: Hex): VenueReportValues & { signature: Hex } {
  const [insuranceUsd, marginUsd, netExposureUsd, asOf, signature] = decodeAbiParameters(VENUE_REPORT_PARAMS, data);
  return { insuranceUsd, marginUsd, netExposureUsd, asOf, signature };
}

/** OrderlyAdapter.deployedValueUsd for these venue values: insurance + max(margin, 0) + in-transit. */
export function reportDeployedValueUsd(r: Pick<VenueReportValues, "insuranceUsd" | "marginUsd">, inTransitUsd: bigint): bigint {
  return r.insuranceUsd + (r.marginUsd > 0n ? r.marginUsd : 0n) + inTransitUsd;
}

/** On-chain adapter state a signed report is checked against. */
export interface AdapterReportState {
  /** adapter.valuationAt() = lastReportAsOf */
  valuationAt: bigint;
  /** adapter.lastFlowAt(): last deposit / confirm / cancel / fail */
  lastFlowAt: bigint;
  /** requested-but-unconfirmed withdrawals (IF + MM) */
  pendingWithdrawUsd: bigint;
}

/**
 * May the report VALUE the venue for a snapshot taken at `snapshotTs` against `state` (read at that block)?
 * It must be for this adapter / chain, not after the snapshot block (it could reflect a flow the snapshot
 * has not seen) and not before the last on-chain flow (the adapter has applied a flow the report has not).
 * A requested withdrawal does not make it inconsistent: ops-venue never signs while one is in flight and
 * the adapter keeps the requested amount venue-side until confirmation, exactly like a pre-request report.
 */
export function reportConsistent(r: SignedVenueReport, o: { adapter: Address; chainId: number; snapshotTs: bigint; state: Pick<AdapterReportState, "lastFlowAt"> }): string | null {
  if (r.adapter.toLowerCase() !== o.adapter.toLowerCase()) return "report signed for another adapter";
  if (r.chainId !== o.chainId) return `report signed for chain ${r.chainId}`;
  if (r.asOf > o.snapshotTs) return `report asOf ${r.asOf} is after the snapshot block (${o.snapshotTs})`;
  if (r.asOf <= o.state.lastFlowAt) return `report asOf ${r.asOf} predates the last venue flow (${o.state.lastFlowAt}) or shares its second`;
  return null;
}

/** Would OrderlyAdapter.reportSigned accept it now (besides the signer role)? null = yes, else why not. */
export function reportIncludable(r: VenueReportValues, state: AdapterReportState, nowTs: bigint): string | null {
  if (state.pendingWithdrawUsd > 0n) return `withdrawal pending (${state.pendingWithdrawUsd})`;
  if (r.asOf > nowTs) return `asOf ${r.asOf} in the future (${nowTs})`;
  if (r.asOf <= state.valuationAt) return `not newer than the adapter's report (${state.valuationAt})`;
  if (r.asOf <= state.lastFlowAt) return `predates the last venue flow (${state.lastFlowAt}) or shares its second`;
  if (!reportInRange(r)) return "values out of range";
  return null;
}

/** Newest candidate passing `ok` (candidates in any order; duplicates by asOf collapse). */
export function newestReport<T extends { asOf: bigint }>(candidates: readonly T[], ok: (r: T) => boolean): T | null {
  let best: T | null = null;
  for (const r of candidates) if (ok(r) && (!best || r.asOf > best.asOf)) best = r;
  return best;
}
