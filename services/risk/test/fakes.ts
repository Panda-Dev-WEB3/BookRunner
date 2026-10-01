// Test fixtures + recording fakes for every port. No infra needed.
import {
  type BookState,
  type DomainEvent,
  type KillMsg,
  type Mandate,
  type OraclePriceMsg,
  type QuotingVenue,
  VENUE,
  type VenueAccount,
  type VenueId,
  type VenueOpsJob,
  createLogger,
  priceId,
  usd,
  wad,
} from "@bookrunner/shared";
import { type Address, type Hex, keccak256, stringToHex, zeroHash } from "viem";
import type { RiskSettings } from "../src/config";
import type { FlattenOrder, Holding } from "../src/domain/flatten";
import type { BusPort, ChainPort, Clock, EventRow, HedgeRow, KillEventRow, KillLog, LimitsRow, QueuePort, ReceiptRow, StorePort, VenueProvider } from "../src/ports";
import type { BookObservation, BookRef, ChainObservation, LiveNav, QuoteObservation, RiskStatePayload } from "../src/types";

export const silentLog = createLogger("risk-test", "silent");

export const RISK_ADDR = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
export const OTHER_ADDR = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;
export const NVDA_TOKEN = "0x00000000000000000000000000000000000000a1" as Address;
export const TSLA_TOKEN = "0x00000000000000000000000000000000000000a2" as Address;

/** NVDA launch-book mandate (ARCHITECTURE §7): 50k / 25 / 8 / 5000–12000 / −800. */
export const MANDATE: Mandate = {
  maxInventoryUsd: usd(50_000),
  maxSkewBps: 25,
  minQuoteWidthBps: 8,
  maxHedgeLeverage: 100,
  hedgeRatioMinBps: 5000,
  hedgeRatioMaxBps: 12000,
  noNewRiskOffHours: true,
  killAtDrawdownBps: -800,
  hedgeAllowRoot: zeroHash,
};

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

export function makeRef(bookId = 1, venue: VenueId = VENUE.ORDERLY): BookRef {
  return {
    bookId,
    venue,
    components: {
      book: addr(0x100 + bookId),
      senior: addr(0x200 + bookId),
      junior: addr(0x300 + bookId),
      vault: addr(0x400 + bookId),
      mandate: addr(0x500 + bookId),
      router: addr(0x600 + bookId),
      desk: addr(0x700 + bookId),
      adapter: addr(0x800 + bookId),
    },
    underlying: priceId("NVDA"),
    priceId: priceId("NVDA"),
    priceIdStr: "NVDA",
    symbol: "PERP_NVDA_USDC",
  };
}

export const T0 = 1_790_000_000; // unix seconds

/** Healthy Live book: 100k accounted (S 70k + J 30k), all value deployed, short 20k hedged 16k. */
export function chainObs(over: Partial<ChainObservation> = {}): ChainObservation {
  return {
    bookState: "Live" as BookState,
    mandate: MANDATE,
    killed: false,
    killReason: zeroHash,
    adapter: {
      netExposureUsd: usd(-20_000),
      deployedValueUsd: usd(84_000),
      insuranceEquityUsd: usd(25_000),
      inTransitUsd: 0n,
      valuationAt: T0,
    },
    desk: { hedgeNotionalUsd: usd(16_000), valueUsd: usd(16_000) },
    vaultIdleUsd: 0n,
    unfundedClaimsUsd: 0n,
    seniorNavUsd: usd(70_000),
    juniorNavUsd: usd(30_000),
    perfIndexWad: wad(1),
    highWaterWad: wad(1),
    oracle: { priceWad: wad(190), publishedAt: T0, held: false, stale: false, source: "chain" },
    maxPriceAgeSec: 300,
    ...over,
  };
}

export function quoteAt(tsMs: number, bid: number, ask: number, oracle = 190): QuoteObservation {
  return { ts: tsMs, bid, ask, oracle, sides: { bid: true, ask: true } };
}

