import { describe, expect, test } from "bun:test";
import { KEYS } from "@bookrunner/shared/queues";
import { METRICS_CACHE_CONTROL, METRICS_CACHE_MS, type MetricsView, buildMetrics } from "../src/domain/metrics";
import { createApp } from "../src/app";
import { webOrigins } from "../src/config";
import { NOW, makeWorld, seedBook } from "./fixtures";

const getMetrics = async (app: ReturnType<typeof createApp>) => {
  const res = await app.request("/metrics");
  return { res, body: (await res.json()) as MetricsView };
};
const appFor = (w: ReturnType<typeof makeWorld>) => createApp(w.deps, { origins: webOrigins("http://127.0.0.1:5180") });

describe("GET /metrics", () => {
  test("no book yet: honest zeros and nulls, nothing invented", async () => {
    const w = makeWorld();
    const { res, body } = await getMetrics(appFor(w));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(METRICS_CACHE_CONTROL);
    expect(body.liveBooks).toBe(0);
    expect(body.tvl).toEqual({ booksUsd: "0.000000", insurancePoolUsd: null, insurancePoolFirstLossUsd: null, backstopUsd: null });
    expect(body.revenue).toEqual({ totalUsd: "0.000000", bySource: [] });
    expect(body.engine).toEqual({ markets: 0, openInterestUsd: { long: "0.000000", short: "0.000000", total: "0.000000" }, openPositions: 0 });
    expect(body.buybacks).toBeNull();
    expect(body.oracle).toEqual([]);
  });

  test("a live book, backstop, buybacks, revenue and a fresh oracle price", async () => {
    const w = makeWorld();
    seedBook(w);
    w.chain.totals = { backstopUsd: 5_000_000_000n, buybackSpentUsd: 250_000_000n, buybackPendingUsd: 10_000_000n };
    w.data.revenueRows = [
      { source: "engine_fees", totalUsd: "12.500000" },
      { source: "venue_taker_share", totalUsd: "7.500000" },
    ];
    w.data.openPositionCount = 3;
    w.kv.put(KEYS.oracleLast("NVDA"), { priceId: "NVDA", underlying: "0x00", priceWad: "1", price: 100, publishedAt: Math.floor(NOW / 1000) - 42, held: false, sourceCount: 2, sources: [], sourcesHash: "0x0", signature: "0x0" });
    const { body } = await getMetrics(appFor(w));
    expect(body.liveBooks).toBe(1);
    expect(body.tvl.booksUsd).toBe("100300.000000");
    expect(body.tvl.backstopUsd).toBe("5000.000000");
    expect(body.revenue.totalUsd).toBe("20.000000");
    expect(body.buybacks).toEqual({ spentUsd: "250.000000", pendingUsd: "10.000000" });
    expect(body.engine.openPositions).toBe(3);
    expect(body.oracle).toEqual([{ priceId: "NVDA", ageSeconds: 42, held: false }]);
  });

  test("cached for 30 s: one computation per window", async () => {
    expect(METRICS_CACHE_MS).toBeGreaterThanOrEqual(30_000);
    const w = makeWorld();
    const app = appFor(w);
    expect((await getMetrics(app)).body.buybacks).toBeNull();
    w.chain.totals = { backstopUsd: 1n, buybackSpentUsd: 1n, buybackPendingUsd: 0n };
    expect((await getMetrics(app)).body.buybacks).toBeNull();
    w.now.ms += METRICS_CACHE_MS;
    expect((await getMetrics(app)).body.buybacks).not.toBeNull();
  });

  test("an unreadable chain leaves figures null; a failing database answers 503", async () => {
    const w = makeWorld({ chain: false });
    seedBook(w);
    const { body } = await getMetrics(appFor(w));
    expect(body.tvl.backstopUsd).toBeNull();
    expect(body.buybacks).toBeNull();
    expect(body.engine.openInterestUsd).toBeNull();
    const w2 = makeWorld();
    w2.data.listBooks = async () => {
      throw new Error("db down");
    };
    expect((await appFor(w2).request("/metrics")).status).toBe(503);
  });

  test("public and wallet-free: no addresses, keys or hosts", async () => {
    const w = makeWorld();
    seedBook(w);
    const text = await (await appFor(w).request("/metrics")).text();
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(text).not.toMatch(/redis|postgres|mnemonic|token|wallet/i);
  });
});

describe("buildMetrics", () => {
  const base = { now: NOW, chainId: 4663, books: [], insurance: null, totals: null, revenue: [], openPositions: 0, markets: [], prices: [] };
  test("open interest at the stored price; a priced-less market with open size makes it unknown", () => {
    const WAD = 10n ** 18n;
    const m = buildMetrics({ ...base, markets: [{ longSize: 2n * WAD, shortSize: -1n * WAD, priceWad: 100n * WAD }] });
    expect(m.engine.openInterestUsd).toEqual({ long: "200.000000", short: "100.000000", total: "300.000000" });
    expect(buildMetrics({ ...base, markets: [{ longSize: WAD, shortSize: 0n, priceWad: null }] }).engine.openInterestUsd).toBeNull();
  });
  test("insurance pool from the snapshot, 6 dp", () => {
    const m = buildMetrics({ ...base, insurance: { poolAssets: "1500", firstLoss: "100.5" } });
    expect(m.tvl.insurancePoolUsd).toBe("1500.000000");
    expect(m.tvl.insurancePoolFirstLossUsd).toBe("100.500000");
  });
});
