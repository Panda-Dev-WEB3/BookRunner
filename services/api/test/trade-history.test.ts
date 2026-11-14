// Trading page v2 (2026-11): the price history (one-minute candles from the recorder, downsampled per range within the
// point bound, cached) and a wallet's trade and PnL history built from the indexed engine events (partial closes,
// funding, a liquidation priced from the replayed entry, a wind-down close-out, totals, pagination).
import { describe, expect, test } from "bun:test";
import { devAccount, priceTypedData, strToBytes32 } from "@bookrunner/shared";
import { encodePriceData, type PriceUpdate } from "@bookrunner/shared/eip712";
import { KEYS } from "@bookrunner/shared/queues";
import type { Address, Hex } from "viem";
import type { EngineMarketChainState } from "../src/chain/gateway";
import type { EnginePriceMinuteRow, EngineTraderEventRow } from "../src/data/types";
import { pnlUsd } from "../src/domain/engine";
import { createApp } from "../src/app";
import { webOrigins } from "../src/config";
import { HISTORY_SPEC, INDEXER_CURSORS, MAX_HISTORY_POINTS, MAX_TRADER_EVENTS, aggregateCandles, buildFills, eventsBackfillPending, historyFrom, minuteRowsFor } from "../src/domain/tradeHistory";
import { PriceRecorder } from "../src/priceRecorder";
import { A, FakePriceHistoryStore } from "./fakes";
import { ALICE, NOW, type World, makeWorld } from "./fixtures";

const U = (n: number) => BigInt(Math.round(n * 1e6));
const UNITS = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const PX = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const sec = Math.floor(NOW / 1000);
const ORACLE = "0x00000000000000000000000000000000000000c8" as Address;
const ENGINE = "0x00000000000000000000000000000000000000cD" as Address;
const ADAPTER = A(0xe8);
const PID = strToBytes32("NVDA");
const oracleKey = devAccount("oracleSigner");

async function bundle(at: number, price: bigint, held = false) {
  const update: PriceUpdate = { underlying: PID, priceWad: price, publishedAt: BigInt(at), held, sourceCount: 1, sourcesHash: `0x${"11".repeat(32)}` as Hex };
  const sig = await oracleKey.signTypedData(priceTypedData(31337, ORACLE, update));
  return { priceData: encodePriceData([update], [sig]), publishedAt: at, chainId: 31337, oracle: ORACLE };
}

function engineMarket(): EngineMarketChainState {
  return {
    engine: ENGINE,
    adapter: ADAPTER,
    marketId: 1,
    nowSec: sec,
    config: { underlying: PID, symbol: strToBytes32("NVDA-PERP"), takerFeeBps: 10, makerFeeBps: 0, initialMarginBps: 1000, maintenanceMarginBps: 500, liquidationFeeBps: 50, fundingVelocityBps: 100, maxNetExposureUsd: U(75_000) },
    state: { spreadBps: 10, skewBps: 0, reduceOnly: false, longSize: 0n, shortSize: 0n, poolCashUsd: U(100_000), insuranceUsd: U(25_000), fundingIndex: 0n },
    inventoryCapUsd: U(75_000),
    closeOutAfter: 0,
    fundingRatePerDayWad: 0n,
    lossBudgetBlocked: false,
    stored: { priceWad: PX(100), publishedAt: sec - 100, held: false },
    lastLiveAt: sec - 100,
    maxPriceAge: 300,
    maxTradePriceAge: 15,
  };
}

function world(bookState = "Live"): World {
  const w = makeWorld();
  w.data.books.push({ id: 7, charterId: 7, venue: 1, symbol: "NVDA-PERP", name: "NVDA perpetual", state: bookState, adapterAddr: ADAPTER.toLowerCase(), underlying: PID, createdAt: new Date(NOW - 86_400_000) } as never);
  w.chain.engineMarkets.set(ADAPTER.toLowerCase(), engineMarket());
  return w;
}

const minute = (t: number, o: number, h: number, l: number, c: number, held = false): EnginePriceMinuteRow => ({
  marketId: 1,
  underlying: PID.toLowerCase(),
  bucket: new Date(t * 1000),
  openWad: PX(o).toString(),
  highWad: PX(h).toString(),
  lowWad: PX(l).toString(),
  closeWad: PX(c).toString(),
  firstAt: t,
  lastAt: t + 59,
  held,
});

