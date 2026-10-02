// Risk in low-gas mode (docs/LOW_GAS.md §1-§2): the monitor values from the oracle's signed prints and
// ops-venue's signed venue reports; no dependence on on-chain price freshness or a 30 s report loop.
import { describe, expect, test } from "bun:test";
import { VENUE, devAccount, priceId, usd, wad } from "@bookrunner/shared";
import type { Hex } from "viem";
import { type SignedPrice, newestByUnderlying } from "../../mark/src/domain/prices";
import { type SignedVenueReport, signVenueReport } from "../../ops-venue/src/report712";
import { CachedSignedFeeds } from "../src/adapters/feeds";
import type { RiskSettings } from "../src/config";
import { pickVenueReport } from "../src/domain/venueReport";
import { BookMonitor } from "../src/monitor";
import type { SignedFeedsPort, SignedPriceMap } from "../src/ports";
import type { BookRef, RiskStatePayload } from "../src/types";
import { NVDA_TOKEN, T0, type World, chainObs, holding, makeRef, makeWorld, settings, silentLog } from "./fakes";

const ops = devAccount("opsVenue");
const REF = makeRef();
const ADAPTER = REF.components.adapter;

async function report(v: { asOf: number; exposure?: bigint; insurance?: bigint; margin?: bigint }, adapter = ADAPTER): Promise<SignedVenueReport> {
  const values = { insuranceUsd: v.insurance ?? usd(25_000), marginUsd: v.margin ?? usd(60_000), netExposureUsd: v.exposure ?? usd(60_000), asOf: BigInt(v.asOf) };
  return { ...values, bookId: 1, chainId: 31337, adapter, signer: ops.address, signedAt: 0, signature: await signVenueReport(ops, 31337, adapter, values) };
}

const print = (priceUsd: number, publishedAt: number): SignedPrice => ({
  priceId: "NVDA",
  underlying: priceId("NVDA").toLowerCase() as Hex,
  priceWad: wad(priceUsd),
  publishedAt: BigInt(publishedAt),
  held: false,
  sourceCount: 3,
  sourcesHash: `0x${"00".repeat(32)}` as Hex,
  signature: `0x${"11".repeat(65)}` as Hex,
});

class StaticFeeds implements SignedFeedsPort {
  pricesCalls = 0;
  constructor(
    public priceList: SignedPrice[] = [],
    public reports: SignedVenueReport[] = [],
    public fail: string | null = null,
  ) {}
  async prices(): Promise<SignedPriceMap> {
    this.pricesCalls++;
    if (this.fail) throw new Error(this.fail);
    return newestByUnderlying(this.priceList);
  }
  async venueReports(): Promise<SignedVenueReport[]> {
    if (this.fail) throw new Error(this.fail);
    return this.reports;
  }
}

function monitorFor(w: World, feeds: SignedFeedsPort | undefined, ref: BookRef = REF, s: Partial<RiskSettings> = {}) {
  return new BookMonitor(ref, {
    chain: w.chain,
    store: w.store,
    bus: w.bus,
    queue: w.queue,
    venues: w.venues,
    clock: w.clock,
    settings: settings(s),
    log: silentLog,
    sleep: async () => {},
    chainId: 31337,
    ...(feeds ? { feeds } : {}),
  });
}

const riskState = (w: World, bookId = 1) => JSON.parse(w.bus.kv.get(`risk:${bookId}`) ?? "null") as RiskStatePayload | null;

/** The adapter's on-chain report is a day old (no report txs any more): short 20k, deployed 84k. */
const dayOldAdapter = () => chainObs({ adapter: { ...chainObs().adapter, valuationAt: T0 - 86_400, lastFlowAt: T0 - 90_000 } });

describe("BookMonitor: signed venue reports (LOW_GAS §2)", () => {
  test("the newest signed report replaces the adapter's day-old figures: exposure, IF equity, deployed value", async () => {
    const w = makeWorld({ obs: dayOldAdapter() });
    const feeds = new StaticFeeds([], [await report({ asOf: T0 - 30, exposure: usd(-30_000) }), await report({ asOf: T0 - 10, exposure: usd(60_000) })]);
    const r = await monitorFor(w, feeds).tick();
    expect(r.snapshot.breaches).toContain("INVENTORY"); // long 60k > maxInventory 50k: invisible in the stale adapter view
    const st = riskState(w);
    expect(st?.meta).toMatchObject({ exposureSource: "signed_report", netExposureUsd: "60000", venueReportAsOf: T0 - 10 });
    // NAV = IF 25k + MM margin 60k (signed) + desk 16k
    expect(st?.meta.liveNavUsd).toBe("101000");
    expect(JSON.parse(w.bus.kv.get("nav:1") ?? "{}")).toMatchObject({ venueSource: "signed_report", venueDeployedUsd: "85000" });
  });

  test("reports not newer than the adapter's own, or older than its last on-chain flow, are ignored", async () => {
    const w = makeWorld({ obs: chainObs({ adapter: { ...chainObs().adapter, valuationAt: T0 - 100, lastFlowAt: T0 - 50 } }) });
    const feeds = new StaticFeeds([], [await report({ asOf: T0 - 200 }), await report({ asOf: T0 - 60 })]);
    await monitorFor(w, feeds).tick();
    expect(riskState(w)?.meta).toMatchObject({ exposureSource: "adapter_report", netExposureUsd: "-20000", venueReportAsOf: null });
  });

  test("the live venue API still wins for exposure + MM equity; IF equity comes from the signed report", async () => {
    const w = makeWorld({ obs: dayOldAdapter() });
    w.venue.acct = {
      equityUsd: usd(70_000),
      freeCollateralUsd: usd(50_000),
      position: { symbol: "PERP_NVDA_USDC", netQty: 100, avgPx: 190, markPx: 200, netExposureUsd: usd(20_000), unrealizedPnlUsd: 0n },
    };
    await monitorFor(w, new StaticFeeds([], [await report({ asOf: T0 - 10, insurance: usd(24_000) })])).tick();
    const st = riskState(w);
    expect(st?.meta.exposureSource).toBe("venue_api");
    expect(st?.meta.netExposureUsd).toBe("20000");
    // 24k (signed IF) + 70k (live MM) + 16k desk
    expect(st?.meta.liveNavUsd).toBe("110000");
  });

  test("engine books never use venue reports", async () => {
    const w = makeWorld({ obs: chainObs() });
    await monitorFor(w, new StaticFeeds([], [await report({ asOf: T0 - 10 })]), makeRef(1, VENUE.POOL_ENGINE)).tick();
    expect(riskState(w)?.meta.exposureSource).toBe("engine");
  });

  test("a feed outage never fails the tick: on-chain figures as before", async () => {
    const w = makeWorld({ obs: dayOldAdapter() });
    const r = await monitorFor(w, new StaticFeeds([], [], "redis down")).tick();
    expect(r.snapshot.state).toBe("ok");
    expect(riskState(w)?.meta).toMatchObject({ exposureSource: "adapter_report", signedPrices: 0 });
  });
});

