// Redis adapter: latest quote + heartbeat keys, quote/fill channels, subscriptions (oracle price,
// risk state, kill). Two connections: commands and a dedicated subscriber.

import { CHANNELS, type FillMsg, KEYS, type Logger, type QuoteMsg } from "@bookrunner/shared";
import { Redis } from "ioredis";

export interface AgentBus {
  publishQuote(q: QuoteMsg, ttlMs: number): Promise<void>;
  clearQuote(bookId: number): Promise<void>;
  publishFill(f: FillMsg): Promise<void>;
  heartbeat(bookId: number, ttlMs: number): Promise<void>;
  getJson<T>(key: string): Promise<T | null>;
  subscribe(channel: string, handler: (raw: string) => void): Promise<void>;
  close(): Promise<void>;
}

export class RedisBus implements AgentBus {
  private readonly cmd: Redis;
  private readonly sub: Redis;
  private readonly handlers = new Map<string, Array<(raw: string) => void>>();

  constructor(url: string, private readonly log: Logger) {
    const opts = { maxRetriesPerRequest: 2, enableOfflineQueue: true, retryStrategy: (n: number) => Math.min(30_000, 500 * 2 ** Math.min(n, 6)) };
    this.cmd = new Redis(url, opts);
    this.sub = new Redis(url, { ...opts, maxRetriesPerRequest: null });
    for (const [name, c] of [["cmd", this.cmd], ["sub", this.sub]] as const) {
      c.on("error", (err: Error) => this.log.warn({ conn: name, err: err.message }, "redis error"));
    }
    this.sub.on("message", (channel: string, message: string) => {
      for (const h of this.handlers.get(channel) ?? []) {
        try {
          h(message);
        } catch (err) {
          this.log.warn({ channel, err: String(err) }, "redis handler failed");
        }
      }
    });
  }

  async publishQuote(q: QuoteMsg, ttlMs: number): Promise<void> {
    const body = JSON.stringify(q);
    await this.cmd.set(KEYS.agentQuote(q.bookId), body, "PX", Math.max(1_000, Math.floor(ttlMs)));
    await this.cmd.publish(CHANNELS.quotes(q.bookId), body);
  }

  async clearQuote(bookId: number): Promise<void> {
    await this.cmd.del(KEYS.agentQuote(bookId));
  }

  async publishFill(f: FillMsg): Promise<void> {
    await this.cmd.publish(CHANNELS.fills(f.bookId), JSON.stringify(f));
  }

  async heartbeat(bookId: number, ttlMs: number): Promise<void> {
    await this.cmd.set(KEYS.agentHeartbeat(bookId), String(Date.now()), "PX", Math.max(1_000, Math.floor(ttlMs)));
  }

  async getJson<T>(key: string): Promise<T | null> {
    const v = await this.cmd.get(key);
    if (!v) return null;
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }

  async subscribe(channel: string, handler: (raw: string) => void): Promise<void> {
    const list = this.handlers.get(channel) ?? [];
    list.push(handler);
    this.handlers.set(channel, list);
    if (list.length === 1) await this.sub.subscribe(channel);
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.sub.quit(), this.cmd.quit()]);
  }
}