describe("price history: aggregation and bounds", () => {
  test("one-minute candles fold into steps: first open, last close, highest high, lowest low; held only when every minute was", () => {
    const t0 = 1_800_000_000 - (1_800_000_000 % 300);
    const rows = [
      minute(t0 + 120, 101, 104, 100.5, 103),
      minute(t0, 100, 101, 99, 100.5), // out of order in: sorted
      minute(t0 + 60, 100.5, 102, 98, 101),
      minute(t0 + 300, 103, 103, 103, 103, true),
      minute(t0 + 360, 103, 103, 103, 103, false),
      minute(t0 + 600, 103, 103, 103, 103, true),
      minute(t0 - 60, 1, 1, 1, 1), // before the range
    ];
    const pts = aggregateCandles(rows, 300, t0, t0 + 3_600);
    expect(pts).toEqual([
      { t: t0, open: "100.0", high: "104.0", low: "98.0", close: "103.0", held: false },
      { t: t0 + 300, open: "103.0", high: "103.0", low: "103.0", close: "103.0", held: false },
      { t: t0 + 600, open: "103.0", high: "103.0", low: "103.0", close: "103.0", held: true },
    ]);
  });

  test("every range stays within the point bound with a full window of minutes; reads are bounded too", () => {
    const now = 1_800_000_123;
    for (const r of ["1D", "1W", "1M"] as const) {
      const from = historyFrom(r, now);
      expect(from % HISTORY_SPEC[r].stepSec).toBe(0);
      expect(now - from).toBeGreaterThanOrEqual(HISTORY_SPEC[r].spanSec);
      const rows: EnginePriceMinuteRow[] = [];
      for (let t = from - (from % 60); t <= now; t += 60) rows.push(minute(t, 100, 101, 99, 100));
      expect(rows.length).toBeLessThanOrEqual(minuteRowsFor(r));
      const pts = aggregateCandles(rows, HISTORY_SPEC[r].stepSec, from, now);
      expect(pts.length).toBeLessThanOrEqual(MAX_HISTORY_POINTS);
      expect(pts.length).toBe(Math.floor((now - from) / HISTORY_SPEC[r].stepSec) + 1);
    }
    // a dense day of steps never exceeds the bound (newest kept)
    const many = Array.from({ length: 1_000 }, (_, i) => minute(i * 60, 100, 100, 100, 100));
    const pts = aggregateCandles(many, 60, 0, 1_000 * 60);
    expect(pts).toHaveLength(MAX_HISTORY_POINTS);
    expect(pts[pts.length - 1]!.t).toBe(999 * 60);
  });
});

describe("price recorder -> trade.history", () => {
  test("records each new signed print of an open market into its minute, once; history serves the range from the candles", async () => {
    const w = world();
    const store = new FakePriceHistoryStore(w.data);
    const rec = new PriceRecorder({ deps: w.deps, store, sampleMs: 5_000, retentionDays: 35 });
    const minuteStart = sec - (sec % 60);
    const prints: Array<[number, number]> = [
      [minuteStart + 1, 100],
      [minuteStart + 1, 100], // same print again: not recorded twice
      [minuteStart + 20, 103],
      [minuteStart + 40, 97],
      [minuteStart + 59, 101],
      [minuteStart + 61, 102], // next minute
    ];
    for (const [at, px] of prints) {
      w.kv.put(KEYS.oracleBundle, await bundle(at, PX(px)));
      w.now.ms += 1_100; // past the signed-source memo
      await rec.tick();
    }
    expect(store.samples).toHaveLength(5);
    expect(w.data.priceMinuteRows).toHaveLength(2);
    expect(w.data.priceMinuteRows[0]).toMatchObject({ openWad: PX(100).toString(), highWad: PX(103).toString(), lowWad: PX(97).toString(), closeWad: PX(101).toString(), held: false });

    const h = await w.caller.trade.history({ marketId: 1, range: "1D" });
    expect(h).toMatchObject({ marketId: 1, range: "1D", stepSeconds: 300 });
    const step = minuteStart - (minuteStart % 300);
    const last = h.points[h.points.length - 1]!;
    expect(last.t).toBe((minuteStart + 60) - ((minuteStart + 60) % 300));
    expect(h.points.find((p) => p.t === step)).toMatchObject({ open: "100.0", low: "97.0" });
  });

  test("a held print is recorded as held; nothing is recorded for a book that is not open; old minutes are pruned", async () => {
    const w = world("Subscription");
    const store = new FakePriceHistoryStore(w.data);
    const rec = new PriceRecorder({ deps: w.deps, store, sampleMs: 5_000, retentionDays: 35 });
    w.data.priceMinuteRows.push(minute(sec - 40 * 86_400, 90, 90, 90, 90));
    w.kv.put(KEYS.oracleBundle, await bundle(sec - 1, PX(100)));
    expect(await rec.tick()).toBe(0);
    expect(w.data.priceMinuteRows).toHaveLength(0); // pruned even with no open market

    const w2 = world();
    const store2 = new FakePriceHistoryStore(w2.data);
    w2.data.priceMinuteRows.push(minute(sec - 40 * 86_400, 90, 90, 90, 90));
    const rec2 = new PriceRecorder({ deps: w2.deps, store: store2, sampleMs: 5_000, retentionDays: 35 });
    w2.kv.put(KEYS.oracleBundle, await bundle(sec - 1, PX(100), true));
    expect(await rec2.tick()).toBe(1);
    expect(w2.data.priceMinuteRows).toHaveLength(1);
    expect(w2.data.priceMinuteRows[0]!.held).toBe(true);
  });

  test("history is cached per (market, range) for the range's TTL; an unknown range or market is refused", async () => {
    const w = world();
    w.data.priceMinuteRows.push(minute(sec - (sec % 60) - 120, 100, 101, 99, 100));
    await w.caller.trade.history({ marketId: 1, range: "1W" });
    await w.caller.trade.history({ marketId: 1, range: "1W" });
    expect(w.data.priceMinuteReads).toBe(1);
    w.now.ms += (HISTORY_SPEC["1W"].cacheSec + 1) * 1000;
    await w.caller.trade.history({ marketId: 1, range: "1W" });
    expect(w.data.priceMinuteReads).toBe(2);
    await expect(w.caller.trade.history({ marketId: 1, range: "5Y" as never })).rejects.toThrow();
    await expect(w.caller.trade.history({ marketId: 9, range: "1D" })).rejects.toThrow(/No open in-house market/);
  });
});

