// Pull-oracle price data selection (docs/LOW_GAS.md §1): freshest signed update per underlying across the
// Redis bundle, the oracle HTTP bundle and the per-price stream; domain checks; encoding round trips.
import { describe, expect, test } from "bun:test";
import { KEYS, type OracleBundleMsg, type OraclePriceMsg, type PriceUpdate, decodePriceData, devAccount, encodePriceData, priceId, priceTypedData } from "@bookrunner/shared";
import { type Address, type Hex, keccak256, toHex } from "viem";
import type { OraclePoint } from "../src/chain/book-chain";
import { DESK_ACTION } from "../src/chain/desk-actions";
import {
  PullPrices,
  bundleUpdates,
  deskPriceData,
  deskWant,
  freshestBundle,
  freshestOracleLatest,
  httpBundleSource,
  isSignature,
  msgUpdate,
  newerPoint,
  redisBundleSource,
  resolvePullMode,
  selectFreshest,
  toPriceData,
} from "../src/chain/pull-prices";

const ORACLE = "0x00000000000000000000000000000000000000aa" as Address;
const DOMAIN = { chainId: 31337, oracle: ORACLE };
const NVDA = priceId("NVDA");
const TSLA = priceId("TSLA");
const RHX5 = priceId("RHX5");
const signer = devAccount("oracleSigner");

const upd = (id: Hex, price: number, at: number, held = false): PriceUpdate => ({
  underlying: id,
  priceWad: BigInt(Math.round(price * 1e6)) * 10n ** 12n,
  publishedAt: BigInt(at),
  held,
  sourceCount: 3,
  sourcesHash: keccak256(toHex(`${id}:${at}`)),
});
const sign = (u: PriceUpdate, oracle: Address = ORACLE) => signer.signTypedData(priceTypedData(31337, oracle, u));

async function bundle(updates: PriceUpdate[], over: Partial<OracleBundleMsg> = {}): Promise<OracleBundleMsg> {
  const sigs = await Promise.all(updates.map((u) => sign(u)));
  return {
    priceData: encodePriceData(updates, sigs),
    publishedAt: Math.max(...updates.map((u) => Number(u.publishedAt))),
    chainId: 31337,
    oracle: ORACLE,
    priceIds: updates.map((u) => u.underlying),
    ...over,
  };
}

async function streamMsg(u: PriceUpdate, id = "NVDA"): Promise<OraclePriceMsg> {
  return {
    priceId: id,
    underlying: u.underlying,
    priceWad: u.priceWad.toString(),
    price: Number(u.priceWad) / 1e18,
    publishedAt: Number(u.publishedAt),
    held: u.held,
    sourceCount: u.sourceCount,
    sources: [],
    sourcesHash: u.sourcesHash,
    signature: await sign(u),
  };
}

describe("bundle parsing", () => {
  test("bundleUpdates decodes a valid bundle; foreign domain, malformed or unsigned entries yield nothing", async () => {
    const b = await bundle([upd(NVDA, 190, 100), upd(TSLA, 440, 100)]);
    const got = bundleUpdates(b, DOMAIN, "redis");
    expect(got.map((g) => [g.update.underlying, g.source])).toEqual([
      [NVDA, "redis"],
      [TSLA, "redis"],
    ]);
    expect(bundleUpdates({ ...b, chainId: 46630 }, DOMAIN)).toEqual([]);
    expect(bundleUpdates({ ...b, oracle: "0x00000000000000000000000000000000000000bb" }, DOMAIN)).toEqual([]);
    expect(bundleUpdates({ ...b, oracle: ORACLE.toUpperCase().replace("0X", "0x") }, DOMAIN)).toHaveLength(2); // case-insensitive
    // the LOW_GAS.md minimum shape {priceData, publishedAt} (no domain fields) is accepted
    expect(bundleUpdates({ priceData: b.priceData, publishedAt: b.publishedAt }, DOMAIN)).toHaveLength(2);
    expect(bundleUpdates({ priceData: "0xdeadbeef", publishedAt: 1 }, DOMAIN)).toEqual([]);
    expect(bundleUpdates(null, DOMAIN)).toEqual([]);
    expect(bundleUpdates("nope", DOMAIN)).toEqual([]);
    const unsigned = encodePriceData([upd(NVDA, 190, 100)], ["0x1234"]);
    expect(bundleUpdates({ priceData: unsigned, publishedAt: 100 }, DOMAIN)).toEqual([]);
  });

  test("msgUpdate: a signed stream message is carriable, the chain fallback ('0x') is not", async () => {
    const m = await streamMsg(upd(NVDA, 190.5, 200));
    expect(msgUpdate(m)?.update).toEqual(upd(NVDA, 190.5, 200));
    expect(msgUpdate({ ...m, signature: "0x" })).toBeNull();
    expect(msgUpdate(null)).toBeNull();
    expect(isSignature(m.signature)).toBe(true);
    expect(isSignature("0x")).toBe(false);
  });

  test("freshestBundle picks the newest valid bundle", async () => {
    const older = await bundle([upd(NVDA, 190, 100)]);
    const newer = await bundle([upd(NVDA, 191, 105)]);
    const foreign = await bundle([upd(NVDA, 192, 110)], { chainId: 1 });
    expect(freshestBundle([older, null, newer, foreign, { junk: true }], DOMAIN)).toBe(newer);
    expect(freshestBundle([foreign], DOMAIN)).toBeNull();
    expect(freshestBundle([], DOMAIN)).toBeNull();
  });
});

