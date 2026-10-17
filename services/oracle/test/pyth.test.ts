// Pyth Pro source (sources/pyth.ts): one batched POST per tick, mantissa x 10^exponent, the feed's own
// timestamp, null when closed / stale / missing, and the access token never in a log line or an error.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@bookrunner/shared";
import { DEFAULT_PYTH_FEEDS, loadOracleConfig } from "../src/config";
import { buildSources } from "../src/sources/index";
import { PYTH_PROPERTIES, type PythPost, PythProSource, pythObservation, scalePythPrice } from "../src/sources/pyth";

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/pyth-latest-price.json"), "utf8")) as unknown;
const T0 = Date.parse("2026-10-01T15:00:00Z"); // fixture parsed.timestampUs
const KEY = "pyth-secret-token-123";
const URL = "https://pyth-lazer.example/v1/latest_price";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakePost(respond: () => { ok: boolean; status: number; body: unknown } = () => ({ ok: true, status: 200, body: FIXTURE })) {
  const calls: Call[] = [];
  const post: PythPost = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    const r = respond();
    return { ok: r.ok, status: r.status, json: async () => r.body };
  };
  return { calls, post };
}

const source = (post: PythPost, now = () => T0, extra: Partial<ConstructorParameters<typeof PythProSource>[0]> = {}) =>
  new PythProSource({ url: URL, apiKey: KEY, feeds: DEFAULT_PYTH_FEEDS, post, now, ...extra });

