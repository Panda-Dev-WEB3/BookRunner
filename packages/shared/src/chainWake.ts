// "Read the chain when something happened, not on a timer" (RPC budget, deploy/server/MAINNET.md "RPC budget").
// A ChainWake pairs a log subscription (logSubscription.ts: eth_subscribe "logs" on the contracts a poll loop looks at)
// with a slow safety poll. While the subscription is up, the loop's chain reads are due only after a notification (a
// contract it watches emitted a log) or once `safetyMs` has passed; while it is down, with no WebSocket URL, or while
// the primary RPC is failing (rpcRoute.ts: the subscription stays down then), they are due every `pollMs`: exactly
// the polling the loop did before. A notification is only a trigger, never a data source: the loop's own canonical
// read (bookIds(), eth_getLogs from its cursor) decides what happened, so a missed notification or a dead socket costs
// latency (at most `safetyMs`), never data. Only chain reads are gated: everything else a loop does (Redis, Orderly,
// its own bookkeeping) keeps its own cadence.
import { LogSubscription, type LogFilter, type SubscriptionLogger, type WsFactory } from "./logSubscription";

export interface ChainWakeOptions {
  /** WebSocket URL (carries the provider key: never logged); null = polling only */
  url: string | null;
  /** shown in logs instead of the URL */
  label: string;
  /** the contracts to watch; read again at start() and on refreshFilter() (a new book was added) */
  filter: () => LogFilter;
  /** chain reads this often without a subscription (the loop's normal poll) */
  pollMs: number;
  /** chain reads at least this often with a subscription up */
  safetyMs: number;
  /** a notification makes a read due, but never sooner than this after the previous one (a busy contract must not cost more than polling; default 5 s) */
  minGapMs?: number;
  log?: SubscriptionLogger;
  ws?: WsFactory;
  now?: () => number;
}

export class ChainWake {
  private sub: LogSubscription | null = null;
  private readonly now: () => number;
  private dirty = true;
  private lastRun = Number.NEGATIVE_INFINITY;
  private wakers = new Set<() => void>();

  constructor(private readonly o: ChainWakeOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Opens the subscription (reads `filter()` now, not at construction). No-op without a WebSocket URL. */
  start(): void {
    if (!this.o.url || this.sub) return;
    this.sub = new LogSubscription({
      url: this.o.url,
      label: this.o.label,
      filter: this.o.filter(),
      ...(this.o.log ? { log: this.o.log } : {}),
      ...(this.o.ws ? { ws: this.o.ws } : {}),
      onLogs: (logs) => {
        if (logs.length > 0) this.touch();
      },
      onState: (up) => {
        if (up) this.touch(); // catch up on what happened while it was down
      },
    });
    this.sub.start();
  }

  stop(): void {
    this.sub?.stop();
    this.sub = null;
    this.wakers.clear();
  }

  /** The watched contracts changed (e.g. a book was added): resubscribe; the new set is read at once. */
  refreshFilter(): void {
    this.sub?.setFilter(this.o.filter());
  }

  /** Subscribed right now: notifications will arrive. */
  get subscribed(): boolean {
    return this.sub?.up ?? false;
  }

  /** Something may have changed: the next due() is true. */
  touch(): void {
    this.dirty = true;
    for (const fn of [...this.wakers]) {
      try {
        fn();
      } catch {
        // a waker never breaks the notification path
      }
    }
  }

  /** Called on a notification (a loop sleeping between polls wakes up early). Returns the remover. */
  onWake(fn: () => void): () => void {
    this.wakers.add(fn);
    return () => void this.wakers.delete(fn);
  }

  /** Is a chain read due now? */
  due(now = this.now()): boolean {
    if (!this.subscribed) return now - this.lastRun >= this.o.pollMs;
    return (this.dirty && now - this.lastRun >= (this.o.minGapMs ?? 5_000)) || now - this.lastRun >= this.o.safetyMs;
  }

  /** The chain read starts now (anything notified from here on makes the next one due). */
  begin(now = this.now()): void {
    this.dirty = false;
    this.lastRun = now;
  }

  /** The chain read failed: it is due again at once (the loop's own backoff paces the retry). */
  failed(): void {
    this.dirty = true;
  }
}
