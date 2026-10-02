// Read on-chain views as if signed prices had landed (pull oracle, docs/LOW_GAS.md §1), without sending a
// tx: ONE eth_call (deployless Multicall3) runs AttestedOracle.update(priceData) first and then the views,
// so they see the updated prices. Used for the in-house engine pool, whose mark-to-market views read the
// stored oracle price.
import { type Abi, type Address, type Hex, type PublicClient, createPublicClient, custom } from "viem";
import { oracleUpdateAsViewAbi } from "./lowgasAbi";

export interface ViewCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/**
 * A client that never batches (a batched multicall would split the update from the views). Requests go
 * through `pc`'s transport, which already retries: no second retry layer here.
 */
export function unbatchedClient(pc: PublicClient): PublicClient {
  return createPublicClient({ chain: pc.chain, transport: custom({ request: (args) => pc.request(args as never) }, { retryCount: 0 }) }) as PublicClient;
}

/**
 * Results of `views` (in order) after `oracle.update(priceData)` at `blockNumber`; null when the update or any
 * view fails (pre-low-gas oracle without `update`, a print the oracle refuses, RPC errors). `time` overrides the
 * call's block timestamp — needed when a print is dated after the block (FuturePrice beyond +5 s); an RPC
 * that does not support block overrides fails the call (null) and the caller keeps the stored-price views.
 */
export async function readAfterPriceUpdate(
  client: PublicClient,
  o: { oracle: Address; priceData: Hex; views: readonly ViewCall[]; blockNumber?: bigint; time?: bigint },
): Promise<unknown[] | null> {
  try {
    const res = await client.multicall({
      deployless: true,
      allowFailure: true,
      ...(o.blockNumber !== undefined ? { blockNumber: o.blockNumber } : {}),
      ...(o.time !== undefined ? { blockOverrides: { time: o.time } } : {}),
      contracts: [{ address: o.oracle, abi: oracleUpdateAsViewAbi, functionName: "update", args: [o.priceData] }, ...o.views] as never,
    });
    const out = res as Array<{ status: "success" | "failure"; result?: unknown }>;
    if (out.some((r) => r.status !== "success")) return null;
    return out.slice(1).map((r) => r.result);
  } catch {
    return null;
  }
}
