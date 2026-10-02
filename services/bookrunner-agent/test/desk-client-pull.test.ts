// DeskClient with signed prices (docs/LOW_GAS.md §1): EngineVenue SetQuote and every hedge leg go out as
// executeWithPrices(action, priceData) carrying the freshest bundle; plain execute when nothing is signed;
// a rejected bundle (signer rotated) is retried once as plain execute, any other revert is not.
import { describe, expect, test } from "bun:test";
import { createLogger, decodePriceData, devAccount, encodePriceData, localChain, priceId } from "@bookrunner/shared";
import { type Address, type Hex, RpcRequestError, createPublicClient, createWalletClient, custom, decodeFunctionData, encodeErrorResult, keccak256, parseTransaction, toFunctionSelector } from "viem";
import { DESK_ACTION } from "../src/chain/desk-actions";
import { encodeFlatten, encodeHedge, encodeReturnToVault, encodeSetQuote } from "../src/chain/desk-actions";
import { DESK_PULL_ABI, DeskClient, isPriceDataRejection } from "../src/chain/desk-client";
import { EXECUTE_WITH_PRICES_SIG } from "../src/chain/lowgas-abi";
import type { DeskPriceData } from "../src/chain/pull-prices";
import { EngineVenue } from "../src/venues/engine";
import { nvdaMandate } from "./helpers";

const DESK = "0x00000000000000000000000000000000000d0e5c" as Address;
const TOKEN = "0x00000000000000000000000000000000000000a1" as Address;
const WITH_PRICES = toFunctionSelector(EXECUTE_WITH_PRICES_SIG);
const PRICE_DATA = encodePriceData(
  [{ underlying: priceId("RHX5"), priceWad: 315n * 10n ** 18n, publishedAt: 1_790_000_000n, held: false, sourceCount: 3, sourcesHash: keccak256("0x01") }],
  [`0x${"11".repeat(65)}`],
);

/** What an http node returns for a revert (code 3 + data): never retried by viem. */
const revert = (data: Hex) => new RpcRequestError({ body: {}, error: { code: 3, message: "execution reverted", data }, url: "fake" });
/** JSON-RPC "method not found": viem falls back (eth_fillTransaction) without retrying. */
const notFound = (method: string) => Object.assign(new Error(`unsupported rpc ${method}`), { code: -32601 });

function fakeProvider(opts: { rejectWithPrices?: Hex; rejectAll?: Hex } = {}) {
  const sent: Hex[] = [];
  const calls: Hex[] = [];
  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    const p = (params ?? []) as unknown[];
    switch (method) {
      case "eth_chainId":
        return "0x7a69";
      case "eth_call":
      case "eth_estimateGas": {
        const data = (p[0] as { data?: Hex; input?: Hex }).data ?? (p[0] as { input?: Hex }).input ?? "0x";
        if (method === "eth_call") calls.push(data);
        if (opts.rejectAll) throw revert(opts.rejectAll);
        if (opts.rejectWithPrices && data.startsWith(WITH_PRICES)) throw revert(opts.rejectWithPrices);
        return method === "eth_call" ? "0x0000000000000000000000000000000000000000000000000000000000000020" + "0".repeat(64) : "0x30d40";
      }
      case "eth_getTransactionCount":
        return `0x${sent.length.toString(16)}`;
      case "eth_gasPrice":
        return "0x3b9aca00";
      case "eth_maxPriorityFeePerGas":
        return "0x1";
      case "eth_blockNumber":
        return "0x64";
      case "eth_getBlockByNumber":
        return { number: "0x64", baseFeePerGas: "0x1", hash: keccak256("0x64"), timestamp: "0x1", transactions: [] };
      case "eth_sendRawTransaction":
        sent.push(p[0] as Hex);
        return keccak256(p[0] as Hex);
      case "eth_getTransactionReceipt":
        return {
          transactionHash: p[0],
          blockHash: keccak256("0xb1"),
          blockNumber: "0x64",
          contractAddress: null,
          cumulativeGasUsed: "0x5208",
          effectiveGasPrice: "0x1",
          from: devAccount("deskKeyIndex").address,
          gasUsed: "0x5208",
          logs: [],
          logsBloom: `0x${"0".repeat(512)}`,
          status: "0x1",
          to: DESK,
          transactionIndex: "0x0",
          type: "0x2",
        };
      default:
        throw notFound(method);
    }
  };
  return { request, sent, calls };
}

function client(provider: ReturnType<typeof fakeProvider>, prices: DeskPriceData | null) {
  const transport = custom({ request: provider.request });
  const pub = createPublicClient({ chain: localChain, transport, pollingInterval: 5 });
  const wallet = createWalletClient({ chain: localChain, transport, account: devAccount("deskKeyIndex") });
  return new DeskClient(pub as never, wallet, DESK, createLogger("desk-test", "silent"), 5_000, undefined, prices);
}

const decodeSent = (raw: Hex) => decodeFunctionData({ abi: DESK_PULL_ABI, data: parseTransaction(raw as never).data! });

