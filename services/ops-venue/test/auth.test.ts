// ed25519 signing (ops-venue) must match the verification in mock-orderly — byte for byte.
import { describe, expect, test } from "bun:test";
import { base58Decode as mockB58Decode, base58Encode as mockB58Encode, parseOrderlyKey, verifyOrderlySignature } from "@bookrunner/mock-orderly";
import { OrderlyBuilderClient, OrderlyVenue } from "../src/client";
import { base58Decode, base58Encode, generateKey, keyFromSecret, secretToString, signRequest } from "../src/orderly/auth";
import { OrderlyHttpError } from "../src/orderly/http";
import { BASE, BROKER, LEDGER, makeMock, MM_ID, OPS, SYMBOL } from "./helpers";

describe("ed25519 request signing", () => {
  test("signature verifies in mock-orderly; any tampering fails", async () => {
    const key = await generateKey();
    const body = JSON.stringify({ symbol: SYMBOL, order_type: "LIMIT", side: "BUY", order_price: 190.1, order_quantity: 1 });
    const h = await signRequest(key, MM_ID, { method: "POST", pathWithQuery: "/v1/order", body, timestamp: 1_700_000_000_123 });
    expect(h["orderly-key"].startsWith("ed25519:")).toBe(true);
    expect(h["orderly-signature"]).not.toMatch(/[+/=]/); // base64url, unpadded
    const parts = { orderlyKey: h["orderly-key"], timestamp: h["orderly-timestamp"], method: "POST", pathWithQuery: "/v1/order", body, signature: h["orderly-signature"] };
    expect(await verifyOrderlySignature(parts)).toBe(true);
    expect(await verifyOrderlySignature({ ...parts, body: body.replace("190.1", "190.2") })).toBe(false);
    expect(await verifyOrderlySignature({ ...parts, pathWithQuery: "/v1/batch-order" })).toBe(false);
    expect(await verifyOrderlySignature({ ...parts, method: "DELETE" })).toBe(false);
    expect(await verifyOrderlySignature({ ...parts, timestamp: "1700000000124" })).toBe(false);
    const other = await generateKey();
    expect(await verifyOrderlySignature({ ...parts, orderlyKey: other.orderlyKey })).toBe(false);
  });

  test("query strings are part of the signed path", async () => {
    const key = await generateKey();
    const h = await signRequest(key, MM_ID, { method: "DELETE", pathWithQuery: `/v1/orders?symbol=${SYMBOL}`, body: "" });
    const base = { orderlyKey: h["orderly-key"], timestamp: h["orderly-timestamp"], method: "DELETE", body: "", signature: h["orderly-signature"] };
    expect(await verifyOrderlySignature({ ...base, pathWithQuery: `/v1/orders?symbol=${SYMBOL}` })).toBe(true);
    expect(await verifyOrderlySignature({ ...base, pathWithQuery: "/v1/orders" })).toBe(false);
  });

  test("base58 codecs agree (incl. leading zero bytes) and secrets round-trip", async () => {
    for (const bytes of [new Uint8Array([0, 0, 1, 2, 255]), new Uint8Array(32).fill(7), crypto.getRandomValues(new Uint8Array(32))]) {
      expect(mockB58Encode(bytes)).toBe(base58Encode(bytes));
      expect([...mockB58Decode(base58Encode(bytes))]).toEqual([...bytes]);
      expect([...base58Decode(mockB58Encode(bytes))]).toEqual([...bytes]);
    }
    const k = await generateKey();
    const k2 = await keyFromSecret(secretToString(k));
    expect(k2.orderlyKey).toBe(k.orderlyKey);
    expect([...parseOrderlyKey(k.orderlyKey)]).toEqual([...k.publicKey]);
  });
});

