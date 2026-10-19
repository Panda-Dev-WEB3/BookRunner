// Signed venue reports (OPS_REPORT_MODE=signed): the OPS_VENUE key signs, Redis carries them to the mark
// keeper (MarkRegistry.commitAndApply), risk and the api. Formats: src/report712.ts.
import { BUILDER_FEED_STATUS_TTL_SEC, type BuilderFeedStatusMsg, KEYS, VENUE_SYMBOL_ISSUES_TTL_SEC, type VenueSymbolIssuesMsg } from "@bookrunner/shared";
import type { Address, Hex, LocalAccount } from "viem";
import { type SignedVenueReportJson, VENUE_REPORT_RECENT_MAX, type VenueReportValues, signVenueReport, venueReportKey, venueReportRecentKey } from "../report712";
import type { ReportPublisher, ReportSigner, StatusPublisher } from "./context";

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

/** Structural subset of ioredis for the status key (SET with expiry). */
export interface RedisSetExLike {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
}

/** KEYS.venueSymbolIssues (read by services/alerts), refreshed every book poll, expires when ops-venue stops. */
/** KEYS.venueEverListed (a Redis SET, no TTL): the listing tracker's persisted everListed symbols. */
export class RedisEverListedStore {
  constructor(private readonly redis: { smembers(key: string): Promise<string[]>; sadd(key: string, ...members: string[]): Promise<number> }) {}

  load(): Promise<string[]> {
    return this.redis.smembers(KEYS.venueEverListed);
  }

  async add(symbol: string): Promise<void> {
    await this.redis.sadd(KEYS.venueEverListed, symbol);
  }
}

export class RedisStatusPublisher implements StatusPublisher {
  constructor(private readonly redis: RedisSetExLike) {}

  async venueSymbolIssues(msg: VenueSymbolIssuesMsg): Promise<void> {
    await this.redis.set(KEYS.venueSymbolIssues, JSON.stringify(msg), "EX", VENUE_SYMBOL_ISSUES_TTL_SEC);
  }

  /** Live builder price push state (builderOracle/feed.ts) for services/alerts builder_price_push. */
  async builderFeed(msg: BuilderFeedStatusMsg): Promise<void> {
    await this.redis.set(KEYS.builderFeedStatus, JSON.stringify(msg), "EX", BUILDER_FEED_STATUS_TTL_SEC);
  }
}
