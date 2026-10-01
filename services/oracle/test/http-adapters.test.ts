import { describe, expect, test } from "bun:test";
import { SESSIONS_24X7, checkCopy, encodeSessions, priceId } from "@bookrunner/shared";
import { LiveOrderlyPriceClient, MockOrderlyPriceClient, NotConfiguredError, builderPriceClient } from "../src/adapters/venue";
import { loadOracleConfig } from "../src/config";
import { buildUniverse } from "../src/domain/universe";
import { ATTESTATION_NOTE, createApp } from "../src/http";
import { startLoop } from "../src/loop";
import { ChainlinkSource } from "../src/sources/chainlink";
import { GenericHttpSource, finnhubSpec, getPath } from "../src/sources/http";
import { FakeChain, ORACLE_ADDR, ScriptedSource, makeService, silentLog } from "./fakes";

describe("HTTP API", () => {
  async function app() {
    const t = Date.parse("2026-10-01T15:00:00Z");
    const srcs = ["a", "b", "c"].map((n) => new ScriptedSource(n, () => t));
    for (const s of srcs) s.set("NVDA", { price: 190 });
    const { svc, signerAccount } = makeService({ sources: srcs, now: () => t });
    const chain = new FakeChain();
    chain.head = Math.floor(t / 1000);
    await svc.setDeployment({ chainId: 31337, oracle: ORACLE_ADDR, chain });
    await svc.setUniverse(
      buildUniverse({ equities: [{ priceId: "NVDA", underlying: priceId("NVDA") }], indexes: [], books: [], defaultSessions: encodeSessions(SESSIONS_24X7) }).entries,
    );
    await svc.tick(t);
    await svc.idle();
    return { app: createApp(svc), signer: signerAccount.address };
  }

  test("GET /health", async () => {
    const { app: a } = await app();
    const res = await a.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { onchain: { signerRegistered: boolean } };
    expect(body).toMatchObject({ ok: true, service: "oracle", status: "running", chainId: 31337 });
    expect(body.onchain.signerRegistered).toBe(true);
  });

  test("GET /prices and /prices/:id", async () => {
    const { app: a } = await app();
    const all = (await (await a.request("/prices")).json()) as { prices: Array<{ priceId: string; price: number }> };
    expect(all.prices.map((p) => [p.priceId, p.price])).toEqual([["NVDA", 190]]);
    expect((await a.request("/prices/NVDA")).status).toBe(200);
    expect((await a.request("/prices/NOPE")).status).toBe(404);
    expect((await a.request("/nope")).status).toBe(404);
  });

  test("GET /attestation: signer + devnet placeholder quote", async () => {
    const { app: a, signer } = await app();
    const body = (await (await a.request("/attestation")).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ signer, chainId: 31337, oracle: ORACLE_ADDR, registered: true, attestation: { type: "devnet-plain-key", quote: null } });
    expect(String(body.note)).toContain("VERIFY");
    expect(checkCopy(ATTESTATION_NOTE)).toEqual([]);
  });
});

describe("venue builder price clients", () => {
  test("mock client POSTs {symbol, price, held} to /mock/price", async () => {
    const calls: Array<{ url: string; body: unknown; method: string }> = [];
    const c = new MockOrderlyPriceClient("http://127.0.0.1:4420/", 1000, async (url, init) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => "" };
    });
    await c.setBuilderPrice({ symbol: "PERP_NVDA_USDC", price: 190.5, held: true, ts: 1 });
    expect(calls).toEqual([{ url: "http://127.0.0.1:4420/mock/price", method: "POST", body: { symbol: "PERP_NVDA_USDC", price: 190.5, held: true } }]);
  });

  test("mock client surfaces HTTP errors", async () => {
    const c = new MockOrderlyPriceClient("http://x", 1000, async () => ({ ok: false, status: 503, text: async () => "down" }));
    await expect(c.setBuilderPrice({ symbol: "S", price: 1, held: false, ts: 1 })).rejects.toThrow("HTTP 503");
  });

  test("live client is a typed stub that refuses with NotConfiguredError", async () => {
    const c = builderPriceClient("live", "https://api.example");
    expect(c).toBeInstanceOf(LiveOrderlyPriceClient);
    await expect(c.setBuilderPrice({ symbol: "S", price: 1, held: false, ts: 1 })).rejects.toBeInstanceOf(NotConfiguredError);
  });
});

