import { describe, expect, test } from "bun:test";
import { VENUE, usd } from "@bookrunner/shared";
import * as ed from "@noble/ed25519";
import { base58Decode, base58Encode, createOrderlySigner, orderlyAuthHeaders } from "../src/adapters/orderlyAuth";
import { parseQuote } from "../src/adapters/redis";
import { OrderlyRiskVenue, OrderlyVenueProvider, venueSymbol } from "../src/adapters/venue";
import { receiptRow } from "../src/domain/records";
import { makeRef, silentLog } from "./fakes";

type Call = { url: string; method: string; headers: Record<string, string> };

function fakeFetch(routes: Record<string, unknown>, calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string> });
    const key = `${method} ${new URL(url).pathname}`;
    if (!(key in routes)) return new Response(JSON.stringify({ success: false, message: "not found" }), { status: 404 });
    return new Response(JSON.stringify({ success: true, data: routes[key] }), { status: 200 });
  }) as typeof fetch;
}

describe("OrderlyRiskVenue", () => {
  const routes = {
    "GET /v1/positions": {
      rows: [
        { symbol: "PERP_NVDA_USDC", position_qty: -150, average_open_price: 191, mark_price: 190, unsettled_pnl: 150 },
        { symbol: "PERP_TSLA_USDC", position_qty: 10, average_open_price: 440, mark_price: 441, unsettled_pnl: 10 },
      ],
    },
    "GET /v1/client/holding": { holding: [{ token: "USDC", holding: 74_000, frozen: 4_000 }] },
    "DELETE /v1/orders": {},
    "GET /v1/trades": { rows: [{ id: 7, symbol: "PERP_NVDA_USDC", side: "SELL", executed_price: 190.1, executed_quantity: 2, fee: 0.1, executed_timestamp: 123, is_maker: 1 }] },
  };

  test("account(): signed exposure of the book's symbol and MM equity", async () => {
    const calls: Call[] = [];
    const v = new OrderlyRiskVenue({ baseUrl: "http://mock", accountId: "0xacc", symbol: "PERP_NVDA_USDC", signer: null, timeoutMs: 1000, fetchImpl: fakeFetch(routes, calls) });
    const a = await v.account();
    expect(a.position?.netExposureUsd).toBe(usd(-28_500));
    expect(a.position?.netQty).toBe(-150);
    expect(a.equityUsd).toBe(usd(74_160));
    expect(a.freeCollateralUsd).toBe(usd(70_000));
    expect(calls.every((c) => c.headers["orderly-account-id"] === "0xacc")).toBe(true);
  });

  test("cancelAll(): DELETE /v1/orders?symbol=; fills parsed from the book's perspective", async () => {
    const calls: Call[] = [];
    const v = new OrderlyRiskVenue({ baseUrl: "http://mock/", accountId: "0xacc", symbol: "PERP_NVDA_USDC", signer: null, timeoutMs: 1000, fetchImpl: fakeFetch(routes, calls) });
    await v.cancelAll();
    expect(calls[0]).toMatchObject({ method: "DELETE", url: "http://mock/v1/orders?symbol=PERP_NVDA_USDC" });
    const fills = await v.fillsSince(100);
    expect(fills).toEqual([{ tradeId: "7", symbol: "PERP_NVDA_USDC", side: "sell", qty: 2, px: 190.1, feeUsd: 0.1, ts: 123, maker: true }]);
    await expect(v.replaceQuote({})).rejects.toThrow();
  });

  test("HTTP / API errors surface as exceptions (the monitor then falls back to the adapter)", async () => {
    const v = new OrderlyRiskVenue({ baseUrl: "http://mock", accountId: "0xacc", symbol: "X", signer: null, timeoutMs: 1000, fetchImpl: fakeFetch({}, []) });
    await expect(v.account()).rejects.toThrow("404");
  });
});

describe("orderly auth", () => {
  test("base58 roundtrip incl. leading zeros", () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 255, 128, 7]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    expect(base58Encode(Uint8Array.from([0, 0, 0]))).toBe("111");
  });

  test("headers carry a verifiable ed25519 signature over ts+METHOD+path+body", async () => {
    const seed = new Uint8Array(32).fill(7);
    const signer = await createOrderlySigner(`ed25519:${base58Encode(seed)}`);
    const h = await orderlyAuthHeaders(signer, "0xacc", "delete", "/v1/orders?symbol=PERP_NVDA_USDC", "", 1_700_000_000_000);
    expect(h["orderly-key"]).toBe(`ed25519:${base58Encode(await ed.getPublicKeyAsync(seed))}`);
    expect(h["orderly-timestamp"]).toBe("1700000000000");
    const sig = Buffer.from((h["orderly-signature"] ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const msg = new TextEncoder().encode("1700000000000DELETE/v1/orders?symbol=PERP_NVDA_USDC");
    expect(await ed.verifyAsync(sig, msg, await ed.getPublicKeyAsync(seed))).toBe(true);
  });

  test("mock mode without a key sends only the account header", async () => {
    expect(await orderlyAuthHeaders(null, "0xacc", "GET", "/v1/positions", "", 1)).toEqual({ "orderly-account-id": "0xacc" });
  });
});

describe("venue provider", () => {
  test("engine books get no venue client; Orderly books get one per MM account", async () => {
    const p = new OrderlyVenueProvider({ mode: "mock", baseUrl: "http://mock", signer: null, timeoutMs: 1000, log: silentLog, accountIdOf: async () => "0xacc" });
    expect(await p.forBook(makeRef(3, VENUE.POOL_ENGINE))).toBeNull();
    expect((await p.forBook(makeRef(1, VENUE.ORDERLY)))?.kind).toBe("orderly");
  });

  test("live mode without a signing key falls back to adapter reports", async () => {
    const p = new OrderlyVenueProvider({ mode: "live", baseUrl: "http://x", signer: null, timeoutMs: 1000, log: silentLog, accountIdOf: async () => "0xacc" });
    expect(await p.forBook(makeRef(1, VENUE.ORDERLY))).toBeNull();
  });

  test("symbol mapping", () => {
    expect(venueSymbol("PERP_NVDA_USDC")).toBe("PERP_NVDA_USDC");
    expect(venueSymbol("NVDA")).toBe("PERP_NVDA_USDC");
  });
});

describe("misc adapters", () => {
  test("parseQuote accepts QuoteMsg and rejects garbage", () => {
    expect(parseQuote({ bookId: 1, ts: 5, bid: 189.9, ask: 190.1, oracle: 190, sides: { bid: true, ask: false } })).toEqual({
      ts: 5,
      bid: 189.9,
      ask: 190.1,
      oracle: 190,
      sides: { bid: true, ask: false },
    });
    expect(parseQuote({ ts: "x" })).toBeNull();
    expect(parseQuote(null)).toBeNull();
  });

  test("receipt rows: payload hash + hour_start = floor(ts / interval) * interval", () => {
    const r = receiptRow(1, 3, 1_790_000_123, { a: 1 }, 3600);
    expect(r.ts.getTime()).toBe(1_790_000_123_000);
    expect(r.hourStart.getTime()).toBe(Math.floor(1_790_000_123 / 3600) * 3600 * 1000);
    expect(r.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
