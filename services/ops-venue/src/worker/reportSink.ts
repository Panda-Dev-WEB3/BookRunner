// Signed venue reports (OPS_REPORT_MODE=signed): the OPS_VENUE key signs, Redis carries them to the mark
// keeper (MarkRegistry.commitAndApply), risk and the api. Formats: src/report712.ts.
import type { Address, Hex, LocalAccount } from "viem";
import { type SignedVenueReportJson, VENUE_REPORT_RECENT_MAX, type VenueReportValues, signVenueReport, venueReportKey, venueReportRecentKey } from "../report712";
import type { ReportPublisher, ReportSigner } from "./context";

/** ReportSigner over the ops-venue LocalAccount (roleAccount("opsVenue")). */
export function accountReportSigner(account: LocalAccount, chainId: number): ReportSigner {
  return {
    address: account.address,
    chainId,
    sign: (adapter: Address, r: VenueReportValues): Promise<Hex> => signVenueReport(account, chainId, adapter, r),
  };
}

/** Structural subset of ioredis used here (multi: SET + LPUSH + LTRIM + PUBLISH, atomically). */
export interface RedisMultiLike {
  multi(): {
    set(key: string, value: string): unknown;
    lpush(key: string, value: string): unknown;
    ltrim(key: string, start: number, stop: number): unknown;
    publish(channel: string, message: string): unknown;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
  };
}

export class RedisReportPublisher implements ReportPublisher {
  constructor(
    private readonly redis: RedisMultiLike,
    private readonly recentMax = VENUE_REPORT_RECENT_MAX,
  ) {}

  async publish(r: SignedVenueReportJson): Promise<void> {
    const json = JSON.stringify(r);
    const m = this.redis.multi();
    m.set(venueReportKey(r.bookId), json);
    m.lpush(venueReportRecentKey(r.bookId), json);
    m.ltrim(venueReportRecentKey(r.bookId), 0, Math.max(0, this.recentMax - 1));
    m.publish(venueReportKey(r.bookId), json);
    const res = await m.exec();
    if (!res) throw new Error("redis transaction aborted while publishing the venue report");
    const failed = res.find(([err]) => err);
    if (failed?.[0]) throw failed[0];
  }
}

/** In-memory publisher (tests): latest + recent per book. */
export class MemoryReportPublisher implements ReportPublisher {
  readonly latest = new Map<number, SignedVenueReportJson>();
  readonly recent = new Map<number, SignedVenueReportJson[]>();
  readonly published: SignedVenueReportJson[] = [];
  fail: string | null = null;

  async publish(r: SignedVenueReportJson): Promise<void> {
    if (this.fail) throw new Error(this.fail);
    this.published.push(r);
    this.latest.set(r.bookId, r);
    this.recent.set(r.bookId, [r, ...(this.recent.get(r.bookId) ?? [])].slice(0, VENUE_REPORT_RECENT_MAX));
  }
}
