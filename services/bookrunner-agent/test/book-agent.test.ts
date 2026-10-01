import { describe, expect, test } from "bun:test";
import {
  type BookState,
  type Mandate,
  type OraclePriceMsg,
  type QuotingVenue,
  RECEIPT_KIND,
  SESSIONS_24X7,
  type TwoSidedQuote,
  type VenueAccount,
  type VenueFill,
  checkQuote,
  usd,
} from "@bookrunner/shared";
import { zeroHash } from "viem";
import { type AgentChain, BookAgent, type BookAgentConfig } from "../src/agent/book-agent";
import type { HedgeCycleContext, HedgeCycleRunner } from "../src/agent/hedger";
import { PriceFeed } from "../src/agent/price-feed";
import type { HedgePlan } from "../src/domain/hedge-planner";
import { DEFAULT_QUOTING_CONFIG } from "../src/domain/quoting";
import { RuleBasedSizing } from "../src/domain/sizing";
import { DEFAULT_VOL_CONFIG, EwmaVolatility } from "../src/domain/volatility";
import { FakeBus, FakeStore, nvdaMandate, silentLog } from "./helpers";

class FakeVenue implements QuotingVenue {
  kind: "orderly" | "engine" = "orderly";
  replaced: TwoSidedQuote[] = [];
  cancels = 0;
  exposure = 0n;
  fills: VenueFill[] = [];
  async replaceQuote(q: TwoSidedQuote): Promise<void> {
    this.replaced.push(q);
  }
  async cancelAll(): Promise<void> {
    this.cancels++;
  }
  async account(): Promise<VenueAccount> {
    return {
      equityUsd: usd(75_000),
      freeCollateralUsd: usd(75_000),
      position: { symbol: "PERP_NVDA_USDC", netQty: 0, avgPx: 0, markPx: 190, netExposureUsd: this.exposure, unrealizedPnlUsd: 0n },
    };
  }
  async fillsSince(since: number): Promise<VenueFill[]> {
    return this.fills.filter((f) => f.ts >= since);
  }
}

class FakeChain implements AgentChain {
  mandate: Mandate = nvdaMandate();
  killed = false;
  off = false;
  state: BookState = "Live";
  async readMandate() {
    return this.mandate;
  }
  async mandateKilled() {
    return this.killed;
  }
  async mandateOffHours() {
    return this.off;
  }
  async bookState() {
    return this.state;
  }
}

class FakeHedger implements HedgeCycleRunner {
  calls: HedgeCycleContext[] = [];
  async cycle(ctx: HedgeCycleContext): Promise<HedgePlan> {
    this.calls.push(ctx);
    return { action: "none", reason: "TEST", ratioBefore: null, ratioAfter: null, targetHedgeUsd: 0n, legs: [] };
  }
}

const cfg: BookAgentConfig = {
  quoting: DEFAULT_QUOTING_CONFIG,
  quoteIntervalMs: 5,
  stateRefreshMs: 5,
  fillPollMs: 5,
  hedgeIntervalMs: 5,
  priceStaleSec: 30,
  chainPriceFallbackSec: 10,
  maxPriceAgeSec: 300,
  requoteBps: 1,
  requoteSizeFrac: 0.2,
  requoteMaxMs: 10_000,
  quoteSampleMs: 1_000,
  quoteReceiptMs: 5_000,
  receiptsIntervalSec: 60,
  heartbeatTtlMs: 60_000,
  quoteTtlMs: 10_000,
  fillLookbackMs: 60_000,
};

function priceMsg(price: number, publishedAt: number, held = false): OraclePriceMsg {
  return { priceId: "NVDA", underlying: zeroHash, priceWad: "0", price, publishedAt, held, sourceCount: 3, sources: [], sourcesHash: zeroHash, signature: "0x" };
}

function setup(opts: { hedger?: boolean } = {}) {
  let now = 1_760_000_000_000;
  const venue = new FakeVenue();
  const chain = new FakeChain();
  const bus = new FakeBus();
  const store = new FakeStore();
  const vol = new EwmaVolatility(DEFAULT_VOL_CONFIG);
  const price = new PriceFeed("NVDA", vol);
  price.ingest(priceMsg(190, now / 1000));
  const hedger = opts.hedger ? new FakeHedger() : null;
  const agent = new BookAgent(
    { bookId: 1, venue, chain, price, vol, sizing: new RuleBasedSizing(), store, bus, hedger, sessions: SESSIONS_24X7, initialMandate: chain.mandate, log: silentLog, now: () => now },
    cfg,
  );
  return { agent, venue, chain, bus, store, price, hedger, advance: (ms: number) => (now += ms), now: () => now };
}