function captureLog() {
  const lines: string[] = [];
  const rec = (level: string) => (...args: unknown[]) => void lines.push(`${level} ${JSON.stringify(args)}`);
  const log = { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug"), fatal: rec("fatal"), trace: rec("trace") } as unknown as Logger;
  return { lines, log };
}

describe("Pyth Pro: scaling and parsing", () => {
  test("mantissa x 10^exponent, negative exponents included, exact decimal scaling", () => {
    expect(scalePythPrice("18523456", -5)).toBe(185.23456);
    expect(scalePythPrice("44012345000", -8)).toBe(440.12345);
    expect(scalePythPrice(19, 1)).toBe(190);
    expect(scalePythPrice("123", 0)).toBe(123);
    expect(scalePythPrice("0.5", -2)).toBeNull();
    expect(scalePythPrice("12a", -2)).toBeNull();
    expect(scalePythPrice("1", 1.5)).toBeNull();
  });

  test("observation: own feedUpdateTimestamp (us -> ms), closed / stale / unusable -> null", () => {
    const f = { priceFeedId: 1314, price: "18523456", exponent: -5, marketSession: "regular", feedUpdateTimestamp: 1_790_866_799_600_000 };
    expect(pythObservation(f, T0, 10_000)).toEqual({ price: 185.23456, ts: T0 - 400, maxAgeMs: 10_000 });
    expect(pythObservation({ ...f, feedUpdateTimestamp: "1790866799600000" }, T0, 10_000)?.ts).toBe(T0 - 400);
    expect(pythObservation({ ...f, marketSession: "closed" }, T0, 10_000)).toBeNull();
    expect(pythObservation({ ...f, marketSession: "overNight" }, T0, 10_000)?.price).toBe(185.23456);
    expect(pythObservation(f, T0 + 10_401, 10_000)).toBeNull(); // > 10 s old
    expect(pythObservation({ ...f, feedUpdateTimestamp: null }, T0, 10_000)).toBeNull(); // never the receive time
    expect(pythObservation({ ...f, price: null }, T0, 10_000)).toBeNull();
    expect(pythObservation({ ...f, exponent: null }, T0, 10_000)).toBeNull();
    expect(pythObservation({ ...f, price: "0" }, T0, 10_000)).toBeNull();
    expect(pythObservation({ ...f, price: "-5" }, T0, 10_000)).toBeNull();
  });
});

describe("Pyth Pro: source", () => {
  test("one batched request per tick serves every ticker; fixture prices per share", async () => {
    const { calls, post } = fakePost();
    const src = source(post);
    expect(src.kind).toBe("pyth");
    expect(src.name).toBe("pyth");
    expect(src.maxAgeMs).toBe(10_000);
    const [nvda, tsla, aapl, msft, amzn] = await Promise.all(["NVDA", "TSLA", "AAPL", "MSFT", "AMZN"].map((t) => src.fetch(t)));
    expect(calls).toHaveLength(1);
    expect(nvda).toEqual({ price: 185.23456, ts: T0 - 400, maxAgeMs: 10_000 });
    expect(tsla).toEqual({ price: 440.12345, ts: T0 - 2_000, maxAgeMs: 10_000 }); // post-market session counts
    expect(aapl).toBeNull(); // 30 s old
    expect(msft).toBeNull(); // session closed
    expect(amzn).toBeNull(); // missing from the response
    expect(await src.fetch("GME")).toBeNull(); // no feed id configured
    expect(calls).toHaveLength(1);

    const c = calls[0]!;
    expect(c.url).toBe(URL);
    expect(c.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(c.headers["content-type"]).toBe("application/json");
    expect(c.body).toEqual({ priceFeedIds: [922, 954, 1292, 1314, 1435], properties: [...PYTH_PROPERTIES], formats: [], channel: "fixed_rate@200ms", parsed: true });
  });

  test("a new tick makes a new request; the channel is configurable", async () => {
    let now = T0;
    const { calls, post } = fakePost();
    const src = source(post, () => now, { channel: "fixed_rate@1000ms", cacheMs: 500 });
    await src.fetch("NVDA");
    now += 499;
    await src.fetch("TSLA");
    expect(calls).toHaveLength(1);
    now += 1;
    await src.fetch("NVDA");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.channel).toBe("fixed_rate@1000ms");
  });

  test("ORACLE_PYTH_FEEDS overrides map tickers to other feed ids", async () => {
    const { calls, post } = fakePost();
    const src = source(post, () => T0, { feeds: { ...DEFAULT_PYTH_FEEDS, AMZN: 1314 } });
    expect((await src.fetch("AMZN"))?.price).toBe(185.23456);
    expect(calls[0]!.body.priceFeedIds).toEqual([922, 1292, 1314, 1435]);
  });

  test("HTTP errors and bad bodies throw (shared by the tick), without the access token", async () => {
    for (const status of [401, 403, 429, 500]) {
      const { calls, post } = fakePost(() => ({ ok: false, status, body: { error: "nope" } }));
      const src = source(post);
      const errs = await Promise.all(["NVDA", "TSLA"].map((t) => src.fetch(t).then(() => "", (e: Error) => e.message)));
      expect(errs[0]).toContain(`pyth: HTTP ${status}`);
      expect(errs[1]).toBe(errs[0]!);
      expect(calls).toHaveLength(1);
      for (const e of errs) expect(e).not.toContain(KEY);
    }
    const { post: empty } = fakePost(() => ({ ok: true, status: 200, body: { parsed: null } }));
    await expect(source(empty).fetch("NVDA")).rejects.toThrow("no parsed.priceFeeds");
  });

  test("a transport error that echoes the token is redacted", async () => {
    const post: PythPost = async () => {
      throw new Error(`connect failed: Authorization: Bearer ${KEY}`);
    };
    const err = await source(post)
      .fetch("NVDA")
      .then(() => null, (e: Error) => e.message);
    expect(err).toBe("pyth: connect failed: Authorization: Bearer ***");
  });

  test("refuses to construct without an access token", () => {
    expect(() => new PythProSource({ url: URL, apiKey: "", feeds: DEFAULT_PYTH_FEEDS })).toThrow("PYTH_API_KEY");
  });
});

describe("Pyth Pro: config and source assembly", () => {
  test("defaults: off, official endpoint, 10 s max age, the five US-equity feed ids", () => {
    const c = loadOracleConfig({});
    expect(c.ORACLE_PYTH).toBe(false);
    expect(c.PYTH_API_KEY).toBeUndefined();
    expect(c.ORACLE_PYTH_URL).toBe("https://pyth-lazer.dourolabs.app/v1/latest_price");
    expect(c.ORACLE_PYTH_CHANNEL).toBe("fixed_rate@200ms");
    expect(c.ORACLE_PYTH_MAX_AGE_MS).toBe(10_000);
    expect(c.pythFeeds).toEqual({ NVDA: 1314, TSLA: 1435, AAPL: 922, MSFT: 1292, AMZN: 954 });
    const o = loadOracleConfig({ ORACLE_PYTH_FEEDS: '{"NVDA":7,"GME":99}', ORACLE_PYTH_CHANNEL: "real_time" });
    expect(o.pythFeeds).toMatchObject({ NVDA: 7, GME: 99, TSLA: 1435 });
    expect(() => loadOracleConfig({ ORACLE_PYTH_FEEDS: '{"NVDA":"Equity.US.NVDA/USD"}' })).toThrow("ORACLE_PYTH_FEEDS");
    expect(() => loadOracleConfig({ ORACLE_PYTH_CHANNEL: "fast" })).toThrow("ORACLE_PYTH_CHANNEL");
  });

  test("ORACLE_PYTH=1 builds the source; without a key it is skipped; the key is never logged", () => {
    const on = captureLog();
    const built = buildSources(loadOracleConfig({ CHAIN_ID: "46630", ORACLE_SYNTHETIC: "0", ORACLE_PYTH: "1", PYTH_API_KEY: KEY }), on.log);
    expect(built.sources.map((s) => `${s.name}:${s.kind}`)).toEqual(["pyth:pyth"]);
    expect(on.lines.some((l) => l.includes("Pyth Pro source enabled"))).toBe(true);
    for (const l of on.lines) expect(l).not.toContain(KEY);

    const off = captureLog();
    const none = buildSources(loadOracleConfig({ CHAIN_ID: "46630", ORACLE_SYNTHETIC: "0", ORACLE_PYTH: "1" }), off.log);
    expect(none.sources).toEqual([]);
    expect(off.lines.some((l) => l.startsWith("warn") && l.includes("PYTH_API_KEY is not set"))).toBe(true);
    expect(buildSources(loadOracleConfig({ CHAIN_ID: "46630", ORACLE_SYNTHETIC: "0", PYTH_API_KEY: KEY }), captureLog().log).sources).toEqual([]);
  });
});
