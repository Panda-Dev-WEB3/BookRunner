import { describe, expect, test } from "bun:test";
import { GbmPath, SECONDS_PER_YEAR } from "../src/domain/gbm";
import { normal, uniform } from "../src/domain/rng";
import { SyntheticMarket, syntheticSources } from "../src/sources/synthetic";

const params = { s0: 190, volAnnual: 0.45, stepMs: 1000 };

describe("rng", () => {
  test("uniform is in (0,1) and a pure function of its inputs", () => {
    for (let i = 0; i < 1000; i++) {
      const u = uniform(42, i, 7);
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(1);
      expect(uniform(42, i, 7)).toBe(u);
    }
    expect(uniform(42, 1)).not.toBe(uniform(43, 1));
    expect(uniform(42, 2 ** 33)).not.toBe(uniform(42, 2 ** 34)); // high bits matter
  });

  test("normal draws have ~zero mean and unit variance", () => {
    const n = 20_000;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const z = normal(7, i);
      s += z;
      s2 += z * z;
    }
    expect(Math.abs(s / n)).toBeLessThan(0.03);
    expect(Math.abs(s2 / n - 1)).toBeLessThan(0.05);
  });
});

describe("GBM path", () => {
  test("deterministic given seed + ticker", () => {
    const a = new GbmPath("seed-1", "NVDA", params).series(500);
    const b = new GbmPath("seed-1", "NVDA", params).series(500);
    expect(a).toEqual(b);
    expect(a[0]).toBe(190);
  });

  test("seed and ticker each change the path", () => {
    const base = new GbmPath("seed-1", "NVDA", params).priceAt(300);
    expect(new GbmPath("seed-2", "NVDA", params).priceAt(300)).not.toBe(base);
    expect(new GbmPath("seed-1", "TSLA", params).priceAt(300)).not.toBe(base);
  });

  test("random access equals sequential access (backwards recomputes)", () => {
    const p = new GbmPath("s", "AAPL", { s0: 255, volAnnual: 0.25, stepMs: 1000 });
    const at900 = p.priceAt(900);
    const at100 = p.priceAt(100); // goes back
    const fresh = new GbmPath("s", "AAPL", { s0: 255, volAnnual: 0.25, stepMs: 1000 });
    expect(fresh.priceAt(100)).toBe(at100);
    expect(fresh.priceAt(900)).toBe(at900);
  });

  test("log-return volatility matches the annualised parameter", () => {
    const vol = 0.6;
    const stepMs = 60_000;
    const p = new GbmPath("vol-check", "TSLA", { s0: 440, volAnnual: vol, stepMs });
    const n = 20_000;
    let prev = Math.log(p.priceAt(0));
    let s2 = 0;
    for (let i = 1; i <= n; i++) {
      const cur = Math.log(p.priceAt(i));
      s2 += (cur - prev) ** 2;
      prev = cur;
    }
    const realised = Math.sqrt(s2 / n) / Math.sqrt(stepMs / 1000 / SECONDS_PER_YEAR);
    expect(Math.abs(realised - vol) / vol).toBeLessThan(0.03);
  });

  test("rejects bad parameters", () => {
    expect(() => new GbmPath("s", "X", { s0: 0, volAnnual: 0.2, stepMs: 1000 })).toThrow();
    expect(() => new GbmPath("s", "X", { s0: 1, volAnnual: 0.2, stepMs: 0 })).toThrow();
    expect(() => new GbmPath("s", "X", params).priceAt(-1)).toThrow();
  });
});

describe("synthetic sources", () => {
  const mk = (seed = "devnet") =>
    new SyntheticMarket({
      seed,
      stepMs: 1000,
      epochMs: 1_000_000,
      tickers: { NVDA: { s0: 190, vol: 0.45 }, TSLA: { s0: 440, vol: 0.6 } },
      noiseBps: 3,
      dropoutProb: 0.05,
      spikeProb: 0.01,
      spikeBps: 400,
    });

  test("three sources share one path and are reproducible", async () => {
    let now = 1_000_000 + 42_500;
    const srcs = syntheticSources(mk(), () => now);
    expect(srcs.map((s) => s.name)).toEqual(["synthetic-a", "synthetic-b", "synthetic-c"]);
    const again = syntheticSources(mk(), () => now);
    for (let i = 0; i < 3; i++) expect(await srcs[i]!.fetch("NVDA")).toEqual(await again[i]!.fetch("NVDA"));
    now += 1000;
    const q = await srcs[0]!.fetch("NVDA");
    if (q) expect(q.ts).toBe(1_000_000 + 43_000); // stamped at the step boundary
  });

  test("noise is small, dropouts and spikes occur at roughly the configured rates", () => {
    const m = mk();
    let drops = 0;
    let spikes = 0;
    let total = 0;
    for (let step = 0; step < 4000; step++) {
      const ms = 1_000_000 + step * 1000;
      const base = m.basePrice("NVDA", ms)!;
      for (let i = 0; i < 3; i++) {
        total++;
        const o = m.observe("NVDA", i, ms);
        if (!o) {
          drops++;
          continue;
        }
        const devBps = (Math.abs(o.price - base) / base) * 1e4;
        if (devBps > 100) spikes++;
        else expect(devBps).toBeLessThan(20); // ~6 sigma of 3 bps noise
      }
    }
    expect(drops / total).toBeGreaterThan(0.03);
    expect(drops / total).toBeLessThan(0.07);
    expect(spikes / total).toBeGreaterThan(0.004);
    expect(spikes / total).toBeLessThan(0.02);
  });

  test("unknown tickers return null; addTicker extends the market", async () => {
    const m = mk();
    const [a] = syntheticSources(m, () => 1_000_000);
    expect(await a!.fetch("AAPL")).toBeNull();
    m.addTicker("AAPL", { s0: 255, vol: 0.25 });
    expect(m.basePrice("AAPL", 1_000_000)).toBe(255);
  });
});
