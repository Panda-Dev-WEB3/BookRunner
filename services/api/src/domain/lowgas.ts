// Low-gas mode views (docs/LOW_GAS.md): the oracle service's latest signed price bundle (pull oracle: prices
// ride in the transactions that need them, so the on-chain stored price is old by design on a quiet market),
// ops-venue's latest signed venue report, and the mark schedule (one mark tx per book per period, daily on
// mainnet). Tolerant parsers over the JSON other services keep in Redis; nothing here trusts a signature —
// the signer is recovered for display, the chain checks it when the data is relayed.
import { type PriceUpdate, priceTypedData } from "@bookrunner/shared/eip712";
import type { OraclePriceMsg } from "@bookrunner/shared/queues";
import { type Address, type Hex, decodeAbiParameters, isAddress, isHex, recoverTypedDataAddress } from "viem";
import { parseSignedVenueReport, verifyVenueReport } from "../../../ops-venue/src/report712";

/** Redis key of the oracle's signed bundle (= KEYS.oracleBundle, JSON OracleBundleMsg). */
export const ORACLE_BUNDLE_KEY = "bkrn:oracle:bundle";
/** Redis key of a book's latest signed venue report (= KEYS.venueReport(bookId), ops-venue). */
export const venueReportKey = (bookId: number) => `bkrn:venue:report:${bookId}`;

