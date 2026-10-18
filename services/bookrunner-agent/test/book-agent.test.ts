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
  KEYS,
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
import { loadAgentEnv, resolveVenuePostOnlyQuote } from "../src/config";
import { MockOrderlyHttpVenue } from "../src/venues/orderly";
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

describe("BookAgent Orderly market gate (ops-venue listing check, VERIFY O20)", () => {
  // ops-venue's KEYS.venueSymbolIssues markets, as built from testnet-like /v1/public/info rows
  const market = (phase: string, venueStatus: string | null, bookIds = [1]) => ({
    v: 1,
    ts: 1,
    mode: "live",
    books: [],
    listingMode: "manual",
    markets: [{ symbol: "PERP_NVDA_USDC_bookrunner", bookIds, phase, venueStatus, openForRisk: phase === "listed" && (venueStatus === null || venueStatus === "ACTIVE"), everListed: phase !== "awaiting", since: 1, checkedAt: 1, failures: 0, error: null }],
  });
  const long = async (issues: unknown, o: { kind?: "orderly" | "engine"; allowPostOnly?: boolean } = {}) => {
    const t = setup();
    if (o.kind) t.venue.kind = o.kind;
    if (o.allowPostOnly !== undefined) (t.agent as unknown as { cfg: BookAgentConfig }).cfg.venueGate = { enabled: true, allowPostOnly: o.allowPostOnly };
    t.venue.exposure = usd(10_000); // long inventory: reduce-only = ask side only
    if (issues !== undefined) t.bus.kv.set(KEYS.venueSymbolIssues, issues);
    await t.agent.refreshState();
    await t.agent.quoteTick();
    return { ...t, q: t.venue.replaced.at(-1) };
  };

  test("not listed / missing / REDUCE_ONLY / DELISTING / POST_ONLY / undocumented: reduce-only quotes", async () => {
    for (const [phase, status] of [["awaiting", null], ["awaiting", "PENDING"], ["missing", null], ["listed", "REDUCE_ONLY"], ["listed", "DELISTING"], ["listed", "DELISTED"], ["listed", "POST_ONLY"], ["listed", "HALTED"]] as const) {
      const { q } = await long(market(phase, status));
      expect([phase, status, q?.bid, q?.reduceOnly]).toEqual([phase, status, undefined, true]);
      expect(q?.ask).toBeDefined();
    }
  });

  test("ACTIVE, a row without status, no entry for the book, unknown phase, no key, malformed key: unchanged two-sided quoting", async () => {
    for (const issues of [market("listed", "ACTIVE"), market("listed", null), market("awaiting", null, [2]), market("unknown", null), undefined, "{not json", { markets: "x" }]) {
      const { q } = await long(issues);
      expect(q?.bid).toBeDefined();
      expect(q?.ask).toBeDefined();
    }
  });

  test("POST_ONLY allowed (live default): both sides, maker-only; restricted / unlisted still reduce-only; engine never gated", async () => {
    const po = await long(market("listed", "POST_ONLY"), { allowPostOnly: true });
    expect([!!po.q?.bid, !!po.q?.ask, po.q?.postOnly, !!po.q?.reduceOnly]).toEqual([true, true, true, false]);
    for (const [phase, status] of [["listed", "REDUCE_ONLY"], ["listed", "DELISTING"], ["listed", "DELISTED"], ["missing", null], ["awaiting", null]] as const) {
      const { q } = await long(market(phase, status), { allowPostOnly: true });
      expect([phase, status, q?.bid, q?.reduceOnly, q?.postOnly]).toEqual([phase, status, undefined, true, undefined]);
    }
    const active = await long(market("listed", "ACTIVE"), { allowPostOnly: true });
    expect(active.q?.postOnly).toBeUndefined();
    expect((await long(market("awaiting", null), { kind: "engine" })).q?.bid).toBeDefined();
  });

  test("leaving POST_ONLY re-quotes as plain limit orders", async () => {
    const t = setup();
    (t.agent as unknown as { cfg: BookAgentConfig }).cfg.venueGate = { enabled: true, allowPostOnly: true };
    t.bus.kv.set(KEYS.venueSymbolIssues, market("listed", "POST_ONLY"));
    await t.agent.refreshState();
    await t.agent.quoteTick();
    expect(t.venue.replaced.at(-1)?.postOnly).toBe(true);
    t.bus.kv.set(KEYS.venueSymbolIssues, market("listed", "ACTIVE"));
    await t.agent.refreshState();
    await t.agent.quoteTick();
    expect(t.venue.replaced.length).toBe(2);
    expect(t.venue.replaced.at(-1)?.postOnly).toBeUndefined();
  });

  test("AGENT_VENUE_POST_ONLY_QUOTE: default true with ORDERLY_MODE=live, false in mock mode, overridable", () => {
    expect(resolveVenuePostOnlyQuote(loadAgentEnv({ ORDERLY_MODE: "live" }))).toBe(true);
    expect(resolveVenuePostOnlyQuote(loadAgentEnv({ ORDERLY_MODE: "mock" }))).toBe(false);
    expect(resolveVenuePostOnlyQuote(loadAgentEnv({ ORDERLY_MODE: "live", AGENT_VENUE_POST_ONLY_QUOTE: "false" }))).toBe(false);
    expect(resolveVenuePostOnlyQuote(loadAgentEnv({ ORDERLY_MODE: "mock", AGENT_VENUE_POST_ONLY_QUOTE: "true" }))).toBe(true);
  });

  test("the mock-orderly fallback venue sends POST_ONLY orders for a postOnly quote, LIMIT otherwise (ops-venue's OrderlyVenue: POST_ONLY whatever its configured type)", async () => {
    const bodies: Array<{ orders: Array<{ order_type: string; side: string }> }> = [];
    const v = new MockOrderlyHttpVenue({ baseUrl: "http://orderly.test", accountId: "0xabc", bookId: 1, symbol: "PERP_NVDA_USDC_bookrunner" }, async (_url, init) => {
      if (init?.method === "POST") bodies.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: {} }) };
    });
    await v.replaceQuote({ bid: { px: 189, qty: 1 }, ask: { px: 191, qty: 1 }, postOnly: true });
    await v.replaceQuote({ bid: { px: 189, qty: 1 }, ask: { px: 191, qty: 1 } });
    expect(bodies.map((b) => b.orders.map((o) => o.order_type))).toEqual([["POST_ONLY", "POST_ONLY"], ["LIMIT", "LIMIT"]]);
  });

  test("the gate applies at the next state refresh and lifts once the market is open; hedging follows (reduce_only)", async () => {
    const t = setup({ hedger: true });
    t.venue.exposure = usd(10_000);
    t.bus.kv.set(KEYS.venueSymbolIssues, market("listed", "ACTIVE"));
    await t.agent.refreshState();
    await t.agent.quoteTick();
    await t.agent.hedgeTick();
    expect(t.venue.replaced.at(-1)?.bid).toBeDefined();
    t.bus.kv.set(KEYS.venueSymbolIssues, market("listed", "REDUCE_ONLY"));
    await t.agent.refreshState();
    await Bun.sleep(25); // the gate change triggers a quote tick at once
    expect(t.venue.replaced.at(-1)?.bid).toBeUndefined();
    await t.agent.hedgeTick();
    t.bus.kv.set(KEYS.venueSymbolIssues, market("listed", "ACTIVE"));
    await t.agent.refreshState();
    await t.agent.quoteTick();
    await t.agent.hedgeTick();
    expect(t.venue.replaced.at(-1)?.bid).toBeDefined();
    expect(t.hedger!.calls.map((c) => c.mode)).toEqual(["normal", "reduce_only", "normal"]);
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

  test("stop() during a hedge cycle: the cycle sees the abort, run() returns once it finishes, nothing new starts", async () => {
    const { agent, hedger, venue } = setup({ hedger: true });
    let release!: () => void;
    const inFlight = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    hedger!.cycle = async (ctx) => {
      hedger!.calls.push(ctx);
      entered();
      await inFlight; // a desk tx waiting for its receipt
      return { action: "none", reason: "TEST", ratioBefore: null, ratioAfter: null, targetHedgeUsd: 0n, legs: [] };
    };
    const running = agent.run();
    await started;
    agent.stop();
    expect(hedger!.calls[0]!.signal?.aborted).toBe(true);
    const quotesAtStop = venue.replaced.length;
    release();
    expect(await running).toEqual({ halted: false, reason: "SHUTDOWN" });
    expect(hedger!.calls.length).toBe(1);
    expect(venue.replaced.length).toBe(quotesAtStop);
    expect(venue.cancels).toBe(1); // shutdown cancel-all
  });
});
