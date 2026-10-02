// Waterfall -> mark coordination (docs/LOW_GAS.md §3): when a period has no fee flow the waterfall sends
// no sweep / distribute tx at all and records "nothing to distribute" for (book, period); the mark
// scheduler then marks right away instead of waiting MARK_WAIT_SECONDS for a distribution that will not
// happen. Redis key `bkrn:waterfall:nodist:<bookId>:<period>` (JSON NoDistribution, TTL 7 days).

export const noDistributionKey = (bookId: number, period: number) => `bkrn:waterfall:nodist:${bookId}:${period}`;
export const NO_DISTRIBUTION_TTL_SECONDS = 7 * 86_400;

export interface NoDistribution {
  bookId: number;
  period: number;
  reason: string;
  /** router.pendingGross() when the decision was taken (always "0"). */
  pendingGross: string;
  at: number; // unix ms
}

export interface SettlementSignals {
  markNoDistribution(d: NoDistribution): Promise<void>;
  /** The waterfall decided `period` has nothing to distribute (null = no such decision, or unknown). */
  noDistribution(bookId: number, period: number): Promise<NoDistribution | null>;
}

/** Structural subset of ioredis. */
export interface RedisKvLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
}

export class RedisSettlementSignals implements SettlementSignals {
  constructor(
    private readonly redis: RedisKvLike,
    private readonly ttlSeconds = NO_DISTRIBUTION_TTL_SECONDS,
  ) {}

  async markNoDistribution(d: NoDistribution): Promise<void> {
    await this.redis.set(noDistributionKey(d.bookId, d.period), JSON.stringify(d), "EX", this.ttlSeconds);
  }

  async noDistribution(bookId: number, period: number): Promise<NoDistribution | null> {
    const raw = await this.redis.get(noDistributionKey(bookId, period));
    if (!raw) return null;
    try {
      const o = JSON.parse(raw) as Partial<NoDistribution>;
      return o && o.bookId === bookId && o.period === period ? (o as NoDistribution) : null;
    } catch {
      return null;
    }
  }
}

export class MemorySettlementSignals implements SettlementSignals {
  readonly map = new Map<string, NoDistribution>();
  async markNoDistribution(d: NoDistribution): Promise<void> {
    this.map.set(noDistributionKey(d.bookId, d.period), d);
  }
  async noDistribution(bookId: number, period: number): Promise<NoDistribution | null> {
    return this.map.get(noDistributionKey(bookId, period)) ?? null;
  }
}