describe("selectFreshest", () => {
  test("per underlying the highest publishedAt across sources; want order kept, duplicates dropped", async () => {
    const redis = bundleUpdates(await bundle([upd(NVDA, 190, 100), upd(TSLA, 440, 104), upd(RHX5, 315, 104)]), DOMAIN, "redis");
    const http = bundleUpdates(await bundle([upd(NVDA, 190.2, 103), upd(TSLA, 439, 101)]), DOMAIN, "http");
    const stream = [msgUpdate(await streamMsg(upd(NVDA, 190.4, 105)))!];
    const sel = selectFreshest([...redis, ...http, ...stream], [TSLA, NVDA, TSLA, priceId("AAPL")], { nowSec: 106, maxAgeSec: 60 });
    expect(sel.map((s) => [s.update.underlying, Number(s.update.publishedAt), s.source])).toEqual([
      [TSLA, 104, "redis"],
      [NVDA, 105, "stream"],
    ]);
  });

  test("drops updates older than maxAgeSec; keeps a slightly future publishedAt; tie -> first candidate", async () => {
    const a = bundleUpdates(await bundle([upd(NVDA, 190, 100)]), DOMAIN, "a");
    const b = bundleUpdates(await bundle([upd(NVDA, 190, 100)]), DOMAIN, "b");
    expect(selectFreshest([...a, ...b], [NVDA], { nowSec: 110, maxAgeSec: 15 })[0]!.source).toBe("a");
    expect(selectFreshest([...a, ...b], [NVDA], { nowSec: 116, maxAgeSec: 15 })).toEqual([]);
    const future = bundleUpdates(await bundle([upd(NVDA, 190, 120)]), DOMAIN, "f");
    expect(selectFreshest(future, [NVDA], { nowSec: 117, maxAgeSec: 15 })).toHaveLength(1);
  });

  test("toPriceData encodes exactly the selection (signatures intact); nothing selected -> null", async () => {
    const cands = bundleUpdates(await bundle([upd(NVDA, 190, 100), upd(TSLA, 440, 100)]), DOMAIN);
    const sel = selectFreshest(cands, [TSLA], { nowSec: 100, maxAgeSec: 60 });
    const data = toPriceData(sel)!;
    const back = decodePriceData(data);
    expect(back.updates).toEqual([upd(TSLA, 440, 100)]);
    expect(back.sigs).toEqual([cands[1]!.sig]);
    expect(toPriceData([])).toBeNull();
  });
});

describe("PullPrices provider", () => {
  test("merges every source + the stream, survives failing / hanging sources, memoizes briefly", async () => {
    let now = 106_000;
    let redisCalls = 0;
    const redisB = await bundle([upd(NVDA, 190, 100), upd(TSLA, 440, 105)]);
    const p = new PullPrices({
      sources: [
        {
          name: "redis",
          get: async () => {
            redisCalls++;
            return redisB;
          },
        },
        { name: "down", get: async () => Promise.reject(new Error("ECONNREFUSED")) },
        { name: "hang", get: () => new Promise(() => {}) },
      ],
      stream: () => [null, { ...(redisB as unknown as OraclePriceMsg), signature: "0x" }],
      domain: DOMAIN,
      timeoutMs: 20,
      memoMs: 500,
      now: () => now,
    });
    const data = await p.priceData([NVDA, TSLA], 60);
    expect(decodePriceData(data!).updates.map((u) => u.underlying)).toEqual([NVDA, TSLA]);
    await p.priceData([NVDA], 60);
    expect(redisCalls).toBe(1); // memoized
    now += 600;
    expect(await p.point(TSLA, 60)).toEqual({ priceWad: 440n * 10n ** 18n, publishedAt: 105, held: false, sourceCount: 3 });
    expect(redisCalls).toBe(2);
    expect(await p.point(priceId("AAPL"), 60)).toBeNull();
    expect(await p.priceData([], 60)).toBeNull();
  });

  test("redis + http sources", async () => {
    const b = await bundle([upd(NVDA, 190, 100)]);
    const keys: string[] = [];
    const redis = redisBundleSource(async (k) => (keys.push(k), b));
    expect(await redis.get()).toBe(b);
    expect(keys).toEqual([KEYS.oracleBundle]);
    const urls: string[] = [];
    const http = httpBundleSource("http://127.0.0.1:4410/", async (url) => (urls.push(url), { ok: true, status: 200, json: async () => b }));
    expect(await http.get()).toEqual(b);
    expect(urls).toEqual(["http://127.0.0.1:4410/prices/signed"]);
    const notYet = httpBundleSource("http://x", async () => ({ ok: false, status: 503, json: async () => ({ error: "no signed bundle yet" }) }));
    expect(await notYet.get()).toBeNull();
  });
});

