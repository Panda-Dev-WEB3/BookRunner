// rpcTransport: retries only the lagging-node error a load-balanced RPC returns for a just-reported head
// (regression: Robinhood Chain testnet -32000 "unsupported block number", ~1 in 60 head-pinned reads).
import { describe, expect, test } from "bun:test";
import { createPublicClient, custom, InvalidInputRpcError, RpcRequestError } from "viem";
import { isLaggingNodeError, rpcTransport } from "../src/clients";

const rpcErr = (message: string) => new InvalidInputRpcError(new RpcRequestError({ body: {}, url: "https://rpc", error: { code: -32000, message } }));
const lagging = () => rpcErr("unsupported block number 127780585");

function flaky(failures: number, err: () => Error = lagging) {
  let calls = 0;
  // viem's own retry off, so only rpcTransport retries
  const base = custom(
    {
      async request({ method }) {
        calls++;
        if (calls <= failures) throw err();
        if (method === "eth_blockNumber") return "0x10";
        throw new Error(`unexpected ${method}`);
      },
    },
    { retryCount: 0 },
  );
  return { base, calls: () => calls };
}

describe("rpcTransport", () => {
  test("recognises the lagging-node error through viem's wrappers", () => {
    expect(isLaggingNodeError(lagging())).toBe(true);
    expect(isLaggingNodeError(new Error("header not found"))).toBe(true);
    expect(isLaggingNodeError(new Error("execution reverted: StalePrice"))).toBe(false);
    expect(isLaggingNodeError(null)).toBe(false);
  });

  test("retries a lagging-node error and returns the next answer", async () => {
    const f = flaky(2);
    const pc = createPublicClient({ transport: rpcTransport("https://rpc", { base: f.base, delayMs: 1 }) });
    expect(await pc.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    expect(f.calls()).toBe(3);
  });

  test("gives up after the retry budget", async () => {
    const f = flaky(10);
    const pc = createPublicClient({ transport: rpcTransport("https://rpc", { base: f.base, delayMs: 1, retries: 2 }) });
    await expect(pc.getBlockNumber({ cacheTime: 0 })).rejects.toThrow(/Missing or invalid parameters/);
    expect(f.calls()).toBe(3);
  });

  test("never retries other errors (reverts, bad requests)", async () => {
    const f = flaky(1, () => rpcErr("execution reverted: StalePrice")); // same -32000 code, not a lag
    const pc = createPublicClient({ transport: rpcTransport("https://rpc", { base: f.base, delayMs: 1 }) });
    await expect(pc.getBlockNumber({ cacheTime: 0 })).rejects.toThrow(/StalePrice/);
    expect(f.calls()).toBe(1);
  });
});
