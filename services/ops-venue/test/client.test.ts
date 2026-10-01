import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrderlyVenue, OrderlyBuilderClient, OrderlyQuoteError, OrderlyVenue } from "../src/client";
import { KeyStore } from "../src/keys";
import { generateKey, keyPrefix } from "../src/orderly/auth";
import { quoteOrders, roundToTick } from "../src/orderly/convert";
import { OrderlyHttpError } from "../src/orderly/http";
import { BASE, BROKER, IF_ID, LEDGER, makeMock, MM_ID, OPS, SYMBOL } from "./helpers";

function liveVenue() {
  const m = makeMock("permissive");
  m.venue.createSymbol({ symbol: SYMBOL, ifAccountId: IF_ID });
  m.venue.credit(IF_ID, 25_000_000_000);
  m.venue.credit(MM_ID, 75_000_000_000);
  m.venue.setPrice("NVDA", 190, false);
  return m;
}

describe("OrderlyVenue (QuotingVenue) against mock-orderly", () => {
  test("replaceQuote rests a two-sided POST_ONLY quote; fills only at quoted prices", async () => {
    const m = liveVenue();
    const key = await generateKey();
    const v = new OrderlyVenue({ baseUrl: BASE, accountId: MM_ID, symbol: SYMBOL, tradeKey: key, mode: "mock", fetch: m.fetch, bookId: 1 });
    await v.replaceQuote({ bid: { px: 189.91234, qty: 2.000049 }, ask: { px: 190.08765, qty: 2 } });
    const resting = m.venue.openOrders(MM_ID);
    // ticks from GET /v1/public/info/{symbol}: quote 0.01 (bid down / ask up), base 0.0001
    expect(resting.map((o) => [o.side, o.type, o.price, o.qty]).sort()).toEqual([
      ["BUY", "POST_ONLY", 189.91, 2],
      ["SELL", "POST_ONLY", 190.09, 2],
    ]);
    await v.replaceQuote({ bid: { px: 189.5, qty: 1 }, ask: { px: 190.5, qty: 1 } });
    expect(m.venue.openOrders(MM_ID)).toHaveLength(2); // previous quote cancelled

    const t0 = Date.now() - 1;
    m.venue.externalTaker(SYMBOL, "BUY", 0.4);
    m.venue.externalTaker(SYMBOL, "SELL", 5); // only 1 resting on the bid
    const fills = await v.fillsSince(t0);
    expect(fills.map((f) => [f.side, f.px, f.qty, f.maker])).toEqual([
      ["sell", 190.5, 0.4, true],
      ["buy", 189.5, 1, true],
    ]);
    const acct = await v.account();
    expect(acct.position?.netQty).toBeCloseTo(0.6, 9);
    expect(acct.position?.netExposureUsd).toBe(BigInt(Math.round(0.6 * 190 * 1e6)));
    // equity = holding (incl. realized 0.4 * (190.5 - 189.5)) + upnl of 0.6 long from 189.5 marked at 190
    expect(acct.equityUsd).toBe(75_000_000_000n + 400_000n + 300_000n);
  });

  test("one-sided quote uses POST /v1/order; a crossing POST_ONLY leg throws OrderlyQuoteError", async () => {
    const m = liveVenue();
    const other = `0x${"c3".repeat(32)}`;
    m.venue.credit(other, 10_000_000_000);
    m.venue.placeOrder({ accountId: other, keyId: null }, { symbol: SYMBOL, order_type: "LIMIT", side: "SELL", order_price: 190, order_quantity: 1 });
    const v = new OrderlyVenue({ baseUrl: BASE, accountId: MM_ID, symbol: SYMBOL, tradeKey: await generateKey(), mode: "mock", fetch: m.fetch });
    await v.replaceQuote({ ask: { px: 191, qty: 1 } });
    expect(m.venue.openOrders(MM_ID)).toHaveLength(1);
    const err = await v.replaceQuote({ bid: { px: 190.2, qty: 1 }, ask: { px: 191, qty: 1 } }).catch((e) => e);
    expect(err).toBeInstanceOf(OrderlyQuoteError);
    expect((err as OrderlyQuoteError).rejected.map((r) => r.side)).toEqual(["BUY"]);
    expect(m.venue.openOrders(MM_ID).map((o) => o.side)).toEqual(["SELL"]);
  });

  test("revoked trade key: orders 401 afterwards and its resting quotes are gone", async () => {
    const m = liveVenue();
    const trade = await generateKey();
    const v = new OrderlyVenue({ baseUrl: BASE, accountId: MM_ID, symbol: SYMBOL, tradeKey: trade, mode: "mock", fetch: m.fetch });
    await v.replaceQuote({ bid: { px: 189, qty: 1 }, ask: { px: 191, qty: 1 } });
    const ops = await generateKey();
    const builder = new OrderlyBuilderClient({ baseUrl: BASE, mode: "mock", brokerId: BROKER, chainId: 31337, builderAccountId: `0x${"33".repeat(32)}`, builderKey: null, keyFor: () => ops, signer: OPS, ledgerAddress: LEDGER, fetch: m.fetch });
    await builder.revokeTradeKey({ accountId: MM_ID, keyPrefix: keyPrefix(trade.orderlyKey) });
    expect(m.venue.openOrders(MM_ID)).toHaveLength(0);
    const err = await v.replaceQuote({ bid: { px: 189, qty: 1 } }).catch((e) => e);
    expect(err).toBeInstanceOf(OrderlyHttpError);
    expect((err as OrderlyHttpError).status).toBe(401);
    await builder.revokeTradeKey({ accountId: MM_ID, keyPrefix: keyPrefix(trade.orderlyKey) }); // idempotent
  });

  test("createOrderlyVenue (agent contract) loads the book's trade key from the key store", async () => {
    const m = liveVenue();
    const dir = mkdtempSync(join(tmpdir(), "bkrn-keys-"));
    const ks = new KeyStore(dir);
    const f = await ks.ensureBook(7, { if: IF_ID, mm: MM_ID }, { tradeMs: 86_400_000, opsMs: 86_400_000 });
    const v = createOrderlyVenue({ bookId: 7, symbol: SYMBOL, accountId: MM_ID, baseUrl: BASE, mode: "mock", env: {}, keysDir: dir, fetch: m.fetch });
    await v.replaceQuote({ bid: { px: 189, qty: 1 } });
    const o = m.venue.openOrders(MM_ID)[0];
    expect(o?.keyId).toBe(f.trade?.orderlyKey ?? "missing");
  });

  test("builder client maps fee settlements and the insurance fund", async () => {
    const m = liveVenue();
    const bkey = await generateKey();
    const builder = new OrderlyBuilderClient({ baseUrl: BASE, mode: "mock", brokerId: BROKER, chainId: 31337, builderAccountId: `0x${"33".repeat(32)}`, builderKey: bkey, signer: OPS, ledgerAddress: LEDGER, fetch: m.fetch });
    const r = await builder.createSymbol({ symbol: SYMBOL, baseAsset: "NVDA", priceSource: "builder", sessions: `0x${"00".repeat(32)}`, ifAccountId: IF_ID });
    expect(r.status).toBe("ACTIVE");
    expect((await builder.insuranceFund(SYMBOL)).balanceUsd).toBe(25_000_000_000n);
    m.venue.placeOrder({ accountId: MM_ID, keyId: null }, { symbol: SYMBOL, order_type: "LIMIT", side: "SELL", order_price: 200, order_quantity: 10 });
    m.venue.externalTaker(SYMBOL, "BUY", 10); // 2000 notional * 6bps = 1.2 -> builder 0.6
    m.venue.settleNow(1_700_000_100);
    const rows = await builder.feeSettlements(0);
    expect(rows).toEqual([expect.objectContaining({ symbol: SYMBOL, amountUsd: 600_000n, period: 1_700_000_100 })]);
  });
});

describe("pure quote helpers", () => {
  test("ticks round bids down and asks up", () => {
    expect(roundToTick(189.99999, 0.01, "down")).toBe(189.99);
    expect(roundToTick(190.00001, 0.01, "up")).toBe(190.01);
    expect(roundToTick(190.01, 0.01, "up")).toBe(190.01);
    const o = quoteOrders({ bid: { px: 1, qty: 0 }, ask: { px: 2, qty: 1 }, reduceOnly: true }, { symbol: "S", orderType: "POST_ONLY", priceTick: 0.01, qtyTick: 1e-8, clientId: (s) => `c-${s}` });
    expect(o).toEqual([{ symbol: "S", order_type: "POST_ONLY", side: "SELL", order_price: 2, order_quantity: 1, client_order_id: "c-SELL", reduce_only: true }]);
  });
});