// ------------------------------------------------------------------ fills
let li = 0;
const ev = (block: number, kind: EngineTraderEventRow["kind"], f: Partial<EngineTraderEventRow> = {}, trader: string = ALICE): EngineTraderEventRow => ({
  txHash: `0x${block.toString(16).padStart(64, "0")}`,
  logIndex: li++,
  block,
  ts: new Date((sec - 10_000 + block) * 1000),
  marketId: 1,
  trader: trader.toLowerCase(),
  kind,
  sizeRaw: null,
  newSizeRaw: null,
  priceWad: null,
  feeRaw: null,
  pnlRaw: null,
  marginDeltaRaw: null,
  fundingRaw: null,
  badDebtRaw: null,
  counterparty: null,
  ...f,
});
const trade = (block: number, delta: bigint, newSize: bigint, fill: bigint, fee: bigint, pnl: bigint, trader?: string) =>
  ev(block, "trade", { sizeRaw: delta.toString(), newSizeRaw: newSize.toString(), priceWad: fill.toString(), feeRaw: fee.toString(), pnlRaw: pnl.toString() }, trader);

/** Alice: deposit, open 10 at 100, add 10 at 110 (entry 105), close 5 at 120 (+75), funding, close 5 at 90 (-75), liquidated 10 at 95 (-100). */
function aliceHistory(): EngineTraderEventRow[] {
  li = 0;
  return [
    ev(1, "margin", { marginDeltaRaw: U(1_000).toString() }),
    trade(2, UNITS(10), UNITS(10), PX(100), U(1), 0n),
    trade(3, UNITS(10), UNITS(20), PX(110), U(1.1), 0n),
    trade(4, -UNITS(5), UNITS(15), PX(120), U(0.6), pnlUsd(UNITS(5), PX(105), PX(120))),
    ev(5, "funding", { fundingRaw: U(2).toString() }),
    trade(5, -UNITS(5), UNITS(10), PX(90), U(0.45), pnlUsd(UNITS(5), PX(105), PX(90))),
    ev(6, "funding", { fundingRaw: (-U(0.5)).toString() }),
    ev(6, "liquidation", { sizeRaw: UNITS(10).toString(), priceWad: PX(95).toString(), feeRaw: U(4.75).toString(), badDebtRaw: "0", counterparty: "0xbeef" }),
    ev(7, "margin", { marginDeltaRaw: (-U(500)).toString() }),
  ];
}