describe("BookAgent quoting", () => {
  test("places a mandate-compliant two-sided quote, publishes it and records a sampled row + receipt", async () => {
    const { agent, venue, bus, store } = setup();
    await agent.refreshState();
    await agent.quoteTick();
    expect(venue.replaced.length).toBe(1);
    const q = venue.replaced[0]!;
    expect(q.bid && q.ask).toBeTruthy();
    expect(checkQuote(nvdaMandate(), { bidPx: q.bid!.px, askPx: q.ask!.px, oraclePx: 190 }).ok).toBe(true);
    expect(bus.quotes.length).toBe(1);
    expect(bus.quotes[0]!.sides).toEqual({ bid: true, ask: true });
    expect(bus.heartbeats).toBe(1);
    expect(store.quotes.length).toBe(1);
    expect(store.quotes[0]!.receipt?.kind).toBe(RECEIPT_KIND.QUOTE);
  });

  test("cancel/replace only on material change; sampling throttles persistence", async () => {
    const { agent, venue, store, price, advance, now } = setup();
    await agent.refreshState();
    await agent.quoteTick();
    advance(200);
    await agent.quoteTick();
    expect(venue.replaced.length).toBe(1); // unchanged
    expect(store.quotes.length).toBe(1); // within 1s sample window
    advance(900);
    price.ingest(priceMsg(190 * 1.0005, now() / 1000)); // +5 bps
    await agent.quoteTick();
    expect(venue.replaced.length).toBe(2);
    expect(store.quotes.length).toBe(2);
    expect(store.quotes[1]!.receipt).toBeNull(); // receipts every 5s or on side changes
  });

  test("stale price cancels once and stops quoting", async () => {
    const { agent, venue, advance } = setup();
    await agent.refreshState();
    await agent.quoteTick();
    advance(31_000);
    await agent.quoteTick();
    await agent.quoteTick();
    expect(venue.cancels).toBe(1);
    expect(venue.replaced.length).toBe(1);
  });

  test("off-hours (held print) with long inventory quotes only the reducing side", async () => {
    const { agent, venue, price, now } = setup();
    venue.exposure = usd(10_000);
    price.ingest(priceMsg(190, now() / 1000 + 1, true));
    await agent.refreshState();
    await agent.quoteTick();
    const q = venue.replaced.at(-1)!;
    expect(q.bid).toBeUndefined();
    expect(q.ask).toBeDefined();
    expect(q.reduceOnly).toBe(true);
  });

  test("risk breach switches to reduce-only immediately", async () => {
    const { agent, venue } = setup();
    venue.exposure = -usd(12_000);
    await agent.refreshState();
    await agent.quoteTick();
    expect(venue.replaced.at(-1)!.ask).toBeDefined();
    agent.onRiskState(JSON.stringify({ state: "breach", breaches: ["SKEW"] }));
    await Bun.sleep(25);
    const q = venue.replaced.at(-1)!;
    expect(q.ask).toBeUndefined();
    expect(q.bid).toBeDefined();
  });

  test("repeated venue account failures pull the resting quote", async () => {
    const { agent, venue } = setup();
    await agent.refreshState();
    await agent.quoteTick();
    venue.account = async () => {
      throw new Error("venue down");
    };
    for (let i = 0; i < 3; i++) await expect(agent.quoteTick()).rejects.toThrow("venue down");
    expect(venue.cancels).toBe(1);
  });

  test("book not live: idle without quotes", async () => {
    const { agent, venue, chain } = setup();
    chain.state = "Subscription";
    await agent.refreshState();
    await agent.quoteTick();
    expect(venue.replaced.length).toBe(0);
  });
});