describe("DeskClient pull oracle", () => {
  test("SetQuote / Hedge / Flatten carry the provider's priceData via executeWithPrices", async () => {
    const asked: number[] = [];
    const provider = fakeProvider();
    const desk = client(provider, { forAction: async (k) => (asked.push(k), PRICE_DATA) });
    const quote = encodeSetQuote(12, -3, 50_000_000_000n);
    const r = await desk.run(quote, "q");
    expect(r.withPrices).toBe(true);
    await desk.run(encodeHedge({ token: TOKEN, buy: true, amountIn: 1_000n, minAmountOut: 1n, poolFee: 3000, proof: [] }), "h");
    await desk.run(encodeFlatten({ token: TOKEN, amountIn: 5n, minAmountOut: 1n, poolFee: 3000 }), "f");
    expect(asked).toEqual([DESK_ACTION.SetQuote, DESK_ACTION.Hedge, DESK_ACTION.Flatten]);
    expect(provider.sent).toHaveLength(3);
    const first = decodeSent(provider.sent[0]!);
    expect(first.functionName).toBe("executeWithPrices");
    const [action, data] = first.args as [{ kind: number; data: Hex; proof: Hex[] }, Hex];
    expect(action).toEqual({ kind: quote.kind, data: quote.data, proof: [] });
    expect(data).toBe(PRICE_DATA);
    expect(decodePriceData(data).updates[0]!.underlying).toBe(priceId("RHX5"));
    expect(provider.sent.map((s) => decodeSent(s).functionName)).toEqual(["executeWithPrices", "executeWithPrices", "executeWithPrices"]);
  });

  test("no signed prices (provider null / throwing / no provider) -> plain execute", async () => {
    for (const prices of [{ forAction: async () => null }, { forAction: async () => Promise.reject(new Error("redis down")) }, null] as Array<DeskPriceData | null>) {
      const provider = fakeProvider();
      const r = await client(provider, prices).run(encodeReturnToVault(5n), "rtv");
      expect(r.withPrices).toBe(false);
      expect(decodeSent(provider.sent[0]!).functionName).toBe("execute");
    }
  });

  test("a rejected bundle (BadSigner) is retried once as plain execute", async () => {
    const bad = encodeErrorResult({ abi: DESK_PULL_ABI, errorName: "BadSigner", args: [devAccount("trader3").address] });
    const provider = fakeProvider({ rejectWithPrices: bad });
    const r = await client(provider, { forAction: async () => PRICE_DATA }).run(encodeSetQuote(12, 0, 1n), "q");
    expect(r.withPrices).toBe(false);
    expect(provider.sent).toHaveLength(1);
    expect(decodeSent(provider.sent[0]!).functionName).toBe("execute");
    expect(provider.calls.map((c) => c.slice(0, 10))).toEqual([WITH_PRICES, toFunctionSelector("execute((uint8,bytes,bytes32[]))")]);
  });

  test("any other revert (stale price, mandate) is NOT retried without prices", async () => {
    const stale = encodeErrorResult({ abi: DESK_PULL_ABI, errorName: "StalePrice", args: [priceId("RHX5"), 1n] });
    const provider = fakeProvider({ rejectWithPrices: stale });
    const err = await client(provider, { forAction: async () => PRICE_DATA })
      .run(encodeSetQuote(12, 0, 1n), "q")
      .catch((e: unknown) => e);
    expect(isPriceDataRejection(err)).toBe(false);
    expect(String((err as Error).message)).toContain("StalePrice");
    expect(provider.sent).toHaveLength(0);
    expect(provider.calls).toHaveLength(1);
  });

  test("EngineVenue SetQuote goes through executeWithPrices", async () => {
    const provider = fakeProvider();
    const desk = client(provider, { forAction: async () => PRICE_DATA });
    const m = nvdaMandate();
    const venue = new EngineVenue({
      chain: {
        readState: async () => ({ netExposureUsd: 0n, marginEquityUsd: 0n, insuranceEquityUsd: 0n, poolEquityUsd: 0n, poolCashUsd: 0n, netSize: 0n, reduceOnly: false }),
        readQuote: async () => null,
        tradesSince: async () => [],
      },
      desk,
      mandate: () => m,
      oraclePx: () => 190,
      symbol: "PERP",
      now: () => 1_000,
    });
    await venue.replaceQuote({ bid: { px: 189.9, qty: 10 }, ask: { px: 190.1, qty: 10 }, oraclePx: 190, theoretical: { bidPx: 189.9, askPx: 190.1 } });
    expect(provider.sent).toHaveLength(1);
    const call = decodeSent(provider.sent[0]!);
    expect(call.functionName).toBe("executeWithPrices");
    expect((call.args as [{ kind: number }, Hex])[0].kind).toBe(DESK_ACTION.SetQuote);
    expect((call.args as [unknown, Hex])[1]).toBe(PRICE_DATA);
  });
});
