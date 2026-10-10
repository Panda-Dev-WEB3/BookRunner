// ORDERLY_MODE=live: request signing and response parsing against recorded fixtures written from Orderly's
// API reference examples (test/fixtures/orderly-live.json), plus RFC 8032 ed25519 vectors. No network.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recoverDelegateSignerLink, recoverWithdrawSigner } from "@bookrunner/mock-orderly";
import * as ed from "@noble/ed25519";
import type { Address, Hex } from "viem";
import { OrderlyBuilderClient, OrderlyVenue } from "../src/client";
import { attributeBrokerWide, BROKER_WIDE, planFeeSweep, type SettlementRow } from "../src/domain/fees";
import { base58Decode, base58Encode, keyFromSecret, signatureMessage, signMessage } from "../src/orderly/auth";
import { dateWindows, FEE_REVENUE_MAX_DAYS, parseAssetHistory, parseDailyFeeRevenue, toVenueAccount } from "../src/orderly/convert";
import { ORDERLY_LEDGER_MAINNET, ORDERLY_LEDGER_TESTNET } from "../src/orderly/eip712";
import type { FetchLike } from "../src/orderly/http";
import { OrderlyHttpError } from "../src/orderly/http";
import { ORDERLY_BASE_URLS, ORDERLY_PATHS } from "../src/orderly/paths";
import { OPS } from "./helpers";

const FX = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "orderly-live.json"), "utf8")) as Record<string, any>;
const hex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