describe("BookAgent kill logic", () => {
  test("kill message: cancel-all, halt, never quote again", async () => {
    const { agent, venue, bus } = setup();
    await agent.refreshState();
    await agent.quoteTick();
    agent.onKill(JSON.stringify({ bookId: 1, ts: 0, reason: "DRAWDOWN", breaches: ["DRAWDOWN"] }));
    const res = await agent.run();
    expect(res).toEqual({ halted: true, reason: "KILL_MSG:DRAWDOWN" });
    expect(venue.cancels).toBeGreaterThanOrEqual(1);
    expect(bus.cleared).toBeGreaterThanOrEqual(1);
    const placed = venue.replaced.length;
    await agent.quoteTick();
    expect(venue.replaced.length).toBe(placed);
  });

  test("kill messages for other books are ignored", async () => {
    const { agent } = setup();
    agent.onKill(JSON.stringify({ bookId: 2, ts: 0, reason: "X", breaches: [] }));
    expect(agent.halted).toBeNull();
  });

  test("mandate.killed() on refresh halts the loops", async () => {
    const { agent, chain, venue } = setup();
    chain.killed = true;
    const res = await agent.run();
    expect(res.halted).toBe(true);
    expect(res.reason).toBe("MANDATE_KILLED");
    expect(venue.cancels).toBeGreaterThanOrEqual(1);
  });

  test("risk state 'killed' halts", async () => {
    const { agent } = setup();
    agent.onRiskState(JSON.stringify({ state: "killed" }));
    const res = await agent.run();
    expect(res).toEqual({ halted: true, reason: "RISK_KILLED" });
  });

  test("graceful stop exits the loops and cancels resting quotes", async () => {
    const { agent, venue } = setup();
    setTimeout(() => agent.stop(), 40);
    const res = await agent.run();
    expect(res).toEqual({ halted: false, reason: "SHUTDOWN" });
    expect(venue.replaced.length).toBeGreaterThanOrEqual(1);
    expect(venue.cancels).toBeGreaterThanOrEqual(1);
  });
});

describe("BookAgent fills and hedging", () => {
  const fill = (id: string, ts: number): VenueFill => ({ tradeId: id, symbol: "PERP_NVDA_USDC", side: "buy", qty: 1, px: 190, feeUsd: 0.02, ts, maker: true });

  test("fills are persisted with receipts and published once; a DB failure is retried", async () => {
    const { agent, venue, store, bus, now } = setup();
    venue.fills = [fill("t1", now() - 1_000), fill("t2", now() - 500)];
    store.failFills = 1;
    await agent.fillsTick();
    expect(bus.fills.length).toBe(2);
    expect(store.fills.length).toBe(0);
    await agent.fillsTick();
    expect(store.fills.map((f) => f.venueTradeId)).toEqual(["t1", "t2"]);
    expect(store.fillReceipts.length).toBe(2);
    expect(store.fillReceipts.every((r) => r.kind === RECEIPT_KIND.FILL)).toBe(true);
    await agent.fillsTick();
    expect(bus.fills.length).toBe(2);
    expect(store.fills.length).toBe(2);
  });

  test("hedging uses the adapter exposure and blocks hedge-adding legs on a stale valuation", async () => {
    const { agent, chain, hedger, now } = setup({ hedger: true });
    const c = chain as FakeChain & { venueExposureUsd?: () => Promise<bigint>; venueValuationAt?: () => Promise<number> };
    c.venueExposureUsd = async () => -usd(33_000);
    c.venueValuationAt = async () => now() / 1000 - 2_000; // > 4 * maxPriceAge (300s)
    await agent.refreshState();
    await agent.hedgeTick();
    expect(hedger!.calls[0]).toMatchObject({ netExposureUsd: -usd(33_000), allowAddHedge: false });
    c.venueValuationAt = async () => now() / 1000 - 10;
    await agent.hedgeTick();
    expect(hedger!.calls[1]!.allowAddHedge).toBe(true);
  });

  test("hedge mode follows the book: normal when live, flatten when Retiring, off when killed", async () => {
    const { agent, chain, hedger } = setup({ hedger: true });
    await agent.refreshState();
    await agent.hedgeTick();
    chain.state = "Retiring";
    await agent.refreshState();
    await agent.hedgeTick();
    expect(hedger!.calls.map((c) => c.mode)).toEqual(["normal", "flatten"]);
    agent.onRiskState(JSON.stringify({ state: "killed" }));
    await agent.hedgeTick();
    expect(hedger!.calls.length).toBe(2);
  });
});