/** Pure-evaluation observation built from a chain observation. */
export function observation(over: Partial<BookObservation> = {}, c: ChainObservation = chainObs()): BookObservation {
  return {
    bookId: 1,
    venue: VENUE.ORDERLY,
    nowMs: T0 * 1000,
    bookState: c.bookState,
    mandate: c.mandate,
    killed: c.killed,
    killReason: c.killReason,
    netExposureUsd: c.adapter.netExposureUsd,
    exposureSource: "adapter_report",
    deskHedgeUsd: c.desk.hedgeNotionalUsd,
    nav: {
      vaultIdleUsd: c.vaultIdleUsd,
      unfundedClaimsUsd: c.unfundedClaimsUsd,
      venueDeployedUsd: c.adapter.deployedValueUsd,
      deskValueUsd: c.desk.valueUsd,
      seniorNavUsd: c.seniorNavUsd,
      juniorNavUsd: c.juniorNavUsd,
      perfIndexWad: c.perfIndexWad,
      highWaterWad: c.highWaterWad,
    },
    oracle: c.oracle ?? { priceWad: 0n, publishedAt: 0, held: false, stale: true, source: "none" },
    quote: null,
    ...over,
  };
}

export const settings = (over: Partial<RiskSettings> = {}): RiskSettings => ({
  intervalMs: 2000,
  limitsEveryTicks: 5,
  breachConfirmTicks: 2,
  quoteMaxAgeMs: 15_000,
  killMode: "enforce",
  flattenMode: "net",
  flattenSlippageBps: 100,
  flattenPoolFee: 3000,
  receiptsIntervalSec: 60,
  stepAttempts: 2,
  stepRetryMs: 1,
  venueTimeoutMs: 1000,
  ...over,
});

const txHash = (label: string): Hex => keccak256(stringToHex(label));

export function holding(token: Address, qtyWhole: number, priceUsd: number): Holding {
  const qtyRaw = BigInt(Math.round(qtyWhole * 1e6)) * 10n ** 12n; // 18 decimals
  return { token, qtyRaw, valueUsd: usd(qtyWhole * priceUsd), priceWad: wad(priceUsd), multiplierWad: wad(1), decimals: 18 };
}

// ------------------------------------------------------------------ recording world

export interface World {
  calls: string[];
  clock: Clock & { t: number };
  chain: ChainPort & { state: ChainWorld };
  store: StorePort & { db: StoreWorld };
  bus: BusPort & { kv: Map<string, string>; published: Array<{ channel: string; msg: unknown }> };
  queue: QueuePort & { jobs: Map<string, VenueOpsJob> };
  venue: QuotingVenue & { failCancel: number; acct: VenueAccount | null };
  venues: VenueProvider;
}

export interface ChainWorld {
  obs: ChainObservation;
  killed: boolean;
  killReason: Hex;
  holdings: Holding[];
  killLogs: KillLog[];
  failMandateKill: number;
  failFlatten: number;
  observeFails: number;
  nonce: number;
}

export interface StoreWorld {
  limits: LimitsRow[];
  events: Array<EventRow & { id: number; createdAt: Date }>;
  receipts: ReceiptRow[];
  killEvents: KillEventRow[];
  hedges: HedgeRow[];
  failInsertEvent: number;
}

