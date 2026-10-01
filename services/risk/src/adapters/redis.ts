// ioredis adapter: keys and channels from packages/shared/src/queues.ts.
import { CHANNELS, type DomainEvent, KEYS, type KillMsg, type OraclePriceMsg, type QuoteMsg } from "@bookrunner/shared";
import type { Redis } from "ioredis";
import type { BusPort } from "../ports";
import type { LiveNav, QuoteObservation, RiskStatePayload } from "../types";
import { withTimeout } from "../util/async";

export class RedisBus implements BusPort {
  constructor(
    private readonly redis: Redis,
    private readonly timeoutMs: number,
  ) {}

  private t<T>(p: Promise<T>, label: string): Promise<T> {
    return withTimeout(p, this.timeoutMs, `redis ${label}`);
  }

  private async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.t(this.redis.get(key), `GET ${key}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async latestQuote(bookId: number): Promise<QuoteObservation | null> {
    return parseQuote(await this.getJson<unknown>(KEYS.agentQuote(bookId)));
  }

  async oracleLast(priceId: string): Promise<OraclePriceMsg | null> {
    const m = await this.getJson<OraclePriceMsg>(KEYS.oracleLast(priceId));
    return m && typeof m.publishedAt === "number" ? m : null;
  }

  async loadRiskState(bookId: number): Promise<RiskStatePayload | null> {
    const p = await this.getJson<RiskStatePayload>(KEYS.riskState(bookId));
    return p && typeof p === "object" && p.meta && typeof p.meta === "object" ? p : null;
  }

  async saveRiskState(bookId: number, payload: RiskStatePayload): Promise<void> {
    const s = JSON.stringify(payload);
    await this.t(this.redis.multi().set(KEYS.riskState(bookId), s).publish(CHANNELS.riskState(bookId), s).exec(), "SET+PUBLISH riskState");
  }

  async saveLiveNav(bookId: number, nav: LiveNav): Promise<void> {
    await this.t(this.redis.set(KEYS.liveNav(bookId), JSON.stringify(nav)), "SET liveNav");
  }

  async publishKill(bookId: number, msg: KillMsg): Promise<void> {
    await this.t(this.redis.publish(CHANNELS.kill(bookId), JSON.stringify(msg)), "PUBLISH kill");
  }

  async publishDomainEvent(evt: DomainEvent): Promise<void> {
    const body = { id: evt.id, type: evt.type, createdAt: evt.createdAt, data: evt.data };
    await this.t(this.redis.publish(CHANNELS.domainEvents, JSON.stringify(body)), "PUBLISH domainEvents");
  }
}

/** QuoteMsg (bookrunner-agent) -> the fields the risk check needs; null if malformed. */
export function parseQuote(v: unknown): QuoteObservation | null {
  if (!v || typeof v !== "object") return null;
  const q = v as Partial<QuoteMsg>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const ts = num(q.ts);
  const bid = num(q.bid);
  const ask = num(q.ask);
  if (ts === null || bid === null || ask === null) return null;
  return {
    ts,
    bid,
    ask,
    oracle: num(q.oracle) ?? 0,
    sides: { bid: q.sides?.bid !== false, ask: q.sides?.ask !== false },
  };
}
