import { describe, expect, test } from "bun:test";
import { HttpCharterServiceClient, parseCharterServiceReply } from "../src/charterService";
import { parseLiveNav, parseOraclePrice, parseRiskState, usdFromLoose } from "../src/domain/live";
import { NOTICE_TEXT, bucketOf, redeemSchedule } from "../src/domain/redemption";
import { dbUsdStr, parseUsd, sharePriceStr, toDate, usdStr, wadStr } from "../src/format";
import { MemoryKv, RedisKv, cached } from "../src/kv";
import { silentLog } from "./fakes";
import { sampleDraft } from "./fixtures";

describe("format", () => {
  test("USD decimal strings always carry 6 decimals", () => {
    expect(usdStr(25_000_000_000n)).toBe("25000.000000");
    expect(usdStr(-1_500_000n)).toBe("-1.500000");
    expect(usdStr(1n)).toBe("0.000001");
    expect(dbUsdStr("100.5")).toBe("100.500000");
    expect(dbUsdStr(null)).toBeNull();
    expect(parseUsd("1500.5")).toBe(1_500_500_000n);
    expect(parseUsd(0.000001)).toBe(1n);
  });

  test("share prices: WAD or human", () => {
    expect(wadStr(1_000_000_000_000_000_000n)).toBe("1.0");
    expect(wadStr(1_012_345_000_000_000_000n)).toBe("1.012345");
    expect(sharePriceStr(1.0123)).toBe("1.0123");
    expect(sharePriceStr(1.0123e18)).toBe("1.0123");
    expect(sharePriceStr("1010000000000000000")).toBe("1.01");
    expect(sharePriceStr("0.99")).toBe("0.99");
    expect(sharePriceStr(null)).toBeNull();
  });

  test("time inputs", () => {
    expect(toDate(1_790_000_000).getTime()).toBe(1_790_000_000_000);
    expect(toDate(1_790_000_000_000).getTime()).toBe(1_790_000_000_000);
    expect(toDate("1790000000").getTime()).toBe(1_790_000_000_000);
    expect(toDate("2026-10-02T00:00:00Z").toISOString()).toBe("2026-10-02T00:00:00.000Z");
    expect(() => toDate("nope")).toThrow();
  });
});

describe("redemption schedule", () => {
  test("Senior eligible now, Junior after notice; bucket = ceil(eligibleAt / interval)", () => {
    expect(redeemSchedule(0, 1000, 900n, 300)).toEqual({ requestedAt: 1000, eligibleAt: 1000, noticeSeconds: 0, requestId: "4", settlesAtPeriodEnd: 1200 });
    expect(redeemSchedule(1, 1000, 900n, 300)).toEqual({ requestedAt: 1000, eligibleAt: 1900, noticeSeconds: 900, requestId: "7", settlesAtPeriodEnd: 2100 });
    expect(redeemSchedule(0, 1200, 0n, 300).settlesAtPeriodEnd).toBe(1200); // exactly on a boundary
    expect(bucketOf("17", new Date(0), 300)).toBe(17n);
    expect(bucketOf(null, new Date(1_900_000), 300)).toBe(7n);
    expect(NOTICE_TEXT).toContain("not a gate");
  });
});

describe("live state parsers", () => {
  test("live NAV tolerates numbers, strings and nested tranches", () => {
    expect(parseLiveNav({ navUsd: 100.5, ts: 1_790_000_000 })).toMatchObject({ navUsd: "100.500000", ts: new Date(1_790_000_000_000).toISOString() });
    expect(parseLiveNav({ nav: "5", tranches: { seniorNav: "3", juniorNav: "2" } })).toMatchObject({ seniorNavUsd: "3.000000", juniorNavUsd: "2.000000" });
    expect(parseLiveNav({ foo: 1 })).toBeNull();
    expect(parseLiveNav("x")).toBeNull();
    expect(usdFromLoose("abc")).toBeNull();
  });

  test("risk state keeps meta", () => {
    const r = parseRiskState({ state: "breach", inventoryUtil: 1.2, breaches: ["INVENTORY"], ts: 1_790_000_000_000, netExposureUsd: 60000, extra: 1 });
    expect(r).toMatchObject({ state: "breach", breaches: ["INVENTORY"], netExposureUsd: 60000, source: "live" });
    expect(r?.meta.extra).toBe(1);
    expect(parseRiskState({ inventoryUtil: 1 })).toBeNull();
  });

  test("oracle price staleness", () => {
    const p = { priceId: "NVDA", price: 190, publishedAt: 1000, held: true, sourceCount: 3 };
    expect(parseOraclePrice(p, 1_200_000, 300)).toMatchObject({ stale: false, held: true });
    expect(parseOraclePrice(p, 1_400_000, 300)?.stale).toBe(true);
    expect(parseOraclePrice({ priceId: "X" }, 0, 300)).toBeNull();
  });
});

