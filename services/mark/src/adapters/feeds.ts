// Redis feeds for the mark (MarkFeeds): the oracle service's signed prices and ops-venue's signed venue
// reports. Every item is signature-checked here — an oracle price must recover to an active AttestedOracle
// signer, a venue report to an OPS_VENUE holder — so a stray Redis write can neither move a NAV nor revert
// the mark tx.
import { KEYS, type Logger, priceTypedData } from "@bookrunner/shared";
import { attestedOracleAbi, bookrunnerConfigAbi } from "@bookrunner/shared/abi";
import type { BookRef } from "@bookrunner/waterfall";
import { type Address, type Hex, type PublicClient, recoverTypedDataAddress } from "viem";
import { type SignedVenueReport, VENUE_REPORT_RECENT_MAX, parseSignedVenueReport, venueReportKey, venueReportRecentKey, verifyVenueReport } from "../../../ops-venue/src/report712";
import { ORACLE_BUNDLE_KEY, type SignedPrice, parseOracleBundle, parseSignedPrice } from "../domain/prices";
import type { MarkFeeds } from "../ports";

/** Structural subset of ioredis used here. */
export interface FeedRedis {
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  scan(cursor: string, matchToken: "MATCH", pattern: string, countToken: "COUNT", count: number): Promise<[string, string[]]>;
}

export interface FeedVerifier {
  chainId: number;
  oracle: Address;
  isOracleSigner(addr: Address): Promise<boolean>;
  isOpsVenue(addr: Address): Promise<boolean>;
}

const ROLE_TTL_MS = 60_000;

/** Cached on-chain role checks (AttestedOracle.isSigner, config.hasRole(OPS_VENUE_ROLE)). */
export function chainVerifier(pc: PublicClient, c: { config: Address; oracle: Address }, chainId: number): FeedVerifier {
  const cache = new Map<string, { ok: boolean; at: number }>();
  let opsRole: Hex | null = null;
  const cached = async (k: string, load: () => Promise<boolean>) => {
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < ROLE_TTL_MS) return hit.ok;
    const ok = await load().catch(() => false);
    cache.set(k, { ok, at: Date.now() });
    return ok;
  };
  return {
    chainId,
    oracle: c.oracle,
    isOracleSigner: (a) => cached(`oracle:${a.toLowerCase()}`, () => pc.readContract({ address: c.oracle, abi: attestedOracleAbi, functionName: "isSigner", args: [a] })),
    isOpsVenue: (a) =>
      cached(`ops:${a.toLowerCase()}`, async () => {
        opsRole ??= await pc.readContract({ address: c.config, abi: bookrunnerConfigAbi, functionName: "OPS_VENUE_ROLE" });
        return pc.readContract({ address: c.config, abi: bookrunnerConfigAbi, functionName: "hasRole", args: [opsRole, a] });
      }),
  };
}

export class RedisMarkFeeds implements MarkFeeds {
  constructor(
    private readonly redis: FeedRedis,
    private readonly verify: FeedVerifier,
    private readonly log: Logger,
    private readonly maxScan = 500,
  ) {}

  async signedPrices(): Promise<SignedPrice[]> {
    const [bundleRaw, keys] = await Promise.all([this.redis.get(ORACLE_BUNDLE_KEY), this.scan(KEYS.oracleLast("*"))]);
    const all = parseOracleBundle(bundleRaw);
    if (keys.length) for (const raw of await this.redis.mget(...keys)) if (raw) {
      try {
        const p = parseSignedPrice(JSON.parse(raw));
        if (p) all.push(p);
      } catch {
        /* malformed message */
      }
    }
    const out: SignedPrice[] = [];
    let rejected = 0;
    for (const p of all) {
      if (await this.priceSignedByOracle(p)) out.push(p);
      else rejected++;
    }
    if (rejected) this.log.warn({ rejected }, "signed prices with an unknown signer ignored");
    return out;
  }

  async venueReports(ref: BookRef): Promise<SignedVenueReport[]> {
    const [latest, recent] = await Promise.all([this.redis.get(venueReportKey(ref.bookId)), this.redis.lrange(venueReportRecentKey(ref.bookId), 0, VENUE_REPORT_RECENT_MAX - 1)]);
    const seen = new Set<string>();
    const out: SignedVenueReport[] = [];
    for (const raw of [latest, ...recent]) {
      const parsed = raw ? parseSignedVenueReport(raw) : null;
      if (!parsed || seen.has(parsed.signature)) continue;
      seen.add(parsed.signature);
      if (parsed.bookId !== ref.bookId || parsed.chainId !== this.verify.chainId || parsed.adapter.toLowerCase() !== ref.components.adapter.toLowerCase()) continue;
      const r = await verifyVenueReport(parsed);
      if (!r || !(await this.verify.isOpsVenue(r.signer))) {
        this.log.warn({ bookId: ref.bookId, asOf: Number(parsed.asOf), signer: r?.signer ?? parsed.signer }, "venue report with an invalid signature / non-OPS_VENUE signer ignored");
        continue;
      }
      out.push(r);
    }
    return out;
  }

  private async priceSignedByOracle(p: SignedPrice): Promise<boolean> {
    try {
      const u = { underlying: p.underlying, priceWad: p.priceWad, publishedAt: p.publishedAt, held: p.held, sourceCount: p.sourceCount, sourcesHash: p.sourcesHash };
      const signer = await recoverTypedDataAddress({ ...priceTypedData(this.verify.chainId, this.verify.oracle, u), signature: p.signature });
      return await this.verify.isOracleSigner(signer);
    } catch {
      return false;
    }
  }

  private async scan(pattern: string): Promise<string[]> {
    const out = new Set<string>();
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
      for (const k of keys) out.add(k);
      cursor = next;
    } while (cursor !== "0" && out.size < this.maxScan);
    return [...out];
  }
}