describe("trade and PnL history from engine events", () => {
  test("partial closes carry the engine's PnL, a liquidation is priced from the replayed entry; fees, funding and net add up", () => {
    const { rows, totals } = buildFills(aliceHistory());
    expect(rows.map((r) => r.kind)).toEqual(["withdrawal", "liquidation", "funding", "trade", "funding", "trade", "trade", "trade", "deposit"]);
    const liq = rows[1]!;
    expect(liq).toMatchObject({ side: "sell", size: "10.0", price: "95.0", notionalUsd: "950.000000", feeUsd: "4.750000", realisedPnlUsd: "-100.000000", badDebtUsd: "0.000000", positionAfter: "0.0" });
    expect(rows[3]).toMatchObject({ side: "sell", size: "5.0", price: "90.0", realisedPnlUsd: "-75.000000", positionAfter: "10.0" });
    expect(rows[5]).toMatchObject({ side: "sell", realisedPnlUsd: "75.000000", positionAfter: "15.0", feeUsd: "0.600000" });
    expect(rows[6]).toMatchObject({ side: "buy", realisedPnlUsd: null, positionAfter: "20.0" }); // an increase realises nothing
    expect(rows[0]).toMatchObject({ marginUsd: "-500.000000" });
    expect(totals).toEqual({
      trades: 4,
      liquidations: 1,
      realisedPnlUsd: "-100.000000",
      tradingFeesUsd: "3.150000",
      liquidationFeesUsd: "4.750000",
      feesUsd: "7.900000",
      fundingUsd: "1.500000",
      netUsd: "-109.400000",
      depositedUsd: "1000.000000",
      withdrawnUsd: "500.000000",
      unknownPnl: 0,
    });
  });

  test("a short liquidated with bad debt loses its margin, not more; a wind-down close-out is one row; a cut-short replay leaves the PnL unknown", () => {
    li = 0;
    const bob = "0x0000000000000000000000000000000000000b0b";
    const short = [trade(1, -UNITS(4), -UNITS(4), PX(50), U(0.2), 0n, bob), ev(2, "liquidation", { sizeRaw: (-UNITS(4)).toString(), priceWad: PX(70).toString(), feeRaw: "0", badDebtRaw: U(30).toString() }, bob)];
    const s = buildFills(short);
    // -80 at the oracle, 30 of it beyond the margin (bad debt, borne by the insurance fund): the trader lost 50
    expect(s.rows[0]).toMatchObject({ side: "buy", realisedPnlUsd: "-50.000000", badDebtUsd: "30.000000" });
    expect(s.totals.realisedPnlUsd).toBe("-50.000000");

    const co = trade(3, -UNITS(2), 0n, PX(60), 0n, U(-1), bob);
    const closed = ev(3, "closed_out", { sizeRaw: UNITS(2).toString(), priceWad: PX(60).toString(), badDebtRaw: U(1).toString(), counterparty: "0xbeef" }, bob);
    expect(closed.logIndex).toBe(co.logIndex + 1);
    const c = buildFills([trade(2, UNITS(2), UNITS(2), PX(61), 0n, 0n, bob), co, closed]);
    expect(c.rows).toHaveLength(2);
    expect(c.rows[0]).toMatchObject({ kind: "close_out", realisedPnlUsd: "0.000000", badDebtUsd: "1.000000", positionAfter: "0.0" }); // -1 at the oracle, all of it bad debt

    // the opening trade is missing (history cut short): the liquidation's PnL is unknown, not guessed
    const cut = buildFills(aliceHistory().slice(3));
    expect(cut.rows.find((r) => r.kind === "liquidation")!.realisedPnlUsd).toBeNull();
    expect(cut.totals.unknownPnl).toBe(1);
  });

  test("trade.fills: newest first, paged by offset, totals over every row, one market or all; cached 2 s", async () => {
    const w = world();
    w.data.engineEventRows.push(...aliceHistory(), { ...ev(9, "margin", { marginDeltaRaw: U(5).toString() }), marketId: 2 });
    const p1 = await w.caller.trade.fills({ wallet: ALICE, marketId: 1, limit: 4 });
    expect(p1).toMatchObject({ total: 9, offset: 0, truncated: false });
    expect(p1.rows.map((r) => r.kind)).toEqual(["withdrawal", "liquidation", "funding", "trade"]);
    const p3 = await w.caller.trade.fills({ wallet: ALICE, marketId: 1, offset: 8, limit: 4 });
    expect(p3.rows.map((r) => r.kind)).toEqual(["deposit"]);
    expect(p3.totals.realisedPnlUsd).toBe("-100.000000");
    const all = await w.caller.trade.fills({ wallet: ALICE });
    expect(all.total).toBe(10);
    expect(all.rows[0]!.marketId).toBe(2);
    const other = await w.caller.trade.fills({ wallet: "0x0000000000000000000000000000000000000b0b" });
    expect(other).toMatchObject({ total: 0, rows: [] });
    // cached: a new event shows after the TTL
    w.data.engineEventRows.push(ev(10, "margin", { marginDeltaRaw: U(1).toString() }));
    expect((await w.caller.trade.fills({ wallet: ALICE, marketId: 1 })).total).toBe(9);
    w.now.ms += 3_000;
    expect((await w.caller.trade.fills({ wallet: ALICE, marketId: 1 })).total).toBe(10);
    await expect(w.caller.trade.fills({ wallet: ALICE, limit: 501 })).rejects.toThrow();
  });

  test("stable cursor: an event indexed during an export neither repeats nor shifts a row", async () => {
    const w = world();
    w.data.engineEventRows.push(...aliceHistory());
    const p1 = await w.caller.trade.fills({ wallet: ALICE, marketId: 1, limit: 4 });
    expect(p1.nextBefore).toEqual({ block: p1.rows[3]!.block, logIndex: p1.rows[3]!.logIndex });
    // a new event lands and the cache expires between two pages
    w.data.engineEventRows.push(ev(20, "margin", { marginDeltaRaw: U(1).toString() }));
    w.now.ms += 3_000;
    const p2 = await w.caller.trade.fills({ wallet: ALICE, marketId: 1, limit: 4, before: p1.nextBefore! });
    const p3 = await w.caller.trade.fills({ wallet: ALICE, marketId: 1, limit: 4, before: p2.nextBefore! });
    expect(p3.nextBefore).toBeNull();
    const ids = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(9);
    expect(ids).toEqual(buildFills(aliceHistory()).rows.map((r) => r.id));
    // offset paging would have shifted: the same second page by offset repeats the fourth row
    expect((await w.caller.trade.fills({ wallet: ALICE, marketId: 1, limit: 4, offset: 4 })).rows[0]!.id).toBe(p1.rows[3]!.id);
  });

  test("incomplete while the indexer's engine-events backfill has not caught up", async () => {
    expect(eventsBackfillPending({})).toBe(false);
    expect(eventsBackfillPending({ [INDEXER_CURSORS.protocol]: 100 })).toBe(true);
    expect(eventsBackfillPending({ [INDEXER_CURSORS.protocol]: 100, [INDEXER_CURSORS.engineEventsBackfill]: 60 })).toBe(true);
    expect(eventsBackfillPending({ [INDEXER_CURSORS.protocol]: 100, [INDEXER_CURSORS.engineEventsBackfill]: 100 })).toBe(false);
    const w = world();
    w.data.engineEventRows.push(...aliceHistory());
    w.data.cursors = { [INDEXER_CURSORS.protocol]: 100, [INDEXER_CURSORS.engineEventsBackfill]: 40 };
    expect((await w.caller.trade.fills({ wallet: ALICE })).incomplete).toBe(true);
    w.data.cursors[INDEXER_CURSORS.engineEventsBackfill] = 100;
    w.now.ms += 3_000;
    expect((await w.caller.trade.fills({ wallet: ALICE })).incomplete).toBe(false);
  });

  test("above the cap the NEWEST events are kept (truncated)", async () => {
    const w = world();
    li = 0;
    for (let b = 1; b <= MAX_TRADER_EVENTS + 5; b++) w.data.engineEventRows.push(ev(b, "margin", { marginDeltaRaw: "1" }));
    const r = await w.caller.trade.fills({ wallet: ALICE, limit: 1 });
    expect(r).toMatchObject({ total: MAX_TRADER_EVENTS, truncated: true });
    expect(r.rows[0]!.block).toBe(MAX_TRADER_EVENTS + 5);
  });

  test("a batch carries one history read at most: N trade.fills / trade.history calls in one request are refused", async () => {
    const w = world();
    const app = createApp(w.deps, { origins: webOrigins("http://127.0.0.1:5180") });
    const batch = (calls: Array<[string, unknown]>) => {
      const paths = calls.map(([p]) => p).join(",");
      const input = Object.fromEntries(calls.map(([, v], i) => [String(i), { json: v }]));
      return app.request(`/trpc/${paths}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`);
    };
    const wallet = (i: number) => `0x${(i + 1).toString(16).padStart(40, "0")}`;
    expect((await batch(Array.from({ length: 10 }, (_, i) => ["trade.fills", { wallet: wallet(i) }]))).status).toBe(400);
    expect((await batch([["trade.fills", { wallet: wallet(0) }], ["trade.fills", { wallet: wallet(1) }]])).status).toBe(400);
    expect((await batch([["trade.history", { marketId: 1 }], ["book.get", { bookId: 7 }]])).status).toBe(400);
    expect((await batch([["trade.fills", { wallet: wallet(0) }]])).status).toBe(200);
    const single = await app.request(`/trpc/trade.fills?input=${encodeURIComponent(JSON.stringify({ json: { wallet: wallet(0) } }))}`);
    expect(single.status).toBe(200);
  });
});
