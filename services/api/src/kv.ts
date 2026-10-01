// Minimal key-value surface the API needs from Redis (live state written by other services + a
// short-TTL cache for chain reads). Redis errors degrade to cache misses; they never fail a request.
import superjson from "superjson";

export interface Kv {
  get(key: string): Promise<string | null>;
  mget(keys: string[]): Promise<Array<string | null>>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Keys matching a glob pattern (SCAN, bounded). */
  scan(pattern: string, max?: number): Promise<string[]>;
}

/** Structural subset of an ioredis client used by RedisKv (keeps tests free of a Redis dependency). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
  scan(cursor: string, matchToken: "MATCH", pattern: string, countToken: "COUNT", count: number): Promise<[string, string[]]>;
}

export class RedisKv implements Kv {
  constructor(
    private readonly redis: RedisLike,
    private readonly onError: (err: unknown, op: string) => void = () => {},
  ) {}

  async get(key: string) {
    try {
      return await this.redis.get(key);
    } catch (err) {
      this.onError(err, "get");
      return null;
    }
  }

  async mget(keys: string[]) {
    if (keys.length === 0) return [];
    try {
      return await this.redis.mget(...keys);
    } catch (err) {
      this.onError(err, "mget");
      return keys.map(() => null);
    }
  }

  async set(key: string, value: string, ttlSeconds: number) {
    if (ttlSeconds <= 0) return;
    try {
      await this.redis.set(key, value, "EX", ttlSeconds);
    } catch (err) {
      this.onError(err, "set");
    }
  }

  async scan(pattern: string, max = 1000) {
    const out = new Set<string>();
    try {
      let cursor = "0";
      do {
        const [next, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
        for (const k of keys) out.add(k);
        cursor = next;
      } while (cursor !== "0" && out.size < max);
    } catch (err) {
      this.onError(err, "scan");
    }
    return [...out].slice(0, max);
  }
}

/** In-memory Kv (tests, and a fallback when Redis is not configured). */
export class MemoryKv implements Kv {
  private readonly map = new Map<string, { v: string; exp: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string) {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.exp && e.exp <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return e.v;
  }
  async mget(keys: string[]) {
    return Promise.all(keys.map((k) => this.get(k)));
  }
  async set(key: string, value: string, ttlSeconds: number) {
    this.map.set(key, { v: value, exp: ttlSeconds > 0 ? this.now() + ttlSeconds * 1000 : 0 });
  }
  /** Test helper: set without expiry. */
  put(key: string, value: unknown) {
    this.map.set(key, { v: typeof value === "string" ? value : JSON.stringify(value), exp: 0 });
  }
  async scan(pattern: string, max = 1000) {
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    return [...this.map.keys()].filter((k) => re.test(k)).slice(0, max);
  }
}

export const CACHE_PREFIX = "bkrn:api:cache:";

/** Read-through cache with superjson (bigint-safe). ttl 0 disables caching. */
export async function cached<T>(kv: Kv, key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  const k = CACHE_PREFIX + key;
  if (ttlSeconds > 0) {
    const hit = await kv.get(k);
    if (hit != null) {
      try {
        return superjson.parse<T>(hit);
      } catch {
        // corrupt entry: reload
      }
    }
  }
  const v = await load();
  if (ttlSeconds > 0) await kv.set(k, superjson.stringify(v), ttlSeconds);
  return v;
}

/** Parses a JSON value stored by another service; null on absence or malformed JSON. */
export function parseJson<T = unknown>(raw: string | null | undefined): T | null {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