/** Recording fetch stub: answers `routes[METHOD path]` (path without query) with a fixture envelope. */
function stub(routes: Record<string, unknown | ((url: URL, init: { method?: string; headers?: Record<string, string>; body?: string }) => unknown)>) {
  const calls: Array<{ method: string; url: URL; headers: Record<string, string>; body: string | undefined }> = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    calls.push({ method, url, headers: init.headers ?? {}, body: init.body });
    const r = routes[`${method} ${url.pathname}`];
    if (r === undefined) return new Response(JSON.stringify({ success: false, code: -1000, message: `no route ${method} ${url.pathname}` }), { status: 404 });
    const body = typeof r === "function" ? (r as (u: URL, i: typeof init) => unknown)(url, init) : r;
    const env = body as { success?: boolean };
    return new Response(JSON.stringify(body), { status: env.success === false ? 400 : 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

const NOW = Date.UTC(2026, 7, 20, 12); // 2026-08-20T12:00Z
const IF_OWNER = "0x00000000000000000000000000000000000a0a05" as Address;
const ADAPTER = "0x00000000000000000000000000000000000a0a01" as Address;

async function liveBuilder(routes: Parameters<typeof stub>[0], o: { feeHistoryStartMs?: number; token?: string } = {}) {
  const s = stub(routes);
  const builderKey = await keyFromSecret(hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"));
  const opsKey = await keyFromSecret(hex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb"));
  const client = new OrderlyBuilderClient({
    baseUrl: ORDERLY_BASE_URLS.mainnet,
    mode: "live",
    brokerId: "bookrunner",
    chainId: 4663,
    builderAccountId: "0xb129e074a17dfba8d652ae1eca21c7d6bb6904f1aa693f4886d50db170933a46",
    builderKey,
    keyFor: () => opsKey,
    signer: OPS,
    ledgerAddress: ORDERLY_LEDGER_MAINNET,
    fetch: s.fetch,
    now: () => NOW,
    sleep: async () => {},
    ...(o.feeHistoryStartMs !== undefined ? { feeHistoryStartMs: o.feeHistoryStartMs } : {}),
    ...(o.token ? { token: o.token } : {}),
  });
  return { client, ...s, builderKey, opsKey };
}

describe("orderly-key auth (ed25519)", () => {
  test("RFC 8032 vectors: signMessage is plain ed25519 over the UTF-8 message, base64url-encoded", async () => {
    const k1 = await keyFromSecret(hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"));
    expect(Buffer.from(k1.publicKey).toString("hex")).toBe("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    const sig1 = await signMessage(k1, "");
    expect(Buffer.from(sig1, "base64url").toString("hex")).toBe(
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    );
    const k2 = await keyFromSecret(hex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb"));
    const sig2 = await signMessage(k2, "r"); // message 0x72
    expect(Buffer.from(sig2, "base64url").toString("hex")).toBe(
      "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
    );
    expect(sig2).not.toMatch(/[+/=]/);
  });

  test("orderly-key = 'ed25519:' + base58(public key) — the docs' example key round-trips", async () => {
    const docsKey = FX.auth_example.orderly_key as string;
    const pub = base58Decode(docsKey.slice("ed25519:".length));
    expect(pub.length).toBe(32);
    expect(`ed25519:${base58Encode(pub)}`).toBe(docsKey);
    const k = await keyFromSecret(base58Encode(hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")));
    expect(k.orderlyKey).toBe(`ed25519:${base58Encode(hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"))}`);
  });

  test("the signed message is timestamp + METHOD + path(+query) + body, exactly as the docs example", () => {
    const body = '{"symbol": "PERP_ETH_USDC", "order_type": "LIMIT", "order_price": 1521.03, "order_quantity": 2.11, "side": "BUY"}';
    expect(signatureMessage(1649920583000, "post", "/v1/order", body)).toBe(FX.auth_example.message);
  });

  test("live requests carry the four orderly headers; the signature covers the exact query and body sent", async () => {
    const { client, calls, builderKey } = await liveBuilder({ "GET /v1/broker/daily_fee_revenue": FX.daily_fee_revenue });
    await client.feeSettlements(Date.UTC(2026, 7, 18));
    const c = calls[0];
    if (!c) throw new Error("no call");
    expect(c.headers["orderly-account-id"]).toBe("0xb129e074a17dfba8d652ae1eca21c7d6bb6904f1aa693f4886d50db170933a46");
    expect(c.headers["orderly-key"]).toBe(builderKey.orderlyKey);
    expect(c.headers["orderly-timestamp"]).toBe(String(NOW));
    expect(c.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const msg = signatureMessage(c.headers["orderly-timestamp"] as string, "GET", `${c.url.pathname}${c.url.search}`, "");
    expect(c.url.search).toBe("?start_date=2026-08-18&end_date=2026-08-20");
    expect(await ed.verifyAsync(Buffer.from(c.headers["orderly-signature"] as string, "base64url"), new TextEncoder().encode(msg), builderKey.publicKey)).toBe(true);
  });

  test("POST bodies are signed byte-for-byte and sent as application/json", async () => {
    const { client, calls, opsKey } = await liveBuilder({ "GET /v1/withdraw_nonce": FX.withdraw_nonce, "POST /v1/delegate_withdraw_request": FX.withdraw_request });
    await client.requestWithdraw({ accountId: "0xaa", amountUsd: 1_000_000n, to: IF_OWNER, nonce: "wr-1", delegateContract: IF_OWNER });
    const post = calls.find((x) => x.method === "POST");
    if (!post?.body) throw new Error("no post");
    expect(post.headers["content-type"]).toBe("application/json");
    expect(post.headers["orderly-account-id"]).toBe("0xaa");
    const msg = signatureMessage(post.headers["orderly-timestamp"] as string, "POST", post.url.pathname, post.body);
    expect(await ed.verifyAsync(Buffer.from(post.headers["orderly-signature"] as string, "base64url"), new TextEncoder().encode(msg), opsKey.publicKey)).toBe(true);
  });
});

describe("live endpoints against recorded fixtures", () => {
  test("positions + holding (docs examples): equity uses the settlement token's holding (+ isolated margin)", () => {
    const pos = FX.positions.data;
    const usdt = toVenueAccount("PERP_BTC_USDC", pos, FX.holding.data, "USDT");
    expect(usdt.equityUsd).toBe(282_485_071_904n + 354_858_492n);
    expect(usdt.freeCollateralUsd).toBe(450_315_091_150n);
    expect(usdt.position).toEqual({ symbol: "PERP_BTC_USDC", netQty: -5, avgPx: 27908.14386047, markPx: 27794.9, netExposureUsd: -138_974_500_000n, unrealizedPnlUsd: 354_858_492n });
    // no USDC row in the docs example: a USDC book sees only its unsettled pnl
    expect(toVenueAccount("PERP_BTC_USDC", pos, FX.holding.data).equityUsd).toBe(354_858_492n);
    // Robinhood Chain: USDG settlement token, isolated margin counted
    const usdg = toVenueAccount("PERP_NVDA_USDC", { rows: [] }, FX.holding_usdg.data, "USDG");
    expect(usdg.equityUsd).toBe(75_250_750_000n);
    expect(usdg.position).toBeNull();
  });

  test("OrderlyVenue live: account() reads both endpoints with the trade key and the configured token", async () => {
    const s = stub({ "GET /v1/positions": FX.positions, "GET /v1/client/holding": FX.holding_usdg });
    const key = await keyFromSecret(hex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb"));
    const v = new OrderlyVenue({ baseUrl: ORDERLY_BASE_URLS.mainnet, accountId: "0xmm", symbol: "PERP_BTC_USDC", tradeKey: key, mode: "live", fetch: s.fetch, token: "USDG" });
    const a = await v.account();
    expect(a.equityUsd).toBe(75_250_750_000n + 354_858_492n);
    expect(s.calls.map((c) => c.url.pathname).sort()).toEqual(["/v1/client/holding", "/v1/positions"]);
    for (const c of s.calls) expect(c.headers["orderly-key"]).toBe(key.orderlyKey);
  });

  test("daily_fee_revenue: date = settlement date = the period label; broker-wide rows; Perp Anything share only", () => {
    expect(parseDailyFeeRevenue(FX.daily_fee_revenue.data)).toEqual([{ id: "fee-revenue:2026-08-18", symbol: BROKER_WIDE, amountUsd: 0n, period: Date.UTC(2026, 7, 18) / 1000, ts: Date.UTC(2026, 7, 18) }]);
    const rows = parseDailyFeeRevenue(FX.daily_fee_revenue_two_days.data);
    expect(rows.map((r) => [r.period, r.amountUsd])).toEqual([
      [Date.UTC(2026, 7, 19) / 1000, 125_500_000n], // builder_fee_revenue (3) is not Perp Anything revenue
      [Date.UTC(2026, 7, 18) / 1000, 1n],
    ]);
  });

  test("feeSettlements live: <= 180-day windows, sorted by period, error envelope surfaces code -1103", async () => {
    const seen: string[] = [];
    const { client } = await liveBuilder(
      {
        "GET /v1/broker/daily_fee_revenue": (u: URL) => {
          seen.push(`${u.searchParams.get("start_date")}..${u.searchParams.get("end_date")}`);
          return u.searchParams.get("end_date") === "2026-08-20" ? FX.daily_fee_revenue_two_days : { success: true, data: { rows: [] } };
        },
      },
      { feeHistoryStartMs: Date.UTC(2025, 6, 1) },
    );
    const out = await client.feeSettlements(0);
    expect(seen).toEqual(["2025-07-01..2025-12-27", "2025-12-28..2026-06-25", "2026-06-26..2026-08-20"]);
    expect(out.map((r) => r.period)).toEqual([Date.UTC(2026, 7, 18) / 1000, Date.UTC(2026, 7, 19) / 1000]);

    const bad = await liveBuilder({ "GET /v1/broker/daily_fee_revenue": FX.daily_fee_revenue_error_range });
    const err = await bad.client.feeSettlements(Date.UTC(2026, 7, 1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderlyHttpError);
    expect((err as OrderlyHttpError).code).toBe(-1103);
    expect((err as Error).message).toContain("greater than 180 days");
  });

  test("dateWindows covers the range without gaps or overlaps", () => {
    const w = dateWindows(Date.UTC(2026, 0, 1, 15), Date.UTC(2026, 0, 3), FEE_REVENUE_MAX_DAYS);
    expect(w).toEqual([["2026-01-01", "2026-01-03"]]);
    expect(dateWindows(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 5), 2)).toEqual([
      ["2026-01-01", "2026-01-02"],
      ["2026-01-03", "2026-01-04"],
      ["2026-01-05", "2026-01-05"],
    ]);
  });

  test("broker-wide revenue is attributed only when one Orderly book is live", () => {
    const rows: SettlementRow[] = parseDailyFeeRevenue(FX.daily_fee_revenue_two_days.data);
    const one = attributeBrokerWide(rows, ["PERP_NVDA_USDC", "PERP_NVDA_USDC"]);
    expect(one.dropped).toBe(0);
    expect(planFeeSweep({ symbol: "PERP_NVDA_USDC", period: Date.UTC(2026, 7, 19) / 1000, settlements: one.rows, sweptTotalUsd: 0n, inFlightUsd: 0n, capUsd: 10n ** 12n }).amount).toBe(125_500_001n);
    const two = attributeBrokerWide(rows, ["PERP_NVDA_USDC", "PERP_TSLA_USDC"]);
    expect([two.rows.length, two.dropped]).toEqual([0, 2]);
  });

  test("asset history: string ids kept verbatim, trans_status, token-unit amounts", async () => {
    expect(parseAssetHistory(FX.asset_history.data)).toEqual([
      { id: "230707030600002", status: "FAILED", txHash: "0x4b0714c63cc7abae72bf68e84e25860b88ca651b7d27dad1e32bf4c027fa5326", amountUsd: 555_000_000n, clientRef: null, receiver: null, createdAt: 1688699193034 },
    ]);
    const { client, calls } = await liveBuilder({ "GET /v1/asset/history": FX.asset_history }, { token: "USDG" });
    expect((await client.withdrawal("0xaa", "230707030600002"))?.status).toBe("FAILED");
    expect(calls[0]?.url.search).toBe("?token=USDG&side=WITHDRAW&page=1&size=100");
  });

  test("delegate withdrawal: /v1/delegate_withdraw_request, receiver = delegateContract, amount as string, Ledger domain", async () => {
    const { client, calls } = await liveBuilder({ "GET /v1/withdraw_nonce": FX.withdraw_nonce, "POST /v1/delegate_withdraw_request": FX.withdraw_request }, { token: "USDG" });
    const r = await client.requestWithdraw({ accountId: "0xaa", amountUsd: 25_001_000_000n, to: IF_OWNER, nonce: "wr-7", delegateContract: IF_OWNER });
    expect(r.withdrawId).toBe("123");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url.pathname).toBe(ORDERLY_PATHS.delegateWithdraw);
    const body = JSON.parse(post?.body ?? "{}");
    expect(body.message).toEqual({ brokerId: "bookrunner", chainId: 4663, receiver: IF_OWNER, token: "USDG", amount: "25001000000", withdrawNonce: 1, timestamp: NOW, delegateContract: IF_OWNER });
    expect(body.verifyingContract).toBe(ORDERLY_LEDGER_MAINNET);
    expect(body.userAddress).toBe(OPS.address);
    expect(body.client_ref).toBeUndefined(); // mock-only field
    expect(await recoverWithdrawSigner(body.message, body.signature as Hex, ORDERLY_LEDGER_MAINNET, true)).toBe(OPS.address);
    // Orderly pays contract accounts only to themselves (LedgerImplA): refuse any other receiver up front
    await expect(client.requestWithdraw({ accountId: "0xaa", amountUsd: 1n, to: ADAPTER, nonce: "wr-8", delegateContract: IF_OWNER })).rejects.toThrow(/must be the delegate contract/);
    expect(ORDERLY_LEDGER_TESTNET).toBe("0x1826B75e2ef249173FC735149AE4B8e9ea10abff");
  });

  test("delegate signer registration: registration nonce -> signed DelegateSigner -> account id", async () => {
    const txHash = `0x${"ab".repeat(32)}` as Hex;
    const { client, calls } = await liveBuilder({ "GET /v1/registration_nonce": FX.registration_nonce, "POST /v1/delegate_signer": FX.delegate_signer });
    const r = await client.registerDelegateSigner({ delegateContract: IF_OWNER, txHash });
    expect(r).toEqual({ accountId: FX.delegate_signer.data.account_id, validSigner: FX.delegate_signer.data.valid_signer });
    const [get, post] = calls;
    expect(get?.headers["orderly-key"]).toBeUndefined(); // public endpoints are unsigned
    expect(post?.headers["orderly-account-id"]).toBeUndefined();
    const body = JSON.parse(post?.body ?? "{}");
    expect(body.message).toEqual({ delegateContract: IF_OWNER, brokerId: "bookrunner", chainId: 4663, timestamp: NOW, registrationNonce: 194528949540, txHash });
    expect(await recoverDelegateSignerLink(body.message, body.signature as Hex)).toBe(OPS.address);
  });

  test("get_account / get_orderly_key (public)", async () => {
    const { client, calls } = await liveBuilder({ "GET /v1/get_account": FX.get_account, "GET /v1/get_orderly_key": FX.get_orderly_key });
    expect(await client.getAccount(ADAPTER)).toEqual({ accountId: FX.get_account.data.account_id, userId: 24 });
    expect(calls[0]?.url.search).toBe(`?address=${ADAPTER}&broker_id=bookrunner&chain_type=EVM`);
    expect(await client.getOrderlyKey("0xaa", "ed25519:7tEoJo5hMBKBrQsqmc8yw1xNfoQCFQBVwQT1eFafRNRf")).toEqual({ orderlyKey: "ed25519:7tEoJo5hMBKBrQsqmc8yw1xNfoQCFQBVwQT1eFafRNRf", scope: "read,trading", expiration: 1689086651947 });
    const missing = await liveBuilder({ "GET /v1/get_account": { success: false, code: -1103, message: "account not exist" } });
    expect(await missing.client.getAccount(ADAPTER)).toBeNull();
  });

  test("delegate key registration posts DelegateAddOrderlyKey with numeric timestamps (docs example shape)", async () => {
    const { client, calls } = await liveBuilder({ "POST /v1/delegate_orderly_key": FX.orderly_key });
    await client.addKey({ accountId: "0xaa", orderlyKey: "ed25519:FRXntsPJBCy6dzKv9WPw4eYSw3rKU9Npz3T6UmvvJc9Z", scope: "read,asset", expirationMs: NOW + 86_400_000, delegateContract: IF_OWNER });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.message).toEqual({ brokerId: "bookrunner", chainId: 4663, orderlyKey: "ed25519:FRXntsPJBCy6dzKv9WPw4eYSw3rKU9Npz3T6UmvvJc9Z", scope: "read,asset", timestamp: NOW, expiration: NOW + 86_400_000, delegateContract: IF_OWNER });
  });
});
