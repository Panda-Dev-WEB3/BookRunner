import { describe, expect, test } from "bun:test";
// @ts-expect-error plain ESM module without types (video/demo runs in the Playwright container)
import * as W from "../demo/wallet-node.mjs";

const ADDR = "0x10e1f86Ff0b52Df12015e40907483331E291ed33";
const TO = "0x000000000000000000000000000000000000dEaD";

/** A handler with fake rpc / send that record their calls (no network). */
function make(rpcChain = "0xb626") {
  const rpcCalls: Array<[string, unknown[]]> = [];
  const sent: unknown[] = [];
  const h = W.createWalletHandler({
    address: ADDR,
    chainId: 46630,
    rpc: async (method: string, params: unknown[]) => {
      rpcCalls.push([method, params]);
      return method === "eth_chainId" ? rpcChain : "0xrpc";
    },
    send: async (tx: unknown) => {
      sent.push(tx);
      return "0xhash";
    },
  });
  return { h, rpcCalls, sent };
}

describe("demo wallet: formatting", () => {
  test("toHexQuantity", () => {
    expect(W.toHexQuantity(46630)).toBe("0xb626");
    expect(W.toHexQuantity(0)).toBe("0x0");
    expect(W.toHexQuantity(10n ** 18n)).toBe("0xde0b6b3a7640000");
    expect(() => W.toHexQuantity(-1)).toThrow();
  });
  test("parseQuantity", () => {
    expect(W.parseQuantity("0x0", "v")).toBe(0n);
    expect(W.parseQuantity("0xB626", "v")).toBe(46630n);
    expect(W.parseQuantity(undefined, "v")).toBeUndefined();
    expect(() => W.parseQuantity("12", "v")).toThrow();
    expect(() => W.parseQuantity("0x", "v")).toThrow();
  });
});

describe("demo wallet: method routing", () => {
  test("classifyMethod", () => {
    expect(W.classifyMethod("eth_requestAccounts")).toBe("wallet");
    expect(W.classifyMethod("wallet_switchEthereumChain")).toBe("wallet");
    expect(W.classifyMethod("eth_sendTransaction")).toBe("send");
    for (const m of ["eth_call", "eth_estimateGas", "eth_blockNumber", "eth_getBalance", "eth_getTransactionCount", "eth_getTransactionReceipt"]) expect(W.classifyMethod(m)).toBe("read");
    for (const m of ["eth_sign", "personal_sign", "eth_signTypedData_v4", "eth_signTransaction", "eth_sendRawTransaction", "wallet_watchAsset"]) expect(W.classifyMethod(m)).toBe("unsupported");
  });
  test("accounts are empty until connected, then revoke disconnects", async () => {
    const { h } = make();
    expect((await h.handle({ method: "eth_accounts" })).result).toEqual([]);
    const c = await h.handle({ method: "eth_requestAccounts" });
    expect(c.result).toEqual([ADDR]);
    expect(c.events).toEqual([["accountsChanged", [ADDR]]]);
    expect((await h.handle({ method: "eth_accounts" })).result).toEqual([ADDR]);
    const r = await h.handle({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    expect(r.result).toBeNull();
    expect(r.events).toEqual([["accountsChanged", []]]);
    expect((await h.handle({ method: "eth_accounts" })).result).toEqual([]);
  });
  test("chain id and switching", async () => {
    const { h, rpcCalls } = make();
    expect((await h.handle({ method: "eth_chainId" })).result).toBe("0xb626");
    expect((await h.handle({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xb626" }] })).result).toBeNull();
    expect((await h.handle({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] })).error?.code).toBe(4902);
    expect((await h.handle({ method: "wallet_addEthereumChain", params: [{ chainId: "0x1" }] })).error?.code).toBe(4001);
    expect(rpcCalls).toEqual([]);
  });
  test("reads go to the rpc unchanged; unsupported methods are refused", async () => {
    const { h, rpcCalls } = make();
    expect((await h.handle({ method: "eth_getBalance", params: [ADDR, "latest"] })).result).toBe("0xrpc");
    expect(rpcCalls).toEqual([["eth_getBalance", [ADDR, "latest"]]]);
    expect((await h.handle({ method: "personal_sign", params: ["0x00", ADDR] })).error?.code).toBe(4200);
  });
});

describe("demo wallet: sending", () => {
  test("refuses to be built for any chain but 46630", () => {
    expect(() => W.createWalletHandler({ address: ADDR, chainId: 1, rpc: async () => null, send: async () => "0x" })).toThrow(/46630/);
    expect(() => W.assertDemoChain("0xb626")).not.toThrow();
    expect(() => W.assertDemoChain(4663)).toThrow();
  });
  test("sends a connected 46630 transaction with parsed quantities", async () => {
    const { h, sent, rpcCalls } = make();
    expect((await h.handle({ method: "eth_sendTransaction", params: [{ from: ADDR, to: TO, value: "0x0", data: "0x" }] })).error?.code).toBe(4100); // not connected
    await h.handle({ method: "eth_requestAccounts" });
    const r = await h.handle({ method: "eth_sendTransaction", params: [{ from: ADDR.toLowerCase(), to: TO, value: "0x10", data: "0xabcd", gas: "0x5208", chainId: "0xb626" }] });
    expect(r.result).toBe("0xhash");
    expect(sent).toEqual([{ to: TO, data: "0xabcd", value: 16n, gas: 21000n }]);
    expect(rpcCalls).toEqual([["eth_chainId", []]]);
  });
  test("refuses another chain id, another sender, or an RPC on another chain", async () => {
    const { h, sent } = make();
    await h.handle({ method: "eth_requestAccounts" });
    expect((await h.handle({ method: "eth_sendTransaction", params: [{ to: TO, chainId: "0x1" }] })).error?.code).toBe(4100);
    expect((await h.handle({ method: "eth_sendTransaction", params: [{ from: TO, to: TO }] })).error?.code).toBe(4100);
    expect((await h.handle({ method: "eth_sendTransaction", params: [{ data: "0x00" }] })).error?.code).toBe(-32602);
    const other = make("0x1");
    await other.h.handle({ method: "eth_requestAccounts" });
    const r = await other.h.handle({ method: "eth_sendTransaction", params: [{ to: TO }] });
    expect(r.error?.message).toMatch(/refusing chain/);
    expect(sent).toEqual([]);
    expect(other.sent).toEqual([]);
  });
});