describe("BookMonitor: signed prices (LOW_GAS §1)", () => {
  test("prints are handed to the chain read; the kill-path flatten is planned at them", async () => {
    const w = makeWorld({ holdings: [holding(NVDA_TOKEN, 10, 190)] });
    const seen: Array<SignedPriceMap | undefined> = [];
    const holdingsSeen: Array<SignedPriceMap | undefined> = [];
    const observe = w.chain.observe.bind(w.chain);
    const deskHoldings = w.chain.deskHoldings.bind(w.chain);
    w.chain.observe = async (ref, prices) => {
      seen.push(prices);
      return observe(ref, prices);
    };
    w.chain.deskHoldings = async (ref, prices) => {
      holdingsSeen.push(prices);
      return deskHoldings(ref, prices);
    };
    // venue long 60k > 50k: a confirmed breach runs the kill (flatten included)
    w.chain.state.obs = chainObs({ adapter: { ...chainObs().adapter, netExposureUsd: usd(60_000), deployedValueUsd: usd(100_000) }, desk: { hedgeNotionalUsd: 0n, valueUsd: 0n } });
    const m = monitorFor(w, new StaticFeeds([print(200, T0 - 1)]));
    await m.tick();
    w.clock.t += 2000;
    const t2 = await m.tick();
    expect(t2.effects).toContain("run_kill");
    expect(seen.every((p) => p?.get(priceId("NVDA").toLowerCase())?.priceWad === wad(200))).toBe(true);
    expect(holdingsSeen.length).toBeGreaterThan(0);
    expect(holdingsSeen.every((p) => p?.get(priceId("NVDA").toLowerCase())?.priceWad === wad(200))).toBe(true);
    expect(riskState(w)?.meta.signedPrices).toBe(1);
  });

  test("no feeds configured: observe is called without prints (pre-low-gas)", async () => {
    const w = makeWorld();
    const seen: Array<SignedPriceMap | undefined> = [];
    const observe = w.chain.observe.bind(w.chain);
    w.chain.observe = async (ref, prices) => {
      seen.push(prices);
      return observe(ref, prices);
    };
    await monitorFor(w, undefined).tick();
    expect(seen).toEqual([undefined]);
  });
});

describe("pickVenueReport (pure)", () => {
  const base = { adapter: ADAPTER, chainId: 31337, valuationAt: T0 - 100, lastFlowAt: T0 - 50, nowSec: T0 };
  test("newest consistent report; future-dated beyond the clock skew, other adapters and other chains are not", async () => {
    const a = await report({ asOf: T0 - 40 });
    const b = await report({ asOf: T0 - 20 });
    const future = await report({ asOf: T0 + 60 });
    const other = await report({ asOf: T0 - 5 }, "0x00000000000000000000000000000000000000ee");
    expect(pickVenueReport([a, future, other, b], base)?.asOf).toBe(BigInt(T0 - 20));
    expect(pickVenueReport([{ ...b, chainId: 1 }], base)).toBeNull();
    expect(pickVenueReport([await report({ asOf: T0 + 3 })], base)?.asOf).toBe(BigInt(T0 + 3)); // within skew
    expect(pickVenueReport([], base)).toBeNull();
  });
});

describe("CachedSignedFeeds", () => {
  test("one verified read shared by every book within the TTL; venue reports per book", async () => {
    let t = 0;
    let reads = 0;
    const inner = {
      signedPrices: async () => {
        reads++;
        return [print(200, T0), print(201, T0 + 1)];
      },
      venueReports: async () => [await report({ asOf: T0 })],
    };
    const f = new CachedSignedFeeds(inner, { ttlMs: 1_000, timeoutMs: 1_000, now: () => t });
    const [p1, p2] = await Promise.all([f.prices(), f.prices()]);
    expect(reads).toBe(1);
    expect(p1).toBe(p2);
    expect(p1.get(priceId("NVDA").toLowerCase())?.priceWad).toBe(wad(201)); // newest per underlying
    t = 1_500;
    await f.prices();
    expect(reads).toBe(2);
    expect(await f.venueReports(REF)).toHaveLength(1);
  });

  test("a hung feed times out (the monitor then degrades to on-chain state)", async () => {
    const f = new CachedSignedFeeds({ signedPrices: () => new Promise(() => {}), venueReports: async () => [] }, { ttlMs: 1_000, timeoutMs: 20 });
    await expect(f.prices()).rejects.toThrow();
  });
});
