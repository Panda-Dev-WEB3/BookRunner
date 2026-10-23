// In-memory JSON-RPC node for the RPC-budget tests: counts every request by method (what Alchemy bills) and serves
// eth_call, Multicall3 aggregate3 (decoded, each inner call dispatched; a throwing handler is a failed inner call)
// and eth_getBlockByNumber. Contracts are registered as (address, abi, functionName) -> result handlers.
import { MULTICALL3_ADDRESS, chainFor } from "@bookrunner/shared";
import { type Abi, type Address, type Hex, type PublicClient, createPublicClient, custom, decodeFunctionData, encodeFunctionResult, multicall3Abi, toFunctionSelector } from "viem";
import type { AbiFunction } from "viem";

type Handler = (args: readonly unknown[], block: string) => unknown;

export class FakeRpc {
  /** JSON-RPC requests by method */
  calls = new Map<string, number>();
  /** inner calls per aggregate3 eth_call, in order */
  aggregates: Array<Array<{ target: Address; fn: string }>> = [];
  /** block tag / number of every eth_call */
  callBlocks: string[] = [];
  blockNumber = 1_000n;
  blockTs = 1_790_000_000;
  private readonly handlers = new Map<string, { abi: Abi; fn: string; h: Handler }>();

  constructor(readonly chainId = 4663) {}

  /** Registers `fn` of `abi` at `address`; the handler returns the decoded result (a tuple for several outputs) or throws (revert). */
  on(address: Address, abi: Abi, fn: string, h: Handler): this {
    const item = abi.find((x): x is AbiFunction => x.type === "function" && x.name === fn);
    if (!item) throw new Error(`no ${fn} in abi`);
    this.handlers.set(`${address.toLowerCase()}:${toFunctionSelector(item)}`, { abi, fn, h });
    return this;
  }

  count(method: string): number {
    return this.calls.get(method) ?? 0;
  }

  reset(): void {
    this.calls.clear();
    this.aggregates = [];
    this.callBlocks = [];
  }

  private dispatch(to: Address, data: Hex, block: string): Hex {
    const k = `${to.toLowerCase()}:${data.slice(0, 10)}`;
    const e = this.handlers.get(k);
    if (!e) throw new Error(`execution reverted (no handler ${k})`);
    const { args } = decodeFunctionData({ abi: e.abi, data });
    const result = e.h(args ?? [], block);
    return encodeFunctionResult({ abi: e.abi, functionName: e.fn, result } as never);
  }

  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
    const p = (params ?? []) as unknown[];
    switch (method) {
      case "eth_chainId":
        return `0x${this.chainId.toString(16)}`;
      case "eth_blockNumber":
        return `0x${this.blockNumber.toString(16)}`;
      case "eth_getBlockByNumber":
        return {
          number: `0x${this.blockNumber.toString(16)}`,
          timestamp: `0x${this.blockTs.toString(16)}`,
          hash: `0x${"11".repeat(32)}`,
          parentHash: `0x${"22".repeat(32)}`,
          transactions: [],
          gasLimit: "0x1",
          gasUsed: "0x0",
        };
      case "eth_call": {
        const { to, data } = p[0] as { to: Address; data: Hex };
        const block = String(p[1] ?? "latest");
        this.callBlocks.push(block);
        if (to.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase() && data.startsWith(toFunctionSelector("aggregate3((address,bool,bytes)[])"))) {
          const { args } = decodeFunctionData({ abi: multicall3Abi, data });
          const calls = (args?.[0] ?? []) as ReadonlyArray<{ target: Address; allowFailure: boolean; callData: Hex }>;
          const inner: Array<{ target: Address; fn: string }> = [];
          const results = calls.map((c) => {
            if (c.target.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase() && c.callData.startsWith(toFunctionSelector("getCurrentBlockTimestamp()"))) {
              inner.push({ target: c.target, fn: "getCurrentBlockTimestamp" });
              return { success: true, returnData: `0x${this.blockTs.toString(16).padStart(64, "0")}` as Hex };
            }
            const e = this.handlers.get(`${c.target.toLowerCase()}:${c.callData.slice(0, 10)}`);
            inner.push({ target: c.target, fn: e?.fn ?? c.callData.slice(0, 10) });
            try {
              return { success: true, returnData: this.dispatch(c.target, c.callData, block) };
            } catch {
              return { success: false, returnData: "0x" as Hex };
            }
          });
          this.aggregates.push(inner);
          return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
        }
        try {
          return this.dispatch(to, data, block);
        } catch (err) {
          throw Object.assign(new Error((err as Error).message), { code: 3, data: "0x" });
        }
      }
      default:
        throw new Error(`unsupported method ${method}`);
    }
  }

  /** A viem client on this node (with the chain config of `chainId`, so mainnet carries Multicall3). */
  client(): PublicClient {
    return createPublicClient({ chain: chainFor(this.chainId, "http://fake.invalid"), transport: custom({ request: (a) => this.request(a as never) }, { retryCount: 0 }) }) as PublicClient;
  }
}
