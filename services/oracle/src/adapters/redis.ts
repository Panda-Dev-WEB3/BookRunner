// Redis publication: latest message under KEYS.oracleLast(priceId), fan-out on CHANNELS.oraclePrice,
// and the pull-oracle bundle under KEYS.oracleBundle (expires with the oracle: no stale bundle survives it).
import { CHANNELS, KEYS, type Logger, type OracleBundleMsg, type OraclePriceMsg } from "@bookrunner/shared";
import { Redis } from "ioredis";

export interface BundlePublication {
  msg: OracleBundleMsg;
  /** key expiry: consumers fall back to their non-pull path once the oracle stops publishing */
  ttlMs: number;
}

export interface PricePublisher {
  /** One round trip: per-price keys + channels and (when given) the signed bundle. */
  publish(msgs: readonly OraclePriceMsg[], bundle?: BundlePublication | null): Promise<void>;
  loadLast(priceId: string): Promise<OraclePriceMsg | null>;
}

export function createRedis(url: string, log: Logger): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false, // fail fast while disconnected; the tick loop just logs and moves on
    retryStrategy: (times) => Math.min(250 * 2 ** Math.min(times, 5), 5_000),
  });
  let lastLog = 0;
  redis.on("error", (err) => {
    const now = Date.now();
    if (now - lastLog > 30_000) {
      lastLog = now;
      log.warn({ err: err.message }, "redis connection error (retrying)");
    }
  });
  redis.on("ready", () => log.info("redis ready"));
  return redis;
}

export class RedisPricePublisher implements PricePublisher {
  constructor(private readonly redis: Redis) {}

  async publish(msgs: readonly OraclePriceMsg[], bundle?: BundlePublication | null): Promise<void> {
    if (msgs.length === 0 && !bundle) return;
    const p = this.redis.pipeline();
    for (const m of msgs) {
      const json = JSON.stringify(m);
      p.set(KEYS.oracleLast(m.priceId), json);
      p.publish(CHANNELS.oraclePrice(m.priceId), json);
    }
    if (bundle) p.set(KEYS.oracleBundle, JSON.stringify(bundle.msg), "PX", Math.max(1_000, Math.floor(bundle.ttlMs)));
    const res = await p.exec();
    const failed = res?.find(([err]) => err);
    if (failed?.[0]) throw failed[0];
  }

  async loadLast(priceId: string): Promise<OraclePriceMsg | null> {
    const raw = await this.redis.get(KEYS.oracleLast(priceId));
    if (!raw) return null;
    try {
      const m = JSON.parse(raw) as OraclePriceMsg;
      return typeof m.price === "number" && Array.isArray(m.sources) ? m : null;
    } catch {
      return null;
    }
  }
}
