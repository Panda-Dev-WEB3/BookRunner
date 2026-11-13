// Trading page v2 (2026-11): records the oracle's signed price of each open engine market into one-minute OHLC candles
// (engine_price_1m), the source of trade.history. It reads the same signed source the trading reads use (the oracle's
// bundle in Redis, re-read at most once a second per process), so it adds no oracle or chain traffic beyond one
// engine-market read per market every MARKETS_REFRESH_MS (market id and underlying never change for an adapter).
// A print is recorded once (newer publishedAt only); the candle upsert commutes, so two API processes recording
// the same market stay consistent. Retention: minutes older than retentionDays are pruned hourly. Never throws.
import { signedPriceFor } from "@bookrunner/shared/signedPrice";
import type { Address, Hex } from "viem";
import type { PriceHistoryStore } from "./data/types";
import type { ApiDeps } from "./deps";
import { engineBooks, signedSource } from "./routers/trade";

export const MARKETS_REFRESH_MS = 5 * 60_000;
export const PRUNE_EVERY_MS = 60 * 60_000;

interface Tracked {
  marketId: number;
  underlying: Hex;
}

export class PriceRecorder {
  private markets: { at: number; list: Tracked[] } | null = null;
  private readonly last = new Map<string, number>();
  private lastPrune = Number.NEGATIVE_INFINITY;
  private lastWarn = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly d: {
      deps: ApiDeps;
      store: PriceHistoryStore;
      sampleMs: number;
      retentionDays: number;
    },
  ) {}

  /** The open engine markets (Live / Retiring engine books), re-read every MARKETS_REFRESH_MS. */
  private async tracked(): Promise<Tracked[]> {
    const { deps } = this.d;
    const now = deps.now();
    if (this.markets && now - this.markets.at < MARKETS_REFRESH_MS) return this.markets.list;
    const gw = deps.chain();
    if (!gw) return [];
    const books = await engineBooks(deps);
    const chains = await Promise.all(books.map((b) => gw.engineMarket(b.adapterAddr as Address)));
    const list = chains.flatMap((c) => (c ? [{ marketId: c.marketId, underlying: c.config.underlying }] : []));
    this.markets = { at: now, list };
    return list;
  }

  /** One sampling pass: the freshest signed print of every open market into its minute. Returns the prints recorded. */
  async tick(): Promise<number> {
    const { deps, store } = this.d;
    let n = 0;
    try {
      // retention first: it runs whether or not a market is open
      if (deps.now() - this.lastPrune >= PRUNE_EVERY_MS) {
        this.lastPrune = deps.now();
        const removed = await store.prunePrices(new Date(deps.now() - this.d.retentionDays * 86_400_000));
        if (removed > 0) deps.log.info({ removed, retentionDays: this.d.retentionDays }, "price history pruned");
      }
      const gw = deps.chain();
      if (!gw) return 0;
      const markets = await this.tracked();
      if (markets.length === 0) return 0;
      const src = await signedSource(deps);
      for (const m of markets) {
        const signed = signedPriceFor(src.bundle, src.messages, m.underlying, { chainId: gw.chainId, oracle: gw.deployment.contracts.oracle });
        if (!signed) continue;
        const publishedAt = Number(signed.update.publishedAt);
        const key = `${m.marketId}:${m.underlying.toLowerCase()}`;
        if (publishedAt <= (this.last.get(key) ?? 0)) continue;
        await store.recordPrice({ marketId: m.marketId, underlying: m.underlying, priceWad: signed.update.priceWad, publishedAt, held: signed.update.held });
        this.last.set(key, publishedAt);
        n++;
      }
    } catch (err) {
      if (deps.now() - this.lastWarn > 60_000) {
        this.lastWarn = deps.now();
        deps.log.warn({ err }, "price history sample failed (retrying next pass)");
      }
    }
    return n;
  }

  start(): void {
    if (this.d.sampleMs <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.tick().finally(() => {
        this.running = false;
      });
    }, this.d.sampleMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