describe("strict mock-orderly auth end to end", () => {
  async function setup() {
    const m = makeMock("strict");
    m.venue.createSymbol({ symbol: SYMBOL, ifAccountId: `0x${"a1".repeat(32)}` });
    m.venue.credit(`0x${"a1".repeat(32)}`, 25_000_000_000);
    m.venue.credit(MM_ID, 75_000_000_000);
    m.venue.setPrice("NVDA", 190, false);
    const adapter = "0x00000000000000000000000000000000000a0a01" as const;
    m.venue.ensureAccount(MM_ID, { owner: adapter, delegateSigner: OPS.address });
    const builder = new OrderlyBuilderClient({ baseUrl: BASE, mode: "mock", brokerId: BROKER, chainId: 31337, builderAccountId: `0x${"33".repeat(32)}`, builderKey: null, signer: OPS, ledgerAddress: LEDGER, fetch: m.fetch });
    const trade = await generateKey();
    await builder.addKey({ accountId: MM_ID, orderlyKey: trade.orderlyKey, scope: "read,trading", expirationMs: Date.now() + 86_400_000, delegateContract: adapter });
    return { m, builder, trade, adapter };
  }

  test("registered key (DelegateAddOrderlyKey EIP-712 verified) can trade; others are rejected", async () => {
    const { m, trade } = await setup();
    const venue = new OrderlyVenue({ baseUrl: BASE, accountId: MM_ID, symbol: SYMBOL, tradeKey: trade, mode: "live", fetch: m.fetch });
    await venue.replaceQuote({ bid: { px: 189.9, qty: 1 }, ask: { px: 190.1, qty: 1 } });
    expect(m.venue.openOrders(MM_ID)).toHaveLength(2);
    const stranger = new OrderlyVenue({ baseUrl: BASE, accountId: MM_ID, symbol: SYMBOL, tradeKey: await generateKey(), mode: "live", fetch: m.fetch });
    const err = await stranger.cancelAll().catch((e) => e);
    expect(err).toBeInstanceOf(OrderlyHttpError);
    expect((err as OrderlyHttpError).status).toBe(401);
    const unsigned = new OrderlyVenue({ baseUrl: BASE, accountId: MM_ID, symbol: SYMBOL, tradeKey: null, mode: "mock", fetch: m.fetch });
    expect(((await unsigned.cancelAll().catch((e) => e)) as OrderlyHttpError).status).toBe(401);
  });

  test("trade-only scope cannot withdraw; an asset-scoped key with the delegate signature can", async () => {
    const { m, builder, trade, adapter } = await setup();
    const tradeOnly = new OrderlyBuilderClient({ baseUrl: BASE, mode: "mock", brokerId: BROKER, chainId: 31337, builderAccountId: `0x${"33".repeat(32)}`, builderKey: null, keyFor: () => trade, signer: OPS, ledgerAddress: LEDGER, fetch: m.fetch });
    const denied = await tradeOnly.requestWithdraw({ accountId: MM_ID, amountUsd: 1_000_000n, to: adapter, nonce: "x", delegateContract: adapter }).catch((e) => e);
    expect((denied as OrderlyHttpError).status).toBe(401);
    const ops = await generateKey();
    await builder.addKey({ accountId: MM_ID, orderlyKey: ops.orderlyKey, scope: "read,asset", expirationMs: Date.now() + 86_400_000, delegateContract: adapter });
    const opsClient = new OrderlyBuilderClient({ baseUrl: BASE, mode: "mock", brokerId: BROKER, chainId: 31337, builderAccountId: `0x${"33".repeat(32)}`, builderKey: null, keyFor: () => ops, signer: OPS, ledgerAddress: LEDGER, fetch: m.fetch });
    const r = await opsClient.requestWithdraw({ accountId: MM_ID, amountUsd: 1_000_000n, to: adapter, nonce: "wr-1", delegateContract: adapter });
    expect(Number(r.withdrawId)).toBeGreaterThan(0);
    expect(m.venue.getAccount(MM_ID).holding).toBe(75_000_000_000 - 1_000_000);
  });
});