export function makeWorld(opts: { ref?: BookRef; obs?: ChainObservation; holdings?: Holding[]; withVenue?: boolean } = {}): World {
  const calls: string[] = [];
  const clock = { t: T0 * 1000, nowMs() { return this.t; } };
  const cw: ChainWorld = {
    obs: opts.obs ?? chainObs(),
    killed: false,
    killReason: zeroHash,
    holdings: opts.holdings ?? [],
    killLogs: [],
    failMandateKill: 0,
    failFlatten: 0,
    observeFails: 0,
    nonce: 0,
  };
  const chain: World["chain"] = {
    state: cw,
    riskAddress: RISK_ADDR,
    async observe() {
      if (cw.observeFails > 0) {
        cw.observeFails--;
        throw new Error("rpc down");
      }
      return { ...cw.obs, killed: cw.killed, killReason: cw.killReason };
    },
    async isKilled() {
      return cw.killed;
    },
    async latestKill() {
      return cw.killLogs.at(-1) ?? null;
    },
    async setReduceOnly() {
      calls.push("chain.setReduceOnly");
      return txHash(`reduce-${cw.nonce++}`);
    },
    async deskHoldings() {
      return cw.holdings.map((h) => ({ ...h }));
    },
    async flatten(_ref, o: FlattenOrder) {
      if (cw.failFlatten > 0) {
        cw.failFlatten--;
        throw new Error("swap reverted: too little received");
      }
      calls.push(`chain.flatten:${o.token}:${o.amountIn}:${o.minAmountOut}`);
      cw.holdings = cw.holdings.map((h) =>
        h.token === o.token ? { ...h, qtyRaw: h.qtyRaw - o.amountIn, valueUsd: h.valueUsd - o.expectedOutUsd } : h,
      );
      return txHash(`flatten-${cw.nonce++}`);
    },
    async mandateKill(_ref, reason) {
      if (cw.failMandateKill > 0) {
        cw.failMandateKill--;
        throw new Error("execution reverted");
      }
      calls.push(`chain.mandateKill:${reason}`);
      const h = txHash(`kill-${cw.nonce++}`);
      cw.killed = true;
      cw.killReason = stringToHex(reason, { size: 32 });
      cw.killLogs.push({ txHash: h, reason: cw.killReason, by: RISK_ADDR, blockNumber: BigInt(cw.nonce) });
      return h;
    },
  };

  const sw: StoreWorld = { limits: [], events: [], receipts: [], killEvents: [], hedges: [], failInsertEvent: 0 };
  let eventId = 0;
  const store: World["store"] = {
    db: sw,
    async insertLimits(r) {
      sw.limits.push(r);
    },
    async insertEvent(e) {
      if (sw.failInsertEvent > 0) {
        sw.failInsertEvent--;
        throw new Error("db down");
      }
      const ex = sw.events.find((x) => x.dedupeKey === e.dedupeKey);
      if (ex) {
        calls.push(`store.insertEvent:${e.type}:dup`);
        return { id: ex.id, createdAt: ex.createdAt, inserted: false };
      }
      const row = { ...e, id: ++eventId, createdAt: new Date(clock.t) };
      sw.events.push(row);
      calls.push(`store.insertEvent:${e.type}`);
      return { id: row.id, createdAt: row.createdAt, inserted: true };
    },
    async insertReceipt(r) {
      sw.receipts.push(r);
      calls.push(`store.insertReceipt:${r.kind}`);
    },
    async insertKillEvent(r) {
      sw.killEvents.push(r);
      calls.push("store.insertKillEvent");
    },
    async killEvents(bookId) {
      return sw.killEvents.filter((k) => k.bookId === bookId).map((k) => ({ reason: k.reason, txHashes: k.txHashes }));
    },
    async insertHedge(r) {
      sw.hedges.push(r);
    },
    async liveBooks() {
      return [];
    },
  };

  const kv = new Map<string, string>();
  const published: Array<{ channel: string; msg: unknown }> = [];
  const bus: World["bus"] = {
    kv,
    published,
    async latestQuote(bookId) {
      const raw = kv.get(`quote:${bookId}`);
      return raw ? (JSON.parse(raw) as QuoteObservation) : null;
    },
    async oracleLast(pid) {
      const raw = kv.get(`oracle:${pid}`);
      return raw ? (JSON.parse(raw) as OraclePriceMsg) : null;
    },
    async loadRiskState(bookId) {
      const raw = kv.get(`risk:${bookId}`);
      return raw ? (JSON.parse(raw) as RiskStatePayload) : null;
    },
    async saveRiskState(bookId, payload) {
      kv.set(`risk:${bookId}`, JSON.stringify(payload));
      published.push({ channel: `risk:${bookId}`, msg: payload });
    },
    async saveLiveNav(bookId, nav: LiveNav) {
      kv.set(`nav:${bookId}`, JSON.stringify(nav));
    },
    async publishKill(bookId, msg: KillMsg) {
      calls.push("bus.publishKill");
      published.push({ channel: `kill:${bookId}`, msg });
    },
    async publishDomainEvent(evt: DomainEvent) {
      calls.push(`bus.publishDomainEvent:${evt.type}`);
      published.push({ channel: "events", msg: evt });
    },
  };

  const jobs = new Map<string, VenueOpsJob>();
  const queue: World["queue"] = {
    jobs,
    async enqueueVenueOp(job, jobId) {
      calls.push(`queue.enqueue:${job.kind}`);
      if (!jobs.has(jobId)) jobs.set(jobId, job);
    },
  };

  const venue: World["venue"] = {
    kind: "orderly",
    failCancel: 0,
    acct: null,
    async replaceQuote() {
      throw new Error("not used");
    },
    async cancelAll() {
      if (venue.failCancel > 0) {
        venue.failCancel--;
        throw new Error("venue 503");
      }
      calls.push("venue.cancelAll");
    },
    async account() {
      if (!venue.acct) throw new Error("venue api unavailable");
      return venue.acct;
    },
    async fillsSince() {
      return [];
    },
  };
  const venues: VenueProvider = {
    async forBook(ref) {
      return opts.withVenue !== false && ref.venue === VENUE.ORDERLY ? venue : null;
    },
  };

  return { calls, clock, chain, store, bus, queue, venue, venues };
}