describe("optional sources", () => {
  test("AggregatorV3 source scales by decimals, caches decimals, ignores unknown / bad answers", async () => {
    let decCalls = 0;
    let answer = 19_012_345_678n;
    const src = new ChainlinkSource(
      { NVDA: "0x00000000000000000000000000000000000000c1" },
      {
        decimals: async () => {
          decCalls++;
          return 8;
        },
        latestRoundData: async () => ({ answer, updatedAt: 1_790_000_000n }),
      },
      3_600_000,
    );
    expect(await src.fetch("NVDA")).toEqual({ price: 190.12345678, ts: 1_790_000_000_000 });
    expect(await src.fetch("NVDA")).not.toBeNull();
    expect(decCalls).toBe(1);
    expect(await src.fetch("TSLA")).toBeNull();
    answer = 0n;
    expect(await src.fetch("NVDA")).toBeNull();
    expect(src.maxAgeMs).toBe(3_600_000);
  });

  test("generic HTTP source: url template, symbol map, json paths, units", async () => {
    const seen: string[] = [];
    const src = new GenericHttpSource(
      { name: "px", url: "https://px.example/q/{ticker}", pricePath: "data.rows.0.p", tsPath: "data.t", tsUnit: "ms", headers: { k: "v" }, symbols: { NVDA: "NVDA.O" } },
      1000,
      async (url, init) => {
        seen.push(`${url} ${init.headers.k}`);
        return { ok: true, status: 200, json: async () => ({ data: { rows: [{ p: "190.25" }], t: 1_790_000_000_123 } }) };
      },
    );
    expect(await src.fetch("NVDA")).toEqual({ price: 190.25, ts: 1_790_000_000_123 });
    expect(seen).toEqual(["https://px.example/q/NVDA.O v"]);
  });

  test("generic HTTP source: errors throw, unusable bodies return null; finnhub preset uses a header key", async () => {
    const bad = new GenericHttpSource(finnhubSpec("k"), 1000, async () => ({ ok: false, status: 429, json: async () => ({}) }));
    await expect(bad.fetch("NVDA")).rejects.toThrow("HTTP 429");
    const empty = new GenericHttpSource(finnhubSpec("k"), 1000, async () => ({ ok: true, status: 200, json: async () => ({ c: 0, t: 0 }) }));
    expect(await empty.fetch("NVDA")).toBeNull();
    expect(finnhubSpec("secret").url).not.toContain("secret");
    expect(getPath({ a: [{ b: 1 }] }, "a.0.b")).toBe(1);
    expect(getPath({ a: 1 }, "a.b.c")).toBeUndefined();
  });
});

describe("config", () => {
  test("defaults", () => {
    const c = loadOracleConfig({});
    expect(c.ORACLE_PORT).toBe(4410);
    expect(c.ORACLE_OUTLIER_BPS).toBe(150);
    expect(c.ORACLE_PUSH_INTERVAL_MS).toBe(5000);
    expect(c.ORACLE_PUSH_DEVIATION_BPS).toBe(25);
    expect(c.ORACLE_MIN_SOURCES).toBe(3);
    expect(c.ORACLE_SYNTHETIC).toBe(true);
    expect(c.ORACLE_HTTP_FINNHUB).toBe(false);
    expect(c.SESSIONS_MODE).toBe("24x7");
    expect(c.tickers).toEqual(["NVDA", "TSLA", "AAPL", "MSFT", "AMZN"]);
    expect(c.demoPrices).toMatchObject({ NVDA: 190, TSLA: 440, AAPL: 255, MSFT: 520, AMZN: 230 });
    expect(c.vols).toMatchObject({ NVDA: 0.45, TSLA: 0.6, AAPL: 0.25, MSFT: 0.25, AMZN: 0.3 });
    expect(c.indexes.RHX5).toEqual({ NVDA: 2000, TSLA: 2000, AAPL: 2000, MSFT: 2000, AMZN: 2000 });
    expect(c.chainlinkFeeds).toEqual({});
  });

  test("overrides, flags and JSON maps", () => {
    const c = loadOracleConfig({
      ORACLE_PORT: "5555",
      ORACLE_SYNTHETIC: "0",
      ORACLE_DEMO_PRICES: '{"NVDA":200,"XYZ":10}',
      ORACLE_CHAINLINK_FEEDS: '{"NVDA":"0x00000000000000000000000000000000000000c1"}',
      ORACLE_HTTP_SOURCES: '[{"name":"x","url":"https://x/{ticker}","pricePath":"p"}]',
    });
    expect(c.ORACLE_PORT).toBe(5555);
    expect(c.ORACLE_SYNTHETIC).toBe(false);
    expect(c.demoPrices.NVDA).toBe(200);
    expect(c.demoPrices.TSLA).toBe(440);
    expect(c.demoPrices.XYZ).toBe(10);
    expect(c.httpSources[0]).toMatchObject({ name: "x", tsUnit: "s", headers: {}, symbols: {} });
  });

  test("invalid values fail with a clear message", () => {
    expect(() => loadOracleConfig({ ORACLE_DEMO_PRICES: "{nope" })).toThrow("ORACLE_DEMO_PRICES is not valid JSON");
    expect(() => loadOracleConfig({ ORACLE_CHAINLINK_FEEDS: '{"NVDA":"0x12"}' })).toThrow("ORACLE_CHAINLINK_FEEDS");
    expect(() => loadOracleConfig({ ORACLE_OUTLIER_BPS: "-1" })).toThrow("ORACLE_OUTLIER_BPS");
  });
});

describe("loop", () => {
  test("keeps running after errors and stops cleanly", async () => {
    let runs = 0;
    const loop = startLoop(
      "t",
      5,
      async () => {
        runs++;
        if (runs === 2) throw new Error("transient");
      },
      silentLog,
      10,
    );
    await Bun.sleep(120);
    await loop.stop();
    const after = runs;
    expect(after).toBeGreaterThan(3);
    await Bun.sleep(30);
    expect(runs).toBe(after);
  });
});