describe("desk action price data", () => {
  test("SetQuote carries the book price only, ReturnToVault nothing, hedge legs book + components", () => {
    const comps = [NVDA, TSLA];
    expect(deskWant(DESK_ACTION.SetQuote, RHX5, comps)).toEqual([RHX5]);
    expect(deskWant(DESK_ACTION.ReturnToVault, RHX5, comps)).toEqual([]);
    for (const k of [DESK_ACTION.Hedge, DESK_ACTION.Flatten, DESK_ACTION.FundDesk, DESK_ACTION.InventoryToVenue, DESK_ACTION.InventoryToVault]) {
      expect(deskWant(k, RHX5, comps)).toEqual([RHX5, NVDA, TSLA]);
    }
  });

  test("deskPriceData encodes the per-kind selection and resolves components only when needed", async () => {
    const b = await bundle([upd(RHX5, 315, 100), upd(NVDA, 190, 100), upd(TSLA, 440, 100)]);
    const p = new PullPrices({ sources: [{ name: "redis", get: async () => b }], domain: DOMAIN, now: () => 101_000 });
    let compCalls = 0;
    const d = deskPriceData(p, { bookPriceId: RHX5, componentPriceIds: async () => (compCalls++, [NVDA, TSLA]), maxAgeSec: 60 });
    const q = decodePriceData((await d.forAction(DESK_ACTION.SetQuote))!);
    expect(q.updates.map((u) => u.underlying)).toEqual([RHX5]);
    expect(compCalls).toBe(0);
    const h = decodePriceData((await d.forAction(DESK_ACTION.Hedge))!);
    expect(h.updates.map((u) => u.underlying)).toEqual([RHX5, NVDA, TSLA]);
    expect(compCalls).toBe(1);
    expect(await d.forAction(DESK_ACTION.ReturnToVault)).toBeNull();
    // too old for the bound -> nothing to carry -> plain execute
    const old = deskPriceData(new PullPrices({ sources: [{ name: "redis", get: async () => b }], domain: DOMAIN, now: () => 500_000 }), {
      bookPriceId: RHX5,
      componentPriceIds: async () => [],
      maxAgeSec: 60,
    });
    expect(await old.forAction(DESK_ACTION.SetQuote)).toBeNull();
  });
});

describe("helpers", () => {
  const pt = (publishedAt: number, price = 1n): OraclePoint => ({ priceWad: price, publishedAt, held: false, sourceCount: 3 });

  test("newerPoint / freshestOracleLatest prefer the newer price and survive one side failing", async () => {
    expect(newerPoint(pt(1), pt(2))).toEqual(pt(2));
    expect(newerPoint(pt(2), pt(2, 5n))).toEqual(pt(2)); // tie: first
    expect(newerPoint(null, pt(1))).toEqual(pt(1));
    let signed: OraclePoint | null = pt(10, 7n);
    let stored: OraclePoint | Error = pt(5, 3n);
    const f = freshestOracleLatest(
      { point: async () => signed },
      async () => {
        if (stored instanceof Error) throw stored;
        return stored;
      },
      60,
    );
    expect(await f(NVDA)).toEqual(pt(10, 7n));
    stored = pt(20, 9n);
    expect(await f(NVDA)).toEqual(pt(20, 9n));
    stored = new Error("rpc down");
    expect(await f(NVDA)).toEqual(pt(10, 7n));
    signed = null;
    await expect(f(NVDA)).rejects.toThrow(/no price/);
  });

  test("resolvePullMode", async () => {
    expect(await resolvePullMode("off", async () => true)).toBe(false);
    expect(await resolvePullMode("on", async () => false)).toBe(true);
    expect(await resolvePullMode("auto", async () => true)).toBe(true);
    expect(await resolvePullMode("auto", async () => Promise.reject(new Error("rpc")))).toBe(false);
  });
});
