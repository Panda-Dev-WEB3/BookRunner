import { describe, expect, test } from "bun:test";
import * as ed from "@noble/ed25519";
import { createApp } from "../src/app";
import { base64urlEncode, formatOrderlyKey, signatureMessage } from "../src/auth";
import { mulberry32 } from "../src/rng";
import { MockVenue } from "../src/venue";

const MM = `0x${"22".repeat(32)}`;
const SYM = "PERP_NVDA_USDC";

function setup(authMode: "strict" | "permissive") {
  const venue = new MockVenue({ settleIntervalSec: 300 });
  const app = createApp({ venue, authMode, brokerId: "bookrunner", ledgerAddress: "0x6F7a338F2aA472838dEFD3283eB360d4Dff5D203", delegateSigners: [], rng: mulberry32(3) });
  return { venue, app };
}

async function signed(app: ReturnType<typeof setup>["app"], sk: Uint8Array, method: string, path: string, body?: unknown) {
  const pub = await ed.getPublicKeyAsync(sk);
  const ts = String(Date.now());
  const raw = body === undefined ? "" : JSON.stringify(body);
  const sig = base64urlEncode(await ed.signAsync(new TextEncoder().encode(signatureMessage(ts, method, path, raw)), sk));
  return app.request(path, {
    method,
    headers: { "content-type": "application/json", "orderly-account-id": MM, "orderly-key": formatOrderlyKey(pub), "orderly-timestamp": ts, "orderly-signature": sig },
    ...(raw ? { body: raw } : {}),
  });
}

describe("mock-orderly HTTP", () => {
  test("strict: unsigned and unregistered keys are rejected; registered keys trade; removed keys 401", async () => {
    const { venue, app } = setup("strict");
    venue.createSymbol({ symbol: SYM });
    venue.setSymbolStatus(SYM, "ACTIVE");
    const unsigned = await app.request("/v1/positions", { headers: { "orderly-account-id": MM } });
    expect(unsigned.status).toBe(401);
    const sk = ed.utils.randomSecretKey();
    expect((await signed(app, sk, "GET", "/v1/positions")).status).toBe(401);
    venue.registerKey(MM, formatOrderlyKey(await ed.getPublicKeyAsync(sk)), ["read", "trading"], Date.now() + 1e9);
    expect((await signed(app, sk, "GET", "/v1/positions")).status).toBe(200);
    expect((await signed(app, sk, "GET", "/v1/withdraw_nonce")).status).toBe(200);
    expect((await signed(app, sk, "POST", "/v1/withdraw_request", { message: {}, signature: "0x" })).status).toBe(401); // lacks asset scope
    const del = await signed(app, sk, "POST", "/v1/client/remove_orderly_key", { orderly_key: formatOrderlyKey(await ed.getPublicKeyAsync(sk)) });
    expect(del.status).toBe(200);
    expect((await signed(app, sk, "GET", "/v1/positions")).status).toBe(401);
  });

  test("permissive: price, credit, orders, taker, settlement, state", async () => {
    const { app } = setup("permissive");
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await post("/mock/price", { symbol: "NVDA", price: 190, held: false })).status).toBe(200);
    expect((await post("/mock/credit", { accountId: MM, amount: 10_000 })).status).toBe(200);
    const builderHdr = { "orderly-account-id": `0x${"33".repeat(32)}` };
    const sym = (await (await post("/v1/builder/symbol", { symbol: SYM, base_asset: "NVDA", price_source: "builder" }, builderHdr)).json()) as { data: { status: string } };
    expect(sym.data.status).toBe("NEW"); // no IF account assigned yet
    expect((await post("/v1/order", { symbol: SYM, order_type: "POST_ONLY", side: "SELL", order_price: 190.5, order_quantity: 1 }, { "orderly-account-id": MM })).status).toBe(400);
    // assign + fund an IF account -> ACTIVE
    const IF = `0x${"11".repeat(32)}`;
    await post("/v1/builder/symbol", { symbol: SYM, insurance_fund_account_id: IF }, builderHdr);
    await post("/mock/credit", { accountId: IF, amount: 1000 });
    const ord = await post("/v1/batch-order", { orders: [{ symbol: SYM, order_type: "POST_ONLY", side: "SELL", order_price: 190.5, order_quantity: 1 }, { symbol: SYM, order_type: "POST_ONLY", side: "BUY", order_price: 191, order_quantity: 1 }] }, { "orderly-account-id": MM });
    const rows = ((await ord.json()) as { data: { rows: Array<{ error_message: string | null }> } }).data.rows;
    expect(rows.map((r) => r.error_message === null)).toEqual([true, false]); // second would cross
    const fills = ((await (await post("/mock/taker", { symbol: SYM, side: "BUY", qty: 1 })).json()) as { data: { fills: Array<{ price: number }> } }).data.fills;
    expect(fills.map((f) => f.price)).toEqual([190.5]);
    const settle = ((await (await post("/mock/settle", {})).json()) as { data: { rows: Array<{ amount: number }> } }).data.rows;
    expect(settle[0]?.amount).toBeCloseTo((190.5 * 6) / 1e4 / 2, 6);
    const fs = await app.request("/v1/builder/fee_settlements?start_t=0", { headers: builderHdr });
    expect(((await fs.json()) as { data: { rows: unknown[] } }).data.rows).toHaveLength(1);
    const st = (await (await app.request("/mock/state")).json()) as { data: { symbols: Array<{ status: string }> } };
    expect(st.data.symbols[0]?.status).toBe("ACTIVE");
  });
});