describe("kv cache", () => {
  test("read-through cache is bigint-safe and expires", async () => {
    const now = { ms: 0 };
    const kv = new MemoryKv(() => now.ms);
    let loads = 0;
    const load = async () => {
      loads++;
      return { v: 10n ** 30n };
    };
    expect(await cached(kv, "k", 5, load)).toEqual({ v: 10n ** 30n });
    expect(await cached(kv, "k", 5, load)).toEqual({ v: 10n ** 30n });
    expect(loads).toBe(1);
    now.ms = 6000;
    await cached(kv, "k", 5, load);
    expect(loads).toBe(2);
    await cached(kv, "nocache", 0, load);
    await cached(kv, "nocache", 0, load);
    expect(loads).toBe(4);
  });

  test("Redis errors degrade to misses", async () => {
    const boom = async () => {
      throw new Error("ECONNREFUSED");
    };
    const errors: string[] = [];
    const kv = new RedisKv({ get: boom, mget: boom, set: boom, scan: boom }, (_e, op) => void errors.push(op));
    expect(await kv.get("a")).toBeNull();
    expect(await kv.mget(["a", "b"])).toEqual([null, null]);
    await kv.set("a", "1", 10);
    expect(await kv.scan("x*")).toEqual([]);
    expect(errors).toEqual(["get", "mget", "set", "scan"]);
  });

  test("memory scan supports globs", async () => {
    const kv = new MemoryKv();
    kv.put("bkrn:oracle:last:NVDA", "{}");
    kv.put("bkrn:oracle:last:TSLA", "{}");
    kv.put("bkrn:other", "{}");
    expect((await kv.scan("bkrn:oracle:last:*")).sort()).toEqual(["bkrn:oracle:last:NVDA", "bkrn:oracle:last:TSLA"]);
  });
});

describe("charter service client", () => {
  test("reply shapes", () => {
    expect(parseCharterServiceReply({ reasons: ["BAD_SYMBOL"] })).toEqual([{ code: "BAD_SYMBOL", field: null, message: "BAD_SYMBOL", source: "charter-service" }]);
    expect(parseCharterServiceReply({ issues: [{ code: "BAD_BPS", field: "seniorCapBps", message: "m" }] })?.[0]).toMatchObject({ code: "BAD_BPS", field: "seniorCapBps" });
    expect(parseCharterServiceReply({ reason: "OK" })).toEqual([]);
    expect(parseCharterServiceReply({ valid: true })).toEqual([]);
    expect(parseCharterServiceReply({ valid: false })).toBeNull();
    expect(parseCharterServiceReply("x")).toBeNull();
  });

  test("HTTP: posts the draft; unreachable -> null (local fallback)", async () => {
    let seen: unknown = null;
    const ok = new HttpCharterServiceClient("http://charter.test/", "/v1/charters/validate", silentLog, 500, (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ reasons: [] }), { status: 200 });
    }) as unknown as typeof fetch);
    expect(await ok.validate(sampleDraft())).toEqual([]);
    expect(seen).toMatchObject({ url: "http://charter.test/v1/charters/validate", body: { symbol: "PERP_NVDA_USDC" } });
    const down = new HttpCharterServiceClient("http://charter.test", "/v", silentLog, 500, (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    expect(await down.validate(sampleDraft())).toBeNull();
  });
});