const PRICE_DATA_PARAMS = [
  {
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
  { type: "bytes[]" },
] as const;

export interface SignedPriceView {
  priceId: string | null;
  underlying: Hex;
  price: number;
  priceWad: string;
  publishedAt: string;
  publishedAtSec: number;
  ageSeconds: number;
  held: boolean;
  sourceCount: number;
  /** address the EIP-712 signature recovers to (AttestedOracle domain); null if unrecoverable */
  signer: Address | null;
}

export interface SignedBundleView {
  available: boolean;
  asOf: string;
  source: "bundle" | "messages" | "none";
  /** newest publishedAt in the bundle */
  publishedAt: string | null;
  ageSeconds: number | null;
  chainId: number | null;
  oracle: Address | null;
  /** abi.encode(PriceUpdate[], bytes[]) — the `priceData` argument consumers carry */
  priceData: Hex | null;
  prices: SignedPriceView[];
}

const wadToNumber = (w: bigint) => Number(w / 10n ** 12n) / 1e6;
const ageOf = (nowMs: number, sec: number) => Math.max(0, Math.floor(nowMs / 1000) - sec);

async function signerOf(chainId: number | null, oracle: Address | null, u: PriceUpdate, sig: Hex): Promise<Address | null> {
  if (chainId === null || oracle === null) return null;
  try {
    return await recoverTypedDataAddress({ ...priceTypedData(chainId, oracle, u), signature: sig });
  } catch {
    return null;
  }
}

async function view(u: PriceUpdate, sig: Hex, priceId: string | null, nowMs: number, chainId: number | null, oracle: Address | null): Promise<SignedPriceView> {
  const publishedAtSec = Number(u.publishedAt);
  return {
    priceId,
    underlying: u.underlying,
    price: wadToNumber(u.priceWad),
    priceWad: u.priceWad.toString(),
    publishedAt: new Date(publishedAtSec * 1000).toISOString(),
    publishedAtSec,
    ageSeconds: ageOf(nowMs, publishedAtSec),
    held: u.held,
    sourceCount: u.sourceCount,
    signer: await signerOf(chainId, oracle, u, sig),
  };
}

const emptyBundle = (nowMs: number): SignedBundleView => ({
  available: false,
  asOf: new Date(nowMs).toISOString(),
  source: "none",
  publishedAt: null,
  ageSeconds: null,
  chainId: null,
  oracle: null,
  priceData: null,
  prices: [],
});

function finish(nowMs: number, source: SignedBundleView["source"], prices: SignedPriceView[], meta: { chainId: number | null; oracle: Address | null; priceData: Hex | null }): SignedBundleView {
  if (!prices.length) return { ...emptyBundle(nowMs), ...meta, source, available: false };
  const newest = Math.max(...prices.map((p) => p.publishedAtSec));
  return {
    available: true,
    asOf: new Date(nowMs).toISOString(),
    source,
    publishedAt: new Date(newest * 1000).toISOString(),
    ageSeconds: ageOf(nowMs, newest),
    ...meta,
    prices: prices.sort((a, b) => (a.priceId ?? a.underlying).localeCompare(b.priceId ?? b.underlying)),
  };
}

/**
 * OracleBundleMsg ({priceData, publishedAt, chainId, oracle, priceIds}) -> view. Falls back to the per-key
 * signed messages (KEYS.oracleLast, OraclePriceMsg incl. signature) when no bundle is published (e.g. an
 * oracle in heartbeat mode); `domain` names the AttestedOracle the signatures are bound to in that case.
 */
export async function signedBundleView(rawBundle: unknown, messages: unknown[], nowMs: number, domain: { chainId: number | null; oracle: Address | null }): Promise<SignedBundleView> {
  const b = rawBundle && typeof rawBundle === "object" ? (rawBundle as Record<string, unknown>) : null;
  if (b && typeof b.priceData === "string" && isHex(b.priceData) && b.priceData !== "0x") {
    const chainId = typeof b.chainId === "number" ? b.chainId : domain.chainId;
    const oracle = typeof b.oracle === "string" && isAddress(b.oracle, { strict: false }) ? (b.oracle as Address) : domain.oracle;
    const ids = Array.isArray(b.priceIds) ? b.priceIds : [];
    try {
      const [updates, sigs] = decodeAbiParameters(PRICE_DATA_PARAMS, b.priceData as Hex);
      const prices = await Promise.all(
        updates.map((u, i) =>
          view({ ...u, sourceCount: Number(u.sourceCount) }, (sigs[i] ?? "0x") as Hex, typeof ids[i] === "string" ? (ids[i] as string) : null, nowMs, chainId, oracle),
        ),
      );
      return finish(nowMs, "bundle", prices, { chainId, oracle, priceData: b.priceData as Hex });
    } catch {
      /* malformed bundle: fall through to the per-key messages */
    }
  }
  const prices: SignedPriceView[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const o = m as Partial<OraclePriceMsg>;
    if (typeof o.priceId !== "string" || typeof o.underlying !== "string" || typeof o.priceWad !== "string" || typeof o.publishedAt !== "number") continue;
    if (typeof o.signature !== "string" || !isHex(o.signature) || typeof o.sourcesHash !== "string") continue;
    try {
      const u: PriceUpdate = { underlying: o.underlying, priceWad: BigInt(o.priceWad), publishedAt: BigInt(o.publishedAt), held: !!o.held, sourceCount: Number(o.sourceCount ?? 0), sourcesHash: o.sourcesHash };
      prices.push(await view(u, o.signature, o.priceId, nowMs, domain.chainId, domain.oracle));
    } catch {
      /* malformed message */
    }
  }
  return prices.length ? finish(nowMs, "messages", prices, { ...domain, priceData: null }) : emptyBundle(nowMs);
}

export interface VenueReportView {
  bookId: number;
  adapter: Address;
  chainId: number;
  insuranceUsd: string;
  marginUsd: string;
  netExposureUsd: string;
  asOf: string;
  asOfSec: number;
  ageSeconds: number;
  /** recovered from the EIP-712 signature (adapter domain); role checks happen on-chain when relayed */
  signer: Address | null;
  /** abi.encode(insuranceUsd, marginUsd, netExposureUsd, asOf, sig): MarkRegistry.commitAndApply / reportSigned input */
  venueReport: Hex | null;
}

const usd6 = (v: bigint) => {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? "-" : ""}${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0")}`;
};

export async function venueReportView(raw: unknown, nowMs: number): Promise<VenueReportView | null> {
  const r = parseSignedVenueReport(raw);
  if (!r) return null;
  const verified = await verifyVenueReport(r);
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
  const asOfSec = Number(r.asOf);
  return {
    bookId: r.bookId,
    adapter: r.adapter,
    chainId: r.chainId,
    insuranceUsd: usd6(r.insuranceUsd),
    marginUsd: usd6(r.marginUsd),
    netExposureUsd: usd6(r.netExposureUsd),
    asOf: new Date(asOfSec * 1000).toISOString(),
    asOfSec,
    ageSeconds: ageOf(nowMs, asOfSec),
    signer: verified?.signer ?? null,
    venueReport: typeof o.venueReport === "string" && isHex(o.venueReport) ? (o.venueReport as Hex) : null,
  };
}

// ------------------------------------------------------------------ mark schedule

export interface MarkScheduleView {
  intervalSeconds: number;
  /** "daily" | "hourly" | "every 5 min" ... */
  cadence: string;
  /** period end of the last applied mark (unix s; null before the first) */
  lastPeriodEnd: number | null;
  /** the next period end a mark is (or will be) committed for */
  nextPeriodEnd: number;
  nextPeriodEndAt: string;
  /** due: that period has closed and its mark is pending; scheduled: it closes in the future */
  status: "due" | "scheduled";
  secondsUntil: number;
}

export function cadenceLabel(intervalSeconds: number): string {
  if (intervalSeconds === 86_400) return "daily";
  if (intervalSeconds === 3_600) return "hourly";
  if (intervalSeconds % 86_400 === 0) return `every ${intervalSeconds / 86_400} days`;
  if (intervalSeconds % 3_600 === 0) return `every ${intervalSeconds / 3_600} hours`;
  if (intervalSeconds % 60 === 0) return `every ${intervalSeconds / 60} min`;
  return `every ${intervalSeconds} s`;
}

/**
 * One mark per book per period: the latest closed period while its mark is pending (a Live / Retiring book
 * whose last mark is older), else the next period end.
 */
export function markSchedule(nowMs: number, intervalSeconds: number, lastPeriodEnd: number | null, markable = true): MarkScheduleView {
  const interval = Math.max(1, Math.floor(intervalSeconds));
  const nowSec = Math.floor(nowMs / 1000);
  const closed = Math.floor(nowSec / interval) * interval;
  const due = markable && (lastPeriodEnd ?? 0) < closed;
  const next = due ? closed : closed + interval;
  return {
    intervalSeconds: interval,
    cadence: cadenceLabel(interval),
    lastPeriodEnd,
    nextPeriodEnd: next,
    nextPeriodEndAt: new Date(next * 1000).toISOString(),
    status: due ? "due" : "scheduled",
    secondsUntil: Math.max(0, next - nowSec),
  };
}
